const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are an expert compliance auditor specializing in detailed gap analysis between compliance requirements and evidence documentation.

Your task is to analyze whether evidence documents satisfy specific compliance requirements. You must:

1. Break down the requirement into 3-7 testable sub-requirements
2. For each sub-requirement, determine if it is met, partially met, or missing based on the evidence
3. Quote specific evidence passages that support your findings
4. Identify precise gaps where evidence is insufficient
5. Provide actionable recommendations

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

function buildUserPrompt(documentText, requirementText, controlName) {
  return `Analyze the following evidence document against the compliance requirement.

## Control: ${controlName || 'Unnamed Control'}

## Compliance Requirement:
${requirementText}

## Evidence Document Content:
${documentText}

## Instructions:
Analyze the evidence against the requirement and return a JSON object with this exact structure:

{
  "status": "compliant" | "partial" | "non_compliant",
  "confidence_score": <number 0-1>,
  "compliance_percentage": <number 0-100>,
  "summary": "<brief summary of findings>",
  "requirements_breakdown": [
    {
      "requirement_id": "REQ-1",
      "requirement_text": "<specific sub-requirement>",
      "status": "met" | "partial" | "missing",
      "evidence_found": "<quoted evidence passage or null>",
      "evidence_location": "<section/page reference or null>",
      "gap_description": "<what's missing or null>",
      "confidence": <number 0-1>
    }
  ],
  "met_requirements": ["REQ-1", ...],
  "partial_requirements": ["REQ-2", ...],
  "missing_requirements": ["REQ-3", ...],
  "evidence_mapping": {
    "REQ-1": "<brief evidence reference>",
    ...
  },
  "recommendations": ["<actionable recommendation>", ...],
  "critical_gaps": ["<critical finding>", ...]
}

Break the requirement into 3-7 testable sub-requirements. Be precise about what evidence supports or contradicts each sub-requirement. Quote specific passages from the evidence document.`;
}

async function analyzeEvidence(documentText, requirementText, controlName) {
  console.log('🤖 Sending document to GPT-4 for analysis...');
  console.log(`📊 Document length: ${documentText.length} chars | Requirement length: ${requirementText.length} chars`);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(documentText, requirementText, controlName) },
      ],
      temperature: 0.2,
      max_tokens: 4000,
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

    // Validate required fields
    if (!analysis.status || !analysis.requirements_breakdown) {
      console.error('❌ GPT response missing required fields');
      throw new Error('GPT response missing required fields (status, requirements_breakdown)');
    }

    console.log(`✅ GPT analysis complete: ${analysis.status} (${analysis.compliance_percentage}% compliance, confidence: ${analysis.confidence_score})`);

    return {
      analysis,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
    };
  } catch (err) {
    if (err.status === 429) {
      console.error('❌ OpenAI rate limit exceeded. Please try again later.');
      throw new Error('OpenAI rate limit exceeded. Please try again later.');
    }
    if (err.status === 401) {
      console.error('❌ Invalid OpenAI API key');
      throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Framework Extraction — extract controls from PDF documents
// ─────────────────────────────────────────────────────────────

const FRAMEWORK_EXTRACTION_PROMPT = `You are an expert compliance framework analyst. Your task is to extract structured compliance controls from a document.

You will receive the text content of a compliance framework document (e.g., PCI DSS, SOC 2, ISO 27001, NIST 800-53, HIPAA, CIS Controls, GDPR, etc.).

Your job is to identify and extract every individual control, requirement, or security measure from the document and return them as structured JSON.

Rules for extraction:
1. Each control MUST have a control_number (the official identifier like "1.1", "AC-1", "A.5.1", etc.)
2. Each control MUST have a title (brief name of the control)
3. Each control SHOULD have a description (detailed requirement text)
4. Each control SHOULD have a category (domain/family/section it belongs to)
5. Preserve the official numbering scheme from the document
6. Maintain hierarchical relationships where applicable (parent controls vs sub-controls)
7. Do NOT invent or fabricate controls that are not in the document
8. If a section contains multiple sub-requirements under one heading, extract each as a separate control
9. For category, use the section or domain heading the control falls under

You must respond with valid JSON only. Do not include any text outside the JSON object.`;

function buildFrameworkExtractionPrompt(documentText, context) {
  let prompt = `Extract all compliance controls from the following framework document.`;

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
Return a JSON object with this exact structure:

{
  "framework_detected": "<name of framework detected from content, or null>",
  "version_detected": "<version detected, or null>",
  "total_controls_found": <number>,
  "categories_found": ["<category1>", "<category2>"],
  "controls": [
    {
      "control_number": "<official identifier, e.g. '1.1.1', 'AC-1', 'A.5.1.1'>",
      "title": "<brief control name/title>",
      "description": "<full requirement description text>",
      "category": "<domain/family/section name>",
      "parent_control_number": "<parent control number if this is a sub-control, or null>",
      "level": <0 for top-level, 1 for sub-control, 2 for sub-sub-control, etc.>
    }
  ],
  "extraction_notes": "<any important notes about the extraction, ambiguities, or limitations>"
}

Extract ALL controls you can find. Be thorough and preserve the document's structure.`;

  return prompt;
}

async function extractFrameworkControls(documentText, context = {}) {
  console.log('🤖 Sending document to GPT-4 for framework extraction...');
  console.log(`📊 Document length: ${documentText.length} chars`);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: FRAMEWORK_EXTRACTION_PROMPT },
        { role: 'user', content: buildFrameworkExtractionPrompt(documentText, context) },
      ],
      temperature: 0.1,
      max_tokens: 4096,
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
      console.error('❌ Failed to parse GPT framework extraction response as JSON');
      throw new Error('GPT returned invalid JSON response during framework extraction');
    }

    if (!result.controls || !Array.isArray(result.controls)) {
      throw new Error('GPT response missing controls array');
    }

    // Filter out controls missing required fields
    result.controls = result.controls.filter((control) => {
      if (!control.control_number || !control.title) {
        console.warn(`⚠️ Skipping control missing required fields: ${JSON.stringify(control).substring(0, 100)}`);
        return false;
      }
      return true;
    });

    console.log(`✅ Extracted ${result.controls.length} controls from framework`);

    return {
      result,
      model: response.model,
      usage: response.usage,
      finish_reason: choice.finish_reason,
      truncated: choice.finish_reason === 'length',
    };
  } catch (err) {
    if (err.status === 429) {
      throw new Error('OpenAI rate limit exceeded. Please try again later.');
    }
    if (err.status === 401) {
      throw new Error('Invalid OpenAI API key.');
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Framework Enhancement — improve extracted control data
// ─────────────────────────────────────────────────────────────

const FRAMEWORK_ENHANCE_PROMPT = `You are an expert compliance framework analyst. Your task is to enhance and improve structured control data that has been extracted from a compliance framework document.

You will receive an array of controls (each with control_number, title, description, category fields) and optional context.

Your enhancements should:
1. Suggest categories where they are missing (based on control content and common framework structures)
2. Standardize control number formatting (e.g., consistent dot notation)
3. Generate concise descriptions where missing (based on the title and category context)
4. Suggest parent-child hierarchy based on control numbering patterns (e.g., 1.1 is parent of 1.1.1)
5. Do NOT change content that already looks correct
6. Do NOT invent new controls — only enhance existing ones

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
  "controls": [
    {
      "control_number": "<standardized>",
      "title": "<original or improved>",
      "description": "<original or generated if missing>",
      "category": "<original or suggested if missing>",
      "parent_control_number": "<inferred parent or null>",
      "level": <inferred hierarchy level>,
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
      model: 'gpt-4-turbo-preview',
      messages: [
        { role: 'system', content: FRAMEWORK_ENHANCE_PROMPT },
        { role: 'user', content: buildEnhancePrompt(controls, context) },
      ],
      temperature: 0.2,
      max_tokens: 4096,
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
    if (err.status === 429) {
      throw new Error('OpenAI rate limit exceeded. Please try again later.');
    }
    if (err.status === 401) {
      throw new Error('Invalid OpenAI API key.');
    }
    throw err;
  }
}

module.exports = { analyzeEvidence, extractFrameworkControls, enhanceFrameworkControls };
