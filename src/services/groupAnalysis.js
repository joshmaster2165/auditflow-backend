const fs = require('fs');
const { supabase, downloadFile, cleanupFile } = require('../utils/supabase');
const { parseDocument, isImageType } = require('./documentParser');
const { analyzeControlWithRetry } = require('../utils/analysisHelpers');

/**
 * Fetch custom_instructions for a project. Returns null if not found or empty.
 *
 * @param {string|null} projectId - UUID of the project
 * @returns {string|null} Custom instructions text, or null
 */
async function fetchCustomInstructions(projectId) {
  if (!projectId) return null;

  try {
    const { data, error } = await supabase
      .from('projects')
      .select('custom_instructions')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      console.log(`📋 No custom instructions found for project ${projectId}`);
      return null;
    }

    const instructions = data.custom_instructions?.trim() || null;
    if (instructions) {
      console.log(`📋 Loaded custom instructions for project ${projectId}: ${instructions.length} chars`);
    }
    return instructions;
  } catch (err) {
    console.warn(`⚠️ Failed to fetch custom instructions for project ${projectId}: ${err.message}`);
    return null;
  }
}

/**
 * Build enriched requirement text from a control and its framework.
 * Extracted from analyze.js so both single-control and group analysis share the same logic.
 *
 * @param {Object} control - { title, description, control_number, category, custom_fields }
 * @param {Object|null} framework - { name, ... } or null
 * @returns {string} Enriched requirement text for GPT analysis
 */
function buildRequirementText(control, framework) {
  const controlName = control.title || 'Unknown Control';
  const controlNumber = control.control_number || '';
  const controlCategory = control.category || '';
  const frameworkName = framework?.name || '';

  // Description is the PRIMARY requirement — it contains the real compliance language
  let requirementText = control.description || control.custom_fields?.requirement_text || null;

  // If no description, build a structured requirement from all available fields
  if (!requirementText && control.title) {
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

  return requirementText || 'No specific requirement text provided';
}

/**
 * Compute aggregate statistics across an array of analysis results.
 * Follows the same pattern as the project-level aggregation in analyze.js.
 *
 * @param {Array} results - Array of { status, compliance_percentage, confidence_score, ... }
 * @returns {Object} Aggregate statistics
 */
function computeGroupAggregate(results) {
  const total = results.length;
  const compliant = results.filter((r) => r.status === 'compliant').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const nonCompliant = results.filter((r) => r.status === 'non_compliant').length;
  const errored = results.filter((r) => r.status === 'error').length;

  // Only average over non-errored results for meaningful metrics
  const validResults = results.filter((r) => r.status !== 'error');
  const validTotal = validResults.length;

  const avgCompliance = validTotal > 0
    ? Math.round(validResults.reduce((sum, r) => sum + (r.compliance_percentage || 0), 0) / validTotal)
    : 0;

  const avgConfidence = validTotal > 0
    ? parseFloat(
        (validResults.reduce((sum, r) => sum + (parseFloat(r.confidence_score) || 0), 0) / validTotal).toFixed(2)
      )
    : 0;

  return {
    total_controls_analyzed: total,
    compliant,
    partial,
    non_compliant: nonCompliant,
    errored,
    average_compliance_percentage: avgCompliance,
    average_confidence_score: avgConfidence,
    overall_status:
      compliant === total && total > 0
        ? 'compliant'
        : nonCompliant > 0
          ? 'non_compliant'
          : 'partial',
  };
}

/**
 * Shared analysis loop: download evidence, parse, analyze each control, aggregate, complete job.
 * Used by both runGroupAnalysis and runGroupAnalysisByIds to avoid code duplication.
 *
 * @param {Object} params
 * @param {string} params.jobId - UUID of the job
 * @param {Object} params.evidence - Evidence record from Supabase
 * @param {Array} params.childControls - Controls to analyze
 * @param {Map} params.jobs - In-memory job store
 * @param {string} params.logPrefix - Log prefix (e.g. "Group" or "GroupByIds")
 * @param {Object} params.resultExtras - Extra fields to merge into the job result (e.g. parentControl, controlIds)
 * @param {string|null} params.customInstructions - Project-level custom instructions
 */
async function executeGroupAnalysisLoop({ jobId, evidence, childControls, jobs, logPrefix, resultExtras, customInstructions }) {
  let tempFilePath = null;
  const startTime = Date.now();

  try {
    const job = jobs.get(jobId);

    console.log(`📊 [${logPrefix}] ${childControls.length} controls to analyze`);

    // Update job with control count
    if (job) {
      job.controlsTotal = childControls.length;
      job.controlsCompleted = 0;
    }

    // Download evidence file — ONCE
    const filePath = evidence.file_path || evidence.storage_path;
    if (!filePath) {
      throw new Error('Evidence record has no file path');
    }

    if (job) job.progress = 'Downloading evidence file...';
    tempFilePath = await downloadFile(filePath);

    // Parse document — ONCE (or read image as base64)
    if (job) job.progress = 'Parsing document...';
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';

    let documentText = null;
    let imageContent = null;

    if (isImageType(mimeType)) {
      const imageBase64 = fs.readFileSync(tempFilePath).toString('base64');
      imageContent = { base64: imageBase64, mimeType };
      console.log(`🖼️ [${logPrefix}] Image evidence (${Math.round(imageBase64.length / 1024)}KB base64)`);
    } else {
      documentText = await parseDocument(tempFilePath, mimeType);
      console.log(`📄 [${logPrefix}] Document parsed: ${documentText.length} chars`);
    }

    // Analyze controls in batches (GPT_CONCURRENCY defaults to 1 for Tier 1 rate limits)
    const results = [];
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const GPT_CONCURRENCY = parseInt(process.env.GPT_CONCURRENCY, 10) || 1;
    const GPT_CALL_DELAY_MS = parseInt(process.env.GPT_CALL_DELAY_MS, 10) || 0;

    for (let batchStart = 0; batchStart < childControls.length; batchStart += GPT_CONCURRENCY) {
      const batch = childControls.slice(batchStart, batchStart + GPT_CONCURRENCY);
      const batchEnd = Math.min(batchStart + batch.length, childControls.length);

      if (job) {
        job.progress = `Analyzing controls ${batchStart + 1}-${batchEnd} of ${childControls.length}`;
        job.controlsCompleted = batchStart;
      }

      const batchPromises = batch.map((ctrl) =>
        analyzeControlWithRetry({
          control: ctrl,
          documentText,
          customInstructions,
          evidenceId: evidence.id,
          projectId: evidence.project_id,
          buildRequirementText,
          logPrefix,
          imageContent,
        })
      );

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        results.push(result);

        if (result.usage) {
          totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += result.usage.completion_tokens || 0;
          totalUsage.total_tokens += result.usage.total_tokens || 0;
        }

        if (result.status !== 'error') {
          console.log(`✅ [${logPrefix}] ${result.control_number}: ${result.status} (${result.compliance_percentage}%)`);
        } else {
          console.error(`❌ [${logPrefix}] ${result.control_number}: ${result.error}`);
        }
      }

      // Inter-batch delay to avoid rate limits
      if (GPT_CALL_DELAY_MS > 0 && batchStart + GPT_CONCURRENCY < childControls.length) {
        console.log(`⏳ [${logPrefix}] Waiting ${GPT_CALL_DELAY_MS}ms before next batch...`);
        await new Promise(r => setTimeout(r, GPT_CALL_DELAY_MS));
      }
    }

    // Compute aggregate statistics
    const aggregate = computeGroupAggregate(results);
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n🏁 [${logPrefix}] Complete: ${results.length} controls analyzed in ${durationSeconds}s`);
    console.log(`📊 [${logPrefix}] Aggregate: ${aggregate.overall_status} (${aggregate.average_compliance_percentage}% avg)`);

    // Update job as completed
    jobs.set(jobId, {
      status: 'completed',
      completedAt: Date.now(),
      result: {
        aggregate,
        results,
        ...resultExtras,
        evidence: {
          id: evidence.id,
          name: evidence.file_name,
        },
        metadata: {
          total_tokens_used: totalUsage,
          duration_seconds: durationSeconds,
          analyzed_at: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    console.error(`💥 [${logPrefix}] Fatal error: ${err.message}`);
    jobs.set(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error: err.message,
    });
  } finally {
    cleanupFile(tempFilePath);
  }
}

/**
 * Run group analysis: analyze one evidence file against all child controls of a parent.
 * Updates the job Map with progress and final results.
 *
 * @param {string} jobId - UUID of the job in the jobs Map
 * @param {string} evidenceId - UUID of the evidence record
 * @param {Map} jobs - In-memory job store
 */
async function runGroupAnalysis(jobId, evidenceId, jobs) {
  try {
    // 1. Fetch evidence record with joined control and framework
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
      throw new Error(`Evidence not found: ${evidenceError?.message || 'no data'}`);
    }

    // 2. Get the parent control
    const parentControl = evidence.controls;
    if (!parentControl) {
      throw new Error('Evidence has no linked control (control_id is null)');
    }

    const customInstructions = await fetchCustomInstructions(evidence.project_id);

    console.log(`📋 [Group ${jobId}] Parent: ${parentControl.control_number} - ${parentControl.title}`);

    // 3. Find all child controls under this parent (cascading strategies)
    const { childControls, matchStrategy } = await findChildControls(parentControl);

    if (!childControls || childControls.length === 0) {
      throw new Error(
        `No child controls found under ${parentControl.control_number}. Tried parent_control_number, group/category, and prefix matching.`
      );
    }

    console.log(`📊 [Group ${jobId}] Matched via: ${matchStrategy}`);

    // 4-9. Shared analysis loop
    await executeGroupAnalysisLoop({
      jobId,
      evidence,
      childControls,
      jobs,
      logPrefix: `Group ${jobId}`,
      customInstructions,
      resultExtras: {
        parentControl: {
          id: parentControl.id,
          control_number: parentControl.control_number,
          title: parentControl.title,
        },
      },
    });
  } catch (err) {
    console.error(`💥 [Group ${jobId}] Fatal error: ${err.message}`);
    jobs.set(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error: err.message,
    });
  }
}

/**
 * Run group analysis by explicit control IDs (no parent-child hierarchy required).
 * Analyzes one evidence file against a provided list of controls.
 * Used for category-grouped controls that don't have parent_control_number set.
 *
 * @param {string} jobId - UUID of the job in the jobs Map
 * @param {string} evidenceId - UUID of the evidence record
 * @param {string[]} controlIds - Array of control UUIDs to analyze
 * @param {Map} jobs - In-memory job store
 */
async function runGroupAnalysisByIds(jobId, evidenceId, controlIds, jobs) {
  try {
    // 1. Fetch evidence record (no control join needed)
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence')
      .select('*')
      .eq('id', evidenceId)
      .single();

    if (evidenceError || !evidence) {
      throw new Error(`Evidence not found: ${evidenceError?.message || 'no data'}`);
    }

    const customInstructions = await fetchCustomInstructions(evidence.project_id);

    // 2. Fetch the specified controls with their frameworks
    const { data: controls, error: controlsError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .in('id', controlIds)
      .order('sort_order', { ascending: true });

    if (controlsError) {
      throw new Error(`Failed to fetch controls: ${controlsError.message}`);
    }

    if (!controls || controls.length === 0) {
      throw new Error('No controls found for the provided IDs');
    }

    // 3-9. Shared analysis loop
    await executeGroupAnalysisLoop({
      jobId,
      evidence,
      childControls: controls,
      jobs,
      logPrefix: `GroupByIds ${jobId}`,
      customInstructions,
      resultExtras: {
        parentControl: null,
        controlIds,
      },
    });
  } catch (err) {
    console.error(`💥 [GroupByIds ${jobId}] Fatal error: ${err.message}`);
    jobs.set(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error: err.message,
    });
  }
}

/**
 * Find child controls under a parent using cascading strategies:
 *  1. parent_control_number match (tree hierarchy)
 *  2. group/category match (grouped layout)
 *  3. control_number prefix match (e.g. parent "3" → children "3.1", "3.2")
 *
 * @param {Object} parentControl - The parent control record (must have id, framework_id, control_number, title, group)
 * @param {string} [selectFields='*, frameworks:framework_id (*)'] - Supabase select fields
 * @returns {Object} { childControls: Array, matchStrategy: string }
 */
async function findChildControls(parentControl, selectFields = '*, frameworks:framework_id (*)') {
  const frameworkId = parentControl.framework_id;
  const controlNumber = parentControl.control_number || '';

  // Build category filters for Strategy B
  const categoryFilters = [
    parentControl.category ? `category.eq.${parentControl.category}` : null,
    `category.eq.${controlNumber}`,
    `category.eq.${parentControl.title}`,
  ].filter(Boolean);

  // Fire all three strategies in parallel (saves 2 round-trips when A misses)
  const [treeResult, catResult, prefixResult] = await Promise.all([
    // Strategy A: parent_control_number match (tree hierarchy)
    supabase
      .from('controls')
      .select(selectFields)
      .eq('framework_id', frameworkId)
      .eq('parent_control_number', controlNumber)
      .order('sort_order', { ascending: true }),

    // Strategy B: category match
    categoryFilters.length > 0
      ? supabase
          .from('controls')
          .select(selectFields)
          .eq('framework_id', frameworkId)
          .or(categoryFilters.join(','))
          .order('sort_order', { ascending: true })
      : Promise.resolve({ data: null, error: null }),

    // Strategy C: control_number prefix match
    controlNumber
      ? supabase
          .from('controls')
          .select(selectFields)
          .eq('framework_id', frameworkId)
          .like('control_number', `${controlNumber}.%`)
          .order('sort_order', { ascending: true })
      : Promise.resolve({ data: null, error: null }),
  ]);

  // Pick first successful strategy (priority order preserved: A > B > C)
  if (!treeResult.error && treeResult.data?.length > 0) {
    console.log(`🔗 Found ${treeResult.data.length} children via parent_control_number = "${controlNumber}"`);
    return { childControls: treeResult.data, matchStrategy: 'parent_control_number' };
  }

  if (!catResult.error && catResult.data?.length > 1) {
    console.log(`🔗 Found ${catResult.data.length} peers via category match (including reference)`);
    return { childControls: catResult.data, matchStrategy: 'category' };
  }

  if (!prefixResult.error && prefixResult.data?.length > 0) {
    console.log(`🔗 Found ${prefixResult.data.length} children via control_number prefix "${controlNumber}.%"`);
    return { childControls: prefixResult.data, matchStrategy: 'prefix' };
  }

  // No children found with any strategy
  return { childControls: [], matchStrategy: 'none' };
}

module.exports = {
  buildRequirementText,
  computeGroupAggregate,
  fetchCustomInstructions,
  findChildControls,
  runGroupAnalysis,
  runGroupAnalysisByIds,
};
