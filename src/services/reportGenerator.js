const crypto = require('crypto');
const { supabase } = require('../utils/supabase');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  ShadingType,
  PageBreak,
} = require('docx');

// ─────────────────────────────────────────────────────────────
// Default Section Templates — All user-written narratives
// ─────────────────────────────────────────────────────────────

const DEFAULT_SECTIONS = {
  audit_compliance: [
    { type: 'introduction', title: 'Introduction', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scope', title: 'Scope', order: 1, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 2, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scoring_summary', title: 'Scoring Summary', order: 3, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Findings', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 5, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
  readiness_gap: [
    { type: 'introduction', title: 'Introduction', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scope', title: 'Scope', order: 1, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 2, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scoring_summary', title: 'Scoring Summary', order: 3, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Findings', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 5, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
  maturity: [
    { type: 'introduction', title: 'Introduction', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scope', title: 'Scope', order: 1, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 2, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scoring_summary', title: 'Maturity Scoring Summary', order: 3, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Maturity Assessment', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 5, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
};

// ─────────────────────────────────────────────────────────────
// Score Mapping
// ─────────────────────────────────────────────────────────────

function mapScoreToScale(rawPercentage, scoringConfig) {
  const { scale, thresholds, custom_labels } = scoringConfig || {};

  if (rawPercentage === null || rawPercentage === undefined) {
    return { scale: scale || 'percentage', raw_score: null, display_score: 'N/A' };
  }

  switch (scale) {
    case '1-5': {
      const mapped = Math.max(1, Math.min(5, Math.round(rawPercentage / 20)));
      const label = custom_labels?.[String(mapped)] || `${mapped}/5`;
      return { scale, raw_score: rawPercentage, display_score: label, numeric_score: mapped };
    }
    case 'pass_fail': {
      const threshold = thresholds?.compliant || 80;
      const passed = rawPercentage >= threshold;
      return { scale, raw_score: rawPercentage, display_score: passed ? 'Pass' : 'Fail', passed };
    }
    case 'custom': {
      const tiers = Object.entries(thresholds || {}).sort((a, b) => b[1] - a[1]);
      const tier = tiers.find(([, min]) => rawPercentage >= min);
      return { scale, raw_score: rawPercentage, display_score: tier ? tier[0] : 'Unrated' };
    }
    default: // percentage
      return { scale: 'percentage', raw_score: rawPercentage, display_score: `${rawPercentage}%` };
  }
}

// ─────────────────────────────────────────────────────────────
// Build Default Sections for a Report Type
// ─────────────────────────────────────────────────────────────

function buildDefaultSections(reportType, scopeText) {
  const template = DEFAULT_SECTIONS[reportType] || DEFAULT_SECTIONS.readiness_gap;
  return template.map(s => ({
    ...s,
    id: crypto.randomUUID(),
    content: s.type === 'scope' ? (scopeText || '') : s.content,
  }));
}

// ─────────────────────────────────────────────────────────────
// Data Gathering — Assemble data from existing tables
// Uses consolidated_analyses for concise findings/gaps/remediation
// ─────────────────────────────────────────────────────────────

async function gatherReportData(projectId, frameworkId) {
  console.log('📊 Gathering report data...');

  // 1. Fetch framework
  const { data: framework } = await supabase
    .from('frameworks')
    .select('id, name, created_at')
    .eq('id', frameworkId)
    .single();

  if (!framework) throw new Error('Framework not found');

  // 2. Fetch controls
  const { data: controls } = await supabase
    .from('controls')
    .select('*')
    .eq('framework_id', frameworkId)
    .order('sort_order', { ascending: true });

  if (!controls || controls.length === 0) throw new Error('No controls found for this framework');

  const controlIds = controls.map(c => c.id);

  // 3. Fetch analysis results (dedup latest per control+evidence pair)
  const { data: allResults } = await supabase
    .from('analysis_results')
    .select('*, evidence:evidence_id (id, file_name, file_type, created_at)')
    .in('control_id', controlIds)
    .eq('project_id', projectId)
    .not('status', 'eq', 'error')
    .not('status', 'eq', 'pending')
    .order('analyzed_at', { ascending: false });

  const seen = new Map();
  for (const r of (allResults || [])) {
    const key = `${r.control_id}::${r.evidence_id}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  const dedupedResults = Array.from(seen.values());

  // 4. Fetch consolidated analyses — the primary source for concise findings
  const { data: consolidations } = await supabase
    .from('consolidated_analyses')
    .select('*')
    .in('parent_control_id', controlIds)
    .eq('project_id', projectId);

  // 5. Build evidence manifest
  const evidenceMap = new Map();
  for (const r of dedupedResults) {
    if (!r.evidence) continue;
    const eid = r.evidence.id;
    if (!evidenceMap.has(eid)) {
      evidenceMap.set(eid, {
        evidence_id: eid,
        file_name: r.evidence.file_name,
        file_type: r.evidence.file_type,
        created_at: r.evidence.created_at,
        controls_analyzed: [],
        analysis_count: 0,
      });
    }
    const entry = evidenceMap.get(eid);
    const ctrlNum = controls.find(c => c.id === r.control_id)?.control_number;
    if (ctrlNum && !entry.controls_analyzed.includes(ctrlNum)) {
      entry.controls_analyzed.push(ctrlNum);
    }
    entry.analysis_count++;
  }

  // 6. Build control findings — prefer consolidated data for concise fields
  const controlFindings = controls.map(control => {
    const resultsForControl = dedupedResults.filter(r => r.control_id === control.id);
    const consolidation = (consolidations || []).find(c => c.parent_control_id === control.id);
    const conData = consolidation?.consolidated_data || null;

    // Status and compliance from consolidation first, then raw analysis
    let status = 'not_assessed';
    let complianceScore = null;

    if (consolidation) {
      status = consolidation.overall_status;
      complianceScore = consolidation.overall_compliance_percentage;
    } else if (resultsForControl.length > 0) {
      const validResults = resultsForControl.filter(r => r.status !== 'error');
      if (validResults.length > 0) {
        const hasNonCompliant = validResults.some(r => r.status === 'non_compliant');
        const hasPartial = validResults.some(r => r.status === 'partial');
        status = hasNonCompliant ? 'non_compliant' : hasPartial ? 'partial' : 'compliant';
        complianceScore = Math.round(
          validResults.reduce((s, r) => s + (parseFloat(r.compliance_percentage) || 0), 0) / validResults.length
        );
      }
    }

    // Evidence files
    const evidenceFiles = [];
    const seenEvidence = new Set();

    // From consolidated per_control_summary evidence_documents first
    if (conData?.per_control_summary) {
      for (const pcs of conData.per_control_summary) {
        for (const docName of (pcs.evidence_documents || [])) {
          if (!seenEvidence.has(docName)) {
            seenEvidence.add(docName);
            evidenceFiles.push({ name: docName });
          }
        }
      }
    }

    // Fill in from raw results for any missing
    for (const r of resultsForControl) {
      if (r.evidence && !seenEvidence.has(r.evidence.file_name)) {
        seenEvidence.add(r.evidence.file_name);
        evidenceFiles.push({
          evidence_id: r.evidence.id,
          name: r.evidence.file_name,
          type: r.evidence.file_type,
        });
      }
    }

    // Concise fields from consolidated data
    let conciseFinding = '';
    let conciseGap = '';
    let conciseRemediation = '';

    if (conData) {
      // Use consolidated_summary as the main finding
      conciseFinding = conData.consolidated_summary || '';

      // Per-control key_finding if available — append for richer context
      if (conData.per_control_summary && conData.per_control_summary.length > 0) {
        const keyFindings = conData.per_control_summary
          .map(pcs => pcs.key_finding)
          .filter(Boolean);
        if (keyFindings.length > 0 && !conciseFinding) {
          conciseFinding = keyFindings.join(' ');
        }
      }

      // Consolidated gaps
      const gaps = conData.consolidated_gaps || [];
      conciseGap = gaps.join('; ');

      // Consolidated recommendations
      const recs = conData.consolidated_recommendations || [];
      conciseRemediation = recs.join('; ');
    } else if (resultsForControl.length > 0) {
      // Fallback to raw analysis results
      const summaries = resultsForControl.map(r => r.summary).filter(Boolean);
      conciseFinding = summaries.join(' ').substring(0, 500);

      const allGaps = [...new Set(resultsForControl.flatMap(r => r.findings?.critical_gaps || []))];
      conciseGap = allGaps.join('; ');

      const allRecs = [...new Set(resultsForControl.flatMap(r => r.recommendations || []))];
      conciseRemediation = allRecs.join('; ');
    }

    return {
      control_id: control.id,
      control_number: control.control_number,
      title: control.title,
      category: control.category || control.group || 'Uncategorized',
      status,
      compliance_score: complianceScore,
      evidence_files: evidenceFiles,
      concise_finding: conciseFinding,
      concise_gap: conciseGap,
      concise_remediation: conciseRemediation,
      scoring_criteria: { scale: 'percentage', raw_score: complianceScore, display_score: complianceScore != null ? `${complianceScore}%` : 'N/A' },
      score_override: null,
      status_override: null,
      user_notes: null,
    };
  });

  console.log(`✅ Gathered: ${controls.length} controls, ${dedupedResults.length} analyses, ${(consolidations || []).length} consolidations, ${evidenceMap.size} evidence files`);

  return {
    framework,
    controls,
    controlFindings,
    evidenceManifest: Array.from(evidenceMap.values()),
  };
}

// ─────────────────────────────────────────────────────────────
// Synchronous Report Generation — Pure data assembly, no AI
// ─────────────────────────────────────────────────────────────

async function generateReport(reportId) {
  const startTime = Date.now();

  // 1. Fetch report
  const { data: report, error: fetchErr } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .single();

  if (fetchErr || !report) throw new Error('Report not found');

  // 2. Gather data from consolidated analyses + raw analysis fallback
  const reportData = await gatherReportData(report.project_id, report.framework_id);

  // 3. Apply scoring config to all findings
  const scoredFindings = reportData.controlFindings.map(f => ({
    ...f,
    scoring_criteria: mapScoreToScale(f.compliance_score, report.scoring_config),
  }));

  // 4. Update report — one save, done
  const durationMs = Date.now() - startTime;

  const { data: updated, error: updateErr } = await supabase
    .from('reports')
    .update({
      status: 'complete',
      control_findings: scoredFindings,
      evidence_manifest: reportData.evidenceManifest,
      snapshot_at: new Date().toISOString(),
      generation_metadata: {
        duration_ms: durationMs,
        controls_count: reportData.controlFindings.length,
        evidence_count: reportData.evidenceManifest.length,
        consolidations_used: reportData.controlFindings.filter(f => f.concise_finding).length,
      },
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', reportId)
    .select()
    .single();

  if (updateErr) throw new Error(`Failed to save report: ${updateErr.message}`);

  console.log(`✅ Report ${reportId} generated in ${durationMs}ms (${scoredFindings.length} controls)`);

  return updated;
}

// ─────────────────────────────────────────────────────────────
// HTML Export — Clean table-focused export for PDF conversion
// ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadge(status) {
  const colors = { compliant: '#22c55e', partial: '#f59e0b', non_compliant: '#ef4444', not_assessed: '#9ca3af' };
  const labels = { compliant: 'Compliant', partial: 'Partial', non_compliant: 'Non-Compliant', not_assessed: 'Not Assessed' };
  const color = colors[status] || '#9ca3af';
  const label = labels[status] || status;
  return `<span style="background:${color}; color:white; padding:2px 8px; border-radius:4px; font-size:0.75rem; font-weight:600;">${label}</span>`;
}

function reportTypeLabel(type) {
  return { audit_compliance: 'Audit Compliance Report', readiness_gap: 'Readiness & Gap Report', maturity: 'Maturity Assessment Report' }[type] || type;
}

function renderControlFindingsTable(findings, columnConfig) {
  const cols = columnConfig || ['control_number', 'title', 'evidence', 'findings', 'gaps', 'recommendations', 'score'];

  const colHeaders = {
    control_number: 'Control #',
    title: 'Title',
    evidence: 'Evidence',
    findings: 'Finding',
    gaps: 'Gap',
    recommendations: 'Remediation',
    score: 'Score',
    status: 'Status',
  };

  const headerRow = cols.map(c => `<th>${colHeaders[c] || c}</th>`).join('');

  const rows = findings.map(f => {
    const cells = cols.map(col => {
      switch (col) {
        case 'control_number': return `<td><strong>${escapeHtml(f.control_number)}</strong></td>`;
        case 'title': return `<td>${escapeHtml(f.title)}</td>`;
        case 'evidence': return `<td class="evidence-list">${f.evidence_files.map(e => escapeHtml(e.name)).join('<br>') || '—'}</td>`;
        case 'findings': return `<td>${escapeHtml(f.concise_finding || '—')}</td>`;
        case 'gaps': return `<td>${escapeHtml(f.concise_gap || '—')}</td>`;
        case 'recommendations': return `<td>${escapeHtml(f.concise_remediation || '—')}</td>`;
        case 'score': {
          const override = f.score_override != null;
          const display = override ? f.score_override : (f.scoring_criteria?.display_score || 'N/A');
          return `<td><strong>${escapeHtml(String(display))}</strong>${override ? ' <em>(override)</em>' : ''}</td>`;
        }
        case 'status': {
          const st = f.status_override || f.status;
          return `<td>${statusBadge(st)}</td>`;
        }
        default: return '<td>—</td>';
      }
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');

  return `
    <div class="section">
      <h2>Control Findings</h2>
      <table class="findings-table">
        <thead><tr>${headerRow}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderTestingConducted(evidenceManifest) {
  if (!evidenceManifest || evidenceManifest.length === 0) {
    return '<div class="section"><h2>Testing Conducted</h2><p>No evidence documents were analyzed.</p></div>';
  }

  const rows = evidenceManifest.map(e => {
    const controls = e.controls_analyzed.join(', ');
    return `<tr>
      <td>${escapeHtml(e.file_name)}</td>
      <td>${escapeHtml(e.file_type || 'Unknown')}</td>
      <td>${escapeHtml(controls)}</td>
      <td>${e.analysis_count}</td>
    </tr>`;
  }).join('\n');

  return `
    <div class="section">
      <h2>Testing Conducted</h2>
      <p>The following ${evidenceManifest.length} evidence document(s) were analyzed:</p>
      <table class="findings-table">
        <thead><tr><th>Document</th><th>Type</th><th>Controls Analyzed</th><th>Analyses</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function generateReportHtml(report) {
  const visibleSections = (report.sections || []).filter(s => s.visible).sort((a, b) => a.order - b.order);
  const findings = report.control_findings || [];
  const manifest = report.evidence_manifest || [];

  // Aggregate stats
  const total = findings.length;
  const assessed = findings.filter(f => f.status !== 'not_assessed');
  const compliant = findings.filter(f => (f.status_override || f.status) === 'compliant').length;
  const partial = findings.filter(f => (f.status_override || f.status) === 'partial').length;
  const nonCompliant = findings.filter(f => (f.status_override || f.status) === 'non_compliant').length;
  const avgScore = assessed.length > 0
    ? Math.round(assessed.reduce((s, f) => s + (f.score_override ?? f.compliance_score ?? 0), 0) / assessed.length)
    : 0;

  const sectionHtml = visibleSections.map(section => {
    if (section.type === 'control_findings') return renderControlFindingsTable(findings, report.column_config);
    if (section.type === 'testing_conducted') return renderTestingConducted(manifest);
    if (section.type === 'scoring_summary') {
      return `
        <div class="section">
          <h2>${escapeHtml(section.title)}</h2>
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">${avgScore}%</div><div class="stat-label">Overall Score</div></div>
            <div class="stat-card"><div class="stat-value" style="color:#22c55e">${compliant}</div><div class="stat-label">Compliant</div></div>
            <div class="stat-card"><div class="stat-value" style="color:#f59e0b">${partial}</div><div class="stat-label">Partial</div></div>
            <div class="stat-card"><div class="stat-value" style="color:#ef4444">${nonCompliant}</div><div class="stat-label">Non-Compliant</div></div>
            <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Controls</div></div>
          </div>
        </div>`;
    }
    // Text sections (introduction, scope, executive_summary)
    return `
      <div class="section">
        <h2>${escapeHtml(section.title)}</h2>
        <div class="section-content">${section.content ? section.content.replace(/\n/g, '<br>') : '<em>No content</em>'}</div>
      </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(report.title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; background: white; padding: 2rem; line-height: 1.6; }
    .container { max-width: 960px; margin: 0 auto; }
    .header { background: #1a1a2e; color: white; padding: 2.5rem; border-radius: 12px; margin-bottom: 2rem; }
    .header h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    .header .meta { font-size: 0.875rem; opacity: 0.8; }
    .header .meta div { margin-top: 0.25rem; }
    .section { margin-bottom: 2rem; page-break-inside: avoid; }
    .section h2 { font-size: 1.25rem; color: #1a1a2e; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem; margin-bottom: 1rem; }
    .section-content { font-size: 0.95rem; color: #374151; }
    .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1rem; margin-top: 1rem; }
    .stat-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; text-align: center; }
    .stat-value { font-size: 1.75rem; font-weight: 700; }
    .stat-label { font-size: 0.75rem; color: #6b7280; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .findings-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 1rem; }
    .findings-table th { background: #1a1a2e; color: white; font-weight: 600; padding: 0.6rem; text-align: left; border-bottom: 2px solid #d1d5db; white-space: nowrap; }
    .findings-table td { padding: 0.6rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    .findings-table tr:nth-child(even) { background: #f9fafb; }
    .evidence-list { font-size: 0.75rem; color: #6b7280; }
    .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; font-size: 0.75rem; color: #9ca3af; text-align: center; }
    @media print {
      body { padding: 0.5rem; }
      .container { max-width: 100%; }
      .header { border-radius: 0; }
      .section { page-break-inside: avoid; }
      .findings-table { font-size: 0.7rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${escapeHtml(report.title)}</h1>
      <div class="meta">
        <div>Framework: ${escapeHtml(report.framework_name || '')}</div>
        <div>Report Type: ${reportTypeLabel(report.report_type)}</div>
        <div>Generated: ${report.snapshot_at ? new Date(report.snapshot_at).toLocaleDateString() : 'Draft'}</div>
      </div>
    </div>
    ${sectionHtml}
    <div class="footer">
      <p>Generated by AuditFlow &bull; ${new Date().toLocaleDateString()}</p>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// DOCX Export — Proper Word document with tables
// ─────────────────────────────────────────────────────────────

const DARK_BLUE = '1a1a2e';
const TABLE_HEADER_BG = '1a1a2e';
const TABLE_ALT_BG = 'f3f4f6';
const STATUS_COLORS = { compliant: '22c55e', partial: 'f59e0b', non_compliant: 'ef4444', not_assessed: '9ca3af' };
const STATUS_LABELS = { compliant: 'Compliant', partial: 'Partial', non_compliant: 'Non-Compliant', not_assessed: 'Not Assessed' };

function docxHeaderCell(text) {
  return new TableCell({
    shading: { type: ShadingType.SOLID, color: TABLE_HEADER_BG },
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'ffffff', size: 18, font: 'Calibri' })] })],
  });
}

function docxCell(text, options = {}) {
  const runs = [new TextRun({ text: text || '—', size: 18, font: 'Calibri', ...options })];
  return new TableCell({
    shading: options.shading ? { type: ShadingType.SOLID, color: options.shading } : undefined,
    children: [new Paragraph({ children: runs })],
  });
}

function buildFindingsDocxTable(findings, columnConfig) {
  const cols = columnConfig || ['control_number', 'title', 'evidence', 'findings', 'gaps', 'recommendations', 'score'];

  const colHeaders = {
    control_number: 'Control #',
    title: 'Title',
    evidence: 'Evidence',
    findings: 'Finding',
    gaps: 'Gap',
    recommendations: 'Remediation',
    score: 'Score',
    status: 'Status',
  };

  // Header row
  const headerRow = new TableRow({
    tableHeader: true,
    children: cols.map(c => docxHeaderCell(colHeaders[c] || c)),
  });

  // Data rows
  const dataRows = findings.map((f, idx) => {
    const rowShading = idx % 2 === 1 ? TABLE_ALT_BG : undefined;

    const cells = cols.map(col => {
      switch (col) {
        case 'control_number': return docxCell(f.control_number, { bold: true, shading: rowShading });
        case 'title': return docxCell(f.title, { shading: rowShading });
        case 'evidence': return docxCell(f.evidence_files.map(e => e.name).join(', ') || '—', { size: 16, color: '6b7280', shading: rowShading });
        case 'findings': return docxCell(f.concise_finding || '—', { shading: rowShading });
        case 'gaps': return docxCell(f.concise_gap || '—', { shading: rowShading });
        case 'recommendations': return docxCell(f.concise_remediation || '—', { shading: rowShading });
        case 'score': {
          const display = f.score_override != null ? String(f.score_override) : (f.scoring_criteria?.display_score || 'N/A');
          return docxCell(display, { bold: true, shading: rowShading });
        }
        case 'status': {
          const st = f.status_override || f.status;
          const color = STATUS_COLORS[st] || '9ca3af';
          return docxCell(STATUS_LABELS[st] || st, { color, bold: true, shading: rowShading });
        }
        default: return docxCell('—', { shading: rowShading });
      }
    });

    return new TableRow({ children: cells });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function buildTestingDocxTable(evidenceManifest) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      docxHeaderCell('Document'),
      docxHeaderCell('Type'),
      docxHeaderCell('Controls Analyzed'),
      docxHeaderCell('Analyses'),
    ],
  });

  const dataRows = (evidenceManifest || []).map((e, idx) => {
    const shading = idx % 2 === 1 ? TABLE_ALT_BG : undefined;
    return new TableRow({
      children: [
        docxCell(e.file_name, { shading }),
        docxCell(e.file_type || 'Unknown', { shading }),
        docxCell(e.controls_analyzed.join(', '), { shading }),
        docxCell(String(e.analysis_count), { shading }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

async function generateReportDocx(report) {
  const visibleSections = (report.sections || []).filter(s => s.visible).sort((a, b) => a.order - b.order);
  const findings = report.control_findings || [];
  const manifest = report.evidence_manifest || [];

  // Aggregate stats
  const total = findings.length;
  const assessed = findings.filter(f => f.status !== 'not_assessed');
  const compliant = findings.filter(f => (f.status_override || f.status) === 'compliant').length;
  const partial = findings.filter(f => (f.status_override || f.status) === 'partial').length;
  const nonCompliant = findings.filter(f => (f.status_override || f.status) === 'non_compliant').length;
  const avgScore = assessed.length > 0
    ? Math.round(assessed.reduce((s, f) => s + (f.score_override ?? f.compliance_score ?? 0), 0) / assessed.length)
    : 0;

  const children = [];

  // Title
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: report.title, bold: true, size: 52, font: 'Calibri', color: DARK_BLUE })],
  }));

  // Meta
  children.push(new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ text: `Framework: ${report.framework_name || ''}  |  Type: ${reportTypeLabel(report.report_type)}  |  Generated: ${report.snapshot_at ? new Date(report.snapshot_at).toLocaleDateString() : 'Draft'}`, size: 20, color: '6b7280', font: 'Calibri' })],
  }));

  children.push(new Paragraph({ children: [] })); // spacer

  // Build sections
  for (const section of visibleSections) {
    if (section.type === 'scoring_summary') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: section.title, bold: true, size: 28, font: 'Calibri', color: DARK_BLUE })],
      }));
      children.push(new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: `Overall Score: ${avgScore}%`, bold: true, size: 22, font: 'Calibri' }),
          new TextRun({ text: `   |   Compliant: ${compliant}   |   Partial: ${partial}   |   Non-Compliant: ${nonCompliant}   |   Total: ${total}`, size: 20, font: 'Calibri', color: '374151' }),
        ],
      }));
    } else if (section.type === 'control_findings') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 100 },
        children: [new TextRun({ text: section.title, bold: true, size: 28, font: 'Calibri', color: DARK_BLUE })],
      }));
      if (findings.length > 0) {
        children.push(buildFindingsDocxTable(findings, report.column_config));
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: 'No control findings available.', italics: true, size: 20 })] }));
      }
    } else if (section.type === 'testing_conducted') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 100 },
        children: [new TextRun({ text: section.title, bold: true, size: 28, font: 'Calibri', color: DARK_BLUE })],
      }));
      if (manifest.length > 0) {
        children.push(new Paragraph({
          spacing: { after: 100 },
          children: [new TextRun({ text: `The following ${manifest.length} evidence document(s) were analyzed:`, size: 20, font: 'Calibri' })],
        }));
        children.push(buildTestingDocxTable(manifest));
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: 'No evidence documents were analyzed.', italics: true, size: 20 })] }));
      }
    } else {
      // Text sections (introduction, scope, executive_summary, custom)
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: section.title, bold: true, size: 28, font: 'Calibri', color: DARK_BLUE })],
      }));
      const content = section.content || '';
      if (content) {
        // Split by newlines to create paragraphs
        const lines = content.split('\n').filter(l => l.trim());
        for (const line of lines) {
          children.push(new Paragraph({
            spacing: { after: 100 },
            children: [new TextRun({ text: line, size: 22, font: 'Calibri', color: '374151' })],
          }));
        }
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: 'No content provided.', italics: true, size: 20, color: '9ca3af' })] }));
      }
    }

    children.push(new Paragraph({ children: [] })); // spacer between sections
  }

  // Footer
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 400 },
    children: [new TextRun({ text: `Generated by AuditFlow — ${new Date().toLocaleDateString()}`, size: 16, color: '9ca3af', font: 'Calibri' })],
  }));

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────

module.exports = {
  buildDefaultSections,
  mapScoreToScale,
  gatherReportData,
  generateReport,
  generateReportHtml,
  generateReportDocx,
};
