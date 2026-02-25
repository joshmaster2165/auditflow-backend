const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase } = require('../utils/supabase');
const { createJobStore } = require('../utils/analysisHelpers');
const {
  buildDefaultSections,
  mapScoreToScale,
  gatherReportData,
  runReportGeneration,
  generateSectionContent,
  generateReportHtml,
} = require('../services/reportGenerator');

// ── In-memory job store for async report generation ──
const jobs = createJobStore({ processingTimeoutMs: 20 * 60 * 1000 });

// ─────────────────────────────────────────────────────────────
// POST /api/report — Create draft report
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { projectId, frameworkId, title, reportType, scoringConfig, columnConfig, scope } = req.body;

    if (!projectId || !frameworkId || !title) {
      return res.status(400).json({ error: 'projectId, frameworkId, and title are required' });
    }

    const validTypes = ['audit_compliance', 'readiness_gap', 'maturity'];
    const type = validTypes.includes(reportType) ? reportType : 'readiness_gap';

    // Default scoring config based on report type
    const defaultScoring = type === 'maturity'
      ? { scale: '1-5', thresholds: { compliant: 4, partial: 2 }, custom_labels: { '5': 'Optimized', '4': 'Managed', '3': 'Defined', '2': 'Developing', '1': 'Initial' } }
      : { scale: 'percentage', thresholds: { compliant: 80, partial: 50 } };

    const sections = buildDefaultSections(type, scope || '');

    const record = {
      project_id: projectId,
      framework_id: frameworkId,
      title,
      report_type: type,
      status: 'draft',
      scoring_config: scoringConfig || defaultScoring,
      column_config: columnConfig || ['control_number', 'title', 'evidence', 'findings', 'gaps', 'recommendations', 'score'],
      sections,
      control_findings: [],
      evidence_manifest: [],
    };

    const { data: report, error } = await supabase
      .from('reports')
      .insert(record)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to create report', details: error.message });
    }

    console.log(`📋 Draft report created: ${report.id} (${type})`);

    return res.status(201).json({ success: true, data: report });
  } catch (err) {
    console.error('❌ Create report error:', err.message);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/report/:reportId/generate — Generate AI content + snapshot data
// ─────────────────────────────────────────────────────────────
router.post('/:reportId/generate', async (req, res) => {
  try {
    const { reportId } = req.params;

    const { data: report, error: fetchErr } = await supabase
      .from('reports')
      .select('*')
      .eq('id', reportId)
      .single();

    if (fetchErr || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    if (report.status === 'generating') {
      return res.status(409).json({ error: 'Report is already being generated' });
    }

    // Set status to generating
    await supabase
      .from('reports')
      .update({ status: 'generating', error: null, updated_at: new Date().toISOString() })
      .eq('id', reportId);

    // Create job for polling
    const jobId = crypto.randomUUID();
    jobs.set(jobId, {
      status: 'processing',
      startedAt: Date.now(),
      progress: 'Starting report generation...',
      sectionsTotal: 0,
      sectionsCompleted: 0,
      reportId,
    });

    // Fire and forget
    runReportGeneration(reportId, jobId, jobs);

    console.log(`🚀 Report generation started: ${reportId} (job: ${jobId})`);

    return res.status(202).json({
      success: true,
      reportId,
      jobId,
      status: 'generating',
    });
  } catch (err) {
    console.error('❌ Generate report error:', err.message);
    res.status(500).json({ error: 'Failed to start report generation' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/report/generate/status/:jobId — Poll generation progress
// ─────────────────────────────────────────────────────────────
router.get('/generate/status/:jobId', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }

  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);

  return res.json({
    status: job.status,
    progress: job.progress || '',
    sectionsCompleted: job.sectionsCompleted || 0,
    sectionsTotal: job.sectionsTotal || 0,
    elapsed,
    reportId: job.reportId,
    ...(job.status === 'failed' && { error: job.error }),
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/report/project/:projectId — List reports for a project
// ─────────────────────────────────────────────────────────────
router.get('/project/:projectId', async (req, res) => {
  try {
    const { data: reports, error } = await supabase
      .from('reports')
      .select('id, title, report_type, status, scoring_config, snapshot_at, created_at, updated_at')
      .eq('project_id', req.params.projectId)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch reports', details: error.message });
    }

    return res.json({ success: true, data: reports || [] });
  } catch (err) {
    console.error('❌ List reports error:', err.message);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/report/:reportId — Get full report
// ─────────────────────────────────────────────────────────────
router.get('/:reportId', async (req, res) => {
  try {
    const { data: report, error } = await supabase
      .from('reports')
      .select('*, framework:framework_id (id, name)')
      .eq('id', req.params.reportId)
      .single();

    if (error || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // Attach framework name at top level for convenience
    report.framework_name = report.framework?.name || '';

    return res.json({ success: true, data: report });
  } catch (err) {
    console.error('❌ Get report error:', err.message);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/report/:reportId/sections — Update sections
// ─────────────────────────────────────────────────────────────
router.put('/:reportId/sections', async (req, res) => {
  try {
    const { sections } = req.body;

    if (!Array.isArray(sections)) {
      return res.status(400).json({ error: 'sections must be an array' });
    }

    const { data, error } = await supabase
      .from('reports')
      .update({ sections, updated_at: new Date().toISOString() })
      .eq('id', req.params.reportId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update sections', details: error.message });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Update sections error:', err.message);
    res.status(500).json({ error: 'Failed to update sections' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/report/:reportId/config — Update scoring + column config
// ─────────────────────────────────────────────────────────────
router.put('/:reportId/config', async (req, res) => {
  try {
    const { scoringConfig, columnConfig } = req.body;

    // Fetch current report
    const { data: report, error: fetchErr } = await supabase
      .from('reports')
      .select('control_findings, scoring_config, column_config')
      .eq('id', req.params.reportId)
      .single();

    if (fetchErr || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const updates = { updated_at: new Date().toISOString() };

    if (columnConfig) {
      updates.column_config = columnConfig;
    }

    if (scoringConfig) {
      updates.scoring_config = scoringConfig;

      // Re-map all control finding scores to new scale (preserving overrides)
      if (report.control_findings && report.control_findings.length > 0) {
        updates.control_findings = report.control_findings.map(f => ({
          ...f,
          scoring_criteria: mapScoreToScale(f.compliance_score, scoringConfig),
        }));
      }
    }

    const { data, error } = await supabase
      .from('reports')
      .update(updates)
      .eq('id', req.params.reportId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update config', details: error.message });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Update config error:', err.message);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/report/:reportId/control-findings — Override scores/status/notes
// ─────────────────────────────────────────────────────────────
router.put('/:reportId/control-findings', async (req, res) => {
  try {
    const { overrides } = req.body;

    if (!Array.isArray(overrides)) {
      return res.status(400).json({ error: 'overrides must be an array of { control_id, score_override?, status_override?, user_notes? }' });
    }

    const { data: report, error: fetchErr } = await supabase
      .from('reports')
      .select('control_findings')
      .eq('id', req.params.reportId)
      .single();

    if (fetchErr || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const findings = report.control_findings || [];

    for (const override of overrides) {
      const idx = findings.findIndex(f => f.control_id === override.control_id);
      if (idx === -1) continue;

      if (override.score_override !== undefined) findings[idx].score_override = override.score_override;
      if (override.status_override !== undefined) findings[idx].status_override = override.status_override;
      if (override.user_notes !== undefined) findings[idx].user_notes = override.user_notes;
      if (override.findings !== undefined) findings[idx].findings = override.findings;
    }

    const { data, error } = await supabase
      .from('reports')
      .update({ control_findings: findings, updated_at: new Date().toISOString() })
      .eq('id', req.params.reportId)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update control findings', details: error.message });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Update control findings error:', err.message);
    res.status(500).json({ error: 'Failed to update control findings' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/report/:reportId/regenerate-section/:sectionId — Re-generate one AI section
// ─────────────────────────────────────────────────────────────
router.post('/:reportId/regenerate-section/:sectionId', async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);

  try {
    const { reportId, sectionId } = req.params;

    const { data: report, error: fetchErr } = await supabase
      .from('reports')
      .select('*')
      .eq('id', reportId)
      .single();

    if (fetchErr || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const section = report.sections.find(s => s.id === sectionId);
    if (!section) {
      return res.status(404).json({ error: 'Section not found' });
    }

    if (!section.ai_generated) {
      return res.status(400).json({ error: 'This section is not AI-generated and cannot be regenerated' });
    }

    // Use existing snapshot if available, otherwise re-gather
    const reportData = report.control_findings.length > 0
      ? { framework: { name: report.framework_name || '' }, controlFindings: report.control_findings, evidenceManifest: report.evidence_manifest, reportType: report.report_type }
      : await gatherReportData(report.project_id, report.framework_id);
    reportData.reportType = report.report_type;

    console.log(`🔄 Regenerating section: ${section.title} (${section.type})`);

    const { result } = await generateSectionContent(section.type, reportData);

    // Update the section content
    if (section.type === 'executive_summary') {
      section.content = result.executive_summary || '';
      section.metadata = { key_findings: result.key_findings || [], risk_level: result.risk_level || 'medium' };
    } else if (section.type === 'gap_analysis') {
      section.content = result.gap_analysis || '';
      section.metadata = { gap_categories: result.gap_categories || [], remediation_timeline: result.remediation_timeline || '' };
    } else if (section.type === 'recommendations') {
      section.content = result.recommendations_narrative || '';
      section.metadata = { prioritized_actions: result.prioritized_actions || [] };
    }

    const { error: updateErr } = await supabase
      .from('reports')
      .update({ sections: report.sections, updated_at: new Date().toISOString() })
      .eq('id', reportId);

    if (updateErr) {
      return res.status(500).json({ error: 'Failed to save regenerated section', details: updateErr.message });
    }

    return res.json({ success: true, section });
  } catch (err) {
    console.error('❌ Regenerate section error:', err.message);

    const isRateLimit = err.status === 429 || err.message?.includes('429');
    res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit ? 'OpenAI rate limit exceeded. Please wait and try again.' : 'Failed to regenerate section',
    });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/report/:reportId/export/html — Export styled HTML for PDF
// ─────────────────────────────────────────────────────────────
router.get('/:reportId/export/html', async (req, res) => {
  try {
    const { data: report, error } = await supabase
      .from('reports')
      .select('*, framework:framework_id (id, name)')
      .eq('id', req.params.reportId)
      .single();

    if (error || !report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    report.framework_name = report.framework?.name || '';

    const html = generateReportHtml(report);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.title.replace(/[^a-zA-Z0-9 ]/g, '')}.html"`);
    return res.send(html);
  } catch (err) {
    console.error('❌ Export HTML error:', err.message);
    res.status(500).json({ error: 'Failed to export report' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/report/:reportId — Delete report
// ─────────────────────────────────────────────────────────────
router.delete('/:reportId', async (req, res) => {
  try {
    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', req.params.reportId);

    if (error) {
      return res.status(500).json({ error: 'Failed to delete report', details: error.message });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete report error:', err.message);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

module.exports = router;
