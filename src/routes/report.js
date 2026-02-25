const express = require('express');
const router = express.Router();
const { supabase } = require('../utils/supabase');
const {
  buildDefaultSections,
  mapScoreToScale,
  gatherReportData,
  generateReport,
  generateReportHtml,
  generateReportDocx,
} = require('../services/reportGenerator');

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
// POST /api/report/:reportId/generate — Synchronous data assembly
// Pulls consolidated analyses + raw analysis fallback, no AI calls
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

    // Set status to generating (brief — will be overwritten quickly)
    await supabase
      .from('reports')
      .update({ status: 'generating', error: null, updated_at: new Date().toISOString() })
      .eq('id', reportId);

    // Synchronous generation — no AI, just data assembly
    const updatedReport = await generateReport(reportId);

    console.log(`✅ Report generated: ${reportId}`);

    return res.json({
      success: true,
      data: updatedReport,
    });
  } catch (err) {
    console.error('❌ Generate report error:', err.message);

    // Mark report as error
    try {
      await supabase
        .from('reports')
        .update({ status: 'error', error: err.message, updated_at: new Date().toISOString() })
        .eq('id', req.params.reportId);
    } catch (_) { /* ignore cleanup error */ }

    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  }
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
      if (override.concise_finding !== undefined) findings[idx].concise_finding = override.concise_finding;
      if (override.concise_gap !== undefined) findings[idx].concise_gap = override.concise_gap;
      if (override.concise_remediation !== undefined) findings[idx].concise_remediation = override.concise_remediation;
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
// GET /api/report/:reportId/export/docx — Export Word document
// ─────────────────────────────────────────────────────────────
router.get('/:reportId/export/docx', async (req, res) => {
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

    const buffer = await generateReportDocx(report);

    const filename = report.title.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    console.error('❌ Export DOCX error:', err.message);
    res.status(500).json({ error: 'Failed to export report as DOCX' });
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
