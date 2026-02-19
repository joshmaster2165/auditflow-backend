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
 * Run group analysis: analyze one evidence file against all child controls of a parent.
 * Updates the job Map with progress and final results.
 *
 * @param {string} jobId - UUID of the job in the jobs Map
 * @param {string} evidenceId - UUID of the evidence record
 * @param {Map} jobs - In-memory job store
 */
async function runGroupAnalysis(jobId, evidenceId, jobs) {
  let tempFilePath = null;
  const startTime = Date.now();

  try {
    const job = jobs.get(jobId);

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

    // Fetch project-level custom instructions (once, before the loop)
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

    console.log(`📊 [Group ${jobId}] Found ${childControls.length} child controls`);

    // Update job with child count
    if (job) {
      job.controlsTotal = childControls.length;
      job.controlsCompleted = 0;
    }

    // 4. Download evidence file — ONCE
    const filePath = evidence.file_path || evidence.storage_path;
    if (!filePath) {
      throw new Error('Evidence record has no file path');
    }

    if (job) job.progress = 'Downloading evidence file...';
    tempFilePath = await downloadFile(filePath);

    // 5. Parse document — ONCE (or read image as base64)
    if (job) job.progress = 'Parsing document...';
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';

    let documentText = null;
    let imageContent = null;

    if (isImageType(mimeType)) {
      // Image evidence — read as base64 once, pass to each control analysis
      const imageBase64 = fs.readFileSync(tempFilePath).toString('base64');
      imageContent = { base64: imageBase64, mimeType };
      console.log(`🖼️ [Group ${jobId}] Image evidence (${Math.round(imageBase64.length / 1024)}KB base64)`);
    } else {
      documentText = await parseDocument(tempFilePath, mimeType);
      console.log(`📄 [Group ${jobId}] Document parsed: ${documentText.length} chars`);
    }

    // 6. Analyze each child control sequentially using shared helper
    const results = [];
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (let i = 0; i < childControls.length; i++) {
      const child = childControls[i];
      const controlName = child.title || `Control ${child.control_number}`;

      const progressMsg = `Analyzing control ${i + 1} of ${childControls.length} (${child.control_number} - ${controlName})`;
      console.log(`🔍 [Group ${jobId}] ${progressMsg}`);

      if (job) {
        job.progress = progressMsg;
        job.controlsCompleted = i;
      }

      const result = await analyzeControlWithRetry({
        control: child,
        documentText,
        customInstructions,
        evidenceId,
        projectId: evidence.project_id,
        buildRequirementText,
        logPrefix: `Group ${jobId}`,
        imageContent,
      });

      results.push(result);

      if (result.usage) {
        totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
        totalUsage.completion_tokens += result.usage.completion_tokens || 0;
        totalUsage.total_tokens += result.usage.total_tokens || 0;
      }

      if (result.status !== 'error') {
        console.log(`✅ [Group ${jobId}] ${child.control_number}: ${result.status} (${result.compliance_percentage}%)`);
      } else {
        console.error(`❌ [Group ${jobId}] ${child.control_number}: ${result.error}`);
      }
    }

    // 7. Compute aggregate statistics
    const aggregate = computeGroupAggregate(results);
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n🏁 [Group ${jobId}] Complete: ${results.length} controls analyzed in ${durationSeconds}s`);
    console.log(`📊 [Group ${jobId}] Aggregate: ${aggregate.overall_status} (${aggregate.average_compliance_percentage}% avg)`);

    // 8. Update job as completed
    jobs.set(jobId, {
      status: 'completed',
      completedAt: Date.now(),
      result: {
        aggregate,
        results,
        parentControl: {
          id: parentControl.id,
          control_number: parentControl.control_number,
          title: parentControl.title,
        },
        evidence: {
          id: evidenceId,
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
    console.error(`💥 [Group ${jobId}] Fatal error: ${err.message}`);
    jobs.set(jobId, {
      status: 'failed',
      completedAt: Date.now(),
      error: err.message,
    });
  } finally {
    // 9. Clean up temp file
    cleanupFile(tempFilePath);
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
  let tempFilePath = null;
  const startTime = Date.now();

  try {
    const job = jobs.get(jobId);

    // 1. Fetch evidence record (no control join needed)
    const { data: evidence, error: evidenceError } = await supabase
      .from('evidence')
      .select('*')
      .eq('id', evidenceId)
      .single();

    if (evidenceError || !evidence) {
      throw new Error(`Evidence not found: ${evidenceError?.message || 'no data'}`);
    }

    // Fetch project-level custom instructions (once, before the loop)
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

    console.log(`📊 [GroupByIds ${jobId}] ${controls.length} controls to analyze`);

    // Update job with control count
    if (job) {
      job.controlsTotal = controls.length;
      job.controlsCompleted = 0;
    }

    // 3. Download evidence file — ONCE
    const filePath = evidence.file_path || evidence.storage_path;
    if (!filePath) {
      throw new Error('Evidence record has no file path');
    }

    if (job) job.progress = 'Downloading evidence file...';
    tempFilePath = await downloadFile(filePath);

    // 4. Parse document — ONCE (or read image as base64)
    if (job) job.progress = 'Parsing document...';
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';

    let documentText = null;
    let imageContent = null;

    if (isImageType(mimeType)) {
      const imageBase64 = fs.readFileSync(tempFilePath).toString('base64');
      imageContent = { base64: imageBase64, mimeType };
      console.log(`🖼️ [GroupByIds ${jobId}] Image evidence (${Math.round(imageBase64.length / 1024)}KB base64)`);
    } else {
      documentText = await parseDocument(tempFilePath, mimeType);
      console.log(`📄 [GroupByIds ${jobId}] Document parsed: ${documentText.length} chars`);
    }

    // 5. Analyze each control sequentially using shared helper
    const results = [];
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (let i = 0; i < controls.length; i++) {
      const ctrl = controls[i];
      const controlName = ctrl.title || `Control ${ctrl.control_number}`;

      const progressMsg = `Analyzing control ${i + 1} of ${controls.length} (${ctrl.control_number} - ${controlName})`;
      console.log(`🔍 [GroupByIds ${jobId}] ${progressMsg}`);

      if (job) {
        job.progress = progressMsg;
        job.controlsCompleted = i;
      }

      const result = await analyzeControlWithRetry({
        control: ctrl,
        documentText,
        customInstructions,
        evidenceId,
        projectId: evidence.project_id,
        buildRequirementText,
        logPrefix: `GroupByIds ${jobId}`,
        imageContent,
      });

      results.push(result);

      if (result.usage) {
        totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
        totalUsage.completion_tokens += result.usage.completion_tokens || 0;
        totalUsage.total_tokens += result.usage.total_tokens || 0;
      }

      if (result.status !== 'error') {
        console.log(`✅ [GroupByIds ${jobId}] ${ctrl.control_number}: ${result.status} (${result.compliance_percentage}%)`);
      } else {
        console.error(`❌ [GroupByIds ${jobId}] ${ctrl.control_number}: ${result.error}`);
      }
    }

    // 6. Compute aggregate statistics
    const aggregate = computeGroupAggregate(results);
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n🏁 [GroupByIds ${jobId}] Complete: ${results.length} controls analyzed in ${durationSeconds}s`);
    console.log(`📊 [GroupByIds ${jobId}] Aggregate: ${aggregate.overall_status} (${aggregate.average_compliance_percentage}% avg)`);

    // 7. Update job as completed
    // Include parentControl: null so the frontend transform handles category-based analysis
    // without crashing on missing parentControl.id
    jobs.set(jobId, {
      status: 'completed',
      completedAt: Date.now(),
      result: {
        aggregate,
        results,
        parentControl: null,
        controlIds,
        evidence: {
          id: evidenceId,
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
    console.error(`💥 [GroupByIds ${jobId}] Fatal error: ${err.message}`);
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
  const parentId = parentControl.id;

  // --- Strategy A: parent_control_number match (tree hierarchy) ---
  const { data: treeChildren, error: treeError } = await supabase
    .from('controls')
    .select(selectFields)
    .eq('framework_id', frameworkId)
    .eq('parent_control_number', controlNumber)
    .order('sort_order', { ascending: true });

  if (!treeError && treeChildren && treeChildren.length > 0) {
    console.log(`🔗 Found ${treeChildren.length} children via parent_control_number = "${controlNumber}"`);
    return { childControls: treeChildren, matchStrategy: 'parent_control_number' };
  }

  // --- Strategy B: category match ---
  // Controls that share the same category as the parent's title or control_number
  const categoryFilters = [
    parentControl.category ? `category.eq.${parentControl.category}` : null,
    `category.eq.${controlNumber}`,
    `category.eq.${parentControl.title}`,
  ].filter(Boolean);

  if (categoryFilters.length > 0) {
    const { data: catChildren, error: catError } = await supabase
      .from('controls')
      .select(selectFields)
      .eq('framework_id', frameworkId)
      .or(categoryFilters.join(','))
      .order('sort_order', { ascending: true });

    // For category match, include ALL peers (don't exclude the reference control)
    if (!catError && catChildren && catChildren.length > 1) {
      console.log(`🔗 Found ${catChildren.length} peers via category match (including reference)`);
      return { childControls: catChildren, matchStrategy: 'category' };
    }
  }

  // --- Strategy C: control_number prefix match ---
  // e.g. parent "3" finds "3.1", "3.1.1", "3.2", etc.
  // e.g. parent "AC-1" finds "AC-1.1", "AC-1.2", etc.
  if (controlNumber) {
    const { data: prefixChildren, error: prefixError } = await supabase
      .from('controls')
      .select(selectFields)
      .eq('framework_id', frameworkId)
      .like('control_number', `${controlNumber}.%`)
      .order('sort_order', { ascending: true });

    if (!prefixError && prefixChildren && prefixChildren.length > 0) {
      console.log(`🔗 Found ${prefixChildren.length} children via control_number prefix "${controlNumber}.%"`);
      return { childControls: prefixChildren, matchStrategy: 'prefix' };
    }
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
