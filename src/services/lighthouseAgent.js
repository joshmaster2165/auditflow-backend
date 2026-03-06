const OpenAI = require('openai');
const fs = require('fs');
const { supabase, supabaseAdmin, downloadFile, cleanupFile } = require('../utils/supabase');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Constants ──
const LIGHTHOUSE_MODEL = 'gpt-5.1';
const MAX_FUNCTION_CALL_LOOPS = 5;

// ── System Prompt ──
const LIGHTHOUSE_SYSTEM_PROMPT = `You are Lighthouse, the AI evidence librarian for AuditFlow — a compliance audit platform. You have deep knowledge of compliance frameworks (ISO 27001, SOC 2, NIST, HIPAA, PCI-DSS, GDPR, and others) and specialize in helping auditors navigate their evidence libraries.

## Your Capabilities
1. **Evidence Search**: You can search through all uploaded evidence documents in this project using file search. When answering questions, always search the evidence library first.
2. **Quantitative Data**: You can look up project compliance statistics, control-level analysis results, evidence inventories, and search across all analysis findings using your function tools.
3. **Compliance Expertise**: You understand compliance frameworks, control requirements, and audit methodology.

## How to Respond
- **Always cite your sources.** When referencing evidence documents, name the specific file and quote relevant passages.
- **Be specific and quantitative.** Use the function tools to provide exact compliance scores, statuses, and counts rather than speaking in generalities.
- **Be thorough but concise.** Auditors need actionable information, not lengthy prose.
- **When asked about compliance posture**, use get_project_summary for overall stats and search_analysis_results to find specific gaps.
- **When asked about a specific control**, use get_control_analysis to get the latest analysis results.
- **When asked about what evidence exists**, use get_evidence_list to provide an inventory.
- **When asked about document contents**, use file search to find relevant passages in the uploaded evidence.

## Response Format
- Use markdown formatting for readability.
- When citing evidence, use format: **[filename.pdf]** or quote specific passages with > blockquotes.
- For compliance scores, use tables when comparing multiple controls.
- For gaps and findings, use bullet points with clear status indicators.

## Important Rules
- Never fabricate evidence or findings. If you cannot find relevant information, say so clearly.
- Always distinguish between what the evidence shows and your interpretation.
- When a document is ambiguous about compliance, note the ambiguity rather than making assumptions.
- You do not have access to modify any data — you are read-only. Direct users to the appropriate AuditFlow features for making changes.`;

// ── Function Tool Definitions ──
const FUNCTION_TOOLS = [
  {
    type: 'function',
    name: 'get_project_summary',
    description: 'Get overall compliance statistics for the current project, including total analyses, compliance rates, and status breakdown. Use this when the auditor asks about overall project health or compliance posture.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project UUID' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'get_control_analysis',
    description: 'Get the latest analysis results for a specific control, including compliance percentage, status, findings, and recommendations. Use when the auditor asks about a specific control or requirement.',
    parameters: {
      type: 'object',
      properties: {
        control_number: { type: 'string', description: 'The control number (e.g. "A.5.1" or "AC-1"). Use this if the user references a control by number.' },
        project_id: { type: 'string', description: 'The project UUID' },
      },
      required: ['project_id', 'control_number'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'get_evidence_list',
    description: 'List all evidence files uploaded to the project with their file names, types, associated controls, and analysis status. Use when the auditor asks what evidence exists or wants an inventory.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project UUID' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'search_analysis_results',
    description: 'Search across all analysis findings, gaps, and recommendations in the project. Use when the auditor asks about specific topics, compliance gaps, or patterns across controls.',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'The project UUID' },
        query: { type: 'string', description: 'Search query to match against findings, summaries, and recommendations' },
        status_filter: { type: 'string', description: 'Filter by status: compliant, partial, non_compliant, or all', enum: ['compliant', 'partial', 'non_compliant', 'all'] },
      },
      required: ['project_id', 'query', 'status_filter'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

/**
 * Resolve a project ID to all its control IDs through the relationship chain:
 * projects.framework_id → controls.framework_id → control IDs
 *
 * Used as fallback when direct project_id queries return 0 results.
 */
async function getProjectControlIds(projectId) {
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('framework_id')
    .eq('id', projectId)
    .single();

  if (!project?.framework_id) {
    console.log(`📚 getProjectControlIds: no framework_id for project ${projectId}`);
    return [];
  }

  const { data: controls } = await supabaseAdmin
    .from('controls')
    .select('id')
    .eq('framework_id', project.framework_id);

  const ids = (controls || []).map(c => c.id);
  console.log(`📚 getProjectControlIds: project=${projectId}, framework=${project.framework_id}, controls=${ids.length}`);
  return ids;
}

// ═══════════════════════════════════════════════════════
// Vector Store Lifecycle
// ═══════════════════════════════════════════════════════

/**
 * Get or create the OpenAI vector store for a project.
 * Lazy-initializes on first call, stores the ID in projects table.
 */
async function getOrCreateVectorStore(projectId) {
  // 1. Check if project already has a vector store
  const { data: project } = await supabaseAdmin
    .from('projects')
    .select('openai_vector_store_id, name')
    .eq('id', projectId)
    .single();

  if (project?.openai_vector_store_id) {
    return project.openai_vector_store_id;
  }

  // 2. Create new vector store
  const vectorStore = await openai.vectorStores.create({
    name: `AuditFlow: ${project?.name || projectId}`,
    metadata: { project_id: projectId },
  });

  // 3. Persist to DB
  await supabaseAdmin
    .from('projects')
    .update({ openai_vector_store_id: vectorStore.id })
    .eq('id', projectId);

  console.log(`📚 Created vector store ${vectorStore.id} for project ${projectId}`);
  return vectorStore.id;
}

/**
 * Upload a single evidence file to the project's vector store.
 * Non-blocking — called after evidence upload or during sync.
 */
async function uploadEvidenceToVectorStore(evidenceRecord) {
  let tempFilePath = null;
  try {
    const { id, project_id, file_path, file_name, file_type } = evidenceRecord;

    // Skip images — they're not useful for vector search
    const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (imageTypes.includes(file_type)) {
      console.log(`📚 Skipping image for vector store: ${file_name}`);
      return null;
    }

    const vectorStoreId = await getOrCreateVectorStore(project_id);

    // Download from Supabase Storage to temp file
    tempFilePath = await downloadFile(file_path);

    // Upload to OpenAI Files API + attach to vector store
    const file = await openai.files.create({
      file: fs.createReadStream(tempFilePath),
      purpose: 'assistants', // Required for vector store usage
    });

    await openai.vectorStores.files.create(vectorStoreId, {
      file_id: file.id,
    });

    // Store the openai_file_id on the evidence record
    await supabaseAdmin
      .from('evidence')
      .update({ openai_file_id: file.id })
      .eq('id', id);

    console.log(`📚 Uploaded ${file_name} to vector store (file: ${file.id})`);
    return file.id;
  } catch (err) {
    console.error(`❌ Failed to upload evidence to vector store: ${err.message}`);
    return null;
  } finally {
    if (tempFilePath) cleanupFile(tempFilePath);
  }
}

/**
 * Remove an evidence file from the vector store when evidence is deleted.
 */
async function removeEvidenceFromVectorStore(evidenceRecord) {
  try {
    const { openai_file_id, project_id } = evidenceRecord;
    if (!openai_file_id) return;

    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('openai_vector_store_id')
      .eq('id', project_id)
      .single();

    if (project?.openai_vector_store_id) {
      try {
        await openai.vectorStores.files.del(project.openai_vector_store_id, openai_file_id);
      } catch (e) {
        console.warn(`⚠️ Could not remove file from vector store: ${e.message}`);
      }
    }

    // Delete from OpenAI Files
    try {
      await openai.files.del(openai_file_id);
    } catch (e) {
      console.warn(`⚠️ Could not delete OpenAI file: ${e.message}`);
    }

    console.log(`📚 Removed file ${openai_file_id} from vector store`);
  } catch (err) {
    console.error(`⚠️ Failed to remove evidence from vector store: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════
// Function Call Handlers
// ═══════════════════════════════════════════════════════

async function executeFunctionCall(name, args) {
  switch (name) {
    case 'get_project_summary': {
      const { project_id } = args;
      console.log(`📚 get_project_summary: project_id=${project_id}`);

      // Try direct project_id first, fallback to control-based query
      let { data: analyses } = await supabaseAdmin
        .from('analysis_results')
        .select('status, compliance_percentage, confidence_score')
        .eq('project_id', project_id)
        .not('status', 'eq', 'error');

      // Fallback: query through project → framework → controls
      if (!analyses || analyses.length === 0) {
        console.log(`📚 get_project_summary: direct query returned 0 — trying control-based fallback`);
        const controlIds = await getProjectControlIds(project_id);
        if (controlIds.length > 0) {
          ({ data: analyses } = await supabaseAdmin
            .from('analysis_results')
            .select('status, compliance_percentage, confidence_score')
            .in('control_id', controlIds)
            .not('status', 'eq', 'error'));
        }
      }

      const total = analyses?.length || 0;
      const compliant = analyses?.filter(a => a.status === 'compliant').length || 0;
      const partial = analyses?.filter(a => a.status === 'partial').length || 0;
      const nonCompliant = analyses?.filter(a => a.status === 'non_compliant').length || 0;
      const avgCompliance = total > 0
        ? Math.round(analyses.reduce((sum, a) => sum + (parseFloat(a.compliance_percentage) || 0), 0) / total)
        : 0;

      // Count evidence — direct first, fallback to control-based
      let { count: evidenceCount } = await supabaseAdmin
        .from('evidence')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project_id);

      if (!evidenceCount || evidenceCount === 0) {
        const controlIds = await getProjectControlIds(project_id);
        if (controlIds.length > 0) {
          ({ count: evidenceCount } = await supabaseAdmin
            .from('evidence')
            .select('id', { count: 'exact', head: true })
            .in('control_id', controlIds));
        }
      }

      console.log(`📚 get_project_summary: analyses=${total}, evidence=${evidenceCount || 0}`);

      return JSON.stringify({
        total_analyses: total,
        compliant,
        partial,
        non_compliant: nonCompliant,
        average_compliance_percentage: avgCompliance,
        overall_status: total === 0 ? 'no_analyses' : compliant === total ? 'compliant' : nonCompliant > 0 ? 'non_compliant' : 'partial',
        evidence_files_count: evidenceCount || 0,
      });
    }

    case 'get_control_analysis': {
      const { project_id, control_number } = args;
      console.log(`📚 get_control_analysis: project_id=${project_id}, control=${control_number}`);

      // Scope control search to this project's framework
      const controlIds = await getProjectControlIds(project_id);

      let controlQuery = supabaseAdmin
        .from('controls')
        .select('id, control_number, title, description, category')
        .ilike('control_number', control_number);

      // If we found the project's controls, scope to them
      if (controlIds.length > 0) {
        controlQuery = controlQuery.in('id', controlIds);
      }

      const { data: controls } = await controlQuery;

      if (!controls || controls.length === 0) {
        return JSON.stringify({ error: `Control "${control_number}" not found` });
      }

      const matchedControlIds = controls.map(c => c.id);

      // Get analyses — try direct project_id first, fallback to control-based
      let { data: analyses } = await supabaseAdmin
        .from('analysis_results')
        .select('status, compliance_percentage, confidence_score, summary, recommendations, findings, analyzed_at, evidence:evidence_id (file_name)')
        .in('control_id', matchedControlIds)
        .eq('project_id', project_id)
        .not('status', 'eq', 'error')
        .order('analyzed_at', { ascending: false })
        .limit(10);

      // Fallback: without project_id filter (already scoped by control IDs within the project)
      if (!analyses || analyses.length === 0) {
        ({ data: analyses } = await supabaseAdmin
          .from('analysis_results')
          .select('status, compliance_percentage, confidence_score, summary, recommendations, findings, analyzed_at, evidence:evidence_id (file_name)')
          .in('control_id', matchedControlIds)
          .not('status', 'eq', 'error')
          .order('analyzed_at', { ascending: false })
          .limit(10));
      }

      console.log(`📚 get_control_analysis: found ${analyses?.length || 0} analyses`);

      return JSON.stringify({
        control: controls[0],
        analyses: analyses || [],
        analysis_count: analyses?.length || 0,
      });
    }

    case 'get_evidence_list': {
      const { project_id } = args;
      console.log(`📚 get_evidence_list: project_id=${project_id}`);

      // Primary: direct project_id query
      let { data } = await supabaseAdmin
        .from('evidence')
        .select('id, file_name, file_type, control_id, created_at, controls:control_id (title, control_number)')
        .eq('project_id', project_id)
        .order('created_at', { ascending: false });

      // Fallback: query through project → framework → controls chain
      if (!data || data.length === 0) {
        console.log(`📚 get_evidence_list: direct query returned 0 — trying control-based fallback`);
        const controlIds = await getProjectControlIds(project_id);
        if (controlIds.length > 0) {
          ({ data } = await supabaseAdmin
            .from('evidence')
            .select('id, file_name, file_type, control_id, created_at, controls:control_id (title, control_number)')
            .in('control_id', controlIds)
            .order('created_at', { ascending: false }));
        }
      }

      console.log(`📚 get_evidence_list: found ${data?.length || 0} files`);

      return JSON.stringify({
        evidence_files: data || [],
        total_count: data?.length || 0,
      });
    }

    case 'search_analysis_results': {
      const { project_id, query, status_filter } = args;
      console.log(`📚 search_analysis_results: project_id=${project_id}, query="${query}"`);

      // Primary: direct project_id query
      let dbQuery = supabaseAdmin
        .from('analysis_results')
        .select('summary, status, compliance_percentage, recommendations, controls:control_id (title, control_number), evidence:evidence_id (file_name)')
        .eq('project_id', project_id)
        .not('status', 'eq', 'error');

      if (status_filter && status_filter !== 'all') {
        dbQuery = dbQuery.eq('status', status_filter);
      }

      let { data } = await dbQuery.order('analyzed_at', { ascending: false });

      // Fallback: query through project → framework → controls
      if (!data || data.length === 0) {
        console.log(`📚 search_analysis_results: direct query returned 0 — trying control-based fallback`);
        const controlIds = await getProjectControlIds(project_id);
        if (controlIds.length > 0) {
          let fallbackQuery = supabaseAdmin
            .from('analysis_results')
            .select('summary, status, compliance_percentage, recommendations, controls:control_id (title, control_number), evidence:evidence_id (file_name)')
            .in('control_id', controlIds)
            .not('status', 'eq', 'error');

          if (status_filter && status_filter !== 'all') {
            fallbackQuery = fallbackQuery.eq('status', status_filter);
          }

          ({ data } = await fallbackQuery.order('analyzed_at', { ascending: false }));
        }
      }

      // Text search filtering on summary and recommendations
      const queryLower = query.toLowerCase();
      const filtered = (data || []).filter(r => {
        const searchText = `${r.summary || ''} ${JSON.stringify(r.recommendations || [])}`.toLowerCase();
        return searchText.includes(queryLower);
      });

      console.log(`📚 search_analysis_results: ${data?.length || 0} total, ${filtered.length} matched query`);

      return JSON.stringify({
        results: filtered.slice(0, 20),
        total_matches: filtered.length,
        query,
      });
    }

    default:
      return JSON.stringify({ error: `Unknown function: ${name}` });
  }
}

// ═══════════════════════════════════════════════════════
// Streaming Chat
// ═══════════════════════════════════════════════════════

/**
 * Stream a chat response via SSE using the OpenAI Responses API.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.message - User's message text
 * @param {string|null} opts.lastResponseId - Previous response ID for conversation continuity
 * @param {string|null} opts.customInstructions - Project-level custom instructions
 * @param {string} opts.vectorStoreId - The project's vector store ID
 * @param {import('express').Response} opts.res - Express response object (SSE)
 * @returns {Object} The final response object
 */
async function streamChat({ projectId, message, lastResponseId, customInstructions, vectorStoreId, res }) {
  // Build instructions with project context
  let instructions = LIGHTHOUSE_SYSTEM_PROMPT;
  if (customInstructions) {
    instructions += `\n\n## Project-Specific Instructions\n${customInstructions}`;
  }
  instructions += `\n\n## Context\nCurrent project ID: ${projectId}. Always pass this project_id when calling function tools.`;

  // Build tools: file_search + custom functions
  const tools = [
    ...(vectorStoreId ? [{
      type: 'file_search',
      vector_store_ids: [vectorStoreId],
    }] : []),
    ...FUNCTION_TOOLS,
  ];

  // Initial input: the user message
  const input = [{ role: 'user', content: message }];

  // Recursive function to handle the response + function call loop
  let loopCount = 0;

  async function executeResponseLoop(currentInput, currentPreviousResponseId) {
    loopCount++;
    if (loopCount > MAX_FUNCTION_CALL_LOOPS) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Too many function call iterations' })}\n\n`);
      return null;
    }

    const stream = await openai.responses.create({
      model: LIGHTHOUSE_MODEL,
      instructions,
      input: currentInput,
      tools,
      previous_response_id: currentPreviousResponseId || undefined,
      stream: true,
      temperature: 0.3,
    });

    let fullResponse = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          res.write(`data: ${JSON.stringify({ type: 'text_delta', delta: event.delta })}\n\n`);
          break;

        case 'response.function_call_arguments.done':
          res.write(`data: ${JSON.stringify({ type: 'status', message: `Looking up ${event.name}...` })}\n\n`);
          break;

        case 'response.completed':
          fullResponse = event.response;
          break;
      }
    }

    if (!fullResponse) {
      return null;
    }

    // Check if the response contains function calls
    const functionCalls = (fullResponse.output || []).filter(item => item.type === 'function_call');

    if (functionCalls.length > 0) {
      // Execute all function calls
      const functionOutputs = [];
      for (const fc of functionCalls) {
        let args;
        try {
          args = JSON.parse(fc.arguments);
        } catch (e) {
          args = {};
        }
        // Inject projectId if not provided
        if (!args.project_id) args.project_id = projectId;

        const result = await executeFunctionCall(fc.name, args);
        functionOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: result,
        });
      }

      // Continue the conversation with function results
      return executeResponseLoop(functionOutputs, fullResponse.id);
    }

    // No more function calls — done
    return fullResponse;
  }

  return executeResponseLoop(input, lastResponseId);
}

module.exports = {
  getOrCreateVectorStore,
  uploadEvidenceToVectorStore,
  removeEvidenceFromVectorStore,
  getProjectControlIds,
  streamChat,
};
