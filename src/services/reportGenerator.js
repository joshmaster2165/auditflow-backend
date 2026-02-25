const OpenAI = require('openai');
const crypto = require('crypto');
const { supabase } = require('../utils/supabase');

// ── OpenAI Client & Configuration ──
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GPT_MODEL = 'gpt-5.1';
const GPT_MAX_TOKENS = 16384;
const GPT_TEMPERATURE = 0.2;

// ── OpenAI Error Handler ──
function handleOpenAIError(err) {
  if (err.status === 429) throw new Error('OpenAI rate limit exceeded. Please try again later.');
  if (err.status === 401) throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
  throw err;
}

// ─────────────────────────────────────────────────────────────
// Default Section Templates by Report Type
// ─────────────────────────────────────────────────────────────

const DEFAULT_SECTIONS = {
  audit_compliance: [
    { type: 'scope', title: 'Scope', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'methodology', title: 'Methodology', order: 1, visible: true, content: 'This assessment was conducted using AuditFlow\'s AI-powered compliance analysis engine. Evidence documents were analyzed against individual control requirements using natural language processing. Each control was decomposed into testable sub-requirements and evaluated independently against the provided evidence. Findings were then consolidated to produce this report.', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 2, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'scoring_summary', title: 'Scoring Summary', order: 3, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Findings', order: 4, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'gap_analysis', title: 'Gap Analysis', order: 5, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'recommendations', title: 'Recommendations', order: 6, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 7, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
  readiness_gap: [
    { type: 'scope', title: 'Scope', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 1, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'scoring_summary', title: 'Scoring Summary', order: 2, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Findings', order: 3, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'gap_analysis', title: 'Gap Analysis', order: 4, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'recommendations', title: 'Recommendations', order: 5, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 6, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
  ],
  maturity: [
    { type: 'scope', title: 'Scope', order: 0, visible: true, content: '', editable: true, ai_generated: false, metadata: {} },
    { type: 'executive_summary', title: 'Executive Summary', order: 1, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'scoring_summary', title: 'Maturity Scoring Summary', order: 2, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'control_findings', title: 'Control Maturity Assessment', order: 3, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
    { type: 'gap_analysis', title: 'Gap Analysis', order: 4, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'recommendations', title: 'Recommendations', order: 5, visible: true, content: '', editable: true, ai_generated: true, metadata: {} },
    { type: 'testing_conducted', title: 'Testing Conducted', order: 6, visible: true, content: null, editable: false, ai_generated: false, metadata: {} },
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

  // 4. Fetch consolidated analyses
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

  // 6. Build control findings
  const controlFindings = controls.map(control => {
    const resultsForControl = dedupedResults.filter(r => r.control_id === control.id);
    const consolidation = (consolidations || []).find(c => c.parent_control_id === control.id);

    // Aggregate status
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

    // Confidence
    const validForConf = resultsForControl.filter(r => r.confidence_score != null);
    const confidenceScore = validForConf.length > 0
      ? parseFloat((validForConf.reduce((s, r) => s + parseFloat(r.confidence_score), 0) / validForConf.length).toFixed(2))
      : null;

    // Evidence files
    const evidenceFiles = [];
    const seenEvidence = new Set();
    for (const r of resultsForControl) {
      if (r.evidence && !seenEvidence.has(r.evidence.id)) {
        seenEvidence.add(r.evidence.id);
        evidenceFiles.push({
          evidence_id: r.evidence.id,
          name: r.evidence.file_name,
          type: r.evidence.file_type,
        });
      }
    }

    // Merge gaps, recommendations, findings, breakdowns
    const allGaps = [...new Set(resultsForControl.flatMap(r => r.findings?.critical_gaps || []))];
    const allRecs = [...new Set(resultsForControl.flatMap(r => r.recommendations || []))];
    const summaries = resultsForControl.map(r => r.summary).filter(Boolean);
    const allBreakdown = resultsForControl.flatMap(r =>
      (r.findings?.requirements_breakdown || []).map(rb => ({
        ...rb,
        evidence_source: r.evidence?.file_name || 'Unknown',
      }))
    );

    return {
      control_id: control.id,
      control_number: control.control_number,
      title: control.title,
      category: control.category || control.group || 'Uncategorized',
      status,
      compliance_score: complianceScore,
      confidence_score: confidenceScore,
      evidence_files: evidenceFiles,
      findings: summaries.join(' '),
      gaps: allGaps,
      recommendations: allRecs,
      requirements_breakdown: allBreakdown,
      scoring_criteria: { scale: 'percentage', raw_score: complianceScore, display_score: complianceScore != null ? `${complianceScore}%` : 'N/A' },
      score_override: null,
      status_override: null,
      user_notes: null,
    };
  });

  console.log(`✅ Gathered: ${controls.length} controls, ${dedupedResults.length} analyses, ${evidenceMap.size} evidence files`);

  return {
    framework,
    controls,
    controlFindings,
    evidenceManifest: Array.from(evidenceMap.values()),
  };
}

// ─────────────────────────────────────────────────────────────
// GPT Report Section Generation
// ─────────────────────────────────────────────────────────────

const REPORT_SYSTEM_PROMPT = `You are a senior compliance auditor and technical writer producing formal audit reports.
Your writing must be:
- Professional and suitable for executive and board-level audiences
- Specific and evidence-based — reference actual control findings and document names
- Structured with clear conclusions and action items
- Honest about gaps while maintaining a constructive tone
- Concise but thorough

You must respond with valid JSON only.`;

function buildExecSummaryPrompt(reportData) {
  const { framework, controlFindings, evidenceManifest, reportType } = reportData;

  const total = controlFindings.length;
  const compliant = controlFindings.filter(f => f.status === 'compliant').length;
  const partial = controlFindings.filter(f => f.status === 'partial').length;
  const nonCompliant = controlFindings.filter(f => f.status === 'non_compliant').length;
  const notAssessed = controlFindings.filter(f => f.status === 'not_assessed').length;
  const assessed = controlFindings.filter(f => f.compliance_score != null);
  const avgCompliance = assessed.length > 0
    ? Math.round(assessed.reduce((s, f) => s + f.compliance_score, 0) / assessed.length)
    : 0;

  // Category breakdown
  const catMap = new Map();
  for (const f of controlFindings) {
    const cat = f.category;
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(f);
  }

  const catSummaries = Array.from(catMap.entries()).map(([cat, findings]) => {
    const catAssessed = findings.filter(f => f.compliance_score != null);
    const catAvg = catAssessed.length > 0
      ? Math.round(catAssessed.reduce((s, f) => s + f.compliance_score, 0) / catAssessed.length)
      : 0;
    const topGaps = findings.flatMap(f => f.gaps).slice(0, 3);
    return `- ${cat}: ${findings.length} controls, ${catAvg}% avg compliance. Key gaps: ${topGaps.join('; ') || 'None identified'}`;
  }).join('\n');

  const topGaps = controlFindings.flatMap(f => f.gaps).slice(0, 10);

  const reportTypeLabel = { audit_compliance: 'Audit Compliance', readiness_gap: 'Readiness & Gap', maturity: 'Maturity Assessment' }[reportType] || reportType;

  return `Generate an executive summary for a ${reportTypeLabel} report.

## Framework: ${framework.name}
## Evidence Documents Reviewed: ${evidenceManifest.length}
## Assessment Scope: ${total} controls

## Results:
- Compliant: ${compliant}/${total}
- Partially Compliant: ${partial}/${total}
- Non-Compliant: ${nonCompliant}/${total}
- Not Assessed: ${notAssessed}/${total}
- Average Compliance: ${avgCompliance}%

## Category Breakdown:
${catSummaries}

## Top Gaps:
${topGaps.map((g, i) => `${i + 1}. ${g}`).join('\n') || 'None identified'}

## Return JSON:
{
  "executive_summary": "<3-5 paragraph executive summary referencing key documents and findings>",
  "key_findings": ["<finding 1>", "<finding 2>", "..."],
  "risk_level": "low | medium | high | critical"
}`;
}

function buildGapAnalysisPrompt(reportData) {
  const { framework, controlFindings } = reportData;

  const withGaps = controlFindings.filter(f => f.gaps.length > 0 || (f.status !== 'compliant' && f.status !== 'not_assessed'));

  const gapDetails = withGaps.slice(0, 50).map(f =>
    `### ${f.control_number} — ${f.title} [${f.status}, ${f.compliance_score ?? 'N/A'}%]
Gaps: ${f.gaps.join('; ') || 'Partially met'}
Evidence: ${f.evidence_files.map(e => e.name).join(', ') || 'None'}`
  ).join('\n\n');

  return `Generate a detailed gap analysis for the ${framework.name} assessment.

## Controls with Gaps (${withGaps.length} of ${controlFindings.length} total):

${gapDetails}

## Return JSON:
{
  "gap_analysis": "<structured gap analysis narrative organized by category/domain, 4-8 paragraphs, referencing specific controls and documents>",
  "gap_categories": [
    { "category": "<domain>", "severity": "critical|high|medium|low", "gap_count": 0, "summary": "<1-2 sentences>", "remediation_effort": "high|medium|low" }
  ],
  "remediation_timeline": "<suggested phased approach, 2-3 sentences>"
}`;
}

function buildRecommendationsPrompt(reportData) {
  const { framework, controlFindings } = reportData;

  const allRecs = controlFindings.flatMap(f =>
    f.recommendations.map(r => ({ rec: r, control: f.control_number, status: f.status, score: f.compliance_score }))
  );

  const recDetails = allRecs.slice(0, 60).map((r, i) =>
    `${i + 1}. [${r.control}] (${r.status}, ${r.score ?? 'N/A'}%): ${r.rec}`
  ).join('\n');

  return `Synthesize and prioritize recommendations for the ${framework.name} assessment.

## Individual Recommendations (${allRecs.length} total):
${recDetails}

## Return JSON:
{
  "recommendations_narrative": "<synthesized recommendations organized by priority, 3-6 paragraphs>",
  "prioritized_actions": [
    { "priority": 1, "action": "<specific action>", "affected_controls": ["<control numbers>"], "effort": "low|medium|high", "impact": "low|medium|high", "timeline": "<suggested timeline>" }
  ]
}`;
}

async function generateSectionContent(sectionType, reportData) {
  const promptBuilders = {
    executive_summary: buildExecSummaryPrompt,
    gap_analysis: buildGapAnalysisPrompt,
    recommendations: buildRecommendationsPrompt,
  };

  const builder = promptBuilders[sectionType];
  if (!builder) throw new Error(`No GPT prompt builder for section type: ${sectionType}`);

  const userPrompt = builder(reportData);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: REPORT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: GPT_TEMPERATURE,
      max_completion_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];
    let result;
    try {
      result = JSON.parse(choice.message.content);
    } catch {
      throw new Error('GPT returned invalid JSON during report section generation');
    }

    return {
      result,
      usage: response.usage,
      model: response.model,
    };
  } catch (err) {
    handleOpenAIError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Main Orchestrator — Fire-and-forget report generation
// ─────────────────────────────────────────────────────────────

async function runReportGeneration(reportId, jobId, jobs) {
  const startTime = Date.now();
  const job = jobs.get(jobId);

  try {
    // 1. Fetch report
    const { data: report, error: fetchErr } = await supabase
      .from('reports')
      .select('*')
      .eq('id', reportId)
      .single();

    if (fetchErr || !report) throw new Error('Report not found');

    if (job) {
      job.progress = 'Gathering analysis data...';
      job.sectionsTotal = 0;
      job.sectionsCompleted = 0;
    }

    // 2. Gather data
    const reportData = await gatherReportData(report.project_id, report.framework_id);
    reportData.reportType = report.report_type;

    // 3. Figure out which AI sections to generate
    const sections = report.sections || [];
    const aiSections = sections.filter(s => s.visible && s.ai_generated && s.type !== 'custom');
    if (job) job.sectionsTotal = aiSections.length;

    console.log(`🤖 Generating ${aiSections.length} AI sections for report ${reportId}...`);

    // 4. Generate AI sections sequentially
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (const section of aiSections) {
      if (job) job.progress = `Generating ${section.title}...`;
      console.log(`  📝 Generating: ${section.title} (${section.type})`);

      try {
        const { result, usage } = await generateSectionContent(section.type, reportData);

        // Map result to section content
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

        if (usage) {
          totalUsage.prompt_tokens += usage.prompt_tokens || 0;
          totalUsage.completion_tokens += usage.completion_tokens || 0;
          totalUsage.total_tokens += usage.total_tokens || 0;
        }
      } catch (err) {
        console.error(`  ⚠️ Failed to generate ${section.title}:`, err.message);
        section.content = `[Generation failed: ${err.message}. You can edit this section manually or try regenerating.]`;
      }

      if (job) job.sectionsCompleted = (job.sectionsCompleted || 0) + 1;
    }

    // 5. Apply scoring config
    const scoredFindings = reportData.controlFindings.map(f => ({
      ...f,
      scoring_criteria: mapScoreToScale(f.compliance_score, report.scoring_config),
    }));

    // 6. Update report
    const durationMs = Date.now() - startTime;

    await supabase
      .from('reports')
      .update({
        status: 'complete',
        sections,
        control_findings: scoredFindings,
        evidence_manifest: reportData.evidenceManifest,
        snapshot_at: new Date().toISOString(),
        generation_metadata: {
          model: GPT_MODEL,
          tokens_used: totalUsage,
          duration_ms: durationMs,
          controls_count: reportData.controlFindings.length,
          evidence_count: reportData.evidenceManifest.length,
          ai_sections_generated: aiSections.length,
        },
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', reportId);

    console.log(`✅ Report ${reportId} generated in ${Math.round(durationMs / 1000)}s`);

    if (job) {
      job.status = 'completed';
      job.completedAt = Date.now();
      job.reportId = reportId;
    }
  } catch (err) {
    console.error(`❌ Report generation failed:`, err.message);

    await supabase
      .from('reports')
      .update({ status: 'error', error: err.message, updated_at: new Date().toISOString() })
      .eq('id', reportId);

    if (job) {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = err.message;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// HTML Export — Self-contained styled HTML for PDF conversion
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
    control_number: 'Control #', title: 'Title', evidence: 'Evidence', findings: 'Findings',
    gaps: 'Gaps', recommendations: 'Recommendations', score: 'Score', confidence: 'Confidence',
    status: 'Status', requirements_breakdown: 'Requirements',
  };

  const headerRow = cols.map(c => `<th>${colHeaders[c] || c}</th>`).join('');

  const rows = findings.map(f => {
    const cells = cols.map(col => {
      switch (col) {
        case 'control_number': return `<td><strong>${escapeHtml(f.control_number)}</strong></td>`;
        case 'title': return `<td>${escapeHtml(f.title)}</td>`;
        case 'evidence': return `<td class="evidence-list">${f.evidence_files.map(e => escapeHtml(e.name)).join('<br>') || '—'}</td>`;
        case 'findings': return `<td>${escapeHtml(f.findings?.substring(0, 300) || '—')}${f.findings?.length > 300 ? '...' : ''}</td>`;
        case 'gaps': return `<td>${f.gaps.length > 0 ? '<ul>' + f.gaps.map(g => `<li>${escapeHtml(g)}</li>`).join('') + '</ul>' : '—'}</td>`;
        case 'recommendations': return `<td>${f.recommendations.length > 0 ? '<ul>' + f.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('') + '</ul>' : '—'}</td>`;
        case 'score': {
          const override = f.score_override != null;
          const display = override ? f.score_override : (f.scoring_criteria?.display_score || 'N/A');
          return `<td><strong>${escapeHtml(String(display))}</strong>${override ? ' <em>(override)</em>' : ''}</td>`;
        }
        case 'confidence': return `<td>${f.confidence_score != null ? `${(f.confidence_score * 100).toFixed(0)}%` : '—'}</td>`;
        case 'status': {
          const st = f.status_override || f.status;
          return `<td>${statusBadge(st)}</td>`;
        }
        case 'requirements_breakdown': {
          if (!f.requirements_breakdown || f.requirements_breakdown.length === 0) return '<td>—</td>';
          const met = f.requirements_breakdown.filter(r => r.status === 'met').length;
          const total = f.requirements_breakdown.length;
          return `<td>${met}/${total} met</td>`;
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

  const typeIcons = {
    'application/pdf': '📄', 'image/png': '🖼️', 'image/jpeg': '🖼️', 'image/gif': '🖼️',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📝',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📊',
    'text/plain': '📃',
  };

  const rows = evidenceManifest.map(e => {
    const icon = typeIcons[e.file_type] || '📎';
    const controls = e.controls_analyzed.join(', ');
    return `<tr>
      <td>${icon} ${escapeHtml(e.file_name)}</td>
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
    // Text sections
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
    .findings-table th { background: #f3f4f6; font-weight: 600; padding: 0.6rem; text-align: left; border-bottom: 2px solid #d1d5db; white-space: nowrap; }
    .findings-table td { padding: 0.6rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
    .findings-table tr:nth-child(even) { background: #f9fafb; }
    .findings-table ul { margin: 0; padding-left: 1.2rem; }
    .findings-table li { margin-bottom: 0.2rem; }
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

module.exports = {
  buildDefaultSections,
  mapScoreToScale,
  gatherReportData,
  generateSectionContent,
  runReportGeneration,
  generateReportHtml,
};
