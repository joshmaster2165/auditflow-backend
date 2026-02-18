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
    const controlCategory = control.category || '';
    const frameworkName = control.frameworks?.name || '';

    // Description is the PRIMARY requirement — it contains the real compliance language
    let requirementText = control.description || control.custom_fields?.requirement_text || null;

    // If no description, build a structured requirement from all available fields
    if (!requirementText && control.title) {
      console.warn(`⚠️ Control "${controlName}" has no description — building requirement from metadata`);
      const parts = [];
      if (frameworkName) parts.push(`Framework: ${frameworkName}`);
      if (controlNumber) parts.push(`Control: ${controlNumber}`);
      parts.push(`Requirement: ${control.title}`);
      if (controlCategory) parts.push(`Domain: ${controlCategory}`);

      requirementText = `Evaluate whether the evidence demonstrates compliance with the following requirement.\n\n${parts.join('\n')}\n\nAnalyze the evidence document for any content that addresses "${control.title}". Assess whether organizational policies, procedures, or controls described in the evidence satisfy this requirement.`;
    } else if (requirementText) {
      // Even when we have description, enrich it with framework/control context
      const contextParts = [];
      if (frameworkName) contextParts.push(`Framework: ${frameworkName}`);
      if (controlNumber) contextParts.push(`Control: ${controlNumber}`);
      if (controlName) contextParts.push(`Title: ${controlName}`);
      if (controlCategory) contextParts.push(`Domain: ${controlCategory}`);

      if (contextParts.length > 0) {
        requirementText = `${contextParts.join(' | ')}\n\nRequirement:\n${requirementText}`;
      }
    }

    requirementText = requirementText || 'No specific requirement text provided';

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

module.exports = router;
