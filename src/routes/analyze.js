const express = require('express');
const router = express.Router();
const { supabase, downloadFile, cleanupFile } = require('../utils/supabase');
const { parseDocument } = require('../services/documentParser');
const { analyzeEvidence } = require('../services/gpt');
const { generateDiff, generateHtmlExport } = require('../services/diffGenerator');

// POST /api/analyze/evidence/:evidenceId - Full analysis pipeline
router.post('/evidence/:evidenceId', async (req, res) => {
  let tempFilePath = null;

  try {
    const { evidenceId } = req.params;
    console.log(`\n🔍 Starting analysis for evidence: ${evidenceId}`);

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

    console.log(`📋 Evidence: ${evidence.file_name || evidence.name || 'unnamed'}`);

    // 2. Download file from storage
    const filePath = evidence.file_path || evidence.storage_path;
    if (!filePath) {
      return res.status(400).json({ error: 'Evidence record has no file path' });
    }

    tempFilePath = await downloadFile(filePath);

    // 3. Parse document text
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';
    const documentText = await parseDocument(tempFilePath, mimeType);

    // 4. Get requirement text
    const control = evidence.controls;
    const requirementText =
      control?.custom_fields?.requirement_text ||
      control?.description ||
      'No specific requirement text provided';

    const controlName = control?.name || control?.title || 'Unknown Control';

    console.log(`📐 Control: ${controlName}`);
    console.log(`📝 Requirement: ${requirementText.substring(0, 100)}...`);

    // 5. Send to GPT for analysis
    const gptResult = await analyzeEvidence(documentText, requirementText, controlName);

    // 6. Generate diff visualization
    const diffData = generateDiff(gptResult.analysis, requirementText);

    // 7. Store results in analysis_results table
    const analysisRecord = {
      evidence_id: evidenceId,
      control_id: control?.id || null,
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
        control: { id: control?.id, name: controlName },
        evidence: { id: evidenceId, name: evidence.file_name || evidence.name },
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
        id: control?.id,
        name: controlName,
        framework: control?.frameworks?.name || null,
      },
      evidence: {
        id: evidenceId,
        name: evidence.file_name || evidence.name,
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

// GET /api/analyze/results/:evidenceId - Fetch latest analysis for evidence
router.get('/results/:evidenceId', async (req, res) => {
  try {
    const { evidenceId } = req.params;

    const { data, error } = await supabase
      .from('analysis_results')
      .select(`
        *,
        evidence:evidence_id (id, file_name, name, file_type, created_at),
        controls:control_id (id, name, title, description)
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
        evidence:evidence_id (id, file_name, name),
        controls:control_id (id, name, title)
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
        evidence:evidence_id (id, file_name, name),
        controls:control_id (id, name, title, frameworks:framework_id (name))
      `)
      .eq('id', analysisId)
      .single();

    if (error || !analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    const html = generateHtmlExport(analysis.diff_data, {
      controlName: analysis.controls?.name || analysis.controls?.title,
      frameworkName: analysis.controls?.frameworks?.name,
      evidenceName: analysis.evidence?.file_name || analysis.evidence?.name,
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

module.exports = router;
