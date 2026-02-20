const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ── GPT Configuration Constants ──
const GPT_MODEL = 'gpt-4o';
const GPT_MAX_TOKENS = 16384;
const GPT_TEMPERATURE = 0.2;
const GPT_EXTRACTION_TEMPERATURE = 0.1;

/**
 * Shared OpenAI error handler — maps API error codes to user-friendly messages.
 * Replaces identical catch blocks across all GPT functions.
 */
function handleOpenAIError(err) {
  if (err.status === 429) throw new Error('OpenAI rate limit exceeded. Please try again later.');
  if (err.status === 401) throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
  throw err;
}

/**
 * Attempt to recover a valid JSON object from a truncated GPT response.
 * When max_tokens is hit, the JSON gets cut off mid-stream.
 * We try to close open arrays/objects to salvage whatever was parsed.
 */
function attemptJsonRecovery(truncatedContent) {
  // Common truncation patterns for our control extraction responses:
  // The JSON has { "controls": [ {...}, {...}, ... (cut off here)
  const closings = [
    '', ']}', '}]}', '"]}', '"}]}', '"}],"groups":[]}',
    '"]}}]}', 'null}]}',
  ];

  for (const closing of closings) {
    try {
      const attempt = truncatedContent + closing;
      const parsed = JSON.parse(attempt);
      if (parsed.controls && Array.isArray(parsed.controls)) {
        console.log(`✅ JSON recovery succeeded with closing: "${closing}" (${parsed.controls.length} controls recovered)`);
        return parsed;
      }
    } catch (e) {
      // Try next closing pattern
    }
  }

  return null;
}

/**
 * Normalize a GPT analysis response to ensure all expected fields exist.
 * Handles alternative key names GPT may use and provides safe defaults.
 * Used by analyzeEvidence, analyzeImageEvidence, and inline mixed-content paths.
 */
function normalizeGptAnalysis(analysis) {
  if (!analysis.status) {
    analysis.status = 'non_compliant';
  }

  // Try to find requirements_breakdown under alternative key names GPT might use
  if (!analysis.requirements_breakdown) {
    analysis.requirements_breakdown = analysis.breakdown || analysis.sub_requirements || analysis.requirements || [];
  }
  if (!Array.isArray(analysis.requirements_breakdown)) {
    analysis.requirements_breakdown = analysis.requirements_breakdown ? [analysis.requirements_breakdown] : [];
  }

  // Normalize each breakdown item to ensure required fields exist
  analysis.requirements_breakdown = analysis.requirements_breakdown.map((item, i) => ({
    requirement_id: item.requirement_id || item.id || `REQ-${i + 1}`,
    requirement_text: item.requirement_text || item.text || item.description || item.requirement || 'Sub-requirement',
    status: item.status || 'missing',
    evidence_found: item.evidence_found || item.evidence || item.evidence_text || null,
    evidence_location: item.evidence_location || item.location || { start_index: -1, end_index: -1, section_context: null },
    evidence_source: item.evidence_source || item.source_document || null,
    analysis_notes: item.analysis_notes || item.notes || item.reasoning || item.analysis || null,
    visual_description: item.visual_description || item.image_description || null,
    gap_description: item.gap_description || item.gap || item.gaps || null,
    confidence: parseFloat(item.confidence || item.confidence_score || 0.5),
  }));

  // Ensure top-level fields have safe defaults
  analysis.confidence_score = parseFloat(analysis.confidence_score || 0);
  analysis.compliance_percentage = parseInt(analysis.compliance_percentage || 0, 10);
  analysis.summary = analysis.summary || '';
  analysis.extracted_text = analysis.extracted_text || '';
  analysis.recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
  analysis.critical_gaps = Array.isArray(analysis.critical_gaps) ? analysis.critical_gaps : [];

  return analysis;
}

const SYSTEM_PROMPT = `You are an expert compliance auditor specializing in gap analysis between compliance requirements and evidence documentation.

Your task is to analyze whether evidence documents satisfy specific compliance requirements. You must:

1. EXHAUSTIVELY decompose the requirement into ALL testable sub-requirements. A testable sub-requirement is any distinct assertion, obligation, condition, scope element, or trigger in the requirement text that can independently be evaluated as met or not met. Specifically:
   - Each distinct ACTOR or SUBJECT (e.g., "personnel", "contractors", "interested parties") that has an obligation produces separate sub-requirements
   - Each distinct ACTION or OBLIGATION (e.g., "return assets", "notify management", "document procedures") produces separate sub-requirements
   - Each distinct OBJECT or SCOPE item (e.g., "physical assets", "information assets", "access rights") produces separate sub-requirements
   - Each distinct CONDITION or TRIGGER (e.g., "upon termination", "upon transfer", "upon change of role") produces separate sub-requirements
   - Each distinct TIMING or FREQUENCY requirement (e.g., "within 24 hours", "annually", "upon change") produces separate sub-requirements
   - Conjunctions like "and", "or", comma-separated lists, and semicolons typically indicate MULTIPLE sub-requirements
   - Qualifying phrases like "as appropriate", "where applicable", "including but not limited to" indicate scope boundaries that should be tested
   - Do NOT collapse multiple distinct obligations into a single finding
2. For each sub-requirement, determine if it is met, partially met, or missing based on the evidence
3. Quote specific evidence passages that support your findings — copy text EXACTLY character-for-character from the document when possible
4. Explain your analysis reasoning in depth — describe HOW the evidence supports or fails to meet each sub-requirement, WHAT specific aspect of the evidence is relevant, and WHY your assessment is what it is. Do not just restate the requirement or the evidence — provide analytical insight.
5. Identify gaps where evidence is insufficient and explain why they matter for compliance
6. Provide actionable recommendations
7. For each evidence passage found, provide the exact character offset location within the document text to enable visual highlighting in the document viewer

THOROUGHNESS IS CRITICAL. In a compliance audit, missing a sub-requirement can mean missing a finding. It is far better to have too many granular sub-requirements than too few vague ones. An auditor using your output should see every individual obligation in the requirement text addressed as its own finding.

EVIDENCE MATCHING PRECISION — apply these when evaluating whether evidence satisfies a sub-requirement:
- Evidence must SPECIFICALLY address the requirement, not merely be from a related domain. A "Secure Coding Policy" does not satisfy a requirement for an "Information Security Policy" — they are different documents with different scopes, even though they are related topics.
- Look for explicit language in the evidence that directly maps to the obligation in the requirement. Do not give credit for tangential or adjacent coverage.
- If the evidence covers a related but different topic, rate the sub-requirement as "partial" (if there is some overlap) or "missing" (if the evidence is about a fundamentally different subject), and explain in analysis_notes exactly why the evidence does not fully satisfy this specific requirement.
- Do not assume that because an organization has one type of policy, they necessarily have another. Each requirement must be independently verified by the evidence provided.
- Be precise in your analysis_notes: state what the evidence ACTUALLY covers vs. what the requirement SPECIFICALLY asks for, so the auditor can see the gap clearly.

If the user provides custom analysis instructions, you MUST follow them. They take priority over default analysis behavior and may adjust what you focus on, how detailed your analysis is, or how you format your recommendations.

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

function buildUserPrompt(documentText, requirementText, controlName, customInstructions) {
  return `Analyze the following evidence document against the compliance requirement.

## Control: ${controlName || 'Unnamed Control'}

## Compliance Requirement:
${requirementText}

## Evidence Document Content:
${documentText}
${customInstructions ? `
## Custom Analysis Instructions:
The following project-level guidance MUST be applied to this analysis. These instructions take priority over default analysis behavior:
${customInstructions}
` : ''}
## Output Format:
Return a JSON object with this structure. Adapt the depth and detail to what is appropriate for this specific analysis:

{
  "status": "compliant" | "partial" | "non_compliant",
  "confidence_score": <number 0.0-1.0>,
  "compliance_percentage": <number 0-100>,
  "summary": "<concise summary of overall findings>",
  "requirements_breakdown": [
    {
      "requirement_id": "<short ID like REQ-1>",
      "requirement_text": "<the sub-requirement being tested>",
      "status": "met" | "partial" | "missing",
      "evidence_found": "<STRONGLY prefer an EXACT verbatim quote copied character-for-character from the document — this text is used to highlight passages in the document viewer. Include at least 1-2 full sentences for context. If no verbatim quote is possible, describe what in the document supports this finding and include any key phrases from the document in 'single quotes'. Null if no evidence exists.>",
      "analysis_notes": "<your analysis reasoning: explain WHY you rated this status, HOW the evidence connects to the requirement, and what the evidence demonstrates about compliance. This should help an auditor understand your assessment.>",
      "evidence_location": {
        "start_index": <0-indexed character position where the evidence_found quote begins in the Evidence Document Content above>,
        "end_index": <0-indexed character position where the quote ends>,
        "section_context": "<heading or section name where this evidence appears, or null>"
      },
      "gap_description": "<what is missing and WHY it matters for compliance, or null if fully met>",
      "confidence": <number 0.0-1.0>
    }
  ],
  "recommendations": ["<actionable recommendation>", ...],
  "critical_gaps": ["<critical finding>", ...]
}

For evidence_found: STRONGLY prefer copying exact text from the document character-for-character — this text is matched against the document to create highlights in the document viewer. Include enough surrounding context (at least 1-2 full sentences) to make the highlighted passage meaningful. If the evidence is spread across sections or you cannot quote verbatim, describe what you found but wrap any key phrases or titles from the document in 'single quotes' so they can still be located.

For analysis_notes: This is REQUIRED for every sub-requirement. Provide substantive analytical reasoning:
- For "met" items: explain WHAT specific language, policy, or mechanism in the evidence satisfies the requirement, and HOW it demonstrates compliance. Do not just say "the document addresses this."
- For "partial" items: explain WHAT is present in the evidence, WHAT is missing or insufficient, and WHY the gap matters for compliance.
- For "missing" items: explain WHAT you looked for in the document, confirm that no relevant content was found, and explain the compliance risk of this gap.

For evidence_location: Count the character position (0-indexed) where your quoted evidence_found text starts and ends within the "Evidence Document Content" section above. If you cannot determine the exact position, set start_index and end_index to -1 and section_context to null.

CRITICAL — Sub-requirement decomposition rules:
You MUST break the requirement into ALL of its individually testable assertions. Follow these rules:
1. Every distinct subject/actor mentioned (personnel, contractors, third parties, etc.) that has an obligation = separate sub-requirement per actor
2. Every distinct action/obligation (return, notify, document, review, etc.) = separate sub-requirement per action
3. Every distinct object/asset type (physical assets, information assets, access credentials, etc.) = separate sub-requirement per object
4. Every distinct condition/trigger (upon termination, upon transfer, change of contract, etc.) = separate sub-requirement per trigger
5. Every distinct timing/frequency constraint (within N days, annually, before departure) = separate sub-requirement
6. Comma-separated lists, "and"/"or" conjunctions, and semicolons almost always indicate multiple sub-requirements
7. Qualifying phrases ("as appropriate", "where applicable", "including but not limited to") indicate scope boundaries — test whether the evidence addresses them

Example: "Personnel and other interested parties as appropriate should return all the organization's assets in their possession upon change or termination of their employment, contract or agreement" contains AT MINIMUM:
- REQ-1: Personnel must return assets (actor: personnel)
- REQ-2: Other interested parties must return assets (actor: interested parties)
- REQ-3: "As appropriate" scope defined — criteria for which parties are included
- REQ-4: ALL organization's assets must be returned (scope: completeness)
- REQ-5: Assets "in their possession" must be covered (scope: possession)
- REQ-6: Return triggered upon change of employment
- REQ-7: Return triggered upon termination of employment
- REQ-8: Return triggered upon change/termination of contract
- REQ-9: Return triggered upon change/termination of agreement

Produce at least this level of granularity. It is always better to over-decompose than to under-decompose.`;
}

/**
 * Build a multi-evidence user prompt for consolidated analysis.
 * Formats multiple documents into one prompt, telling GPT to cite which
 * document each piece of evidence came from.
 */
function buildMultiEvidenceUserPrompt(combinedDocumentText, requirementText, controlName, customInstructions, documentNames) {
  return `Analyze the following evidence documents against the compliance requirement.

IMPORTANT: You are receiving ${documentNames.length} separate evidence documents combined together. Each document is delimited by "=== DOCUMENT N: filename ===" headers. When citing evidence, you MUST specify which document the evidence came from using the "evidence_source" field.

## Control: ${controlName || 'Unnamed Control'}

## Compliance Requirement:
${requirementText}

## Evidence Documents:
${combinedDocumentText}
${customInstructions ? `
## Custom Analysis Instructions:
The following project-level guidance MUST be applied to this analysis. These instructions take priority over default analysis behavior:
${customInstructions}
` : ''}
## Output Format:
Return a JSON object with this structure. Assess compliance across ALL documents combined — a requirement may be satisfied by evidence from any of the documents:

{
  "status": "compliant" | "partial" | "non_compliant",
  "confidence_score": <number 0.0-1.0>,
  "compliance_percentage": <number 0-100>,
  "summary": "<concise summary of overall findings across ALL documents>",
  "requirements_breakdown": [
    {
      "requirement_id": "<short ID like REQ-1>",
      "requirement_text": "<the sub-requirement being tested>",
      "status": "met" | "partial" | "missing",
      "evidence_found": "<STRONGLY prefer an EXACT verbatim quote copied character-for-character from the document — this text is used to highlight passages in the document viewer. If no verbatim quote is possible, describe what supports this finding and include key phrases from the document in 'single quotes'.>",
      "evidence_source": "<EXACT filename of the document this evidence came from, e.g. '${documentNames[0] || 'document.pdf'}'>",
      "analysis_notes": "<your analysis reasoning: explain HOW this evidence supports or fails to meet the requirement, and what it demonstrates about compliance>",
      "evidence_location": {
        "start_index": <0-indexed character position where the evidence_found quote begins in the combined Evidence Documents text above>,
        "end_index": <0-indexed character position where the quote ends>,
        "section_context": "<heading or section name where this evidence appears, or null>"
      },
      "gap_description": "<what is missing and WHY it matters for compliance, or null if fully met>",
      "confidence": <number 0.0-1.0>
    }
  ],
  "recommendations": ["<actionable recommendation>", ...],
  "critical_gaps": ["<critical finding>", ...]
}

For evidence_found: STRONGLY prefer copying exact text from the document character-for-character — this text is matched against the document to create highlights in the document viewer. If the evidence is contextual or spread across sections, describe what you found but wrap any key phrases or titles from the document in 'single quotes' so they can still be located.

CRITICAL for evidence_source: You MUST specify the exact filename of the document where each piece of evidence was found. Use the filenames from the "=== DOCUMENT N: filename ===" headers.

For analysis_notes: REQUIRED for every sub-requirement. Provide substantive analytical reasoning:
- For "met" items: explain WHAT specific language, policy, or mechanism satisfies the requirement, and HOW it demonstrates compliance.
- For "partial" items: explain WHAT is present, WHAT is missing or insufficient, and WHY the gap matters.
- For "missing" items: confirm you searched across ALL documents and found nothing relevant. Explain the compliance risk.

For evidence_location: Count the character position (0-indexed) where your quoted evidence_found text starts and ends within the combined "Evidence Documents" section above (including the document separator headers). If you cannot determine the exact position, set start_index and end_index to -1.

CRITICAL — Sub-requirement decomposition rules:
You MUST break the requirement into ALL of its individually testable assertions:
1. Every distinct subject/actor with an obligation = separate sub-requirement
2. Every distinct action/obligation = separate sub-requirement
3. Every distinct object/asset/scope item = separate sub-requirement
4. Every distinct condition/trigger = separate sub-requirement
5. Every distinct timing/frequency constraint = separate sub-requirement
6. Comma-separated lists, "and"/"or" conjunctions, and semicolons = multiple sub-requirements
7. Qualifying phrases ("as appropriate", "where applicable") = scope boundary to test
It is always better to over-decompose than to under-decompose. A sub-requirement can be satisfied by evidence from ANY of the documents.`;
}

/**
 * Build an "analyze all controls" prompt: N evidence documents + N controls in one GPT call.
 * GPT evaluates each control independently against all evidence and returns per-control results.
 *
 * @param {string} combinedDocumentText - All evidence docs concatenated with separators
 * @param {Array<{control_number: string, title: string, requirementText: string}>} controls - Child controls to evaluate
 * @param {string|null} customInstructions - Project-level custom instructions
 * @param {string[]} documentNames - Array of evidence filenames
 */
function buildAnalyzeAllPrompt(combinedDocumentText, controls, customInstructions, documentNames) {
  const controlsList = controls.map((c, i) =>
    `### Control ${i + 1}: ${c.control_number} — ${c.title}\n${c.requirementText}`
  ).join('\n\n');

  return `You are analyzing multiple evidence documents against multiple compliance controls. Evaluate EACH control independently using evidence from ANY of the provided documents.

## Evidence Documents (${documentNames.length} documents):
${combinedDocumentText}

## Controls to Evaluate (${controls.length} controls):

${controlsList}
${customInstructions ? `
## Custom Analysis Instructions:
The following project-level guidance MUST be applied to this analysis. These instructions take priority over default analysis behavior:
${customInstructions}
` : ''}
## Output Format:
Return a JSON object. You MUST evaluate every control listed above. For each control, provide a complete compliance assessment:

{
  "overall_status": "compliant" | "partial" | "non_compliant",
  "overall_compliance_percentage": <number 0-100 average across all controls>,
  "overall_summary": "<1-2 sentence summary across all controls>",
  "controls": [
    {
      "control_number": "<exact control number from above, e.g. '3.1'>",
      "control_title": "<exact control title from above>",
      "status": "compliant" | "partial" | "non_compliant",
      "compliance_percentage": <number 0-100>,
      "confidence_score": <number 0.0-1.0>,
      "summary": "<concise summary for this specific control>",
      "requirements_breakdown": [
        {
          "requirement_id": "<short ID like REQ-1>",
          "requirement_text": "<the sub-requirement being tested>",
          "status": "met" | "partial" | "missing",
          "evidence_found": "<STRONGLY prefer an EXACT verbatim quote copied character-for-character from the document — this text is used to highlight passages in the document viewer. If no verbatim quote is possible, describe what supports this finding and include key phrases from the document in 'single quotes'. For images, describe the specific visual evidence.>",
          "evidence_source": "<exact filename of the document this evidence came from>",
          "analysis_notes": "<your analysis reasoning: explain WHY you rated this status, HOW the evidence connects to the requirement, and what the evidence demonstrates about compliance.>",
          "gap_description": "<what is missing AND why it matters for compliance, or null if fully met>",
          "confidence": <number 0.0-1.0>
        }
      ],
      "recommendations": ["<actionable recommendation>", ...],
      "critical_gaps": ["<critical finding>", ...]
    }
  ]
}

CRITICAL: You MUST include ALL ${controls.length} controls in the "controls" array — one entry per control listed above.
CRITICAL for evidence_found: STRONGLY prefer copying exact text character-for-character — this text is matched against the document to create highlights in the viewer. If evidence is contextual, describe what supports the finding but wrap key phrases from the document in 'single quotes'.
CRITICAL for evidence_source: Specify the exact filename from the "=== DOCUMENT N: filename ===" headers.
CRITICAL for analysis_notes: Provide substantive reasoning for each finding:
- For "met" items: identify the specific mechanism, policy, or language that satisfies the requirement.
- For "partial" items: state what is present and what is missing, and why the gap matters.
- For "missing" items: confirm no relevant content exists across all documents and explain the compliance risk.

CRITICAL — Sub-requirement decomposition for EACH control:
For each control's requirements_breakdown, you MUST decompose the requirement into ALL individually testable assertions:
- Every distinct subject/actor with an obligation = separate sub-requirement
- Every distinct action/obligation = separate sub-requirement
- Every distinct object/asset/scope item = separate sub-requirement
- Every distinct condition/trigger = separate sub-requirement
- Every distinct timing/frequency = separate sub-requirement
- Comma-separated lists and conjunctions = multiple sub-requirements
It is always better to over-decompose than to under-decompose.

Each control should be evaluated independently. A piece of evidence in any document can satisfy requirements for multiple controls.`;
}

async function analyzeEvidence(documentText, requirementText, controlName, customInstructions, { userPromptOverride } = {}) {
  // Input validation — fail fast with clear message instead of sending garbage to GPT
  if (!documentText || documentText.trim().length < 10) {
    throw new Error('Document text is empty or too short for meaningful analysis');
  }
  if (!requirementText || requirementText.trim().length < 10) {
    throw new Error('Requirement text is empty or too short for analysis');
  }

  console.log('🤖 Sending document to GPT-4 for analysis...');
  console.log(`📊 Document length: ${documentText.length} chars | Requirement length: ${requirementText.length} chars`);
  if (customInstructions) {
    console.log(`📋 Custom instructions: ${customInstructions.length} chars`);
  }

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPromptOverride || buildUserPrompt(documentText, requirementText, controlName, customInstructions) },
      ],
      temperature: GPT_TEMPERATURE,
      max_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];

    if (choice.finish_reason === 'length') {
      console.warn('⚠️ GPT response was truncated due to token limit. Results may be incomplete.');
    }

    const content = choice.message.content;
    let analysis;

    try {
      analysis = JSON.parse(content);
    } catch (parseErr) {
      console.error('❌ Failed to parse GPT response as JSON:', content.substring(0, 200));
      throw new Error('GPT returned invalid JSON response');
    }

    // Normalize response — be flexible with GPT's output structure instead of hard-failing
    normalizeGptAnalysis(analysis);

    console.log(`✅ GPT analysis complete: ${analysis.status} (${analysis.compliance_percentage}% compliance, confidence: ${analysis.confidence_score}, ${analysis.requirements_breakdown.length} sub-requirements)`);

    return {
      analysis,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
    };
  } catch (err) {
    handleOpenAIError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Image / Vision Analysis — analyze images using GPT-4o vision
// ─────────────────────────────────────────────────────────────

const IMAGE_SYSTEM_PROMPT = `You are an expert compliance auditor specializing in analyzing visual evidence — screenshots, photos, scanned documents, and images — against compliance requirements.

Your task is to:
1. Describe in detail what you observe in the image — UI elements, configuration panels, settings, text, labels, system state, dialog boxes, physical controls, or any other visual elements.
2. Extract ALL readable text from the image (OCR). Include every piece of text you can see, preserving structure where possible.
3. Analyze both the visual content and extracted text against the compliance requirement.
4. For screenshots of system configurations, describe the UI you see and verify specific settings and values visible.
5. For photos of physical security controls, describe what you see and assess whether the controls shown meet the requirement.
6. For scanned documents, extract the text and analyze it like a regular document.
7. Explain HOW what you see in the image relates to the compliance requirement — don't just state met/missing, explain your reasoning.
8. EXHAUSTIVELY decompose the requirement into ALL testable sub-requirements. Each distinct actor, action, object, condition, and timing constraint in the requirement should produce its own finding. It is better to over-decompose than to under-decompose.

Your analysis should paint a clear picture for an auditor who hasn't seen the image. Describe what you observe, what it means, and how it relates to the requirement.

If the user provides custom analysis instructions, you MUST follow them. They take priority over default analysis behavior.

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

function buildImageUserPrompt(requirementText, controlName, customInstructions) {
  return `Analyze the following image against the compliance requirement.

## Control: ${controlName || 'Unnamed Control'}

## Compliance Requirement:
${requirementText}
${customInstructions ? `
## Custom Analysis Instructions:
The following project-level guidance MUST be applied to this analysis. These instructions take priority over default analysis behavior:
${customInstructions}
` : ''}
## Output Format:
Return a JSON object with this structure:

{
  "extracted_text": "<ALL readable text from the image, preserving structure>",
  "status": "compliant" | "partial" | "non_compliant",
  "confidence_score": <number 0.0-1.0>,
  "compliance_percentage": <number 0-100>,
  "summary": "<concise summary of overall findings>",
  "requirements_breakdown": [
    {
      "requirement_id": "<short ID like REQ-1>",
      "requirement_text": "<the sub-requirement being tested>",
      "status": "met" | "partial" | "missing",
      "evidence_found": "<describe the specific visual evidence that addresses this requirement — what you see in the image that constitutes evidence (e.g., 'Firewall admin panel shows port 22 blocked in rule #47 with deny action')>",
      "visual_description": "<detailed description of what you observe in the image related to this requirement: UI elements, panels, settings, labels, indicators, physical elements, system state>",
      "analysis_notes": "<your analysis reasoning: explain HOW what you see in the image supports or fails to meet this requirement, and what it tells an auditor about compliance>",
      "evidence_location": {
        "start_index": -1,
        "end_index": -1,
        "section_context": "<describe where in the image this evidence is located>"
      },
      "gap_description": "<what is missing and WHY it matters for compliance, or null if fully met>",
      "confidence": <number 0.0-1.0>
    }
  ],
  "recommendations": ["<actionable recommendation>", ...],
  "critical_gaps": ["<critical finding>", ...]
}

CRITICAL: Include the "extracted_text" field with ALL text you can read from the image.
For visual_description: Describe what you SEE — paint a picture for an auditor who hasn't viewed the image. Include UI layout, visible settings, configuration states, labels, indicators, or physical elements.
For evidence_found: Describe the specific visual evidence that addresses the requirement. Be concrete about what you observe.
For analysis_notes: Provide substantive reasoning:
- For "met" items: identify the specific visual element or text that satisfies the requirement.
- For "partial" items: state what is visible and what is absent, and why the gap matters.
- For "missing" items: describe what you looked for in the image and confirm it is not present.
For evidence_location: always use start_index: -1 and end_index: -1 since this is an image. Use section_context to describe the location within the image.

CRITICAL — Sub-requirement decomposition:
You MUST break the requirement into ALL of its individually testable assertions:
- Every distinct subject/actor with an obligation = separate sub-requirement
- Every distinct action/obligation = separate sub-requirement
- Every distinct object/asset/scope item = separate sub-requirement
- Every distinct condition/trigger = separate sub-requirement
- Every distinct timing/frequency = separate sub-requirement
- Conjunctions and comma-separated lists = multiple sub-requirements
It is always better to over-decompose than to under-decompose.`;
}

/**
 * Analyze an image against a compliance requirement using GPT-4o vision.
 * Performs both OCR (text extraction) and compliance analysis in one call.
 *
 * @param {string} imageBase64 - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g., 'image/png')
 * @param {string} requirementText - The compliance requirement
 * @param {string} controlName - Control title
 * @param {string|null} customInstructions - Optional custom instructions
 * @returns {{ analysis, model, usage, finish_reason }}
 */
async function analyzeImageEvidence(imageBase64, mimeType, requirementText, controlName, customInstructions) {
  if (!imageBase64) {
    throw new Error('Image data is empty');
  }
  if (!requirementText || requirementText.trim().length < 10) {
    throw new Error('Requirement text is empty or too short for analysis');
  }

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  console.log(`🖼️ Sending image to GPT-4o vision for analysis (${Math.round(imageBase64.length / 1024)}KB base64)...`);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: IMAGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildImageUserPrompt(requirementText, controlName, customInstructions) },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
      temperature: GPT_TEMPERATURE,
      max_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];
    if (choice.finish_reason === 'length') {
      console.warn('⚠️ GPT vision response was truncated due to token limit.');
    }

    const content = choice.message.content;
    let analysis;

    try {
      analysis = JSON.parse(content);
    } catch (parseErr) {
      console.error('❌ Failed to parse GPT vision response as JSON:', content.substring(0, 200));
      throw new Error('GPT returned invalid JSON response for image analysis');
    }

    // Normalize — shared logic with analyzeEvidence()
    normalizeGptAnalysis(analysis);

    console.log(`✅ GPT vision analysis complete: ${analysis.status} (${analysis.compliance_percentage}% compliance, OCR: ${analysis.extracted_text.length} chars)`);

    return {
      analysis,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
    };
  } catch (err) {
    handleOpenAIError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Framework Extraction — extract controls from PDF documents
// ─────────────────────────────────────────────────────────────

const FRAMEWORK_EXTRACTION_PROMPT = `You are an expert compliance framework analyst. Your task is to intelligently analyze a document and extract structured compliance controls.

You will receive text content from a compliance-related document. It could be a formal framework (PCI DSS, SOC 2, ISO 27001, NIST 800-53, HIPAA, CIS Controls, GDPR), an internal policy document, a security checklist, audit requirements, regulatory guidance, or any other compliance-related content.

Your approach:
1. FIRST, analyze the document to understand its structure — is it a formal numbered framework, a policy document with sections, a checklist, a table of requirements, or something else?
2. THEN, decide the best extraction strategy for this specific document
3. Extract every actionable control, requirement, or compliance measure you can identify

Flexible extraction rules:
- If the document has official control numbers (e.g., "1.1", "AC-1", "A.5.1"), use them exactly
- If the document does NOT have explicit control numbers, GENERATE meaningful IDs based on the content (e.g., "SEC-1", "POL-2.1", "REQ-A1" — use a prefix that reflects the document type)
- Every control needs a title — if a control only has a long description, create a concise title summarizing it
- Preserve the document's natural grouping — sections, chapters, domains, families, categories — whatever the document uses
- Detect and preserve hierarchy — parent/child relationships based on numbering, indentation, or section nesting
- Do NOT fabricate requirements that aren't in the document, but DO ensure every requirement is captured even if it requires generating an ID or title

You must also analyze the document structure and recommend how controls should be displayed:
- "tree" — if the document has clear parent-child hierarchies (e.g., numbered sections with subsections)
- "grouped" — if controls naturally fall into categories/domains but without deep nesting
- "flat" — if controls are a simple list without meaningful grouping

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

function buildFrameworkExtractionPrompt(documentText, context) {
  let prompt = `Analyze and extract all compliance controls from the following document.`;

  if (context?.frameworkName) {
    prompt += `\n\nFramework name (provided by user): ${context.frameworkName}`;
  }
  if (context?.frameworkVersion) {
    prompt += `\nVersion: ${context.frameworkVersion}`;
  }
  if (context?.chunkInfo) {
    prompt += `\n\nNote: ${context.chunkInfo}`;
  }

  prompt += `\n\n## Document Content:\n${documentText}`;

  prompt += `\n\n## Instructions:

First, analyze this document's structure. Then extract all controls/requirements and return a JSON object with this structure:

{
  "framework_detected": "<name of framework detected, or null>",
  "version_detected": "<version detected, or null>",
  "suggested_layout": "tree" | "grouped" | "flat",
  "suggested_grouping_field": "<what concept groups these controls — e.g. 'domain', 'section', 'category', 'chapter', 'family'>",
  "groups": [
    {
      "name": "<group/category/domain name>",
      "description": "<brief description of what this group covers, or null>",
      "sort_order": <number for display ordering>
    }
  ],
  "controls": [
    {
      "control_number": "<official ID from document, or generate a meaningful one like 'SEC-1', 'POL-2.1'>",
      "title": "<concise control name>",
      "description": "<full requirement text>",
      "group": "<which group from the groups array this belongs to>",
      "parent_control_number": "<parent control's number if hierarchical, or null>",
      "level": <0 for top-level, 1 for sub-control, 2 for sub-sub, etc.>,
      "sort_order": <number for natural reading order>
    }
  ],
  "extraction_notes": "<notes about your extraction approach, any ambiguities, or what you generated vs found in the document>"
}

Key guidance:
- Generate control_number IDs if the document doesn't have them — use a prefix that fits the document (SEC-, POL-, REQ-, CHK-, etc.)
- Create concise titles even if the document only has long descriptions
- Identify the natural grouping in the document and populate the "groups" array
- Set suggested_layout to "tree" if there's clear hierarchy, "grouped" if there are categories but flat within them, "flat" if it's a simple list
- Every control must belong to a group. If ungrouped, create a "General" group.
- Be thorough — extract ALL requirements, don't skip any.`;

  return prompt;
}

async function extractFrameworkControls(documentText, context = {}) {
  console.log('🤖 Sending document to GPT-4 for framework extraction...');
  console.log(`📊 Document length: ${documentText.length} chars`);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: FRAMEWORK_EXTRACTION_PROMPT },
        { role: 'user', content: buildFrameworkExtractionPrompt(documentText, context) },
      ],
      temperature: GPT_EXTRACTION_TEMPERATURE,
      max_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];

    if (choice.finish_reason === 'length') {
      console.warn('⚠️ GPT extraction response was truncated. Some controls may be missing.');
    }

    const content = choice.message.content;
    let result;

    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      // If truncated, try to salvage partial JSON
      if (choice.finish_reason === 'length') {
        console.warn('⚠️ Attempting to recover truncated JSON...');
        result = attemptJsonRecovery(content);
        if (!result) {
          console.error('❌ Could not recover truncated JSON');
          throw new Error('GPT response was truncated and could not be recovered. Try a smaller file or fewer rows.');
        }
        console.log('✅ Recovered partial JSON from truncated response');
      } else {
        console.error('❌ Failed to parse GPT framework extraction response as JSON');
        throw new Error('GPT returned invalid JSON response during framework extraction');
      }
    }

    if (!result.controls || !Array.isArray(result.controls)) {
      throw new Error('GPT response missing controls array');
    }

    // Backfill missing fields instead of dropping controls
    let autoIdCounter = 1;
    result.controls = result.controls
      .filter((control) => {
        // Only drop if completely empty (no title AND no description)
        if (!control.title && !control.description) {
          console.warn(`⚠️ Dropping empty control: ${JSON.stringify(control).substring(0, 100)}`);
          return false;
        }
        return true;
      })
      .map((control) => {
        // Generate control_number if missing
        if (!control.control_number) {
          control.control_number = `CTRL-${String(autoIdCounter++).padStart(3, '0')}`;
          console.log(`📝 Generated ID ${control.control_number} for: "${(control.title || control.description || '').substring(0, 50)}"`);
        }
        // Generate title from description if missing
        if (!control.title && control.description) {
          control.title = control.description.substring(0, 80) + (control.description.length > 80 ? '...' : '');
        }
        // Generate description from title if missing — critical for analysis pipeline
        if (!control.description && control.title) {
          control.description = `Compliance requirement: ${control.title}`;
        }
        // Ensure all fields exist with defaults
        control.description = control.description || null;
        control.group = control.group || control.category || null;
        control.parent_control_number = control.parent_control_number || null;
        control.level = control.level || 0;
        control.sort_order = control.sort_order || 0;
        return control;
      });

    // Ensure suggested_layout and groups exist with defaults
    result.suggested_layout = result.suggested_layout || 'grouped';
    result.suggested_grouping_field = result.suggested_grouping_field || 'category';
    result.groups = result.groups || [];

    console.log(`✅ Extracted ${result.controls.length} controls (layout: ${result.suggested_layout}, groups: ${result.groups.length})`);

    return {
      result,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
      truncated: choice.finish_reason === 'length',
    };
  } catch (err) {
    handleOpenAIError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Tabular Extraction — extract controls from CSV/XLSX data
// ─────────────────────────────────────────────────────────────

const TABULAR_EXTRACTION_PROMPT = `You are an expert compliance framework analyst. You are analyzing structured spreadsheet data (CSV or XLSX) that contains compliance framework controls, requirements, or policies.

Your task is to intelligently interpret the columns and rows, and produce structured compliance controls.

Your approach:
1. FIRST, analyze the column headers to understand what each column represents (control ID, title, description, category, etc.)
2. THEN, map every row into a structured control
3. If a column clearly maps to a known field (control number, title, description, category/domain/section), use it directly
4. If the spreadsheet has columns that don't map to standard fields, preserve that data in the control's description or as additional context
5. Generate any missing fields intelligently:
   - If there's no description column but there IS a title, generate a brief description from context
   - If there's no category/group column, infer groups from numbering patterns or content similarity
   - If there's no explicit control number, generate meaningful IDs (e.g., "CTRL-001", "SEC-1.1")

Important rules:
- Map EVERY row to a control — do not skip any data rows
- Preserve the original data faithfully — don't change values that are already good
- If a cell is empty, treat it as missing (null) — don't fabricate data for it
- Detect hierarchy from numbering patterns (e.g., "1.1" is child of "1", "AC-1.a" is child of "AC-1")
- Suggest the best display layout based on what you see

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

function buildTabularExtractionPrompt(textData, context) {
  let prompt = `Analyze and extract all compliance controls from the following spreadsheet data.`;

  if (context?.frameworkName) {
    prompt += `\n\nFramework name (provided by user): ${context.frameworkName}`;
  }
  if (context?.frameworkVersion) {
    prompt += `\nVersion: ${context.frameworkVersion}`;
  }

  prompt += `\n\n## Spreadsheet Data:\n${textData}`;

  prompt += `\n\n## Instructions:

Analyze the column structure, then map every row to a structured control. Return a JSON object with this structure:

{
  "framework_detected": "<name of framework detected from the data, or null>",
  "version_detected": "<version detected, or null>",
  "column_mapping": {
    "<original column name>": "<what this column represents: control_number | title | description | category | parent | level | other>"
  },
  "suggested_layout": "tree" | "grouped" | "flat",
  "suggested_grouping_field": "<what concept groups these controls — e.g. 'domain', 'section', 'category'>",
  "groups": [
    {
      "name": "<group/category/domain name>",
      "description": "<brief description, or null>",
      "sort_order": <number>
    }
  ],
  "controls": [
    {
      "control_number": "<from spreadsheet or generated>",
      "title": "<from spreadsheet or generated>",
      "description": "<from spreadsheet or generated — combine relevant columns if needed>",
      "group": "<which group this belongs to>",
      "parent_control_number": "<parent control's number if hierarchical, or null>",
      "level": <0 for top-level, 1 for sub-control, etc.>,
      "sort_order": <row order from spreadsheet>
    }
  ],
  "extraction_notes": "<notes about how you interpreted the columns and any decisions you made>"
}

Key guidance:
- Map EVERY row — the output controls count should match the input row count (unless rows are truly empty)
- If a column contains long text, that's likely the description
- If a column has short codes or numbers, that's likely the control ID
- If a column has repeated values across many rows, that's likely a category/group
- Combine multiple text columns into the description if they contain useful requirement details
- Every control must belong to a group. If ungrouped, create a "General" group.`;

  return prompt;
}

async function extractControlsFromTabular(textData, context = {}) {
  console.log('🤖 Sending tabular data to GPT-4 for control extraction...');
  console.log(`📊 Text length: ${textData.length} chars`);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: TABULAR_EXTRACTION_PROMPT },
        { role: 'user', content: buildTabularExtractionPrompt(textData, context) },
      ],
      temperature: GPT_EXTRACTION_TEMPERATURE,
      max_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];

    if (choice.finish_reason === 'length') {
      console.warn('⚠️ GPT tabular extraction response was truncated. Some controls may be missing.');
    }

    const content = choice.message.content;
    let result;

    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      // If truncated, try to salvage partial JSON
      if (choice.finish_reason === 'length') {
        console.warn('⚠️ Attempting to recover truncated tabular JSON...');
        result = attemptJsonRecovery(content);
        if (!result) {
          console.error('❌ Could not recover truncated tabular JSON');
          throw new Error('GPT response was truncated and could not be recovered. Try a smaller file or fewer rows.');
        }
        console.log('✅ Recovered partial JSON from truncated tabular response');
      } else {
        console.error('❌ Failed to parse GPT tabular extraction response as JSON');
        throw new Error('GPT returned invalid JSON response during tabular extraction');
      }
    }

    if (!result.controls || !Array.isArray(result.controls)) {
      throw new Error('GPT response missing controls array');
    }

    // Backfill missing fields
    let autoIdCounter = 1;
    result.controls = result.controls
      .filter((control) => {
        if (!control.title && !control.description) {
          console.warn(`⚠️ Dropping empty control: ${JSON.stringify(control).substring(0, 100)}`);
          return false;
        }
        return true;
      })
      .map((control) => {
        if (!control.control_number) {
          control.control_number = `CTRL-${String(autoIdCounter++).padStart(3, '0')}`;
        }
        if (!control.title && control.description) {
          control.title = control.description.substring(0, 80) + (control.description.length > 80 ? '...' : '');
        }
        // Generate description from title if missing — critical for analysis pipeline
        if (!control.description && control.title) {
          control.description = `Compliance requirement: ${control.title}`;
        }
        control.description = control.description || null;
        control.group = control.group || control.category || null;
        control.parent_control_number = control.parent_control_number || null;
        control.level = control.level || 0;
        control.sort_order = control.sort_order || 0;
        return control;
      });

    result.suggested_layout = result.suggested_layout || 'grouped';
    result.suggested_grouping_field = result.suggested_grouping_field || 'category';
    result.groups = result.groups || [];

    console.log(`✅ Extracted ${result.controls.length} controls from tabular data (layout: ${result.suggested_layout}, groups: ${result.groups.length})`);

    return {
      result,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
      truncated: choice.finish_reason === 'length',
    };
  } catch (err) {
    handleOpenAIError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Framework Enhancement — improve extracted control data
// ─────────────────────────────────────────────────────────────

const FRAMEWORK_ENHANCE_PROMPT = `You are an expert compliance framework analyst. Your task is to enhance and improve structured control data that has been extracted from a compliance framework document.

You will receive an array of controls (each with control_number, title, description, group fields) and optional context.

Your enhancements should:
1. Suggest groups/categories where they are missing (based on control content and common framework structures)
2. Standardize control number formatting for consistency
3. Generate concise descriptions where missing (based on the title and group context)
4. Infer parent-child hierarchy based on numbering patterns, naming conventions, or content relationships
5. Suggest the best display layout: "tree" if clear hierarchy, "grouped" if categories without nesting, "flat" if simple list
6. Standardize group names for consistency (e.g., don't have "Access Control" and "Access Controls" as separate groups)
7. Do NOT change content that already looks correct
8. Do NOT invent new controls — only enhance existing ones

You must respond with valid JSON only.`;

function buildEnhancePrompt(controls, context) {
  let prompt = `Enhance the following ${controls.length} compliance controls.`;

  if (context?.frameworkName) {
    prompt += `\nFramework: ${context.frameworkName}`;
  }
  if (context?.frameworkVersion) {
    prompt += `\nVersion: ${context.frameworkVersion}`;
  }

  prompt += `\n\n## Controls to enhance:\n${JSON.stringify(controls, null, 2)}`;

  prompt += `\n\n## Return JSON with this structure:
{
  "suggested_layout": "tree" | "grouped" | "flat",
  "suggested_grouping_field": "<best grouping concept — e.g. 'domain', 'category', 'section'>",
  "controls": [
    {
      "control_number": "<standardized>",
      "title": "<original or improved>",
      "description": "<original or generated if missing>",
      "group": "<original or suggested if missing>",
      "parent_control_number": "<inferred parent or null>",
      "level": <inferred hierarchy level>,
      "sort_order": <recommended display order>,
      "changes_made": ["<description of each change made>"]
    }
  ],
  "summary": {
    "categories_added": <number>,
    "descriptions_generated": <number>,
    "hierarchy_inferred": <number>,
    "numbers_standardized": <number>
  }
}`;

  return prompt;
}

async function enhanceFrameworkControls(controls, context = {}) {
  console.log(`🤖 Enhancing ${controls.length} controls with GPT-4...`);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: FRAMEWORK_ENHANCE_PROMPT },
        { role: 'user', content: buildEnhancePrompt(controls, context) },
      ],
      temperature: GPT_TEMPERATURE,
      max_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];
    let result;

    try {
      result = JSON.parse(choice.message.content);
    } catch (parseErr) {
      console.error('❌ Failed to parse GPT enhance response as JSON');
      throw new Error('GPT returned invalid JSON response during enhancement');
    }

    if (!result.controls || !Array.isArray(result.controls)) {
      throw new Error('GPT enhance response missing controls array');
    }

    console.log(`✅ Enhanced ${result.controls.length} controls`);

    return {
      result,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
      truncated: choice.finish_reason === 'length',
    };
  } catch (err) {
    handleOpenAIError(err);
  }
}

module.exports = { analyzeEvidence, analyzeImageEvidence, normalizeGptAnalysis, buildMultiEvidenceUserPrompt, buildAnalyzeAllPrompt, extractFrameworkControls, extractControlsFromTabular, enhanceFrameworkControls, SYSTEM_PROMPT };
