const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ── GPT Configuration Constants ──
const GPT_MODEL = 'gpt-5.1';
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
    analysis.status = 'partial';
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
    status: item.status || 'partial',
    evidence_found: item.evidence_found || item.evidence || item.evidence_text || null,
    evidence_location: item.evidence_location || item.location || { start_index: -1, end_index: -1, section_context: null },
    evidence_source: item.evidence_source || item.source_document || null,
    analysis_notes: item.analysis_notes || item.notes || item.reasoning || item.analysis || null,
    visual_description: item.visual_description || item.image_description || null,
    gap_description: item.gap_description || item.gap || item.gaps || null,
    suggested_evidence: item.suggested_evidence || null,
    confidence: parseFloat(item.confidence || item.confidence_score || 0.5),
  }));

  // Ensure top-level fields have safe defaults
  analysis.confidence_score = parseFloat(analysis.confidence_score || 0);
  analysis.compliance_percentage = parseInt(analysis.compliance_percentage || 0, 10);
  analysis.summary = analysis.summary || '';
  analysis.extracted_text = analysis.extracted_text || '';
  analysis.recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];
  analysis.critical_gaps = Array.isArray(analysis.critical_gaps) ? analysis.critical_gaps : [];
  analysis.suggested_evidence = Array.isArray(analysis.suggested_evidence) ? analysis.suggested_evidence : [];

  return analysis;
}

const SYSTEM_PROMPT = `You are an expert compliance auditor specializing in gap analysis between compliance requirements and evidence documentation.

Your task is to analyze whether evidence documents satisfy specific compliance requirements. You must:

1. Decompose the requirement into its KEY testable sub-requirements. Group closely related items together rather than splitting every conjunction into a separate finding. Specifically:
   - Group related ACTORS (e.g., "personnel and contractors") into one sub-requirement when they share the same obligation
   - Group related OBJECTS (e.g., "physical assets, information assets, access rights") into one sub-requirement when they are part of the same return/review obligation
   - Keep distinct ACTIONS as separate sub-requirements (e.g., "return assets" vs. "notify management" are different obligations)
   - Keep distinct CONDITIONS/TRIGGERS separate when they represent meaningfully different scenarios (e.g., "upon termination" vs. "upon transfer")
   - Keep TIMING constraints as part of the action they modify rather than splitting them into standalone sub-requirements
   - Aim for 3-7 sub-requirements per control. Go beyond 7 only if the requirement genuinely contains many independent obligations.
   - Prioritize MEANINGFUL coverage over exhaustive granularity — an auditor needs to see whether major obligations are met, not a checklist of every conjunction
2. For each sub-requirement, determine if it is met, partially met, or missing based on the evidence
3. Quote relevant evidence passages that support your findings — include 2-4 sentences of surrounding context so the highlighted region in the document viewer is meaningful. Prefer copying text from the document, but broader passages with context are better than narrow exact phrases.
4. Provide concise, structured analysis notes using bullet points and **bold** for key terms. Keep each analysis_notes field to 2-3 sentences or bullet points maximum. Focus on the key finding, not exhaustive explanation.
5. Identify gaps where evidence is insufficient and explain why they matter for compliance
6. Provide actionable recommendations
7. For each evidence passage found, provide the exact character offset location within the document text to enable visual highlighting in the document viewer
8. For any "partial" or "missing" finding, proactively suggest specific additional evidence that would help validate the requirement. Be concrete — name specific document types, artifacts, screenshots, or system exports (e.g., a **User Provisioning Procedure**, an **Access Control Matrix** screenshot, **change management logs** from the past 12 months). Do not be vague — suggest the exact type of evidence an auditor would ask for.

THOROUGHNESS IS IMPORTANT. Cover all major obligations in the requirement, but group related items sensibly. An auditor using your output should see every distinct obligation area addressed — but closely related items (like lists of similar actors or assets sharing the same obligation) should be grouped into single findings for readability.

EVIDENCE MATCHING — apply these when evaluating whether evidence satisfies a sub-requirement:
- Use REASONABLE INFERENCE. Evidence does not need to spell out an obligation word-for-word to satisfy it. If the evidence demonstrates a practice, mechanism, or artifact that logically implies the requirement is met, give credit. Examples:
  * An "annual review" table or review dates on a policy document reasonably implies annual reviews are conducted for that policy scope.
  * Evidence of "unique user accounts" or "user login screens" reasonably implies unique user identification is in place.
  * A "change management log" with approval columns reasonably implies a change approval process exists.
  * A "risk register" with review dates reasonably implies periodic risk assessments occur.
- Rate as "met" when the evidence directly addresses OR strongly implies the requirement through demonstrated practice, artifacts, or logical inference.
- Rate as "partial" when the evidence covers a related area but leaves meaningful gaps — explain what is covered and what remains uncertain.
- Rate as "missing" ONLY when no evidence in the document is relevant to this requirement, even through reasonable inference. Do not rate "missing" simply because the wording does not match exactly.
- Still distinguish genuinely different domains: a "Secure Coding Policy" does not satisfy a requirement for an "Information Security Policy" unless its content actually covers the required scope.
- In analysis_notes: explain what evidence you found, what inference you drew, and your confidence level. If rating "partial" or "missing", state what additional evidence would close the gap.

SCORING GUIDANCE:
- compliance_percentage should reflect the proportion of the requirement addressed by the evidence, including through reasonable inference:
  * 85-100%: All or nearly all sub-requirements met (directly or through strong inference)
  * 60-84%: Most sub-requirements met, with minor gaps remaining
  * 30-59%: Some evidence present but significant gaps remain
  * 0-29%: Little to no relevant evidence found
- When sub-requirements are met through reasonable inference, score them generously (80%+ for strong inference, 60-79% for moderate inference)
- Map status thresholds: "compliant" when compliance >= 80%, "partial" when 40-79%, "non_compliant" when < 40%
- confidence_score should reflect how certain you are in your assessment (1.0 = very certain, 0.5 = moderate, < 0.3 = uncertain)

OUTPUT FORMATTING — use structured text in all free-text fields:
- Use **bold** for key terms, policy names, and evidence references
- Use _italics_ for document names and section references
- Use bullet points (- or *) for lists within analysis_notes, gap_description, and recommendations
- Keep all text fields concise: summary (1-2 sentences), analysis_notes (2-3 bullets), gap_description (1 sentence), recommendations (1 sentence each)

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
  "summary": "<1-2 sentence executive summary of key findings>",
  "requirements_breakdown": [
    {
      "requirement_id": "<short ID like REQ-1>",
      "requirement_text": "<the sub-requirement being tested>",
      "status": "met" | "partial" | "missing",
      "evidence_found": "<Copy a relevant passage from the document with 2-4 sentences of context. Use **bold** to highlight the key phrases that directly address the requirement. If the passage contains a list or numbered items, preserve them with line breaks. If no direct quote is possible, describe what supports this finding and wrap key phrases in **bold**. Null if no evidence.>",
      "analysis_notes": "<2-3 bullet points max: key finding, evidence link, and compliance impact>",
      "evidence_location": {
        "start_index": <approximate 0-indexed character position where the evidence_found quote begins>,
        "end_index": <approximate character position where the quote ends>,
        "section_context": "<heading or section name where this evidence appears, or null>"
      },
      "gap_description": "<brief description of gap, or null if met>",
      "suggested_evidence": "<specific document/artifact to upload that would validate this requirement (e.g., 'Access Control Matrix', 'Annual Review Meeting Minutes'), or null if fully met>",
      "confidence": <number 0.0-1.0>
    }
  ],
  "recommendations": ["<short actionable recommendation (1 sentence each)>", ...],
  "critical_gaps": ["<brief critical finding (1 sentence each)>", ...],
  "suggested_evidence": ["<specific document or evidence type to upload that would strengthen this assessment>"]
}

For evidence_found: Copy a relevant passage from the document with 2-4 sentences of surrounding context. Use **bold** to highlight the specific phrases that address the requirement — this helps auditors scan quickly. If the passage contains numbered lists or distinct items, preserve them on separate lines. The matching system strips formatting before comparing, so focus on capturing the right area. If evidence is spread across sections, describe what you found and **bold** key phrases from the document.

For analysis_notes: REQUIRED. Keep concise (2-3 bullet points max). Use **bold** for key terms and _italic_ for document references:
- "met": - What evidence satisfies this (1 sentence) - How it demonstrates compliance
- "partial": - What is covered - What gap remains - What evidence to upload
- "missing": - What was looked for - Compliance risk - What evidence to upload

For evidence_location: Provide an approximate character position (0-indexed) where the quoted passage begins and ends within the "Evidence Document Content" section above. An approximate range is fine — the system uses fuzzy matching to locate the passage. If you are unsure of the position, set start_index and end_index to -1 and provide section_context with the heading or section name instead.

Sub-requirement decomposition guidance:
Break the requirement into its KEY distinct obligations. Group related items together for readability:
1. Group related actors sharing the same obligation into one sub-requirement (e.g., "personnel and interested parties" = one actor group)
2. Each distinct action/obligation = separate sub-requirement (e.g., "return assets" vs. "notify management")
3. Group related scope items into one sub-requirement (e.g., "physical and information assets" = one scope item)
4. Keep meaningfully different conditions/triggers separate (e.g., "upon termination" vs. "upon role change")
5. Attach timing constraints to the action they modify, not as standalone sub-requirements

Example: "Personnel and other interested parties as appropriate should return all the organization's assets in their possession upon change or termination of their employment, contract or agreement" should produce:
- REQ-1: Personnel and interested parties must return organization assets (covers: actors + core obligation)
- REQ-2: All asset types in their possession must be covered (scope: completeness of asset return)
- REQ-3: Return must be triggered upon change or termination of employment/contract/agreement (covers: trigger conditions)

Aim for 3-7 sub-requirements per control. Quality of analysis matters more than quantity of line items.`;
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
      "summary": "<1-2 sentence summary for this control>",
      "requirements_breakdown": [
        {
          "requirement_id": "<short ID like REQ-1>",
          "requirement_text": "<the sub-requirement being tested>",
          "status": "met" | "partial" | "missing",
          "evidence_found": "<Copy a relevant passage with 2-4 sentences of context. Use **bold** to highlight key phrases that address the requirement. Preserve numbered lists with line breaks. For images, describe the specific visual evidence with key terms in **bold**.>",
          "evidence_source": "<exact filename of the document this evidence came from>",
          "analysis_notes": "<2-3 bullet points max: key finding, evidence link, and compliance impact>",
          "gap_description": "<brief description of gap, or null if met>",
          "suggested_evidence": "<specific document/artifact to upload that would validate this requirement, or null if fully met>",
          "confidence": <number 0.0-1.0>
        }
      ],
      "recommendations": ["<short actionable recommendation (1 sentence)>", ...],
      "critical_gaps": ["<brief critical finding (1 sentence)>", ...],
      "suggested_evidence": ["<specific document or evidence type to upload that would strengthen this control's assessment>"]
    }
  ]
}

CRITICAL: You MUST include ALL ${controls.length} controls in the "controls" array — one entry per control listed above.
For evidence_found: Copy a relevant passage with 2-4 sentences of context. Use **bold** to highlight the specific phrases that address the requirement. Preserve numbered lists on separate lines. The matching system strips formatting before comparing. If evidence is spread across sections, describe what you found and **bold** key phrases.
CRITICAL for evidence_source: Specify the exact filename from the "=== DOCUMENT N: filename ===" headers.
CRITICAL for analysis_notes: Keep concise (2-3 bullet points max). Use **bold** for key terms and _italic_ for document references:
- "met": - What evidence/mechanism satisfies this - How it demonstrates compliance (including inference)
- "partial": - What is covered - What gap remains - What evidence to upload
- "missing": - Confirm no relevant content found - Compliance risk - What evidence to upload

Sub-requirement decomposition for EACH control:
For each control's requirements_breakdown, decompose the requirement into its KEY distinct obligations:
- Group related actors sharing the same obligation into one sub-requirement
- Each distinct action/obligation = separate sub-requirement
- Group related scope items (asset types, object lists) into one sub-requirement
- Keep meaningfully different conditions/triggers separate
- Aim for 3-7 sub-requirements per control. Quality of analysis over quantity of line items.

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
      max_completion_tokens: GPT_MAX_TOKENS,
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
8. Decompose the requirement into its KEY testable sub-requirements. Group related actors, related scope items, and timing constraints with their parent actions. Aim for 3-7 sub-requirements per control — focus on meaningful coverage of distinct obligations rather than exhaustive granularity.

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
      "evidence_found": "<describe the specific visual evidence with key terms in **bold** — what you see in the image that constitutes evidence (e.g., 'Firewall admin panel shows **port 22 blocked** in rule #47 with **deny action**')>",
      "visual_description": "<detailed description of what you observe in the image related to this requirement: UI elements, panels, settings, labels, indicators, physical elements, system state>",
      "analysis_notes": "<your analysis reasoning: explain HOW what you see in the image supports or fails to meet this requirement, and what it tells an auditor about compliance>",
      "evidence_location": {
        "start_index": -1,
        "end_index": -1,
        "section_context": "<describe where in the image this evidence is located>"
      },
      "gap_description": "<what is missing and WHY it matters for compliance, or null if fully met>",
      "suggested_evidence": "<specific document/artifact to upload that would validate this requirement, or null if fully met>",
      "confidence": <number 0.0-1.0>
    }
  ],
  "recommendations": ["<actionable recommendation>", ...],
  "critical_gaps": ["<critical finding>", ...],
  "suggested_evidence": ["<specific document or evidence type to upload that would strengthen this assessment>"]
}

CRITICAL: Include the "extracted_text" field with ALL text you can read from the image.
For visual_description: Describe what you SEE — paint a picture for an auditor who hasn't viewed the image. Include UI layout, visible settings, configuration states, labels, indicators, or physical elements.
For evidence_found: Describe the specific visual evidence that addresses the requirement. Be concrete about what you observe.
For analysis_notes: Keep concise (2-3 bullet points max). Use **bold** for key terms:
- "met": - What visual element/text satisfies the requirement
- "partial": - What is visible - What is absent - What evidence to upload
- "missing": - What was looked for - Confirm not present - What evidence to upload
For evidence_location: always use start_index: -1 and end_index: -1 since this is an image. Use section_context to describe the location within the image.

Sub-requirement decomposition:
Break the requirement into its KEY distinct obligations:
- Group related actors sharing the same obligation into one sub-requirement
- Each distinct action/obligation = separate sub-requirement
- Group related scope items (asset types, object lists) into one sub-requirement
- Keep meaningfully different conditions/triggers separate
- Aim for 3-7 sub-requirements per control. Quality of analysis over quantity of line items.`;
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
      max_completion_tokens: GPT_MAX_TOKENS,
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
      max_completion_tokens: GPT_MAX_TOKENS,
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
      max_completion_tokens: GPT_MAX_TOKENS,
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
      max_completion_tokens: GPT_MAX_TOKENS,
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

// ─────────────────────────────────────────────────────────────
// Consolidated Analysis — unify M×N evidence results into one report
// ─────────────────────────────────────────────────────────────

const CONSOLIDATION_SYSTEM_PROMPT = `You are a senior compliance auditor producing a consolidated analysis report. You will receive individual evidence-vs-control analysis results from multiple documents and controls.

Your job is to synthesize ALL individual analyses into ONE unified report that:
1. Provides an overall compliance status and percentage across all controls and evidence
2. Summarizes key findings, citing specific document names as references
3. Lists which documents contribute evidence to which controls
4. Identifies gaps that persist across all available evidence
5. Provides prioritized, actionable recommendations

Rules:
- Always reference documents by their exact filename
- If multiple documents address the same control, note the strongest evidence source
- Do NOT invent findings — only consolidate what the individual analyses found
- Be concise but thorough
- Use relaxed scoring thresholds: "compliant" when compliance >= 80%, "partial" when 40-79%, "non_compliant" when < 40%
- When evidence from multiple documents covers a requirement through reasonable inference, score generously
- Use **bold** for key terms and _italic_ for document names in all free-text fields
- Keep text concise: consolidated_summary (2-4 sentences), key_findings (1-2 sentences each), recommendations (1 sentence each)
- Consolidate suggested evidence from individual analyses — list the top evidence items that would have the most impact across multiple controls

You must respond with valid JSON only.`;

function buildConsolidationPrompt(analyses, controlContext) {
  let prompt = `## Parent Control\n`;
  prompt += `Control: ${controlContext.control_number || 'N/A'} — ${controlContext.title || 'Untitled'}\n`;
  if (controlContext.description) {
    prompt += `Description: ${controlContext.description}\n`;
  }

  prompt += `\n## Individual Analysis Results (${analyses.length} total)\n\n`;

  for (const a of analyses) {
    prompt += `### ${a.control_number} — ${a.control_title}\n`;
    prompt += `- Document: ${a.evidence_name}\n`;
    prompt += `- Status: ${a.status} | Compliance: ${a.compliance_percentage}%\n`;
    prompt += `- Summary: ${a.summary || 'No summary'}\n`;
    if (a.critical_gaps && a.critical_gaps.length > 0) {
      prompt += `- Gaps: ${a.critical_gaps.join('; ')}\n`;
    }
    if (a.recommendations && a.recommendations.length > 0) {
      prompt += `- Recommendations: ${a.recommendations.join('; ')}\n`;
    }
    prompt += `\n`;
  }

  prompt += `## Return JSON with this exact structure:
{
  "overall_status": "compliant" | "partial" | "non_compliant",
  "overall_compliance_percentage": <0-100>,
  "consolidated_summary": "<2-4 sentence executive summary referencing key documents>",
  "document_coverage": [
    {
      "document_name": "<exact filename>",
      "relevance": "high" | "medium" | "low",
      "controls_addressed": ["<control numbers>"],
      "key_findings": "<1-2 sentence summary of what this document evidences>"
    }
  ],
  "consolidated_gaps": ["<gap description referencing which controls are affected>"],
  "consolidated_recommendations": ["<actionable recommendation>"],
  "suggested_evidence": ["<specific document/evidence type that would strengthen compliance across assessed controls>"],
  "per_control_summary": [
    {
      "control_number": "<number>",
      "control_title": "<title>",
      "status": "compliant" | "partial" | "non_compliant",
      "compliance_percentage": <0-100>,
      "evidence_documents": ["<filenames that provided evidence>"],
      "key_finding": "<1 sentence>"
    }
  ]
}`;

  return prompt;
}

async function consolidateAnalyses(analyses, controlContext) {
  console.log(`🔗 Consolidating ${analyses.length} analysis results...`);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: CONSOLIDATION_SYSTEM_PROMPT },
        { role: 'user', content: buildConsolidationPrompt(analyses, controlContext) },
      ],
      temperature: GPT_TEMPERATURE,
      max_completion_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];
    let result;

    try {
      result = JSON.parse(choice.message.content);
    } catch (parseErr) {
      console.error('❌ Failed to parse GPT consolidation response as JSON');
      throw new Error('GPT returned invalid JSON response during consolidation');
    }

    console.log(`✅ Consolidation complete — overall: ${result.overall_status} (${result.overall_compliance_percentage}%)`);

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

// ── Per-Control Consolidation (multiple evidence docs → one control) ──

const PER_CONTROL_CONSOLIDATION_SYSTEM_PROMPT = `You are a senior compliance auditor producing a per-control evidence consolidation report. You will receive individual analysis results from multiple evidence documents that were each analyzed against the SAME control requirement.

Your job is to synthesize ALL individual document analyses into ONE unified report that:
1. Provides an overall compliance status and percentage for this single control based on all available evidence
2. Summarizes key findings, citing specific document names as references
3. Assesses each document's relevance and contribution to demonstrating compliance
4. Identifies gaps that persist even after considering all available evidence
5. Provides prioritized, actionable recommendations to close remaining gaps

Rules:
- Always reference documents by their exact filename
- Assess each document's relevance: "high" if it directly addresses control requirements, "medium" if it partially or indirectly addresses them, "low" if it has minimal relevance
- If multiple documents address the same requirement, note the strongest evidence source
- Do NOT invent findings — only consolidate what the individual analyses found
- Use relaxed scoring thresholds: "compliant" when compliance >= 80%, "partial" when 40-79%, "non_compliant" when < 40%
- When evidence from multiple documents covers a requirement through reasonable inference, score generously
- Do NOT use markdown formatting (no **bold**, no _italic_, no headers). Return plain text only in all fields.
- consolidated_summary: EXACTLY 2 sentences max. State factual observations only. Reference document names only if directly relevant. No filler.
- consolidated_gaps: MAX 3 items. Each item starts with sub-control ID if applicable (e.g., "CC4.1 — No evidence of annual testing cadence"). Be direct, no filler words.
- consolidated_recommendations: MAX 3 items. Each item starts with an action verb. Be specific and actionable (e.g., "Establish a formal annual penetration testing schedule").
- key_findings: 1 paragraph max, 3-4 sentences.
- Do NOT repeat the control title in any field.
- Do NOT exceed the limits above.

You must respond with valid JSON only.`;

function buildPerControlConsolidationPrompt(analyses, controlContext) {
  let prompt = `## Control Under Assessment\n`;
  prompt += `Control: ${controlContext.control_number || 'N/A'} — ${controlContext.title || 'Untitled'}\n`;
  if (controlContext.description) {
    prompt += `Description: ${controlContext.description}\n`;
  }

  prompt += `\n## Individual Document Analysis Results (${analyses.length} documents)\n\n`;

  for (const a of analyses) {
    prompt += `### Document: ${a.evidence_name}\n`;
    prompt += `- Status: ${a.status} | Compliance: ${a.compliance_percentage}%\n`;
    prompt += `- Summary: ${a.summary || 'No summary'}\n`;
    if (a.critical_gaps && a.critical_gaps.length > 0) {
      prompt += `- Gaps: ${a.critical_gaps.join('; ')}\n`;
    }
    if (a.recommendations && a.recommendations.length > 0) {
      prompt += `- Recommendations: ${a.recommendations.join('; ')}\n`;
    }
    prompt += `\n`;
  }

  prompt += `## Return JSON with this exact structure:
{
  "overall_status": "compliant" | "partial" | "non_compliant",
  "overall_compliance_percentage": <0-100>,
  "consolidated_summary": "<max 2 sentences: factual observations, reference doc names only if directly relevant>",
  "evidence_coverage": [
    {
      "document_name": "<exact filename>",
      "relevance": "high" | "medium" | "low",
      "key_contribution": "<1 sentence describing what this document evidences for this control>"
    }
  ],
  "consolidated_gaps": ["<max 3 items, prefix with sub-control ID if applicable, e.g. 'CC4.1 — No evidence of X'>"],
  "consolidated_recommendations": ["<max 3 items, start each with action verb, e.g. 'Establish a formal...'>"],
  "key_findings": "<1 paragraph max summarizing the most important findings across all evidence>"
}`;

  return prompt;
}

async function consolidateControlAnalyses(analyses, controlContext) {
  console.log(`🔗 Consolidating ${analyses.length} document analyses for control ${controlContext.control_number}...`);

  try {
    const response = await openai.chat.completions.create({
      model: GPT_MODEL,
      messages: [
        { role: 'system', content: PER_CONTROL_CONSOLIDATION_SYSTEM_PROMPT },
        { role: 'user', content: buildPerControlConsolidationPrompt(analyses, controlContext) },
      ],
      temperature: GPT_TEMPERATURE,
      max_completion_tokens: GPT_MAX_TOKENS,
      response_format: { type: 'json_object' },
    });

    const choice = response.choices[0];
    let result;

    try {
      result = JSON.parse(choice.message.content);
    } catch (parseErr) {
      console.error('❌ Failed to parse GPT per-control consolidation response as JSON');
      throw new Error('GPT returned invalid JSON response during per-control consolidation');
    }

    console.log(`✅ Per-control consolidation complete — overall: ${result.overall_status} (${result.overall_compliance_percentage}%)`);

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

module.exports = { analyzeEvidence, analyzeImageEvidence, normalizeGptAnalysis, buildAnalyzeAllPrompt, extractFrameworkControls, extractControlsFromTabular, enhanceFrameworkControls, consolidateAnalyses, consolidateControlAnalyses, SYSTEM_PROMPT };
