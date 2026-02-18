const { supabase, downloadFile, cleanupFile } = require('../utils/supabase');
const { parseDocument } = require('./documentParser');
const { analyzeEvidence } = require('./gpt');
const { generateDiff } = require('./diffGenerator');

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

    const framework = parentControl.frameworks || null;

    console.log(`📋 [Group ${jobId}] Parent: ${parentControl.control_number} - ${parentControl.title}`);

    // 3. Find all child controls under this parent
    const { data: childControls, error: childError } = await supabase
      .from('controls')
      .select('*, frameworks:framework_id (*)')
      .eq('framework_id', parentControl.framework_id)
      .eq('parent_control_number', parentControl.control_number)
      .order('sort_order', { ascending: true });

    if (childError) {
      throw new Error(`Failed to fetch child controls: ${childError.message}`);
    }

    if (!childControls || childControls.length === 0) {
      throw new Error(
        `No child controls found under ${parentControl.control_number}. Ensure controls have parent_control_number set.`
      );
    }

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

    // 5. Parse document — ONCE
    if (job) job.progress = 'Parsing document...';
    const mimeType = evidence.file_type || evidence.mime_type || 'text/plain';
    const documentText = await parseDocument(tempFilePath, mimeType);

    console.log(`📄 [Group ${jobId}] Document parsed: ${documentText.length} chars`);

    // 6. Analyze each child control sequentially
    const results = [];
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (let i = 0; i < childControls.length; i++) {
      const child = childControls[i];
      const childFramework = child.frameworks || framework;
      const controlName = child.title || `Control ${child.control_number}`;

      const progressMsg = `Analyzing control ${i + 1} of ${childControls.length} (${child.control_number} - ${controlName})`;
      console.log(`🔍 [Group ${jobId}] ${progressMsg}`);

      if (job) {
        job.progress = progressMsg;
        job.controlsCompleted = i;
      }

      try {
        // Build requirement text using shared helper
        const requirementText = buildRequirementText(child, childFramework);

        // Call GPT analysis
        const gptResult = await analyzeEvidence(documentText, requirementText, controlName);

        // Generate diff visualization
        const diffData = generateDiff(gptResult.analysis, requirementText);

        // Store analysis result in DB
        const analysisRecord = {
          evidence_id: evidenceId,
          control_id: child.id,
          project_id: evidence.project_id || null,
          analyzed_at: new Date().toISOString(),
          analysis_version: 'v1.0-group',
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

        const { data: saved, error: saveError } = await supabase
          .from('analysis_results')
          .insert(analysisRecord)
          .select()
          .single();

        if (saveError) {
          console.error(`⚠️ [Group ${jobId}] DB save failed for ${child.control_number}: ${saveError.message}`);
        }

        results.push({
          analysis_id: saved?.id || null,
          control_id: child.id,
          control_number: child.control_number,
          control_title: child.title,
          status: gptResult.analysis.status,
          compliance_percentage: gptResult.analysis.compliance_percentage,
          confidence_score: gptResult.analysis.confidence_score,
          summary: gptResult.analysis.summary,
          save_error: saveError?.message || null,
        });

        // Accumulate token usage
        totalUsage.prompt_tokens += gptResult.usage?.prompt_tokens || 0;
        totalUsage.completion_tokens += gptResult.usage?.completion_tokens || 0;
        totalUsage.total_tokens += gptResult.usage?.total_tokens || 0;

        console.log(`✅ [Group ${jobId}] ${child.control_number}: ${gptResult.analysis.status} (${gptResult.analysis.compliance_percentage}%)`);
      } catch (err) {
        console.error(`❌ [Group ${jobId}] Error analyzing ${child.control_number}: ${err.message}`);

        // Rate limit retry
        if (err.message && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))) {
          console.log(`⏳ [Group ${jobId}] Rate limited. Waiting 60s before retrying ${child.control_number}...`);
          if (job) job.progress = `Rate limited. Waiting 60s before retrying ${child.control_number}...`;
          await new Promise((resolve) => setTimeout(resolve, 60000));

          try {
            const requirementText = buildRequirementText(child, childFramework);
            const gptResult = await analyzeEvidence(documentText, requirementText, controlName);
            const diffData = generateDiff(gptResult.analysis, requirementText);

            const analysisRecord = {
              evidence_id: evidenceId,
              control_id: child.id,
              project_id: evidence.project_id || null,
              analyzed_at: new Date().toISOString(),
              analysis_version: 'v1.0-group',
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

            const { data: saved, error: saveError } = await supabase
              .from('analysis_results')
              .insert(analysisRecord)
              .select()
              .single();

            results.push({
              analysis_id: saved?.id || null,
              control_id: child.id,
              control_number: child.control_number,
              control_title: child.title,
              status: gptResult.analysis.status,
              compliance_percentage: gptResult.analysis.compliance_percentage,
              confidence_score: gptResult.analysis.confidence_score,
              summary: gptResult.analysis.summary,
              save_error: saveError?.message || null,
            });

            totalUsage.prompt_tokens += gptResult.usage?.prompt_tokens || 0;
            totalUsage.completion_tokens += gptResult.usage?.completion_tokens || 0;
            totalUsage.total_tokens += gptResult.usage?.total_tokens || 0;

            console.log(`✅ [Group ${jobId}] Retry succeeded for ${child.control_number}`);
            continue;
          } catch (retryErr) {
            console.error(`❌ [Group ${jobId}] Retry also failed for ${child.control_number}: ${retryErr.message}`);
          }
        }

        // Record error result and continue to next control
        results.push({
          analysis_id: null,
          control_id: child.id,
          control_number: child.control_number,
          control_title: child.title,
          status: 'error',
          error: err.message,
          compliance_percentage: null,
          confidence_score: null,
          summary: null,
        });
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

module.exports = {
  buildRequirementText,
  computeGroupAggregate,
  runGroupAnalysis,
};
