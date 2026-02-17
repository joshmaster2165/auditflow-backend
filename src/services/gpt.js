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

module.exports = { analyzeEvidence };
