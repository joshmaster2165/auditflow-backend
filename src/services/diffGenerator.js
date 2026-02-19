function generateDiff(analysisResult, requirementText) {
  const { requirements_breakdown = [], recommendations = [], critical_gaps = [] } = analysisResult;

  const requirementCoverage = generateRequirementCoverage(requirements_breakdown);
  const sideBySide = generateSideBySide(requirements_breakdown);
  const timelineView = generateTimelineView(requirements_breakdown);
  const statistics = calculateStatistics(requirements_breakdown, analysisResult);

  const highlightRanges = generateHighlightRanges(requirements_breakdown);

  return {
    requirement_coverage: requirementCoverage,
    side_by_side: sideBySide,
    timeline_view: timelineView,
    statistics,
    recommendations,
    critical_gaps,
    highlight_ranges: highlightRanges,
    original_requirement: requirementText,
    generated_at: new Date().toISOString(),
  };
}

function generateRequirementCoverage(breakdown) {
  const statusGroups = {
    met: { label: 'Met Requirements', color: '#22c55e', items: [] },
    partial: { label: 'Partially Met', color: '#f59e0b', items: [] },
    missing: { label: 'Missing Requirements', color: '#ef4444', items: [] },
  };

  for (const req of breakdown) {
    const group = statusGroups[req.status] || statusGroups.missing;
    group.items.push({
      id: req.requirement_id,
      text: req.requirement_text,
      status: req.status,
      evidence: req.evidence_found,
      gap: req.gap_description,
      confidence: req.confidence,
      analysis_notes: req.analysis_notes || null,
      visual_description: req.visual_description || null,
    });
  }

  return Object.values(statusGroups).filter(g => g.items.length > 0);
}

function generateSideBySide(breakdown) {
  return breakdown.map(req => ({
    id: req.requirement_id,
    required: req.requirement_text,
    found: req.evidence_found || '— No evidence found —',
    status: req.status,
    gap: req.gap_description,
    confidence: req.confidence,
    analysis_notes: req.analysis_notes || null,
    visual_description: req.visual_description || null,
  }));
}

function generateTimelineView(breakdown) {
  return breakdown.map((req, index) => ({
    step: index + 1,
    id: req.requirement_id,
    description: req.requirement_text,
    status: req.status,
    checked: req.status === 'met',
    partial: req.status === 'partial',
    evidence_snippet: req.evidence_found
      ? req.evidence_found.substring(0, 150) + (req.evidence_found.length > 150 ? '...' : '')
      : null,
    gap: req.gap_description,
    analysis_notes: req.analysis_notes || null,
  }));
}

function calculateStatistics(breakdown, analysisResult) {
  const total = breakdown.length;
  const met = breakdown.filter(r => r.status === 'met').length;
  const partial = breakdown.filter(r => r.status === 'partial').length;
  const missing = breakdown.filter(r => r.status === 'missing').length;

  return {
    total_requirements: total,
    met_count: met,
    partial_count: partial,
    missing_count: missing,
    met_percentage: total > 0 ? Math.round((met / total) * 100) : 0,
    partial_percentage: total > 0 ? Math.round((partial / total) * 100) : 0,
    missing_percentage: total > 0 ? Math.round((missing / total) * 100) : 0,
    compliance_percentage: analysisResult.compliance_percentage || 0,
    confidence_score: analysisResult.confidence_score || 0,
    overall_status: analysisResult.status || 'pending',
  };
}

function generateHighlightRanges(breakdown) {
  return breakdown
    .filter(req => req.evidence_found && req.evidence_location && req.evidence_location.start_index >= 0)
    .map(req => ({
      startOffset: req.evidence_location.start_index,
      endOffset: req.evidence_location.end_index,
      requirementId: req.requirement_id,
      status: req.status,
      evidenceText: req.evidence_found,
      sectionContext: req.evidence_location.section_context || null,
    }));
}

function generateHtmlExport(diffData, metadata = {}) {
  const { statistics, requirement_coverage, side_by_side, recommendations, critical_gaps } = diffData;
  const { controlName, frameworkName, evidenceName, analyzedAt } = metadata;

  const statusColors = {
    met: '#22c55e',
    partial: '#f59e0b',
    missing: '#ef4444',
    compliant: '#22c55e',
    'non_compliant': '#ef4444',
  };

  const statusLabel = (status) => {
    const labels = { met: 'Met', partial: 'Partial', missing: 'Missing', compliant: 'Compliant', non_compliant: 'Non-Compliant' };
    return labels[status] || status;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AuditFlow Compliance Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; background: #f8f9fa; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    .header { background: #1a1a2e; color: white; padding: 2rem; border-radius: 12px; margin-bottom: 2rem; }
    .header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .header .meta { font-size: 0.875rem; opacity: 0.8; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: white; padding: 1.5rem; border-radius: 8px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card .value { font-size: 2rem; font-weight: 700; }
    .stat-card .label { font-size: 0.75rem; text-transform: uppercase; color: #6b7280; margin-top: 0.25rem; }
    .section { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .section h2 { font-size: 1.125rem; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #e5e7eb; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; color: white; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 0.875rem; }
    th { font-weight: 600; color: #6b7280; }
    .evidence-text { color: #059669; font-style: italic; }
    .gap-text { color: #dc2626; }
    .rec-list { list-style: none; }
    .rec-list li { padding: 0.5rem 0; border-bottom: 1px solid #f3f4f6; }
    .rec-list li:before { content: "→ "; color: #3b82f6; font-weight: 600; }
    .critical { background: #fef2f2; border-left: 4px solid #ef4444; padding: 0.75rem 1rem; margin-bottom: 0.5rem; border-radius: 0 4px 4px 0; }
    .footer { text-align: center; color: #9ca3af; font-size: 0.75rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Compliance Analysis Report</h1>
      <div class="meta">
        ${controlName ? `<div>Control: ${escapeHtml(controlName)}</div>` : ''}
        ${frameworkName ? `<div>Framework: ${escapeHtml(frameworkName)}</div>` : ''}
        ${evidenceName ? `<div>Evidence: ${escapeHtml(evidenceName)}</div>` : ''}
        <div>Generated: ${analyzedAt || new Date().toISOString()}</div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="value" style="color: ${statusColors[statistics.overall_status] || '#6b7280'}">${statistics.compliance_percentage}%</div>
        <div class="label">Compliance</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color: #22c55e">${statistics.met_count}</div>
        <div class="label">Met</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color: #f59e0b">${statistics.partial_count}</div>
        <div class="label">Partial</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color: #ef4444">${statistics.missing_count}</div>
        <div class="label">Missing</div>
      </div>
    </div>

    <div class="section">
      <h2>Requirement Coverage</h2>
      <table>
        <thead>
          <tr><th>ID</th><th>Requirement</th><th>Status</th><th>Confidence</th></tr>
        </thead>
        <tbody>
          ${(side_by_side || []).map(item => `
          <tr>
            <td>${escapeHtml(item.id)}</td>
            <td>${escapeHtml(item.required)}</td>
            <td><span class="badge" style="background: ${statusColors[item.status] || '#6b7280'}">${statusLabel(item.status)}</span></td>
            <td>${Math.round((item.confidence || 0) * 100)}%</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Evidence Comparison</h2>
      ${(side_by_side || []).map(item => `
      <div style="margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #e5e7eb;">
        <div style="font-weight: 600; margin-bottom: 0.5rem;">
          <span class="badge" style="background: ${statusColors[item.status] || '#6b7280'}">${statusLabel(item.status)}</span>
          ${escapeHtml(item.id)}: ${escapeHtml(item.required)}
        </div>
        <div class="evidence-text" style="margin-bottom: 0.25rem;">Evidence: ${escapeHtml(item.found)}</div>
        ${item.analysis_notes ? `<div style="color: #4b5563; font-size: 0.85rem; margin-bottom: 0.25rem; padding: 0.5rem; background: #f9fafb; border-radius: 4px;"><strong>Analysis:</strong> ${escapeHtml(item.analysis_notes)}</div>` : ''}
        ${item.visual_description ? `<div style="color: #6366f1; font-size: 0.85rem; margin-bottom: 0.25rem;"><strong>Visual Description:</strong> ${escapeHtml(item.visual_description)}</div>` : ''}
        ${item.gap ? `<div class="gap-text">Gap: ${escapeHtml(item.gap)}</div>` : ''}
      </div>`).join('')}
    </div>

    ${critical_gaps && critical_gaps.length > 0 ? `
    <div class="section">
      <h2>Critical Gaps</h2>
      ${critical_gaps.map(gap => `<div class="critical">${escapeHtml(gap)}</div>`).join('')}
    </div>` : ''}

    ${recommendations && recommendations.length > 0 ? `
    <div class="section">
      <h2>Recommendations</h2>
      <ul class="rec-list">
        ${recommendations.map(rec => `<li>${escapeHtml(rec)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <div class="footer">
      <p>Generated by AuditFlow AI Analysis Engine | ${new Date().toISOString()}</p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { generateDiff, generateHtmlExport };
