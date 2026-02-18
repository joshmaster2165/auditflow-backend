const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase, downloadFile, cleanupFile } = require('../utils/supabase');
const { parseDocument } = require('../services/documentParser');
const { analyzeEvidence } = require('../services/gpt');
const { generateDiff, generateHtmlExport } = require('../services/diffGenerator');
const { buildRequirementText, computeGroupAggregate, runGroupAnalysis, runGroupAnalysisByIds } = require('../services/groupAnalysis');

// ── In-memory job store for async group analysis ──
const jobs = new Map();

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'completed' || job.status === 'failed') && now - job.completedAt > 30 * 60 * 1000) {
      jobs.delete(id);
    } else if (job.status === 'processing' && now - job.startedAt > 20 * 60 * 1000) {
      jobs.set(id, { ...job, status: 'failed', error: 'Group analysis timed out after 20 minutes', completedAt: Date.now() });
    }
  }
}, 10 * 60 * 1000);

// POST /api/analyze/evidence/:evidenceId - Full analysis pipeline
router.post('/evidence/:evidenceId', async (req, res) => {
  let tempFilePath = null;

  try {
    const { evidenceId } = req.params;
    const { controlContext } = req.body || {};
    console.log(`\n🔍 Starting analysis for evidence: ${evidenceId}`);
    console.log(`🔎 controlContext from frontend: ${JSON.stringify(controlContext || null)}`);

    // 1. Fetch evidence record with joined controls and frameworks
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence')
      .select(`
        *,
        controls:control_id (
          *,
          frameworks:framework_id (*)
        )
      `)
      .eq('id', evidenceId)
      .single();

    if (evidenceError || !evidence) {
      console.error('❌ Evidence not found:', evidenceError?.message);
      return res.status(404).json({ error: 'Evidence record not found', details: evidenceError?.message });
    }

    console.log(`📋 Evidence: ${evidence.file_name || 'unnamed'}`);

    // 2. Download file from storage
    const filePath = evidence.file_path || evidence.storage_path;
    if (!filePath) {
      return res.status(400).json({ error: 'Evidence record has no file path' });
    }

    tempFilePath = await downloadFile(filePath);

    // 3. Parse document text
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';
    const documentText = await parseDocument(tempFilePath, mimeType);

    // 4. Get requirement text — prioritize frontend-provided context, fallback to DB join
    const dbControl = evidence.controls;
    console.log(`🔎 DB join control: ${JSON.stringify(dbControl, null, 2)?.substring(0, 500)}`);

    // Merge: frontend body data takes priority over DB join
    let control = {
      title: controlContext?.title || dbControl?.title || null,
      description: controlContext?.description || dbControl?.description || null,
      control_number: controlContext?.control_number || dbControl?.control_number || '',
      category: dbControl?.category || '',
      id: dbControl?.id || null,
      custom_fields: dbControl?.custom_fields || null,
      frameworks: dbControl?.frameworks || null,
    };

    console.log(`🔎 Control source: ${controlContext?.title ? 'frontend body' : (dbControl?.title ? 'DB join' : 'NONE')}`);

    // Last-resort fallback: if both frontend and join are empty, query controls directly
    if (!control.title && !control.description && evidence.control_id) {
      console.warn(`⚠️ No control data from frontend or join — fetching control ${evidence.control_id} directly`);
      const { data: fallbackControl, error: fallbackErr } = await supabase
        .from('controls')
        .select('*, frameworks:framework_id (*)')
        .eq('id', evidence.control_id)
        .single();

      if (fallbackControl) {
        console.log(`✅ Direct control fetch succeeded: "${fallbackControl.title}"`);
        control = {
          title: fallbackControl.title,
          description: fallbackControl.description,
          control_number: fallbackControl.control_number || '',
          category: fallbackControl.category || '',
          id: fallbackControl.id,
          custom_fields: fallbackControl.custom_fields || null,
          frameworks: fallbackControl.frameworks || null,
        };
      } else {
        console.error(`❌ Direct control fetch failed: ${fallbackErr?.message}`);
      }
    }

    const controlName = control.title || 'Unknown Control';
    const controlNumber = control.control_number || '';
    const frameworkName = control.frameworks?.name || '';

    // Build enriched requirement text using shared helper
    const requirementText = buildRequirementText(control, control.frameworks);

    console.log(`📐 Control: ${controlName} (${controlNumber})`);
    console.log(`🏛️ Framework: ${frameworkName || 'none'}`);
    console.log(`📝 Requirement (first 200 chars): ${requirementText.substring(0, 200)}...`);

    // 5. Send to GPT for analysis
    const gptResult = await analyzeEvidence(documentText, requirementText, controlName);

    // 6. Generate diff visualization
    const diffData = generateDiff(gptResult.analysis, requirementText);

    // 7. Store results in analysis_results table
    const analysisRecord = {
      evidence_id: evidenceId,
      control_id: control.id || null,
      project_id: evidence.project_id || null,
      analyzed_at: new Date().toISOString(),
      analysis_version: 'v1.0',
      model_used: gptResult.model || 'gpt-4-turbo-preview',
      status: gptResult.analysis.status,
      confidence_score: gptResult.analysis.confidence_score,
      compliance_percentage: gptResult.analysis.compliance_percentage,
      findings: gptResult.analysis,
      diff_data: diffData,
      summary: gptResult.analysis.summary,
      recommendations: gptResult.analysis.recommendations || [],
      raw_response: {
        usage: gptResult.usage,
        finish_reason: gptResult.finish_reason,
        model: gptResult.model,
      },
    };

    const { data: savedAnalysis, error: saveError } = await supabase
      .from('analysis_results')
      .insert(analysisRecord)
      .select()
      .single();

    if (saveError) {
      console.error('❌ Failed to save analysis:', saveError.message);
      // Still return the analysis even if save fails
      return res.status(200).json({
        success: true,
        warning: 'Analysis completed but failed to save to database',
        analysis: gptResult.analysis,
        diff_data: diffData,
        control: { id: control.id, name: controlName },
        evidence: { id: evidenceId, name: evidence.file_name },
      });
    }

    console.log(`✅ Analysis saved: ${savedAnalysis.id}`);

    // 8. Return analysis response
    res.json({
      success: true,
      analysis_id: savedAnalysis.id,
      analysis: gptResult.analysis,
      diff_data: diffData,
      control: {
        id: control.id,
        name: controlName,
        framework: control.frameworks?.name || null,
      },
      evidence: {
        id: evidenceId,
        name: evidence.file_name,
      },
      metadata: {
        model: gptResult.model,
        tokens_used: gptResult.usage,
        analyzed_at: savedAnalysis.analyzed_at,
      },
    });
  } catch (err) {
    console.error('❌ Analysis pipeline error:', err.message);
    res.status(500).json({
      error: 'Analysis failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    // 9. Clean up temp files
    cleanupFile(tempFilePath);
  }
});

// GET /api/analyze/results/by-control/:controlId - Fetch latest analysis for a specific control
// Useful when you only know the control ID (e.g., category page listing)
router.get('/results/by-control/:controlId', async (req, res) => {
  try {
    const { controlId } = req.params;

    const { data, error } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name, file_type, created_at),
        controls:control_id (id, title, description)
      `)
      .eq('control_id', controlId)
      .order('analyzed_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'No analysis found for this control' });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch results by control error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch analysis results',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// GET /api/analyze/results/:evidenceId/:controlId - Fetch analysis for specific evidence+control pair
// Used by category pages after bulk analysis where one evidence is analyzed against multiple controls
router.get('/results/:evidenceId/:controlId', async (req, res) => {
  try {
    const { evidenceId, controlId } = req.params;

    const { data, error } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name, file_type, created_at),
        controls:control_id (id, title, description)
      `)
      .eq('evidence_id', evidenceId)
      .eq('control_id', controlId)
      .order('analyzed_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'No analysis found for this evidence+control pair' });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch results by evidence+control error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch analysis results',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// GET /api/analyze/results/:evidenceId - Fetch latest analysis for evidence
router.get('/results/:evidenceId', async (req, res) => {
  try {
    const { evidenceId } = req.params;

    const { data, error } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name, file_type, created_at),
        controls:control_id (id, title, description)
      `)
      .eq('evidence_id', evidenceId)
      .order('analyzed_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'No analysis found for this evidence' });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch results error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch analysis results',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// GET /api/analyze/project/:projectId/results - Aggregate project results
router.get('/project/:projectId/results', async (req, res) => {
  try {
    const { projectId } = req.params;

    const { data: analyses, error } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name),
        controls:control_id (id, title)
      `)
      .eq('project_id', projectId)
      .order('analyzed_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch project results', details: error.message });
    }

    // Calculate aggregate statistics
    const total = analyses.length;
    const compliant = analyses.filter(a => a.status === 'compliant').length;
    const partial = analyses.filter(a => a.status === 'partial').length;
    const nonCompliant = analyses.filter(a => a.status === 'non_compliant').length;
    const pending = analyses.filter(a => a.status === 'pending').length;
    const errored = analyses.filter(a => a.status === 'error').length;

    const avgCompliance = total > 0
      ? Math.round(analyses.reduce((sum, a) => sum + (a.compliance_percentage || 0), 0) / total)
      : 0;

    const avgConfidence = total > 0
      ? parseFloat((analyses.reduce((sum, a) => sum + (parseFloat(a.confidence_score) || 0), 0) / total).toFixed(2))
      : 0;

    res.json({
      success: true,
      stats: {
        total_analyses: total,
        compliant,
        partial,
        non_compliant: nonCompliant,
        pending,
        error: errored,
        average_compliance_percentage: avgCompliance,
        average_confidence_score: avgConfidence,
        overall_status: compliant === total && total > 0
          ? 'compliant'
          : nonCompliant > 0
            ? 'non_compliant'
            : 'partial',
      },
      analyses,
    });
  } catch (err) {
    console.error('❌ Project results error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch project results',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// GET /api/analyze/export/:analysisId/html - Export HTML report
router.get('/export/:analysisId/html', async (req, res) => {
  try {
    const { analysisId } = req.params;

    const { data: analysis, error } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name),
        controls:control_id (id, title, frameworks:framework_id (name))
      `)
      .eq('id', analysisId)
      .single();

    if (error || !analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    const html = generateHtmlExport(analysis.diff_data, {
      controlName: analysis.controls?.title,
      frameworkName: analysis.controls?.frameworks?.name,
      evidenceName: analysis.evidence?.file_name,
      analyzedAt: analysis.analyzed_at,
    });

    const filename = `auditflow-report-${analysisId.substring(0, 8)}.html`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (err) {
    console.error('❌ Export error:', err.message);
    res.status(500).json({
      error: 'Failed to generate export',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GROUP ANALYSIS ENDPOINTS
// Analyze evidence against all child controls of a parent control
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/analyze/group/:evidenceId — Trigger group analysis
router.post('/group/:evidenceId', async (req, res) => {
  try {
    const { evidenceId } = req.params;
    console.log(`\n🔍 Starting GROUP analysis for evidence: ${evidenceId}`);

    // 1. Fetch evidence to get the parent control
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence')
      .select(`
        *,
        controls:control_id (
          *,
          frameworks:framework_id (*)
        )
      `)
      .eq('id', evidenceId)
      .single();

    if (evidenceError || !evidence) {
      return res.status(404).json({ error: 'Evidence record not found', details: evidenceError?.message });
    }

    const parentControl = evidence.controls;
    if (!parentControl) {
      return res.status(400).json({ error: 'Evidence has no linked control. Attach evidence to a parent control first.' });
    }

    // 2. Verify the parent has child controls
    const { data: childControls, error: childError } = await supabase
      .from('controls')
      .select('id, control_number, title')
      .eq('framework_id', parentControl.framework_id)
      .eq('parent_control_number', parentControl.control_number)
      .order('sort_order', { ascending: true });

    if (childError) {
      return res.status(500).json({ error: 'Failed to fetch child controls', details: childError.message });
    }

    if (!childControls || childControls.length === 0) {
      return res.status(400).json({
        error: `No child controls found under ${parentControl.control_number} (${parentControl.title}). This control may not be a parent, or child controls may not have parent_control_number set.`,
      });
    }

    // 3. Create job and start async processing
    const jobId = crypto.randomUUID();

    jobs.set(jobId, {
      status: 'processing',
      startedAt: Date.now(),
      progress: 'Initializing group analysis...',
      controlsTotal: childControls.length,
      controlsCompleted: 0,
    });

    console.log(`📋 [Group ${jobId}] Parent: ${parentControl.control_number} - ${parentControl.title}`);
    console.log(`📊 [Group ${jobId}] ${childControls.length} child controls to analyze`);

    // Fire-and-forget — runGroupAnalysis updates the job Map on progress/completion/failure
    runGroupAnalysis(jobId, evidenceId, jobs).catch((err) => {
      console.error(`💥 [Group ${jobId}] Unhandled error: ${err.message}`);
      if (jobs.get(jobId)?.status === 'processing') {
        jobs.set(jobId, {
          status: 'failed',
          completedAt: Date.now(),
          error: `Unhandled error: ${err.message}`,
        });
      }
    });

    // 4. Return immediately with job info
    return res.json({
      success: true,
      jobId,
      status: 'processing',
      parentControl: {
        id: parentControl.id,
        control_number: parentControl.control_number,
        title: parentControl.title,
      },
      childControls: childControls.length,
      evidenceName: evidence.file_name,
    });
  } catch (err) {
    console.error('❌ Group analysis start error:', err.message);
    res.status(500).json({
      error: 'Failed to start group analysis',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// GET /api/analyze/group/status/:jobId — Poll group analysis status
router.get('/group/status/:jobId', (req, res) => {
  // Prevent browser caching so polling always gets fresh data
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('ETag', `"${Date.now()}"`);

  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }

  if (job.status === 'processing') {
    return res.json({
      status: 'processing',
      progress: job.progress || 'Processing...',
      controlsCompleted: job.controlsCompleted || 0,
      controlsTotal: job.controlsTotal || 0,
      elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    });
  }

  if (job.status === 'completed') {
    return res.json({
      status: 'completed',
      ...job.result,
    });
  }

  if (job.status === 'failed') {
    return res.json({
      status: 'failed',
      error: job.error,
    });
  }
});

// GET /api/analyze/group/results/:parentControlId — Fetch stored group results
router.get('/group/results/:parentControlId', async (req, res) => {
  try {
    const { parentControlId } = req.params;

    // 1. Get the parent control
    const { data: parentControl, error: parentError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .eq('id', parentControlId)
      .single();

    if (parentError || !parentControl) {
      return res.status(404).json({ error: 'Parent control not found', details: parentError?.message });
    }

    // 2. Find all child control IDs
    const { data: childControls, error: childError } = await supabase
      .from('controls')
      .select('id, control_number, title')
      .eq('framework_id', parentControl.framework_id)
      .eq('parent_control_number', parentControl.control_number)
      .order('sort_order', { ascending: true });

    if (childError || !childControls || childControls.length === 0) {
      return res.status(404).json({ error: 'No child controls found under this parent' });
    }

    const childIds = childControls.map((c) => c.id);

    // 3. Fetch all analysis results for these child controls (latest per control)
    const { data: analyses, error: analysisError } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name),
        controls:control_id (id, title, control_number)
      `)
      .in('control_id', childIds)
      .order('analyzed_at', { ascending: false });

    if (analysisError) {
      return res.status(500).json({ error: 'Failed to fetch analysis results', details: analysisError.message });
    }

    if (!analyses || analyses.length === 0) {
      return res.json({
        success: true,
        message: 'No analysis results found for child controls of this parent',
        parentControl: {
          id: parentControl.id,
          control_number: parentControl.control_number,
          title: parentControl.title,
        },
        childControls: childControls.length,
        aggregate: null,
        results: [],
      });
    }

    // 4. Deduplicate to latest result per control
    const latestByControl = new Map();
    for (const analysis of analyses) {
      if (!latestByControl.has(analysis.control_id)) {
        latestByControl.set(analysis.control_id, analysis);
      }
    }
    const latestResults = Array.from(latestByControl.values());

    // 5. Build response with aggregate
    const results = latestResults.map((a) => ({
      analysis_id: a.id,
      control_id: a.control_id,
      control_number: a.controls?.control_number,
      control_title: a.controls?.title,
      status: a.status,
      compliance_percentage: a.compliance_percentage,
      confidence_score: a.confidence_score,
      summary: a.summary,
      evidence_name: a.evidence?.file_name,
      analyzed_at: a.analyzed_at,
    }));

    const aggregate = computeGroupAggregate(results);

    res.json({
      success: true,
      parentControl: {
        id: parentControl.id,
        control_number: parentControl.control_number,
        title: parentControl.title,
      },
      childControls: childControls.length,
      aggregate,
      results,
    });
  } catch (err) {
    console.error('❌ Group results error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch group results',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// POST /api/analyze/group-by-ids/:evidenceId — Trigger group analysis with explicit control IDs
// Used for category-grouped controls that don't have parent-child hierarchy
router.post('/group-by-ids/:evidenceId', async (req, res) => {
  try {
    const { evidenceId } = req.params;
    const { controlIds } = req.body;

    if (!controlIds || !Array.isArray(controlIds) || controlIds.length === 0) {
      return res.status(400).json({ error: 'controlIds must be a non-empty array of control UUIDs' });
    }

    console.log(`\n🔍 Starting GROUP-BY-IDS analysis for evidence: ${evidenceId}, ${controlIds.length} controls`);
    console.log(`📋 [GroupByIds] Received controlIds:`, JSON.stringify(controlIds));

    // 1. Fetch evidence record (just need to verify it exists and has a file)
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence')
      .select('*')
      .eq('id', evidenceId)
      .single();

    if (evidenceError || !evidence) {
      return res.status(404).json({ error: 'Evidence record not found', details: evidenceError?.message });
    }

    const filePath = evidence.file_path || evidence.storage_path;
    if (!filePath) {
      return res.status(400).json({ error: 'Evidence record has no file path' });
    }

    // 2. Fetch controls to validate they exist and get names for the response
    console.log(`📋 [GroupByIds] Querying controls table with .in('id', ...) for ${controlIds.length} IDs`);
    const { data: controls, error: controlsError } = await supabase
      .from('controls')
      .select('id, control_number, title')
      .in('id', controlIds)
      .order('sort_order', { ascending: true });

    console.log(`📋 [GroupByIds] Query result: ${controls?.length || 0} controls found, error: ${controlsError?.message || 'none'}`);

    if (controlsError) {
      return res.status(500).json({ error: 'Failed to fetch controls', details: controlsError.message, receivedIds: controlIds });
    }

    if (!controls || controls.length === 0) {
      return res.status(400).json({
        error: 'No valid controls found for the provided IDs',
        receivedIds: controlIds,
        hint: 'Ensure controlIds are UUID primary keys from the controls table id column',
      });
    }

    // 3. Create job and start async processing
    const jobId = crypto.randomUUID();

    jobs.set(jobId, {
      status: 'processing',
      startedAt: Date.now(),
      progress: 'Initializing group analysis...',
      controlsTotal: controls.length,
      controlsCompleted: 0,
    });

    console.log(`📊 [GroupByIds ${jobId}] ${controls.length} controls to analyze`);

    // Fire-and-forget
    runGroupAnalysisByIds(jobId, evidenceId, controlIds, jobs).catch((err) => {
      console.error(`💥 [GroupByIds ${jobId}] Unhandled error: ${err.message}`);
      if (jobs.get(jobId)?.status === 'processing') {
        jobs.set(jobId, {
          status: 'failed',
          completedAt: Date.now(),
          error: `Unhandled error: ${err.message}`,
        });
      }
    });

    // 4. Return immediately with job info
    // Include parentControl: null so the frontend transform handles category-based analysis
    // without crashing on missing parentControl.id
    return res.json({
      success: true,
      jobId,
      status: 'processing',
      parentControl: null,
      childControls: controls.length,
      controlCount: controls.length,
      controlIds: controlIds,
      evidenceName: evidence.file_name,
    });
  } catch (err) {
    console.error('❌ Group-by-IDs analysis start error:', err.message);
    res.status(500).json({
      error: 'Failed to start group analysis',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

module.exports = router;
