const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase, downloadFile, cleanupFile, getSignedUrl } = require('../utils/supabase');
const fs = require('fs');
const { parseDocument, parseDocumentForViewer, isImageType } = require('../services/documentParser');
const { verifyAndBuildHighlightRanges } = require('../utils/passageMatcher');
const { analyzeEvidence, analyzeImageEvidence, normalizeGptAnalysis, buildAnalyzeAllPrompt, consolidateAnalyses, consolidateControlAnalyses, SYSTEM_PROMPT } = require('../services/gpt');
const { generateDiff, generateHtmlExport } = require('../services/diffGenerator');
const { buildRequirementText, computeGroupAggregate, fetchCustomInstructions, findChildControls, runGroupAnalysis, runGroupAnalysisByIds } = require('../services/groupAnalysis');
const { createJobStore } = require('../utils/analysisHelpers');

// ── Constants ──
const MAX_COMBINED_TEXT_CHARS = 400000;
const MAX_IMAGE_FILES = 10;

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

    // 3. Determine MIME type
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';

    // 4. Get requirement text — prioritize frontend-provided context, fallback to DB join
    const dbControl = evidence.controls;

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

    // 6. Branch: Image vs Text analysis
    let gptResult;
    let diffData;

    if (isImageType(mimeType)) {
      // ── IMAGE ANALYSIS PATH ──
      console.log(`🖼️ Image evidence detected (${mimeType}) — using GPT-4o vision`);
      const imageBase64 = fs.readFileSync(tempFilePath).toString('base64');

      // Size guard: reject images over 20MB base64
      if (imageBase64.length > 20 * 1024 * 1024 * 1.37) {
        return res.status(400).json({ error: 'Image file is too large for analysis (max 20MB)' });
      }

      gptResult = await analyzeImageEvidence(imageBase64, mimeType, requirementText, controlName, customInstructions);

      // Generate diff + store OCR extracted text
      diffData = generateDiff(gptResult.analysis, requirementText);
      diffData.extracted_text = gptResult.analysis.extracted_text || '';
      diffData.is_image = true;
    } else {
      // ── TEXT ANALYSIS PATH (existing) ──
      const documentText = await parseDocument(tempFilePath, mimeType);
      gptResult = await analyzeEvidence(documentText, requirementText, controlName, customInstructions);
      diffData = generateDiff(gptResult.analysis, requirementText);
    }

    // 7. Store results in analysis_results table
    const analysisRecord = {
      evidence_id: evidenceId,
      control_id: control.id || null,
      project_id: evidence.project_id || null,
      analyzed_at: new Date().toISOString(),
      analysis_version: 'v1.0',
      model_used: gptResult.model || 'gpt-5.1',
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

    const defaultEvidence = analysis.evidence;
    if (!defaultEvidence) {
      return res.status(400).json({ error: 'Evidence record not found for this analysis' });
    }

    // 2. Find all sibling analyses for the same control (enables evidence tab switching)
    const { data: siblingAnalyses } = await supabase
      .from('analysis_results')
      .select('id, evidence:evidence_id (id, file_name, file_type), status, compliance_percentage, analyzed_at')
      .eq('control_id', analysis.control_id)
      .order('analyzed_at', { ascending: false });

    // Deduplicate to latest analysis per evidence file
    const latestByEvidence = new Map();
    for (const s of (siblingAnalyses || [])) {
      if (s.evidence && !latestByEvidence.has(s.evidence.id)) {
        latestByEvidence.set(s.evidence.id, s);
      }
    }

    const evidenceSources = Array.from(latestByEvidence.values()).map(s => ({
      id: s.evidence.id,
      fileName: s.evidence.file_name,
      fileType: s.evidence.file_type,
      analysisId: s.id,
      status: s.status,
      compliancePercentage: s.compliance_percentage,
    }));

    // 3. Each analysis_id maps to exactly 1 evidence file (per-pair model, v2.0+)
    const activeEvidence = defaultEvidence;
    const filePath = activeEvidence.file_path;
    if (!filePath) {
      return res.status(400).json({ error: 'Evidence file path not available' });
    }

    const mimeType = activeEvidence.file_type || 'text/plain';

    // 3. Use analysis data directly — no per-evidence filtering needed
    const responseFindings = analysis.findings;
    const responseStatus = analysis.status;
    const responseCompliance = analysis.compliance_percentage;
    const responseConfidence = analysis.confidence_score;
    const responseSummary = analysis.summary;
    const responseDiffData = {
      requirement_coverage: analysis.diff_data?.requirement_coverage,
      statistics: analysis.diff_data?.statistics,
      side_by_side: analysis.diff_data?.side_by_side,
      recommendations: analysis.diff_data?.recommendations || [],
      critical_gaps: analysis.diff_data?.critical_gaps || [],
    };

    // 4. IMAGE VIEWER: return signed URL + extracted text, no highlights
    if (isImageType(mimeType)) {
      const signedUrl = await getSignedUrl(filePath, 300);
      const extractedText = analysis.diff_data?.extracted_text || analysis.findings?.extracted_text || '';

      return res.json({
        success: true,
        viewer: {
          analysisId,
          fileType: 'image',
          signedUrl,
          documentText: extractedText,
          documentHtml: null,
          highlightRanges: [],
          currentEvidenceId: activeEvidence.id,
        },
        analysis: {
          id: analysis.id,
          status: responseStatus,
          compliance_percentage: responseCompliance,
          confidence_score: responseConfidence,
          summary: responseSummary,
          findings: responseFindings,
          diff_data: responseDiffData,
        },
        evidenceSources,
        evidence: {
          id: activeEvidence.id,
          fileName: activeEvidence.file_name,
          fileType: activeEvidence.file_type,
        },
        control: analysis.controls ? {
          id: analysis.controls.id,
          title: analysis.controls.title,
          controlNumber: analysis.controls.control_number,
        } : null,
      });
    }

    // 5. Check for cached viewer data in diff_data
    let documentText = analysis.diff_data?.viewer_document_text || null;
    let documentHtml = analysis.diff_data?.viewer_document_html || null;
    let highlightRanges = analysis.diff_data?.viewer_highlight_ranges || null;

    const hasValidCache = documentText && highlightRanges && highlightRanges.length > 0;

    // 6. If not cached, download and parse the document
    if (!hasValidCache) {
      console.log(`📄 [Viewer] Loading analysis ${analysisId} — downloading ${activeEvidence.file_name}`);

      tempFilePath = await downloadFile(filePath);
      const parsed = await parseDocumentForViewer(tempFilePath, mimeType);

      documentText = parsed.text;
      documentHtml = parsed.html;

      const highlightFindings = analysis.findings?.requirements_breakdown || [];
      highlightRanges = verifyAndBuildHighlightRanges(documentText, highlightFindings);

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

    // 7. Generate signed URL for PDF viewing
    let signedUrl = null;
    if (mimeType === 'application/pdf') {
      signedUrl = await getSignedUrl(filePath, 300);
    }

    // 8. Determine file type for frontend
    let fileType = 'text';
    if (mimeType === 'application/pdf') {
      fileType = 'pdf';
    } else if (mimeType.includes('wordprocessingml') || mimeType.includes('docx')) {
      fileType = 'docx';
    }

    // 9. Return viewer response
    res.json({
      success: true,
      viewer: {
        analysisId,
        fileType,
        signedUrl,
        documentText,
        documentHtml,
        highlightRanges,
        currentEvidenceId: activeEvidence.id,
      },
      analysis: {
        id: analysis.id,
        status: responseStatus,
        compliance_percentage: responseCompliance,
        confidence_score: responseConfidence,
        summary: responseSummary,
        findings: responseFindings,
        diff_data: responseDiffData,
      },
      evidenceSources,
      evidence: {
        id: activeEvidence.id,
        fileName: activeEvidence.file_name,
        fileType: activeEvidence.file_type,
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
    const { controlIds: explicitIds, evidenceIds: explicitEvidenceIds } = req.body || {};
    console.log(`\n🔍 Starting ANALYZE-ALL for control: ${parentControlId}`);
    if (explicitIds) console.log(`📋 Explicit controlIds: ${explicitIds.length}`);
    if (explicitEvidenceIds) console.log(`📋 Explicit evidenceIds: ${explicitEvidenceIds.length}`);

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

    // 3. Fetch evidence — explicit IDs first, then from all controls in the group
    let evidenceFiles = [];

    if (explicitEvidenceIds && Array.isArray(explicitEvidenceIds) && explicitEvidenceIds.length > 0) {
      // --- Mode: Explicit evidence IDs from frontend ---
      const { data: explicitEvidence, error: explicitEvError } = await supabase
        .from('evidence')
        .select('*')
        .in('id', explicitEvidenceIds)
        .order('uploaded_at', { ascending: true });

      if (!explicitEvError && explicitEvidence) {
        evidenceFiles = explicitEvidence;
      }
      console.log(`📎 ${evidenceFiles.length} evidence file(s) from explicit IDs`);
    } else {
      // --- Fallback: Fetch from all controls in the group ---
      const controlIdsForEvidence = [parentControlId, ...controlsToAnalyze.map(c => c.id)];
      const uniqueIds = [...new Set(controlIdsForEvidence)];

      const { data: groupEvidence, error: evidenceError } = await supabase
        .from('evidence')
        .select('*')
        .in('control_id', uniqueIds)
        .order('uploaded_at', { ascending: true });

      if (evidenceError) {
        return res.status(500).json({ error: 'Failed to fetch evidence files', details: evidenceError.message });
      }
      evidenceFiles = groupEvidence || [];
      console.log(`📎 ${evidenceFiles.length} evidence file(s) from control group`);
    }

    if (!evidenceFiles || evidenceFiles.length === 0) {
      return res.status(404).json({
        error: 'No evidence files found. Upload evidence before validating.',
      });
    }

    // 4. Download and parse all evidence (dedupe by file_path) — separate text and images
    const seenPaths = new Set();
    const parsedDocs = [];
    const parsedImages = [];

    for (const ev of evidenceFiles) {
      const evFilePath = ev.file_path;
      if (!evFilePath || seenPaths.has(evFilePath)) continue;
      seenPaths.add(evFilePath);

      try {
        const tempPath = await downloadFile(evFilePath);
        tempFiles.push(tempPath);
        const mimeType = ev.file_type || 'text/plain';

        if (isImageType(mimeType)) {
          const imageBase64 = fs.readFileSync(tempPath).toString('base64');
          parsedImages.push({ evidence: ev, base64: imageBase64, mimeType });
        } else {
          const text = await parseDocument(tempPath, mimeType);
          parsedDocs.push({ evidence: ev, text });
        }
      } catch (parseErr) {
        console.error(`❌ Failed to parse ${ev.file_name}: ${parseErr.message}`);
      }
    }

    const totalEvidenceCount = parsedDocs.length + parsedImages.length;
    if (totalEvidenceCount === 0) {
      return res.status(400).json({ error: 'Could not parse any evidence files' });
    }

    // Image count guard
    if (parsedImages.length > MAX_IMAGE_FILES) {
      return res.status(400).json({
        error: `Too many image files (${parsedImages.length}). Maximum ${MAX_IMAGE_FILES} images per request.`,
      });
    }

    // 5. Build controls list with enriched requirement text
    const controlsList = controlsToAnalyze.map(c => ({
      control_number: c.control_number || '',
      title: c.title || 'Unnamed Control',
      requirementText: buildRequirementText(c, c.frameworks),
    }));

    // 6. Fetch custom instructions
    const projectId = evidenceFiles[0].project_id || null;
    const customInstructions = await fetchCustomInstructions(projectId);

    // 7. Process each evidence file separately — one GPT call per evidence × all controls
    //    This produces M×N results (one per evidence-control pair)
    const allParsedEvidence = [
      ...parsedDocs.map(d => ({ evidence: d.evidence, text: d.text, isImage: false })),
      ...parsedImages.map(d => ({ evidence: d.evidence, base64: d.base64, mimeType: d.mimeType, isImage: true })),
    ];

    const results = [];
    let totalUsage = null;
    const CONCURRENCY = 3;

    // Process evidence files in parallel batches of CONCURRENCY
    for (let batchStart = 0; batchStart < allParsedEvidence.length; batchStart += CONCURRENCY) {
      const batch = allParsedEvidence.slice(batchStart, batchStart + CONCURRENCY);

      const batchPromises = batch.map(async (parsed) => {
        const ev = parsed.evidence;
        let gptResult;

        if (parsed.isImage) {
          // ── IMAGE EVIDENCE: vision API with all controls ──
          const textPrompt = buildAnalyzeAllPrompt(
            '(Image evidence — see attached image)', controlsList, customInstructions, [ev.file_name]
          );
          const contentParts = [
            { type: 'text', text: textPrompt },
            { type: 'text', text: `\n=== IMAGE EVIDENCE: ${ev.file_name} ===` },
            { type: 'image_url', image_url: { url: `data:${parsed.mimeType};base64,${parsed.base64}`, detail: 'high' } },
          ];

          const OpenAI = require('openai');
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
          const response = await openai.chat.completions.create({
            model: 'gpt-5.1',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: contentParts },
            ],
            temperature: 0.2,
            max_completion_tokens: 16384,
            response_format: { type: 'json_object' },
          });

          const choice = response.choices[0];
          let analysis;
          try { analysis = JSON.parse(choice.message.content); } catch (e) {
            throw new Error(`GPT returned invalid JSON for image evidence: ${ev.file_name}`);
          }
          analysis.status = analysis.overall_status || analysis.status || 'non_compliant';
          analysis.controls = Array.isArray(analysis.controls) ? analysis.controls : [];
          gptResult = { analysis, model: response.model, usage: response.usage, finish_reason: choice.finish_reason };
        } else {
          // ── TEXT EVIDENCE: one doc + all controls ──
          const singleDocText = `\n\n=== DOCUMENT 1: ${ev.file_name} ===\n\n${parsed.text}`;

          // Token limit guard per document
          if (singleDocText.length > MAX_COMBINED_TEXT_CHARS) {
            console.warn(`⚠️ Evidence ${ev.file_name} too large (${singleDocText.length} chars) — skipping`);
            return [];
          }

          const userPromptOverride = buildAnalyzeAllPrompt(singleDocText, controlsList, customInstructions, [ev.file_name]);
          console.log(`🤖 Analyzing ${ev.file_name} against ${controlsToAnalyze.length} controls...`);
          gptResult = await analyzeEvidence(parsed.text, 'multiple controls', parentControl.title, customInstructions, { userPromptOverride });
        }

        // Accumulate token usage
        if (gptResult.usage) {
          if (!totalUsage) totalUsage = { ...gptResult.usage };
          else {
            totalUsage.prompt_tokens = (totalUsage.prompt_tokens || 0) + (gptResult.usage.prompt_tokens || 0);
            totalUsage.completion_tokens = (totalUsage.completion_tokens || 0) + (gptResult.usage.completion_tokens || 0);
            totalUsage.total_tokens = (totalUsage.total_tokens || 0) + (gptResult.usage.total_tokens || 0);
          }
        }

        // Parse per-control results and save one row per evidence×control pair
        const gptControls = gptResult.analysis.controls || [];
        const pairResults = [];

        for (const child of controlsToAnalyze) {
          const gptCtrl = gptControls.find(g =>
            g.control_number === child.control_number ||
            g.control_number === (child.control_number || '').trim()
          ) || null;

          if (!gptCtrl) {
            console.warn(`⚠️ GPT did not return result for control ${child.control_number} (evidence: ${ev.file_name}) — skipping`);
            pairResults.push({
              analysis_id: null,
              control_id: child.id,
              evidence_id: ev.id,
              evidence_name: ev.file_name,
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

          const controlAnalysis = normalizeGptAnalysis({ ...gptCtrl });
          const requirementText = buildRequirementText(child, child.frameworks);
          const diffData = generateDiff(controlAnalysis, requirementText);

          const analysisRecord = {
            evidence_id: ev.id,
            control_id: child.id,
            project_id: projectId,
            analyzed_at: new Date().toISOString(),
            analysis_version: 'v2.0-pair',
            model_used: gptResult.model || 'gpt-5.1',
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
            console.error(`⚠️ DB save failed for ${child.control_number} × ${ev.file_name}: ${saveError.message}`);
          }

          pairResults.push({
            analysis_id: saved?.id || null,
            control_id: child.id,
            evidence_id: ev.id,
            evidence_name: ev.file_name,
            control_number: child.control_number,
            control_title: child.title,
            status: controlAnalysis.status,
            compliance_percentage: controlAnalysis.compliance_percentage,
            confidence_score: controlAnalysis.confidence_score,
            summary: controlAnalysis.summary,
          });

          console.log(`✅ ${child.control_number} × ${ev.file_name}: ${controlAnalysis.status} (${controlAnalysis.compliance_percentage}%)`);
        }

        return pairResults;
      });

      const batchResults = await Promise.all(batchPromises);
      for (const pairResults of batchResults) {
        results.push(...pairResults);
      }
    }

    // 8. Compute aggregate (use latest per control for backward compat)
    const validResults = results.filter(r => r.status !== 'error');
    const aggregate = computeGroupAggregate(validResults);
    const pairsAnalyzed = results.length;

    console.log(`🏁 Analyze-all complete: ${pairsAnalyzed} pairs (${allParsedEvidence.length} evidence × ${controlsToAnalyze.length} controls), aggregate: ${aggregate.overall_status} (${aggregate.average_compliance_percentage}%)`);

    res.json({
      success: true,
      aggregate,
      results,
      parentControl: {
        id: parentControl.id,
        control_number: parentControl.control_number,
        title: parentControl.title,
      },
      evidence_files: allParsedEvidence.map(p => ({
        id: p.evidence.id,
        name: p.evidence.file_name,
      })),
      overall: {
        status: aggregate.overall_status,
        compliance_percentage: aggregate.average_compliance_percentage,
        summary: '',
      },
      metadata: {
        model: 'gpt-5.1',
        tokens_used: totalUsage,
        analyzed_at: new Date().toISOString(),
        documents_analyzed: allParsedEvidence.length,
        controls_analyzed: controlsToAnalyze.length,
        pairs_analyzed: pairsAnalyzed,
      },
    });
  } catch (err) {
    console.error('❌ Analyze-all error:', err.message);
    const isRateLimit = err.status === 429
      || err.message?.includes('429')
      || err.message?.toLowerCase().includes('rate limit');

    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit
        ? 'OpenAI rate limit exceeded. Please wait a minute and try again.'
        : 'Analyze-all failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    tempFiles.forEach(f => cleanupFile(f));
  }
});

// ── POST /api/analyze/consolidate-control/:controlId — Consolidate multi-evidence analyses for ONE control ──
router.post('/consolidate-control/:controlId', async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);

  try {
    const { controlId } = req.params;
    const { projectId, evidenceIds } = req.body || {};

    console.log(`\n🔗 Starting PER-CONTROL CONSOLIDATION for control: ${controlId}`);

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required in the request body' });
    }

    // 1. Fetch the control
    const { data: control, error: controlError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .eq('id', controlId)
      .single();

    if (controlError || !control) {
      return res.status(404).json({ error: 'Control not found', details: controlError?.message });
    }

    // 2. Fetch analysis_results for this single control
    let query = supabase
      .from('analysis_results')
      .select('*, evidence:evidence_id (id, file_name), control:control_id (id, control_number, title)')
      .eq('control_id', controlId)
      .eq('project_id', projectId)
      .not('status', 'eq', 'error')
      .not('status', 'eq', 'pending')
      .order('analyzed_at', { ascending: false });

    // Optionally filter by specific evidence IDs
    if (evidenceIds && Array.isArray(evidenceIds) && evidenceIds.length > 0) {
      query = query.in('evidence_id', evidenceIds);
    }

    const { data: allResults, error: resultsError } = await query;

    if (resultsError) {
      return res.status(500).json({ error: 'Failed to fetch analysis results', details: resultsError.message });
    }

    if (!allResults || allResults.length === 0) {
      return res.status(400).json({
        error: 'No analyses found to consolidate for this control. Run evidence analysis first.',
      });
    }

    // 3. Deduplicate — keep latest per evidence_id (control_id is fixed)
    const seen = new Map();
    for (const r of allResults) {
      const key = r.evidence_id;
      if (!seen.has(key)) {
        seen.set(key, r);
      }
    }
    const dedupedResults = Array.from(seen.values());

    console.log(`📊 Found ${dedupedResults.length} unique document analyses to consolidate for control ${control.control_number}`);

    // 4. Build condensed input for GPT
    const condensed = dedupedResults.map(r => ({
      evidence_name: r.evidence?.file_name || 'Unknown document',
      status: r.status,
      compliance_percentage: r.compliance_percentage || 0,
      summary: r.summary || '',
      critical_gaps: r.findings?.critical_gaps || [],
      recommendations: r.recommendations || [],
    }));

    // 5. Call GPT per-control consolidation
    const consolidation = await consolidateControlAnalyses(condensed, {
      control_number: control.control_number,
      title: control.title,
      description: control.description,
    });

    // 6. Collect unique document names
    const uniqueDocs = new Set(condensed.map(c => c.evidence_name));

    console.log(`✅ Per-control consolidation complete — ${uniqueDocs.size} documents`);

    // 7. Save to consolidated_analyses (upsert — one per control+project)
    const upsertRecord = {
      parent_control_id: controlId,
      project_id: projectId,
      overall_status: consolidation.result.overall_status || 'partial',
      overall_compliance_percentage: consolidation.result.overall_compliance_percentage || 0,
      consolidated_data: consolidation.result,
      source_analyses_count: dedupedResults.length,
      controls_covered: 1,
      documents_referenced: uniqueDocs.size,
      model_used: consolidation.model || 'gpt-5.1',
      tokens_used: consolidation.usage || {},
      updated_at: new Date().toISOString(),
    };

    const { data: savedRecord, error: saveError } = await supabase
      .from('consolidated_analyses')
      .upsert(upsertRecord, { onConflict: 'parent_control_id,project_id' })
      .select()
      .single();

    if (saveError) {
      console.warn('⚠️ Failed to save per-control consolidation (returning result anyway):', saveError.message);
    } else {
      console.log(`💾 Saved per-control consolidation: ${savedRecord.id}`);
    }

    return res.json({
      success: true,
      data: {
        id: savedRecord?.id || null,
        consolidated: consolidation.result,
        source_analyses_count: dedupedResults.length,
        controls_covered: 1,
        documents_referenced: uniqueDocs.size,
        created_at: savedRecord?.created_at || null,
        updated_at: savedRecord?.updated_at || null,
        metadata: {
          model: consolidation.model || 'gpt-5.1',
          tokens_used: consolidation.usage || {},
          truncated: consolidation.truncated || false,
        },
      },
    });
  } catch (err) {
    console.error('❌ Per-control consolidation error:', err.message);

    const isRateLimit = err.status === 429
      || err.message?.includes('429')
      || err.message?.toLowerCase().includes('rate limit');

    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit
        ? 'OpenAI rate limit exceeded. Please wait a minute and try again.'
        : 'Per-control consolidation failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// ── GET /api/analyze/consolidate-control/:controlId — Retrieve saved per-control consolidation ──
router.get('/consolidate-control/:controlId', async (req, res) => {
  try {
    const { controlId } = req.params;
    const { projectId } = req.query;

    let query = supabase
      .from('consolidated_analyses')
      .select('*')
      .eq('parent_control_id', controlId);

    if (projectId) {
      query = query.eq('project_id', projectId);
    } else {
      query = query.is('project_id', null);
    }

    const { data: record, error } = await query.maybeSingle();

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch per-control consolidation', details: error.message });
    }

    if (!record) {
      return res.json({ success: true, data: null });
    }

    return res.json({
      success: true,
      data: {
        id: record.id,
        consolidated: record.consolidated_data,
        source_analyses_count: record.source_analyses_count,
        controls_covered: record.controls_covered,
        documents_referenced: record.documents_referenced,
        created_at: record.created_at,
        updated_at: record.updated_at,
        metadata: {
          model: record.model_used,
          tokens_used: record.tokens_used,
        },
      },
    });
  } catch (err) {
    console.error('❌ Fetch per-control consolidation error:', err.message);
    res.status(500).json({ error: 'Failed to fetch per-control consolidation' });
  }
});

// ── POST /api/analyze/consolidate/:parentControlId — Consolidate M×N analyses into one report ──
router.post('/consolidate/:parentControlId', async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);

  try {
    const { parentControlId } = req.params;
    const { controlIds: explicitIds, projectId } = req.body || {};

    console.log(`\n🔗 Starting CONSOLIDATION for control: ${parentControlId}`);

    // 1. Fetch the parent control
    const { data: parentControl, error: parentError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .eq('id', parentControlId)
      .single();

    if (parentError || !parentControl) {
      return res.status(404).json({ error: 'Control not found', details: parentError?.message });
    }

    // 2. Determine which controls to consolidate
    let controlIds = [];

    if (explicitIds && Array.isArray(explicitIds) && explicitIds.length > 0) {
      controlIds = explicitIds;
    } else {
      // Use same child-discovery as analyze-all
      const { childControls } = await findChildControls(parentControl);
      if (childControls && childControls.length > 0) {
        controlIds = childControls.map(c => c.id);
      } else if (parentControl.category) {
        const { data: categoryControls } = await supabase
          .from('controls')
          .select('id')
          .eq('framework_id', parentControl.framework_id)
          .eq('category', parentControl.category)
          .neq('id', parentControlId);
        if (categoryControls) {
          controlIds = categoryControls.map(c => c.id);
        }
      }
    }

    // Include the parent itself if no children found
    if (controlIds.length === 0) {
      controlIds = [parentControlId];
    }

    // 3. Fetch all analysis_results for these controls
    let query = supabase
      .from('analysis_results')
      .select('*, evidence:evidence_id (id, file_name), control:control_id (id, control_number, title)')
      .in('control_id', controlIds)
      .not('status', 'eq', 'error')
      .not('status', 'eq', 'pending')
      .order('analyzed_at', { ascending: false });

    if (projectId) {
      query = query.eq('project_id', projectId);
    }

    const { data: allResults, error: resultsError } = await query;

    if (resultsError) {
      return res.status(500).json({ error: 'Failed to fetch analysis results', details: resultsError.message });
    }

    if (!allResults || allResults.length === 0) {
      return res.status(400).json({
        error: 'No analyses found to consolidate. Run evidence analysis first.',
      });
    }

    // 4. Deduplicate — keep latest per (evidence_id, control_id) pair
    const seen = new Map();
    for (const r of allResults) {
      const key = `${r.evidence_id}::${r.control_id}`;
      if (!seen.has(key)) {
        seen.set(key, r);
      }
    }
    const dedupedResults = Array.from(seen.values());

    console.log(`📊 Found ${dedupedResults.length} unique analyses to consolidate`);

    // 5. Build condensed input for GPT
    const condensed = dedupedResults.map(r => ({
      control_number: r.control?.control_number || 'N/A',
      control_title: r.control?.title || 'Untitled',
      evidence_name: r.evidence?.file_name || 'Unknown document',
      status: r.status,
      compliance_percentage: r.compliance_percentage || 0,
      summary: r.summary || '',
      critical_gaps: r.findings?.critical_gaps || [],
      recommendations: r.recommendations || [],
    }));

    // 6. Call GPT consolidation
    const consolidation = await consolidateAnalyses(condensed, {
      control_number: parentControl.control_number,
      title: parentControl.title,
      description: parentControl.description,
    });

    // 7. Collect unique document names and control count
    const uniqueDocs = new Set(condensed.map(c => c.evidence_name));
    const uniqueControls = new Set(condensed.map(c => c.control_number));

    console.log(`✅ Consolidation complete — ${uniqueDocs.size} documents, ${uniqueControls.size} controls`);

    // 8. Save to consolidated_analyses (upsert — one per control+project)
    const upsertRecord = {
      parent_control_id: parentControlId,
      project_id: projectId || null,
      overall_status: consolidation.result.overall_status || 'partial',
      overall_compliance_percentage: consolidation.result.overall_compliance_percentage || 0,
      consolidated_data: consolidation.result,
      source_analyses_count: dedupedResults.length,
      controls_covered: uniqueControls.size,
      documents_referenced: uniqueDocs.size,
      model_used: consolidation.model || 'gpt-5.1',
      tokens_used: consolidation.usage || {},
      updated_at: new Date().toISOString(),
    };

    const { data: savedRecord, error: saveError } = await supabase
      .from('consolidated_analyses')
      .upsert(upsertRecord, { onConflict: 'parent_control_id,project_id' })
      .select()
      .single();

    if (saveError) {
      console.warn('⚠️ Failed to save consolidation (returning result anyway):', saveError.message);
    } else {
      console.log(`💾 Saved consolidation: ${savedRecord.id}`);
    }

    return res.json({
      success: true,
      data: {
        id: savedRecord?.id || null,
        consolidated: consolidation.result,
        source_analyses_count: dedupedResults.length,
        controls_covered: uniqueControls.size,
        documents_referenced: uniqueDocs.size,
        created_at: savedRecord?.created_at || null,
        updated_at: savedRecord?.updated_at || null,
        metadata: {
          model: consolidation.model || 'gpt-5.1',
          tokens_used: consolidation.usage || {},
          truncated: consolidation.truncated || false,
        },
      },
    });
  } catch (err) {
    console.error('❌ Consolidation error:', err.message);

    const isRateLimit = err.status === 429
      || err.message?.includes('429')
      || err.message?.toLowerCase().includes('rate limit');

    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit
        ? 'OpenAI rate limit exceeded. Please wait a minute and try again.'
        : 'Consolidation failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// ── GET /api/analyze/consolidate/:parentControlId — Retrieve saved consolidation ──
router.get('/consolidate/:parentControlId', async (req, res) => {
  try {
    const { parentControlId } = req.params;
    const { projectId } = req.query;

    let query = supabase
      .from('consolidated_analyses')
      .select('*')
      .eq('parent_control_id', parentControlId);

    if (projectId) {
      query = query.eq('project_id', projectId);
    } else {
      query = query.is('project_id', null);
    }

    const { data: record, error } = await query.maybeSingle();

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch consolidation', details: error.message });
    }

    if (!record) {
      return res.json({ success: true, data: null });
    }

    return res.json({
      success: true,
      data: {
        id: record.id,
        consolidated: record.consolidated_data,
        source_analyses_count: record.source_analyses_count,
        controls_covered: record.controls_covered,
        documents_referenced: record.documents_referenced,
        created_at: record.created_at,
        updated_at: record.updated_at,
        metadata: {
          model: record.model_used,
          tokens_used: record.tokens_used,
        },
      },
    });
  } catch (err) {
    console.error('❌ Fetch consolidation error:', err.message);
    res.status(500).json({ error: 'Failed to fetch consolidation' });
  }
});

module.exports = router;
