const OpenAI = require('openai');
const { supabase } = require('../utils/supabase');

// ── OpenAI Client & Configuration ──
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const GPT_MODEL = 'gpt-5.1';
const GPT_MAX_TOKENS = 16384;
const GPT_TEMPERATURE = 0.2;
const BATCH_SIZE = 12;
const CONCURRENCY = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 60000;
const BATCH_INSERT_SIZE = 100;

// ── GPT System Prompt ──

const CROSSWALK_SYSTEM_PROMPT = `You are an expert compliance framework analyst specializing in control mapping and crosswalk analysis between regulatory and compliance frameworks.

Your task is to analyze controls from two different compliance frameworks and identify relationships between them. You must:

1. For each control in the "Source Controls" set, identify ALL controls in the "Target Framework" that are meaningfully related.
2. Classify each relationship precisely:
   - "equivalent": Controls address the same requirement with essentially the same scope and intent.
   - "partial_overlap": Controls address overlapping but not identical requirements — there is meaningful shared scope but also unique aspects in each.
   - "subset": The source control's scope is fully contained within the target control (target is broader).
   - "superset": The source control's scope fully contains the target control (source is broader).
   - "related": Controls address related but distinct topics — understanding one provides context for the other, but they are not interchangeable.
3. Assign a confidence score (0.0 to 1.0) reflecting how confident you are in the mapping:
   - 0.9-1.0: Clear, unambiguous relationship with strong textual and intent alignment.
   - 0.7-0.89: Strong relationship with minor differences in scope or language.
   - 0.5-0.69: Moderate relationship — related topic area but notable differences in approach or specificity.
   - 0.3-0.49: Weak but valid relationship — tangentially related.
   - Below 0.3: Do not include — the relationship is too tenuous to be useful.
4. Provide a concise rationale explaining WHY the controls are related — what shared concepts, requirements, or objectives link them.

PRECISION IS CRITICAL. False positives (mapping unrelated controls) waste auditor time. It is better to miss a weak relationship than to include a spurious one. Only include mappings where an auditor would genuinely benefit from knowing the relationship.

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

// ── Prompt Builders ──

/**
 * Build a condensed reference index of a framework's controls for use as context.
 * @param {Array} controls - Array of control records
 * @param {boolean} compressed - If true, only include control_number + title (for very large frameworks)
 * @returns {string} Formatted text index
 */
function buildFrameworkIndex(controls, compressed = false) {
  if (compressed) {
    return controls.map(c => `- ${c.control_number}: ${c.title}`).join('\n');
  }
  return controls.map(c => {
    const desc = c.description
      ? c.description.substring(0, 150) + (c.description.length > 150 ? '...' : '')
      : '';
    return `- ${c.control_number}: ${c.title}${desc ? ' \u2014 ' + desc : ''}`;
  }).join('\n');
}

/**
 * Build the user prompt for a single batch of source controls.
 * @param {Array} sourceControls - Batch of source controls (up to BATCH_SIZE)
 * @param {string} targetFrameworkIndex - Pre-built condensed reference of the target framework
 * @param {string} sourceFrameworkName - Name of the source framework
 * @param {string} targetFrameworkName - Name of the target framework
 * @returns {string} User prompt
 */
function buildCrosswalkBatchPrompt(sourceControls, targetFrameworkIndex, sourceFrameworkName, targetFrameworkName) {
  const sourceBlock = sourceControls.map((c, i) =>
    `### ${i + 1}. ${c.control_number} \u2014 ${c.title}\n${c.description || 'No description available.'}`
  ).join('\n\n');

  return `Map the following controls from "${sourceFrameworkName}" to related controls in "${targetFrameworkName}".

## Source Controls to Map:
${sourceBlock}

## Target Framework Reference ("${targetFrameworkName}"):
${targetFrameworkIndex}

## Output Format:
Return a JSON object with mappings for each source control. Include ALL valid mappings (a source control may map to zero, one, or many target controls):

{
  "mappings": [
    {
      "source_control_number": "<exact control_number from Source Controls>",
      "target_control_number": "<exact control_number from Target Framework>",
      "relationship_type": "equivalent" | "partial_overlap" | "subset" | "superset" | "related",
      "confidence": <number 0.3-1.0>,
      "rationale": "<1-2 sentence explanation of why these controls are related>"
    }
  ]
}

RULES:
- Include every source control in your analysis \u2014 if a source control has no meaningful matches, simply omit it from the mappings array (zero mappings is valid).
- A source control CAN map to multiple target controls (many-to-many).
- Do NOT include mappings with confidence below 0.3.
- Use the EXACT control_number values from both the source and target lists \u2014 do not modify or abbreviate them.
- The rationale should explain the specific shared concept or requirement, not just restate the control titles.`;
}

// ── JSON Recovery ──

/**
 * Attempt to recover valid JSON from a truncated GPT crosswalk response.
 * @param {string} truncatedContent - The truncated JSON string
 * @returns {Object|null} Parsed object with mappings array, or null if unrecoverable
 */
function attemptCrosswalkJsonRecovery(truncatedContent) {
  const closings = ['', ']}', '"}]}', '"]}', '"}]}'];
  for (const closing of closings) {
    try {
      const attempt = truncatedContent + closing;
      const parsed = JSON.parse(attempt);
      if (parsed.mappings && Array.isArray(parsed.mappings)) {
        console.log(`  Crosswalk JSON recovery succeeded with closing: "${closing}" (${parsed.mappings.length} mappings recovered)`);
        return parsed;
      }
    } catch (_e) { /* try next */ }
  }
  return null;
}

// ── OpenAI Error Handler ──

function handleOpenAIError(err) {
  if (err.status === 429) throw new Error('OpenAI rate limit exceeded. Please try again later.');
  if (err.status === 401) throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
  throw err;
}

// ── Single Batch Processing ──

/**
 * Process a single batch of source controls against the target framework.
 * Includes a single rate-limit retry after 60s.
 *
 * @param {Array} sourceControlsBatch - Batch of source controls
 * @param {string} targetIndex - Pre-built target framework reference
 * @param {string} sourceFrameworkName - Source framework display name
 * @param {string} targetFrameworkName - Target framework display name
 * @returns {{ mappings: Array, usage: Object|null }}
 */
async function processCrosswalkBatch(sourceControlsBatch, targetIndex, sourceFrameworkName, targetFrameworkName) {
  const userPrompt = buildCrosswalkBatchPrompt(sourceControlsBatch, targetIndex, sourceFrameworkName, targetFrameworkName);

  const callGpt = async () => {
    return await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: CROSSWALK_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: GPT_TEMPERATURE,
      max_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });
  };

  try {
    const response = await callGpt();
    const content = response.choices[0].message.content;

    let result;
    try {
      result = JSON.parse(content);
    } catch (_parseErr) {
      if (response.choices[0].finish_reason === 'length') {
        result = attemptCrosswalkJsonRecovery(content);
        if (!result) throw new Error('GPT crosswalk response truncated and unrecoverable');
      } else {
        throw new Error('GPT returned invalid JSON for crosswalk batch');
      }
    }

    return {
      mappings: result.mappings || [],
      usage: response.usage || null,
    };
  } catch (err) {
    // Rate-limit retry (once) — matches existing pattern in analysisHelpers.js
    if (err.status === 429 || err.message?.includes('429') || err.message?.toLowerCase().includes('rate limit')) {
      console.log('  Rate limited on crosswalk batch. Waiting 60s before retry...');
      await new Promise(r => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));

      try {
        const response = await callGpt();
        const content = response.choices[0].message.content;
        const result = JSON.parse(content);
        return { mappings: result.mappings || [], usage: response.usage || null };
      } catch (retryErr) {
        console.error('  Retry also failed:', retryErr.message);
        return { mappings: [], usage: null };
      }
    }

    handleOpenAIError(err);
  }
}

// ── Main Orchestrator ──

/**
 * Generate a crosswalk between two frameworks using GPT-4o.
 * This is called fire-and-forget after the HTTP response is sent.
 * Updates the jobs Map with progress and the crosswalks/crosswalk_mappings tables in Supabase.
 *
 * @param {string} crosswalkId - UUID of the crosswalks row
 * @param {string} jobId - UUID of the in-memory job entry
 * @param {Map} jobs - In-memory job store (from createJobStore)
 */
async function runCrosswalkGeneration(crosswalkId, jobId, jobs) {
  const startTime = Date.now();
  const job = jobs.get(jobId);

  try {
    // 1. Fetch the crosswalk record
    const { data: crosswalk, error: cwErr } = await supabase
      .from('crosswalks')
      .select('*, framework_a:framework_a_id (id, name), framework_b:framework_b_id (id, name)')
      .eq('id', crosswalkId)
      .single();

    if (cwErr || !crosswalk) {
      throw new Error(`Failed to fetch crosswalk: ${cwErr?.message || 'not found'}`);
    }

    if (job) job.progress = 'Fetching framework controls...';

    // 2. Fetch all controls from both frameworks
    const { data: controlsA, error: errA } = await supabase
      .from('controls')
      .select('id, control_number, title, description, category')
      .eq('framework_id', crosswalk.framework_a_id)
      .order('sort_order', { ascending: true });

    const { data: controlsB, error: errB } = await supabase
      .from('controls')
      .select('id, control_number, title, description, category')
      .eq('framework_id', crosswalk.framework_b_id)
      .order('sort_order', { ascending: true });

    if (errA) throw new Error(`Failed to fetch Framework A controls: ${errA.message}`);
    if (errB) throw new Error(`Failed to fetch Framework B controls: ${errB.message}`);

    if (!controlsA.length || !controlsB.length) {
      throw new Error(`One or both frameworks have no controls (A: ${controlsA.length}, B: ${controlsB.length})`);
    }

    console.log(`\ud83d\uddd3\ufe0f [Crosswalk ${crosswalkId}] Framework A "${crosswalk.framework_a.name}": ${controlsA.length} controls`);
    console.log(`\ud83d\uddd3\ufe0f [Crosswalk ${crosswalkId}] Framework B "${crosswalk.framework_b.name}": ${controlsB.length} controls`);

    // 3. Pick the smaller framework as "source" to minimize API calls
    let sourceControls, targetControls, sourceFrameworkName, targetFrameworkName;
    let sourceIsA = true;

    if (controlsA.length <= controlsB.length) {
      sourceControls = controlsA;
      targetControls = controlsB;
      sourceFrameworkName = crosswalk.framework_a.name;
      targetFrameworkName = crosswalk.framework_b.name;
    } else {
      sourceControls = controlsB;
      targetControls = controlsA;
      sourceFrameworkName = crosswalk.framework_b.name;
      targetFrameworkName = crosswalk.framework_a.name;
      sourceIsA = false;
    }

    // 4. Build the target framework reference index
    const compressed = targetControls.length > 300;
    const targetIndex = buildFrameworkIndex(targetControls, compressed);
    console.log(`\ud83d\udcc4 [Crosswalk ${crosswalkId}] Target index: ${targetIndex.length} chars (${compressed ? 'compressed' : 'full'})`);

    // 5. Chunk source controls into batches
    const batches = [];
    for (let i = 0; i < sourceControls.length; i += BATCH_SIZE) {
      batches.push(sourceControls.slice(i, i + BATCH_SIZE));
    }

    if (job) {
      job.batchesTotal = batches.length;
      job.batchesCompleted = 0;
      job.mappingsFound = 0;
      job.progress = `Starting ${batches.length} batches (${sourceControls.length} source controls)...`;
    }

    console.log(`\ud83d\ude80 [Crosswalk ${crosswalkId}] Processing ${batches.length} batches with concurrency ${CONCURRENCY}`);

    // 6. Build lookup maps for control_number -> id resolution
    const sourceMap = new Map(sourceControls.map(c => [c.control_number, c.id]));
    const targetMap = new Map(targetControls.map(c => [c.control_number, c.id]));

    // 7. Process batches with concurrency control
    const allRawMappings = [];
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    for (let batchStart = 0; batchStart < batches.length; batchStart += CONCURRENCY) {
      const concurrentBatches = batches.slice(batchStart, batchStart + CONCURRENCY);

      const batchPromises = concurrentBatches.map(async (batch, idx) => {
        const batchNum = batchStart + idx + 1;

        if (job) {
          job.progress = `Processing batch ${batchNum} of ${batches.length}...`;
        }

        console.log(`  \ud83d\udd04 [Crosswalk ${crosswalkId}] Batch ${batchNum}/${batches.length} (${batch.length} controls)`);

        const result = await processCrosswalkBatch(batch, targetIndex, sourceFrameworkName, targetFrameworkName);

        console.log(`  \u2705 [Crosswalk ${crosswalkId}] Batch ${batchNum} returned ${result.mappings.length} mappings`);

        return result;
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        allRawMappings.push(...result.mappings);
        if (result.usage) {
          totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += result.usage.completion_tokens || 0;
          totalUsage.total_tokens += result.usage.total_tokens || 0;
        }
      }

      if (job) {
        job.batchesCompleted = Math.min(batchStart + CONCURRENCY, batches.length);
        job.mappingsFound = allRawMappings.length;
      }
    }

    console.log(`\ud83d\udcca [Crosswalk ${crosswalkId}] Total raw mappings from GPT: ${allRawMappings.length}`);

    // 8. Resolve control numbers to UUIDs and deduplicate
    const dedupeMap = new Map(); // key: "controlAId:controlBId" -> mapping record

    for (const raw of allRawMappings) {
      const sourceId = sourceMap.get(raw.source_control_number);
      const targetId = targetMap.get(raw.target_control_number);

      if (!sourceId || !targetId) {
        console.warn(`  \u26a0\ufe0f Skipping mapping: unresolved control number (source: ${raw.source_control_number} -> ${sourceId}, target: ${raw.target_control_number} -> ${targetId})`);
        continue;
      }

      // Ensure control_a always references framework_a, control_b references framework_b
      const controlAId = sourceIsA ? sourceId : targetId;
      const controlBId = sourceIsA ? targetId : sourceId;
      const dedupeKey = `${controlAId}:${controlBId}`;

      const existing = dedupeMap.get(dedupeKey);
      if (!existing || raw.confidence > existing.ai_confidence) {
        dedupeMap.set(dedupeKey, {
          crosswalk_id: crosswalkId,
          control_a_id: controlAId,
          control_b_id: controlBId,
          ai_confidence: parseFloat(raw.confidence) || 0,
          relationship_type: raw.relationship_type || 'related',
          ai_rationale: raw.rationale || null,
          status: 'ai_generated',
        });
      }
    }

    const mappingRecords = Array.from(dedupeMap.values());
    console.log(`\ud83d\udcca [Crosswalk ${crosswalkId}] After deduplication: ${mappingRecords.length} unique mappings`);

    // 9. Batch insert into crosswalk_mappings
    if (job) job.progress = 'Saving mappings to database...';

    let insertedCount = 0;
    for (let i = 0; i < mappingRecords.length; i += BATCH_INSERT_SIZE) {
      const batch = mappingRecords.slice(i, i + BATCH_INSERT_SIZE);
      const { error: insertErr } = await supabase.from('crosswalk_mappings').insert(batch);
      if (insertErr) {
        console.error(`  \u274c DB insert batch failed: ${insertErr.message}`);
      } else {
        insertedCount += batch.length;
      }
    }

    console.log(`\ud83d\udcbe [Crosswalk ${crosswalkId}] Inserted ${insertedCount} mappings into DB`);

    // 10. Calculate statistics and update the crosswalks row
    const avgConfidence = mappingRecords.length > 0
      ? parseFloat((mappingRecords.reduce((sum, m) => sum + m.ai_confidence, 0) / mappingRecords.length).toFixed(2))
      : 0;

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    const { error: updateErr } = await supabase
      .from('crosswalks')
      .update({
        status: 'completed',
        total_mappings: insertedCount,
        avg_confidence: avgConfidence,
        metadata: {
          model: GPT_MODEL,
          tokens_used: totalUsage,
          duration_seconds: durationSeconds,
          batches_processed: batches.length,
          source_framework: sourceFrameworkName,
          target_framework: targetFrameworkName,
          source_controls_count: sourceControls.length,
          target_controls_count: targetControls.length,
          compressed_index: compressed,
        },
      })
      .eq('id', crosswalkId);

    if (updateErr) {
      console.error(`  \u274c Failed to update crosswalk status: ${updateErr.message}`);
    }

    // 11. Update the job store with completion
    if (job) {
      jobs.set(jobId, {
        status: 'completed',
        completedAt: Date.now(),
        crosswalkId,
        totalMappings: insertedCount,
        avgConfidence,
        metadata: {
          model: GPT_MODEL,
          tokens_used: totalUsage,
          duration_seconds: durationSeconds,
          batches_processed: batches.length,
        },
      });
    }

    console.log(`\u2705 [Crosswalk ${crosswalkId}] Generation complete! ${insertedCount} mappings in ${durationSeconds}s`);

  } catch (err) {
    console.error(`\u274c [Crosswalk ${crosswalkId}] Generation failed:`, err.message);

    // Mark the crosswalk as failed in Supabase
    await supabase
      .from('crosswalks')
      .update({ status: 'failed', error: err.message })
      .eq('id', crosswalkId)
      .catch(e => console.error('  Failed to update crosswalk error status:', e.message));

    // Update the job store
    if (job) {
      jobs.set(jobId, {
        status: 'failed',
        completedAt: Date.now(),
        error: err.message,
      });
    }
  }
}

module.exports = { runCrosswalkGeneration };
