const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase, downloadFile, cleanupFile, getSignedUrl } = require('../utils/supabase');
const { parseDocument, parseDocumentForViewer } = require('../services/documentParser');
const { verifyAndBuildHighlightRanges } = require('../utils/passageMatcher');
const { analyzeEvidence, buildMultiEvidenceUserPrompt, buildAnalyzeAllPrompt } = require('../services/gpt');
const { generateDiff, generateHtmlExport } = require('../services/diffGenerator');
const { buildRequirementText, computeGroupAggregate, fetchCustomInstructions, findChildControls, runGroupAnalysis, runGroupAnalysisByIds } = require('../services/groupAnalysis');
const { createJobStore } = require('../utils/analysisHelpers');

// ── In-memory job store for async group analysis ──
const jobs = createJobStore({ processingTimeoutMs: 20 * 60 * 1000 });

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

    // 5. Fetch project-level custom instructions
    const customInstructions = await fetchCustomInstructions(evidence.project_id);

    // 6. Send to GPT for analysis
    const gptResult = await analyzeEvidence(documentText, requirementText, controlName, customInstructions);

    // 7. Generate diff visualization
    const diffData = generateDiff(gptResult.analysis, requirementText);

    // 8. Store results in analysis_results table
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

    // 9. Return analysis response
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
    // 10. Clean up temp files
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
// DOCUMENT VIEWER ENDPOINT
// Returns everything the frontend needs to render the interactive document viewer
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/analyze/document-viewer/:analysisId — Serve document viewer data
router.get('/document-viewer/:analysisId', async (req, res) => {
  let tempFilePath = null;

  try {
    const { analysisId } = req.params;

    // 1. Fetch analysis with joined evidence + control data
    const { data: analysis, error: analysisError } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (
          id, file_name, file_type, file_path
        ),
        controls:control_id (id, title, control_number)
      `)
      .eq('id', analysisId)
      .single();

    if (analysisError || !analysis) {
      return res.status(404).json({ error: 'Analysis not found', details: analysisError?.message });
    }

    const evidence = analysis.evidence;
    if (!evidence) {
      return res.status(400).json({ error: 'Evidence record not found for this analysis' });
    }

    const filePath = evidence.file_path;
    if (!filePath) {
      return res.status(400).json({ error: 'Evidence file path not available' });
    }

    const mimeType = evidence.file_type || 'text/plain';

    // 2. Check for cached viewer data in diff_data
    //    Re-compute if highlightRanges is empty (may have been cached before fuzzy matching was added)
    let documentText = analysis.diff_data?.viewer_document_text || null;
    let documentHtml = analysis.diff_data?.viewer_document_html || null;
    let highlightRanges = analysis.diff_data?.viewer_highlight_ranges || null;
    const hasValidCache = documentText && highlightRanges && highlightRanges.length > 0;

    // 3. If not cached or cache had zero highlights, regenerate
    if (!hasValidCache) {
      console.log(`📄 [Viewer] First view for analysis ${analysisId} — downloading and parsing document`);

      tempFilePath = await downloadFile(filePath);
      const parsed = await parseDocumentForViewer(tempFilePath, mimeType);

      documentText = parsed.text;
      documentHtml = parsed.html; // null for PDF/text

      // Verify GPT's offsets and build highlight ranges
      const breakdown = analysis.findings?.requirements_breakdown || [];
      highlightRanges = verifyAndBuildHighlightRanges(documentText, breakdown);

      console.log(`🎯 [Viewer] ${highlightRanges.length} highlight ranges matched (${highlightRanges.filter(r => r.matchQuality === 'exact').length} exact)`);

      // Cache results back to diff_data (non-blocking)
      supabase
        .from('analysis_results')
        .update({
          diff_data: {
            ...analysis.diff_data,
            viewer_document_text: documentText,
            viewer_document_html: documentHtml,
            viewer_highlight_ranges: highlightRanges,
          },
        })
        .eq('id', analysisId)
        .then(({ error: updateError }) => {
          if (updateError) {
            console.warn(`⚠️ [Viewer] Failed to cache viewer data: ${updateError.message}`);
          } else {
            console.log(`💾 [Viewer] Cached viewer data for analysis ${analysisId}`);
          }
        });
    }

    // 4. Generate signed URL for PDF viewing
    let signedUrl = null;
    if (mimeType === 'application/pdf') {
      signedUrl = await getSignedUrl(filePath, 300);
    }

    // 5. Determine file type for frontend
    let fileType = 'text';
    if (mimeType === 'application/pdf') {
      fileType = 'pdf';
    } else if (mimeType.includes('wordprocessingml') || mimeType.includes('docx')) {
      fileType = 'docx';
    }

    // 6. Return viewer response
    res.json({
      success: true,
      viewer: {
        analysisId,
        fileType,
        signedUrl,
        documentText,
        documentHtml,
        highlightRanges,
      },
      analysis: {
        id: analysis.id,
        status: analysis.status,
        compliance_percentage: analysis.compliance_percentage,
        confidence_score: analysis.confidence_score,
        summary: analysis.summary,
        findings: analysis.findings,
        diff_data: {
          requirement_coverage: analysis.diff_data?.requirement_coverage,
          statistics: analysis.diff_data?.statistics,
          side_by_side: analysis.diff_data?.side_by_side,
          recommendations: analysis.diff_data?.recommendations,
          critical_gaps: analysis.diff_data?.critical_gaps,
        },
      },
      evidenceSources: analysis.diff_data?.evidence_sources || null,
      evidence: {
        id: evidence.id,
        fileName: evidence.file_name,
        fileType: evidence.file_type,
      },
      control: analysis.controls ? {
        id: analysis.controls.id,
        title: analysis.controls.title,
        controlNumber: analysis.controls.control_number,
      } : null,
    });
  } catch (err) {
    console.error('❌ Document viewer error:', err.message);
    res.status(500).json({
      error: 'Failed to load document viewer data',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    cleanupFile(tempFilePath);
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

    // 2. Verify the parent has child controls (cascading strategies)
    const { childControls, matchStrategy } = await findChildControls(parentControl, 'id, control_number, title');

    if (!childControls || childControls.length === 0) {
      return res.status(400).json({
        error: `No child controls found under ${parentControl.control_number} (${parentControl.title}). Tried parent_control_number, group/category, and prefix matching.`,
      });
    }
    console.log(`🔗 [Group] Matched ${childControls.length} children via: ${matchStrategy}`);

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

    // 2. Find all child control IDs (cascading strategies)
    const { childControls, matchStrategy } = await findChildControls(parentControl, 'id, control_number, title');

    if (!childControls || childControls.length === 0) {
      return res.status(404).json({ error: 'No child controls found under this parent' });
    }
    console.log(`🔗 [GroupResults] Matched ${childControls.length} children via: ${matchStrategy}`);

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
    const { data: controls, error: controlsError } = await supabase
      .from('controls')
      .select('id, control_number, title')
      .in('id', controlIds)
      .order('sort_order', { ascending: true });

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

// ══════════════════════════════════════════════════════════════════════════════
// ANALYZE ALL CONTROLS
// All evidence from parent + all child requirements → one GPT call
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/analyze/analyze-all/:parentControlId — Validate all controls in a category at once
//
// Supports TWO modes:
//   Mode 1 (hierarchy):  parentControlId is a true parent → find children via parent_control_number/prefix
//   Mode 2 (category):   parentControlId is one control in a flat category → find all siblings in same category
//
// Optional body: { controlIds: [...] } to explicitly specify which controls to analyze
//
router.post('/analyze-all/:parentControlId', async (req, res) => {
  const tempFiles = [];

  try {
    const { parentControlId } = req.params;
    const { controlIds: explicitIds } = req.body || {};
    console.log(`\n🔍 Starting ANALYZE-ALL for control: ${parentControlId}`);

    // 1. Fetch the reference control with framework
    const { data: parentControl, error: parentError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .eq('id', parentControlId)
      .single();

    if (parentError || !parentControl) {
      return res.status(404).json({ error: 'Control not found', details: parentError?.message });
    }

    // 2. Determine which controls to analyze
    let controlsToAnalyze = [];
    let matchStrategy = 'unknown';

    if (explicitIds && Array.isArray(explicitIds) && explicitIds.length > 0) {
      // --- Mode: Explicit control IDs from frontend ---
      const { data: explicitControls, error: explicitError } = await supabase
        .from('controls')
        .select('*, frameworks:framework_id (*)')
        .in('id', explicitIds)
        .order('sort_order', { ascending: true });

      if (!explicitError && explicitControls && explicitControls.length > 0) {
        controlsToAnalyze = explicitControls;
        matchStrategy = 'explicit_ids';
      }
    }

    if (controlsToAnalyze.length === 0) {
      // --- Try cascading child discovery (hierarchy) ---
      const { childControls, matchStrategy: ms } = await findChildControls(parentControl);
      if (childControls && childControls.length > 0) {
        controlsToAnalyze = childControls;
        matchStrategy = ms;
      }
    }

    if (controlsToAnalyze.length === 0 && parentControl.category) {
      // --- Fallback: All controls in the same category (flat/grouped frameworks) ---
      const { data: categoryControls, error: catError } = await supabase
        .from('controls')
        .select('*, frameworks:framework_id (*)')
        .eq('framework_id', parentControl.framework_id)
        .eq('category', parentControl.category)
        .order('sort_order', { ascending: true });

      if (!catError && categoryControls && categoryControls.length > 0) {
        controlsToAnalyze = categoryControls;
        matchStrategy = 'same_category';
        console.log(`🔗 Found ${categoryControls.length} controls in category "${parentControl.category}"`);
      }
    }

    if (controlsToAnalyze.length === 0) {
      return res.status(400).json({
        error: `No controls found to analyze for ${parentControl.control_number} (${parentControl.title}).`,
        hint: 'Tried hierarchy, category, and prefix matching. Send controlIds in request body as fallback.',
      });
    }

    console.log(`📐 Reference: ${parentControl.control_number} - ${parentControl.title}`);
    console.log(`🔗 ${controlsToAnalyze.length} controls to analyze (strategy: ${matchStrategy})`);

    // 3. Fetch evidence — try parent control first, then all controls in the group
    const controlIdsForEvidence = [parentControlId, ...controlsToAnalyze.map(c => c.id)];
    const uniqueIds = [...new Set(controlIdsForEvidence)];

    const { data: evidenceFiles, error: evidenceError } = await supabase
      .from('evidence')
      .select('*')
      .in('control_id', uniqueIds)
      .order('uploaded_at', { ascending: true });

    if (evidenceError) {
      return res.status(500).json({ error: 'Failed to fetch evidence files', details: evidenceError.message });
    }

    if (!evidenceFiles || evidenceFiles.length === 0) {
      return res.status(404).json({
        error: 'No evidence files found. Upload evidence to this category before validating.',
      });
    }

    console.log(`📎 ${evidenceFiles.length} evidence file(s) attached to parent`);

    // 4. Download and parse all evidence (dedupe by file_path)
    const seenPaths = new Set();
    const parsedDocs = [];

    for (const ev of evidenceFiles) {
      const filePath = ev.file_path;
      if (!filePath || seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);

      try {
        const tempPath = await downloadFile(filePath);
        tempFiles.push(tempPath);
        const mimeType = ev.file_type || 'text/plain';
        const text = await parseDocument(tempPath, mimeType);
        parsedDocs.push({ evidence: ev, text });
      } catch (parseErr) {
        console.error(`❌ Failed to parse ${ev.file_name}: ${parseErr.message}`);
      }
    }

    if (parsedDocs.length === 0) {
      return res.status(400).json({ error: 'Could not parse any evidence files' });
    }

    // 5. Concatenate with separators
    const combinedText = parsedDocs.map((d, i) =>
      `\n\n=== DOCUMENT ${i + 1}: ${d.evidence.file_name} ===\n\n${d.text}`
    ).join('');

    // 6. Token limit guard
    if (combinedText.length > 400000) {
      return res.status(400).json({
        error: 'Combined evidence is too large for a single analysis',
        combined_length: combinedText.length,
        hint: 'Try reducing the number or size of evidence files',
      });
    }

    // 7. Build controls list with enriched requirement text
    const controlsList = controlsToAnalyze.map(c => ({
      control_number: c.control_number || '',
      title: c.title || 'Unnamed Control',
      requirementText: buildRequirementText(c, c.frameworks),
    }));

    // 8. Fetch custom instructions
    const projectId = evidenceFiles[0].project_id || null;
    const customInstructions = await fetchCustomInstructions(projectId);

    // 9. Build prompt and call GPT
    const documentNames = parsedDocs.map(d => d.evidence.file_name);
    const userPromptOverride = buildAnalyzeAllPrompt(combinedText, controlsList, customInstructions, documentNames);

    console.log(`🤖 Sending ${parsedDocs.length} docs + ${controlsToAnalyze.length} controls to GPT...`);
    const gptResult = await analyzeEvidence(combinedText, 'multiple controls', parentControl.title, customInstructions, { userPromptOverride });

    // 10. Parse per-control results from GPT response
    const gptControls = gptResult.analysis.controls || [];
    const evidenceSources = parsedDocs.map(d => ({
      id: d.evidence.id,
      fileName: d.evidence.file_name,
      fileType: d.evidence.file_type,
      filePath: d.evidence.file_path,
    }));

    // 11. Save one analysis_results per control
    const results = [];
    for (const child of controlsToAnalyze) {
      // Match GPT result by control_number
      const gptCtrl = gptControls.find(g =>
        g.control_number === child.control_number ||
        g.control_number === (child.control_number || '').trim()
      ) || null;

      if (!gptCtrl) {
        console.warn(`⚠️ GPT did not return result for control ${child.control_number} — skipping DB save`);
        results.push({
          analysis_id: null,
          control_id: child.id,
          control_number: child.control_number,
          control_title: child.title,
          status: 'error',
          error: 'GPT did not return a result for this control',
          compliance_percentage: null,
          confidence_score: null,
          summary: null,
        });
        continue;
      }

      // Normalize the per-control analysis to match standard format
      const controlAnalysis = {
        status: gptCtrl.status || 'non_compliant',
        confidence_score: parseFloat(gptCtrl.confidence_score || 0),
        compliance_percentage: parseInt(gptCtrl.compliance_percentage || 0, 10),
        summary: gptCtrl.summary || '',
        requirements_breakdown: (gptCtrl.requirements_breakdown || []).map((item, i) => ({
          requirement_id: item.requirement_id || `REQ-${i + 1}`,
          requirement_text: item.requirement_text || '',
          status: item.status || 'missing',
          evidence_found: item.evidence_found || null,
          evidence_source: item.evidence_source || null,
          evidence_location: item.evidence_location || { start_index: -1, end_index: -1, section_context: null },
          gap_description: item.gap_description || null,
          confidence: parseFloat(item.confidence || 0.5),
        })),
        recommendations: Array.isArray(gptCtrl.recommendations) ? gptCtrl.recommendations : [],
        critical_gaps: Array.isArray(gptCtrl.critical_gaps) ? gptCtrl.critical_gaps : [],
      };

      const requirementText = buildRequirementText(child, child.frameworks);
      const diffData = generateDiff(controlAnalysis, requirementText);
      diffData.evidence_sources = evidenceSources;

      const analysisRecord = {
        evidence_id: parsedDocs[0].evidence.id,
        control_id: child.id,
        project_id: projectId,
        analyzed_at: new Date().toISOString(),
        analysis_version: 'v1.0-all',
        model_used: gptResult.model || 'gpt-4o',
        status: controlAnalysis.status,
        confidence_score: controlAnalysis.confidence_score,
        compliance_percentage: controlAnalysis.compliance_percentage,
        findings: controlAnalysis,
        diff_data: diffData,
        summary: controlAnalysis.summary,
        recommendations: controlAnalysis.recommendations,
        raw_response: {
          usage: gptResult.usage,
          finish_reason: gptResult.finish_reason,
          model: gptResult.model,
        },
      };

      const { data: saved, error: saveError } = await supabase
        .from('analysis_results')
        .insert(analysisRecord)
        .select()
        .single();

      if (saveError) {
        console.error(`⚠️ DB save failed for ${child.control_number}: ${saveError.message}`);
      }

      results.push({
        analysis_id: saved?.id || null,
        control_id: child.id,
        control_number: child.control_number,
        control_title: child.title,
        status: controlAnalysis.status,
        compliance_percentage: controlAnalysis.compliance_percentage,
        confidence_score: controlAnalysis.confidence_score,
        summary: controlAnalysis.summary,
        evidence_count: parsedDocs.length,
      });

      console.log(`✅ ${child.control_number}: ${controlAnalysis.status} (${controlAnalysis.compliance_percentage}%)`);
    }

    // 12. Compute aggregate
    const validResults = results.filter(r => r.status !== 'error');
    const aggregate = computeGroupAggregate(validResults);

    console.log(`🏁 Analyze-all complete: ${results.length} controls, aggregate: ${aggregate.overall_status} (${aggregate.average_compliance_percentage}%)`);

    res.json({
      success: true,
      aggregate,
      results,
      parentControl: {
        id: parentControl.id,
        control_number: parentControl.control_number,
        title: parentControl.title,
      },
      evidence_files: parsedDocs.map(d => ({
        id: d.evidence.id,
        name: d.evidence.file_name,
      })),
      overall: {
        status: gptResult.analysis.overall_status || aggregate.overall_status,
        compliance_percentage: gptResult.analysis.overall_compliance_percentage || aggregate.average_compliance_percentage,
        summary: gptResult.analysis.overall_summary || '',
      },
      metadata: {
        model: gptResult.model,
        tokens_used: gptResult.usage,
        analyzed_at: new Date().toISOString(),
        documents_analyzed: parsedDocs.length,
        controls_analyzed: controlsToAnalyze.length,
      },
    });
  } catch (err) {
    console.error('❌ Analyze-all error:', err.message);
    res.status(500).json({
      error: 'Analyze-all failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    tempFiles.forEach(f => cleanupFile(f));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-EVIDENCE CONSOLIDATED ANALYSIS
// Analyzes ALL evidence files attached to a control in one GPT call
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/analyze/multi-evidence/:controlId — Consolidated multi-evidence analysis
router.post('/multi-evidence/:controlId', async (req, res) => {
  const tempFiles = [];

  try {
    const { controlId } = req.params;
    console.log(`\n🔍 Starting MULTI-EVIDENCE analysis for control: ${controlId}`);

    // 1. Fetch all evidence files linked to this control
    const { data: evidenceFiles, error: evidenceError } = await supabase
      .from('evidence')
      .select('*')
      .eq('control_id', controlId)
      .order('uploaded_at', { ascending: true });

    if (evidenceError) {
      return res.status(500).json({ error: 'Failed to fetch evidence files', details: evidenceError.message });
    }

    if (!evidenceFiles || evidenceFiles.length === 0) {
      return res.status(404).json({ error: 'No evidence files found for this control' });
    }

    console.log(`📎 Found ${evidenceFiles.length} evidence file(s) for control ${controlId}`);

    // 2. Fetch control with framework
    const { data: control, error: controlError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .eq('id', controlId)
      .single();

    if (controlError || !control) {
      return res.status(404).json({ error: 'Control not found', details: controlError?.message });
    }

    const controlName = control.title || 'Unknown Control';
    const requirementText = buildRequirementText(control, control.frameworks);

    console.log(`📐 Control: ${controlName} (${control.control_number || ''})`);

    // 3. Download and parse ALL documents in parallel
    const parsedDocs = await Promise.all(evidenceFiles.map(async (ev) => {
      const filePath = ev.file_path;
      if (!filePath) {
        console.warn(`⚠️ Evidence ${ev.id} (${ev.file_name}) has no file path — skipping`);
        return null;
      }

      try {
        const tempPath = await downloadFile(filePath);
        tempFiles.push(tempPath);
        const mimeType = ev.file_type || 'text/plain';
        const text = await parseDocument(tempPath, mimeType);
        return { evidence: ev, text };
      } catch (parseErr) {
        console.error(`❌ Failed to parse ${ev.file_name}: ${parseErr.message}`);
        return null;
      }
    }));

    // Filter out any that failed
    const validDocs = parsedDocs.filter(Boolean);
    if (validDocs.length === 0) {
      return res.status(400).json({ error: 'Could not parse any evidence files' });
    }

    console.log(`📄 Successfully parsed ${validDocs.length} of ${evidenceFiles.length} documents`);

    // 4. Concatenate documents with clear separators
    const combinedText = validDocs.map((d, i) =>
      `\n\n=== DOCUMENT ${i + 1}: ${d.evidence.file_name} ===\n\n${d.text}`
    ).join('');

    // 5. Token limit guard (~100K tokens ≈ 400K chars)
    if (combinedText.length > 400000) {
      return res.status(400).json({
        error: 'Combined document text is too large for a single analysis',
        combined_length: combinedText.length,
        max_length: 400000,
        hint: 'Try reducing the number of evidence files or splitting large documents',
      });
    }

    // 6. Fetch custom instructions
    const customInstructions = await fetchCustomInstructions(evidenceFiles[0].project_id);

    // 7. Build multi-evidence prompt and call GPT
    const documentNames = validDocs.map(d => d.evidence.file_name);
    const userPromptOverride = buildMultiEvidenceUserPrompt(
      combinedText, requirementText, controlName, customInstructions, documentNames
    );

    console.log(`🤖 Sending ${validDocs.length} documents (${combinedText.length} chars combined) to GPT for consolidated analysis...`);
    const gptResult = await analyzeEvidence(combinedText, requirementText, controlName, customInstructions, { userPromptOverride });

    // 8. Generate diff visualization
    const diffData = generateDiff(gptResult.analysis, requirementText);

    // Add evidence_sources to diff_data for multi-doc viewer
    diffData.evidence_sources = validDocs.map(d => ({
      id: d.evidence.id,
      fileName: d.evidence.file_name,
      fileType: d.evidence.file_type,
      filePath: d.evidence.file_path,
    }));

    // 9. Save ONE consolidated analysis_results record
    const analysisRecord = {
      evidence_id: validDocs[0].evidence.id, // FK constraint: use first evidence
      control_id: controlId,
      project_id: evidenceFiles[0].project_id || null,
      analyzed_at: new Date().toISOString(),
      analysis_version: 'v1.0-multi',
      model_used: gptResult.model || 'gpt-4o',
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
      console.error('❌ Failed to save multi-evidence analysis:', saveError.message);
      return res.status(200).json({
        success: true,
        warning: 'Analysis completed but failed to save to database',
        analysis: gptResult.analysis,
        diff_data: diffData,
      });
    }

    console.log(`✅ Multi-evidence analysis saved: ${savedAnalysis.id} (${validDocs.length} docs consolidated)`);

    // 10. Return consolidated result
    res.json({
      success: true,
      analysis_id: savedAnalysis.id,
      analysis_version: 'v1.0-multi',
      analysis: gptResult.analysis,
      diff_data: diffData,
      control: {
        id: control.id,
        name: controlName,
        control_number: control.control_number,
        framework: control.frameworks?.name || null,
      },
      evidence_files: validDocs.map(d => ({
        id: d.evidence.id,
        name: d.evidence.file_name,
      })),
      metadata: {
        model: gptResult.model,
        tokens_used: gptResult.usage,
        analyzed_at: savedAnalysis.analyzed_at,
        documents_analyzed: validDocs.length,
      },
    });
  } catch (err) {
    console.error('❌ Multi-evidence analysis error:', err.message);
    res.status(500).json({
      error: 'Multi-evidence analysis failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    // Clean up ALL temp files
    tempFiles.forEach(f => cleanupFile(f));
  }
});

module.exports = router;
