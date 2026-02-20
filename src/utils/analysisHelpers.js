const { supabase } = require('./supabase');
const { analyzeEvidence, analyzeImageEvidence } = require('../services/gpt');
const { generateDiff } = require('../services/diffGenerator');

const RATE_LIMIT_RETRY_DELAYS = [30000, 60000, 120000]; // escalating backoff: 30s, 60s, 120s

/**
 * Build a standardized analysis_results DB record.
 * Replaces 4+ identical object literals scattered across groupAnalysis.js and analyze.js.
 */
function buildAnalysisRecord({ evidenceId, controlId, projectId, gptResult, diffData, version = 'v1.0-group' }) {
  return {
    evidence_id: evidenceId,
    control_id: controlId,
    project_id: projectId || null,
    analyzed_at: new Date().toISOString(),
    analysis_version: version,
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
}

/**
 * Analyze a single control against evidence text, save to DB, and handle rate-limit retry.
 * Replaces the ~80-line try/catch block duplicated in runGroupAnalysis and runGroupAnalysisByIds.
 *
 * @param {Object} opts
 * @param {Object} opts.control - Control record (with .id, .control_number, .title, .frameworks)
 * @param {string} opts.documentText - Parsed evidence document text (null for images)
 * @param {string|null} opts.customInstructions - Project-level custom instructions
 * @param {string} opts.evidenceId - Evidence UUID
 * @param {string|null} opts.projectId - Project UUID
 * @param {Function} opts.buildRequirementText - Requirement text builder function
 * @param {string} opts.logPrefix - Prefix for console logs (e.g. "Group abc123")
 * @param {Object|null} opts.imageContent - Optional image data { base64, mimeType } for vision analysis
 * @returns {Object} Result summary for the control
 */
async function analyzeControlWithRetry({
  control, documentText, customInstructions, evidenceId, projectId,
  buildRequirementText, logPrefix, imageContent,
}) {
  const controlName = control.title || `Control ${control.control_number}`;
  const ctrlFramework = control.frameworks || null;
  const requirementText = buildRequirementText(control, ctrlFramework);

  // Helper: call the right GPT function based on text vs image
  const runAnalysis = () => {
    if (imageContent) {
      return analyzeImageEvidence(imageContent.base64, imageContent.mimeType, requirementText, controlName, customInstructions);
    }
    return analyzeEvidence(documentText, requirementText, controlName, customInstructions);
  };

  // Attempt GPT call with escalating rate-limit retries (30s, 60s, 120s)
  let lastErr;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS.length; attempt++) {
    try {
      const gptResult = await runAnalysis();
      const diffData = generateDiff(gptResult.analysis, requirementText);

      if (imageContent) {
        diffData.extracted_text = gptResult.analysis.extracted_text || '';
        diffData.is_image = true;
      }

      const record = buildAnalysisRecord({ evidenceId, controlId: control.id, projectId, gptResult, diffData });

      const { data: saved, error: saveError } = await supabase
        .from('analysis_results')
        .insert(record)
        .select()
        .single();

      if (saveError) {
        console.error(`⚠️ [${logPrefix}] DB save failed for ${control.control_number}: ${saveError.message}`);
      }

      if (attempt > 0) {
        console.log(`✅ [${logPrefix}] Retry ${attempt} succeeded for ${control.control_number}`);
      }

      return {
        analysis_id: saved?.id || null,
        control_id: control.id,
        control_number: control.control_number,
        control_title: control.title,
        status: gptResult.analysis.status,
        compliance_percentage: gptResult.analysis.compliance_percentage,
        confidence_score: gptResult.analysis.confidence_score,
        summary: gptResult.analysis.summary,
        save_error: saveError?.message || null,
        usage: gptResult.usage,
      };
    } catch (err) {
      lastErr = err;
      const isRateLimit = err.message?.includes('429') || err.message?.toLowerCase().includes('rate limit');
      if (isRateLimit && attempt < RATE_LIMIT_RETRY_DELAYS.length) {
        const delay = RATE_LIMIT_RETRY_DELAYS[attempt];
        console.log(`⏳ [${logPrefix}] Rate limited. Waiting ${delay / 1000}s before retry ${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS.length} for ${control.control_number}...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        break; // non-rate-limit error or exhausted retries
      }
    }
  }

  // All attempts failed — return error result
  return {
    analysis_id: null,
    control_id: control.id,
    control_number: control.control_number,
    control_title: control.title,
    status: 'error',
    error: lastErr.message,
    compliance_percentage: null,
    confidence_score: null,
    summary: null,
    usage: null,
  };
}

/**
 * Create an in-memory job Map with automatic cleanup of stale jobs.
 * Replaces the duplicated job store + setInterval blocks in analyze.js and framework.js.
 *
 * @param {Object} opts
 * @param {number} opts.processingTimeoutMs - Max time a job can stay "processing" (default 20 min)
 * @param {number} opts.completedRetentionMs - How long to keep completed/failed jobs (default 30 min)
 * @param {number} opts.cleanupIntervalMs - How often to run cleanup (default 10 min)
 * @returns {Map} The job store Map
 */
function createJobStore({
  processingTimeoutMs = 20 * 60 * 1000,
  completedRetentionMs = 30 * 60 * 1000,
  cleanupIntervalMs = 10 * 60 * 1000,
} = {}) {
  const jobs = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        now - (job.completedAt || 0) > completedRetentionMs
      ) {
        jobs.delete(id);
      } else if (job.status === 'processing' && now - (job.startedAt || 0) > processingTimeoutMs) {
        jobs.set(id, {
          ...job,
          status: 'failed',
          error: `Processing timed out after ${Math.round(processingTimeoutMs / 60000)} minutes`,
          completedAt: Date.now(),
        });
      }
    }
  }, cleanupIntervalMs);

  return jobs;
}

module.exports = { buildAnalysisRecord, analyzeControlWithRetry, createJobStore };
