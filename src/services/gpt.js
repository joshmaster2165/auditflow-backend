const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

const SYSTEM_PROMPT = `You are an expert compliance auditor specializing in detailed gap analysis between compliance requirements and evidence documentation.

Your task is to analyze whether evidence documents satisfy specific compliance requirements. You must:

1. Break down the requirement into 3-7 testable sub-requirements
2. For each sub-requirement, determine if it is met, partially met, or missing based on the evidence
3. Quote specific evidence passages that support your findings
4. Identify precise gaps where evidence is insufficient
5. Provide actionable recommendations

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
The project owner has provided the following guidance for this analysis. Apply these instructions when evaluating the evidence:
${customInstructions}
` : ''}
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

async function analyzeEvidence(documentText, requirementText, controlName, customInstructions) {
  console.log('🤖 Sending document to GPT-4 for analysis...');
  console.log(`📊 Document length: ${documentText.length} chars | Requirement length: ${requirementText.length} chars`);
  if (customInstructions) {
    console.log(`📋 Custom instructions: ${customInstructions.length} chars`);
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(documentText, requirementText, controlName, customInstructions) },
      ],
      temperature: 0.2,
      max_tokens: 16384,
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
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: FRAMEWORK_EXTRACTION_PROMPT },
        { role: 'user', content: buildFrameworkExtractionPrompt(documentText, context) },
      ],
      temperature: 0.1,
      max_tokens: 16384,
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
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: TABULAR_EXTRACTION_PROMPT },
        { role: 'user', content: buildTabularExtractionPrompt(textData, context) },
      ],
      temperature: 0.1,
      max_tokens: 16384,
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
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: FRAMEWORK_ENHANCE_PROMPT },
        { role: 'user', content: buildEnhancePrompt(controls, context) },
      ],
      temperature: 0.2,
      max_tokens: 16384,
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

module.exports = { analyzeEvidence, extractFrameworkControls, extractControlsFromTabular, enhanceFrameworkControls };
