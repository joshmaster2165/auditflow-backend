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
  SectionType,
  VerticalAlign,
  PageOrientation,
  convertInchesToTwip,
  TableLayoutType,
  Header,
  Footer,
  PageNumber,
  HeightRule,
} = require('docx');

// ─────────────────────────────────────────────────────────────
// Default Section Templates — Enhanced with methodology, rating legend, grouping
// ─────────────────────────────────────────────────────────────

const DEFAULT_SECTIONS = {
  audit_compliance: [
    { type: 'introduction', title: 'Overview', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scope', title: 'Standards and Scope', order: 1, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'methodology', title: 'Methodology', order: 2, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 3, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'rating_legend', title: 'Classification of Audit Results', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'scoring_summary', title: 'Scoring Summary', order: 5, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Detailed Analysis', order: 6, visible: true, content: null, editable: false, ai_generated: false, metadata: { grouped: true } },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 7, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
  readiness_gap: [
    { type: 'introduction', title: 'Introduction', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scope', title: 'Scope', order: 1, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'methodology', title: 'Methodology', order: 2, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 3, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'rating_legend', title: 'Rating Definitions', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'scoring_summary', title: 'Scoring Summary', order: 5, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Findings', order: 6, visible: true, content: null, editable: false, ai_generated: false, metadata: { grouped: true } },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 7, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
  maturity: [
    { type: 'introduction', title: 'Introduction', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'scope', title: 'Scope', order: 1, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'methodology', title: 'Methodology', order: 2, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 3, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'rating_legend', title: 'Maturity Level Definitions', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'scoring_summary', title: 'Maturity Scoring Summary', order: 5, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Maturity Assessment', order: 6, visible: true, content: null, editable: false, ai_generated: false, metadata: { grouped: true } },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 7, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
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
      conciseFinding = conData.consolidated_summary || '';

      if (conData.per_control_summary && conData.per_control_summary.length > 0) {
        const keyFindings = conData.per_control_summary
          .map(pcs => pcs.key_finding)
          .filter(Boolean);
        if (keyFindings.length > 0 && !conciseFinding) {
          conciseFinding = keyFindings.join(' ');
        }
      }

      const gaps = conData.consolidated_gaps || [];
      conciseGap = gaps.join('; ');

      const recs = conData.consolidated_recommendations || [];
      conciseRemediation = recs.join('; ');
    } else if (resultsForControl.length > 0) {
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

  const { data: report, error: fetchErr } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .single();

  if (fetchErr || !report) throw new Error('Report not found');

  const reportData = await gatherReportData(report.project_id, report.framework_id);

  const scoredFindings = reportData.controlFindings.map(f => ({
    ...f,
    scoring_criteria: mapScoreToScale(f.compliance_score, report.scoring_config),
  }));

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

// ═══════════════════════════════════════════════════════════════
// HTML EXPORT
// ═══════════════════════════════════════════════════════════════

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

// ── Inner table renderer (shared by flat and grouped) ──

const COL_HEADERS = {
  control_number: 'Control #',
  title: 'Title',
  evidence: 'Evidence',
  findings: 'Finding',
  gaps: 'Gap',
  recommendations: 'Remediation',
  score: 'Score',
  status: 'Status',
};

function renderFindingsTableInner(findings, columnConfig) {
  const cols = columnConfig || ['control_number', 'title', 'evidence', 'findings', 'gaps', 'recommendations', 'score'];

  const headerRow = cols.map(c => `<th>${COL_HEADERS[c] || c}</th>`).join('');

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

  return `<table class="findings-table">
    <thead><tr>${headerRow}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Flat control findings table ──

function renderControlFindingsTable(title, findings, columnConfig) {
  if (!findings || findings.length === 0) {
    return `<div class="section"><h2>${escapeHtml(title)}</h2><p>No control findings available.</p></div>`;
  }
  return `<div class="section">
    <h2>${escapeHtml(title)}</h2>
    ${renderFindingsTableInner(findings, columnConfig)}
  </div>`;
}

// ── Grouped control findings (by category) ──

function renderGroupedControlFindingsHtml(title, findings, columnConfig) {
  if (!findings || findings.length === 0) {
    return `<div class="section"><h2>${escapeHtml(title)}</h2><p>No control findings available.</p></div>`;
  }

  // Group by category preserving order of first appearance
  const groups = new Map();
  for (const f of findings) {
    const cat = f.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(f);
  }

  let html = `<div class="section"><h2>${escapeHtml(title)}</h2>`;

  for (const [category, categoryFindings] of groups) {
    const compliantCount = categoryFindings.filter(f => (f.status_override || f.status) === 'compliant').length;
    html += `<h3 class="category-header">${escapeHtml(category)}</h3>`;
    html += `<p class="category-summary">${categoryFindings.length} control(s) — ${compliantCount} compliant</p>`;
    html += renderFindingsTableInner(categoryFindings, columnConfig);
  }

  html += `</div>`;
  return html;
}

// ── Rating legend ──

function renderRatingLegendHtml(title, scoringConfig) {
  const tierDescs = scoringConfig?.tier_descriptions;
  let entries = [];

  if (tierDescs && Object.keys(tierDescs).length > 0) {
    entries = Object.entries(tierDescs);
  } else {
    // Fallback: build from thresholds
    const thresholds = scoringConfig?.thresholds || {};
    for (const [key, value] of Object.entries(thresholds)) {
      entries.push([key, `Score threshold: ≥ ${value}%`]);
    }
  }

  if (entries.length === 0) {
    return `<div class="section"><h2>${escapeHtml(title)}</h2><p>No rating definitions configured.</p></div>`;
  }

  const rows = entries.map(([rating, description]) =>
    `<tr><td><strong>${escapeHtml(rating)}</strong></td><td>${escapeHtml(description)}</td></tr>`
  ).join('\n');

  return `<div class="section">
    <h2>${escapeHtml(title)}</h2>
    <table class="findings-table">
      <thead><tr><th style="width:25%">Classification</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Custom table (user-defined columns + rows) ──

function renderCustomTableHtml(section) {
  const { columns, rows } = section.metadata || {};

  if (!columns || !rows || rows.length === 0) {
    return `<div class="section"><h2>${escapeHtml(section.title)}</h2><p>No data provided.</p></div>`;
  }

  const headerRow = columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const dataRows = rows.map(row =>
    `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
  ).join('\n');

  return `<div class="section">
    <h2>${escapeHtml(section.title)}</h2>
    <table class="findings-table">
      <thead><tr>${headerRow}</tr></thead>
      <tbody>${dataRows}</tbody>
    </table>
  </div>`;
}

// ── Testing conducted ──

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

  return `<div class="section">
    <h2>Testing Conducted</h2>
    <p>The following ${evidenceManifest.length} evidence document(s) were analyzed:</p>
    <table class="findings-table">
      <thead><tr><th>Document</th><th>Type</th><th>Controls Analyzed</th><th>Analyses</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── Main HTML generator ──

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
    switch (section.type) {
      case 'control_findings':
        if (section.metadata?.grouped) {
          return renderGroupedControlFindingsHtml(section.title, findings, report.column_config);
        }
        return renderControlFindingsTable(section.title, findings, report.column_config);

      case 'testing_conducted':
        return renderTestingConducted(manifest);

      case 'scoring_summary':
        return `<div class="section">
          <h2>${escapeHtml(section.title)}</h2>
          <div class="stats-grid">
            <div class="stat-card"><div class="stat-value">${avgScore}%</div><div class="stat-label">Overall Score</div></div>
            <div class="stat-card"><div class="stat-value" style="color:#22c55e">${compliant}</div><div class="stat-label">Compliant</div></div>
            <div class="stat-card"><div class="stat-value" style="color:#f59e0b">${partial}</div><div class="stat-label">Partial</div></div>
            <div class="stat-card"><div class="stat-value" style="color:#ef4444">${nonCompliant}</div><div class="stat-label">Non-Compliant</div></div>
            <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Controls</div></div>
          </div>
        </div>`;

      case 'rating_legend':
        return renderRatingLegendHtml(section.title, report.scoring_config);

      case 'custom_table':
        return renderCustomTableHtml(section);

      default:
        // All narrative sections: introduction, scope, methodology, executive_summary, custom
        return `<div class="section">
          <h2>${escapeHtml(section.title)}</h2>
          <div class="section-content">${section.content ? section.content.replace(/\n/g, '<br>') : '<em>No content</em>'}</div>
        </div>`;
    }
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
    .category-header { font-size: 1.1rem; color: #1a1a2e; margin-top: 1.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3rem; }
    .category-summary { font-size: 0.85rem; color: #6b7280; margin-bottom: 0.5rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1rem; margin-top: 1rem; }
    .stat-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; text-align: center; }
    .stat-value { font-size: 1.75rem; font-weight: 700; }
    .stat-label { font-size: 0.75rem; color: #6b7280; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .findings-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 1rem; }
    .findings-table th { background: #1a1a2e; color: white; font-weight: 600; padding: 0.6rem; text-align: left; border-bottom: 2px solid #d1d5db; white-space: nowrap; }
    .findings-table td { padding: 0.6rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; word-break: break-word; }
    .findings-table tr:nth-child(even) { background: #f9fafb; }
    .evidence-list { font-size: 0.8rem; color: #6b7280; }
    .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; font-size: 0.75rem; color: #9ca3af; text-align: center; }
    .category-header { page-break-before: auto; }
    @media print {
      @page { size: landscape; margin: 0.5in; }
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

// ═══════════════════════════════════════════════════════════════
// DOCX EXPORT
// ═══════════════════════════════════════════════════════════════

const DARK_BLUE = '1a1a2e';
const TABLE_HEADER_BG = '1a1a2e';
const TABLE_ALT_BG = 'f3f4f6';
const STATUS_COLORS = { compliant: '22c55e', partial: 'f59e0b', non_compliant: 'ef4444', not_assessed: '9ca3af' };
const STATUS_LABELS = { compliant: 'Compliant', partial: 'Partial', non_compliant: 'Non-Compliant', not_assessed: 'Not Assessed' };

// Landscape page properties — 0.75" margins all around
const PAGE_LANDSCAPE = {
  page: {
    size: { orientation: PageOrientation.LANDSCAPE },
    margin: {
      top: convertInchesToTwip(0.75),
      bottom: convertInchesToTwip(0.75),
      left: convertInchesToTwip(0.75),
      right: convertInchesToTwip(0.75),
    },
  },
};

// Portrait page properties for cover page
const PAGE_PORTRAIT = {
  page: {
    margin: {
      top: convertInchesToTwip(1),
      bottom: convertInchesToTwip(1),
      left: convertInchesToTwip(1),
      right: convertInchesToTwip(1),
    },
  },
};

// Usable landscape width = 11" - 2×0.75" = 9.5" = 13680 twips
const LANDSCAPE_USABLE_WIDTH = convertInchesToTwip(9.5);

// Column width percentages for findings tables (must sum to 100)
const COLUMN_WIDTH_MAP = {
  control_number: 8,
  title: 14,
  evidence: 12,
  findings: 22,
  gaps: 16,
  recommendations: 16,
  score: 6,
  status: 6,
};

function docxHeaderCell(text, widthTwips) {
  return new TableCell({
    shading: { type: ShadingType.SOLID, color: TABLE_HEADER_BG },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    width: widthTwips ? { size: widthTwips, type: WidthType.DXA } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: 'ffffff', size: 18, font: 'Calibri' })] })],
  });
}

function docxCell(text, options = {}) {
  const runs = [new TextRun({ text: text || '—', size: 18, font: 'Calibri', ...options })];
  return new TableCell({
    shading: options.shading ? { type: ShadingType.SOLID, color: options.shading } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    width: options.widthTwips ? { size: options.widthTwips, type: WidthType.DXA } : undefined,
    children: [new Paragraph({ children: runs })],
  });
}

// ── Findings table (shared by flat and grouped) ──

function buildFindingsDocxTable(findings, columnConfig) {
  const cols = columnConfig || ['control_number', 'title', 'evidence', 'findings', 'gaps', 'recommendations', 'score'];

  // Calculate column widths in twips based on COLUMN_WIDTH_MAP
  const colWidths = cols.map(c => {
    const pct = COLUMN_WIDTH_MAP[c] || Math.floor(100 / cols.length);
    return Math.round((pct / 100) * LANDSCAPE_USABLE_WIDTH);
  });

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 400, rule: HeightRule.ATLEAST },
    children: cols.map((c, i) => docxHeaderCell(COL_HEADERS[c] || c, colWidths[i])),
  });

  const dataRows = findings.map((f, idx) => {
    const rowShading = idx % 2 === 1 ? TABLE_ALT_BG : undefined;

    const cells = cols.map((col, i) => {
      const w = colWidths[i];
      switch (col) {
        case 'control_number': return docxCell(f.control_number, { bold: true, shading: rowShading, widthTwips: w });
        case 'title': return docxCell(f.title, { shading: rowShading, widthTwips: w });
        case 'evidence': return docxCell(f.evidence_files.map(e => e.name).join(', ') || '—', { size: 16, color: '6b7280', shading: rowShading, widthTwips: w });
        case 'findings': return docxCell(f.concise_finding || '—', { shading: rowShading, widthTwips: w });
        case 'gaps': return docxCell(f.concise_gap || '—', { shading: rowShading, widthTwips: w });
        case 'recommendations': return docxCell(f.concise_remediation || '—', { shading: rowShading, widthTwips: w });
        case 'score': {
          const display = f.score_override != null ? String(f.score_override) : (f.scoring_criteria?.display_score || 'N/A');
          return docxCell(display, { bold: true, shading: rowShading, widthTwips: w });
        }
        case 'status': {
          const st = f.status_override || f.status;
          const color = STATUS_COLORS[st] || '9ca3af';
          return docxCell(STATUS_LABELS[st] || st, { color, bold: true, shading: rowShading, widthTwips: w });
        }
        default: return docxCell('—', { shading: rowShading, widthTwips: w });
      }
    });

    return new TableRow({ children: cells });
  });

  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  });
}

// ── Grouped findings (returns array of elements) ──

function buildGroupedFindingsDocxElements(findings, columnConfig) {
  const elements = [];

  const groups = new Map();
  for (const f of findings) {
    const cat = f.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(f);
  }

  for (const [category, categoryFindings] of groups) {
    // Category sub-header
    elements.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 100 },
      children: [new TextRun({ text: category, bold: true, size: 24, font: 'Calibri', color: DARK_BLUE })],
    }));

    // Category summary
    const compliantCount = categoryFindings.filter(f => (f.status_override || f.status) === 'compliant').length;
    elements.push(new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({
        text: `${categoryFindings.length} control(s) — ${compliantCount} compliant`,
        size: 18, font: 'Calibri', color: '6b7280',
      })],
    }));

    // Table for this category
    elements.push(buildFindingsDocxTable(categoryFindings, columnConfig));

    elements.push(new Paragraph({ children: [] })); // spacer
  }

  return elements;
}

// ── Rating legend DOCX table ──

function buildRatingLegendDocxTable(scoringConfig) {
  const tierDescs = scoringConfig?.tier_descriptions;
  let entries = [];

  if (tierDescs && Object.keys(tierDescs).length > 0) {
    entries = Object.entries(tierDescs);
  } else {
    const thresholds = scoringConfig?.thresholds || {};
    for (const [key, value] of Object.entries(thresholds)) {
      entries.push([key, `Score threshold: ≥ ${value}%`]);
    }
  }

  if (entries.length === 0) return null;

  const headerRow = new TableRow({
    tableHeader: true,
    children: [docxHeaderCell('Classification'), docxHeaderCell('Description')],
  });

  const dataRows = entries.map(([rating, description], idx) => {
    const shading = idx % 2 === 1 ? TABLE_ALT_BG : undefined;
    return new TableRow({
      children: [
        docxCell(rating, { bold: true, shading }),
        docxCell(description, { shading }),
      ],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

// ── Custom table DOCX ──

function buildCustomDocxTable(section) {
  const { columns, rows } = section.metadata || {};
  if (!columns || !rows || rows.length === 0) return null;

  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map(col => docxHeaderCell(col)),
  });

  const dataRows = rows.map((row, idx) => {
    const shading = idx % 2 === 1 ? TABLE_ALT_BG : undefined;
    return new TableRow({
      children: row.map(cell => docxCell(cell || '', { shading })),
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

// ── Testing conducted DOCX table ──

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

// ── Cover page section ──

function buildCoverPageSection(report) {
  return {
    properties: {
      type: SectionType.NEXT_PAGE,
      ...PAGE_PORTRAIT,
    },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 3600, after: 400 },
        children: [new TextRun({ text: report.title, bold: true, size: 72, font: 'Calibri', color: DARK_BLUE })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: report.framework_name || '', size: 32, font: 'Calibri', color: '374151' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: reportTypeLabel(report.report_type), size: 28, font: 'Calibri', color: '6b7280' })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({
          text: report.snapshot_at
            ? new Date(report.snapshot_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Draft',
          size: 24, font: 'Calibri', color: '9ca3af',
        })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 2400 },
        children: [new TextRun({ text: 'Generated by AuditFlow', size: 20, font: 'Calibri', color: '9ca3af' })],
      }),
    ],
  };
}

// ── DOCX section heading helper ──

function docxSectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 200, after: 100 },
    children: [new TextRun({ text, bold: true, size: 28, font: 'Calibri', color: DARK_BLUE })],
  });
}

// ── Main DOCX generator ──

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

  const contentChildren = [];

  // Build section content
  for (const section of visibleSections) {
    switch (section.type) {
      case 'scoring_summary':
        contentChildren.push(docxSectionHeading(section.title));
        contentChildren.push(new Paragraph({
          spacing: { after: 200 },
          children: [
            new TextRun({ text: `Overall Score: ${avgScore}%`, bold: true, size: 22, font: 'Calibri' }),
            new TextRun({ text: `   |   Compliant: ${compliant}   |   Partial: ${partial}   |   Non-Compliant: ${nonCompliant}   |   Total: ${total}`, size: 20, font: 'Calibri', color: '374151' }),
          ],
        }));
        break;

      case 'control_findings':
        contentChildren.push(docxSectionHeading(section.title));
        if (findings.length > 0) {
          if (section.metadata?.grouped) {
            contentChildren.push(...buildGroupedFindingsDocxElements(findings, report.column_config));
          } else {
            contentChildren.push(buildFindingsDocxTable(findings, report.column_config));
          }
        } else {
          contentChildren.push(new Paragraph({ children: [new TextRun({ text: 'No control findings available.', italics: true, size: 20 })] }));
        }
        break;

      case 'testing_conducted':
        contentChildren.push(docxSectionHeading(section.title));
        if (manifest.length > 0) {
          contentChildren.push(new Paragraph({
            spacing: { after: 100 },
            children: [new TextRun({ text: `The following ${manifest.length} evidence document(s) were analyzed:`, size: 20, font: 'Calibri' })],
          }));
          contentChildren.push(buildTestingDocxTable(manifest));
        } else {
          contentChildren.push(new Paragraph({ children: [new TextRun({ text: 'No evidence documents were analyzed.', italics: true, size: 20 })] }));
        }
        break;

      case 'rating_legend': {
        contentChildren.push(docxSectionHeading(section.title));
        const legendTable = buildRatingLegendDocxTable(report.scoring_config);
        if (legendTable) {
          contentChildren.push(legendTable);
        } else {
          contentChildren.push(new Paragraph({ children: [new TextRun({ text: 'No rating definitions configured.', italics: true, size: 20 })] }));
        }
        break;
      }

      case 'custom_table': {
        contentChildren.push(docxSectionHeading(section.title));
        const customTable = buildCustomDocxTable(section);
        if (customTable) {
          contentChildren.push(customTable);
        } else {
          contentChildren.push(new Paragraph({ children: [new TextRun({ text: 'No data provided.', italics: true, size: 20 })] }));
        }
        break;
      }

      default: {
        // All narrative sections: introduction, scope, methodology, executive_summary, custom
        contentChildren.push(docxSectionHeading(section.title));
        const content = section.content || '';
        if (content) {
          const lines = content.split('\n').filter(l => l.trim());
          for (const line of lines) {
            contentChildren.push(new Paragraph({
              spacing: { after: 100 },
              children: [new TextRun({ text: line, size: 22, font: 'Calibri', color: '374151' })],
            }));
          }
        } else {
          contentChildren.push(new Paragraph({ children: [new TextRun({ text: 'No content provided.', italics: true, size: 20, color: '9ca3af' })] }));
        }
        break;
      }
    }

    contentChildren.push(new Paragraph({ children: [] })); // spacer between sections
  }

  const doc = new Document({
    sections: [
      buildCoverPageSection(report),
      {
        properties: {
          ...PAGE_LANDSCAPE,
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({ text: 'Generated by AuditFlow  |  Page ', size: 16, color: '9ca3af', font: 'Calibri' }),
                new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '9ca3af', font: 'Calibri' }),
              ],
            })],
          }),
        },
        children: contentChildren,
      },
    ],
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
