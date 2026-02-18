const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/upload');
const { parseFrameworkFile, tabularToText } = require('../services/frameworkParser');
const { extractFrameworkControls, extractControlsFromTabular, enhanceFrameworkControls } = require('../services/gpt');
const { cleanupFile } = require('../utils/supabase');
const { chunkText, needsChunking } = require('../utils/chunker');

// POST /api/framework/parse — Upload and parse a framework file
// ALL file types (CSV, XLSX, PDF) go through AI extraction
// Returns unified response shape with controls, groups, suggestedLayout
router.post('/parse', upload.single('file'), async (req, res) => {
  // Allow up to 5 minutes for GPT processing of large files
  try { req.setTimeout(300000); } catch (e) { /* ignore if not supported */ }
  try { res.setTimeout(300000); } catch (e) { /* ignore if not supported */ }

  let filePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    filePath = req.file.path;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;

    const memStart = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`\n📄 Parsing framework file: ${fileName} (${mimeType}) [${memStart}MB heap]`);

    const parsed = await parseFrameworkFile(filePath, mimeType);
    const memAfterParse = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`📊 Parse complete [${memAfterParse}MB heap]`);

    const context = {
      frameworkName: req.body.frameworkName || null,
      frameworkVersion: req.body.frameworkVersion || null,
    };

    let allControls = [];
    let allGroups = [];
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let chunked = false;
    let chunkCount = 1;
    let frameworkDetected = null;
    let versionDetected = null;
    let extractionNotes = null;
    let suggestedLayout = 'grouped';
    let suggestedGroupingField = 'category';
    let rawPreview = null;

    // ── Tabular path (CSV / XLSX) — now goes through AI too ──
    if (parsed.type === 'tabular') {
      console.log(`📊 Tabular file: ${parsed.totalRows} rows, ${parsed.headers.length} columns`);

      // Build raw preview for frontend transparency
      rawPreview = {
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, 3),
        totalRows: parsed.totalRows,
      };

      // Convert to text and send through AI
      const textData = tabularToText(parsed.headers, parsed.rows);

      if (needsChunking(textData)) {
        chunked = true;
        const chunks = chunkText(textData);
        chunkCount = chunks.length;
        console.log(`📦 Tabular data requires chunking: ${chunks.length} chunks`);

        for (let i = 0; i < chunks.length; i++) {
          console.log(`🔄 Processing chunk ${i + 1}/${chunks.length}...`);
          const chunkContext = {
            ...context,
            chunkInfo: `This is part ${i + 1} of ${chunks.length} of the spreadsheet. Extract all controls found in this section.`,
          };
          const extraction = await extractControlsFromTabular(chunks[i], chunkContext);
          chunks[i] = null; // Free chunk memory after processing
          allControls.push(...extraction.result.controls);

          if (i === 0) {
            frameworkDetected = extraction.result.framework_detected || null;
            versionDetected = extraction.result.version_detected || null;
            suggestedLayout = extraction.result.suggested_layout || 'grouped';
            suggestedGroupingField = extraction.result.suggested_grouping_field || 'category';
            allGroups = extraction.result.groups || [];
          } else {
            const existingGroupNames = new Set(allGroups.map((g) => g.name));
            (extraction.result.groups || []).forEach((g) => {
              if (!existingGroupNames.has(g.name)) {
                allGroups.push(g);
                existingGroupNames.add(g.name);
              }
            });
          }

          totalUsage.prompt_tokens += extraction.usage?.prompt_tokens || 0;
          totalUsage.completion_tokens += extraction.usage?.completion_tokens || 0;
          totalUsage.total_tokens += extraction.usage?.total_tokens || 0;
        }

        // Deduplicate by control_number
        const seen = new Map();
        allControls = allControls.filter((c) => {
          if (seen.has(c.control_number)) return false;
          seen.set(c.control_number, true);
          return true;
        });

        extractionNotes = `Spreadsheet was processed in ${chunkCount} chunks. ${allControls.length} unique controls extracted from ${parsed.totalRows} rows.`;
      } else {
        const extraction = await extractControlsFromTabular(textData, context);
        allControls = extraction.result.controls;
        allGroups = extraction.result.groups || [];
        frameworkDetected = extraction.result.framework_detected || null;
        versionDetected = extraction.result.version_detected || null;
        extractionNotes = extraction.result.extraction_notes || null;
        suggestedLayout = extraction.result.suggested_layout || 'grouped';
        suggestedGroupingField = extraction.result.suggested_grouping_field || 'category';
        totalUsage = extraction.usage || totalUsage;
      }
    }

    // ── Document path (PDF) ──
    if (parsed.type === 'document') {
      if (needsChunking(parsed.text)) {
        chunked = true;
        const chunks = chunkText(parsed.text);
        parsed.text = null; // Free the large text buffer — we have chunks now
        chunkCount = chunks.length;
        console.log(`📦 Document requires chunking: ${chunks.length} chunks`);

        for (let i = 0; i < chunks.length; i++) {
          console.log(`🔄 Processing chunk ${i + 1}/${chunks.length}...`);
          const chunkContext = {
            ...context,
            chunkInfo: `This is part ${i + 1} of ${chunks.length} of the document. Extract all controls found in this section.`,
          };
          const extraction = await extractFrameworkControls(chunks[i], chunkContext);
          chunks[i] = null; // Free chunk memory after processing
          allControls.push(...extraction.result.controls);

          if (i === 0) {
            frameworkDetected = extraction.result.framework_detected || null;
            versionDetected = extraction.result.version_detected || null;
            suggestedLayout = extraction.result.suggested_layout || 'grouped';
            suggestedGroupingField = extraction.result.suggested_grouping_field || 'category';
            allGroups = extraction.result.groups || [];
          } else {
            const existingGroupNames = new Set(allGroups.map((g) => g.name));
            (extraction.result.groups || []).forEach((g) => {
              if (!existingGroupNames.has(g.name)) {
                allGroups.push(g);
                existingGroupNames.add(g.name);
              }
            });
          }

          totalUsage.prompt_tokens += extraction.usage?.prompt_tokens || 0;
          totalUsage.completion_tokens += extraction.usage?.completion_tokens || 0;
          totalUsage.total_tokens += extraction.usage?.total_tokens || 0;
        }

        // Deduplicate by control_number
        const seen = new Map();
        allControls = allControls.filter((c) => {
          if (seen.has(c.control_number)) return false;
          seen.set(c.control_number, true);
          return true;
        });

        extractionNotes = `Document was processed in ${chunkCount} chunks. ${allControls.length} unique controls extracted.`;
        if (parsed.truncated) {
          extractionNotes += ` Note: Document was truncated from ${parsed.originalCharCount} to ${parsed.charCount} characters due to size limits. Some controls from later sections may be missing.`;
        }
      } else {
        const extraction = await extractFrameworkControls(parsed.text, context);
        allControls = extraction.result.controls;
        allGroups = extraction.result.groups || [];
        frameworkDetected = extraction.result.framework_detected || null;
        versionDetected = extraction.result.version_detected || null;
        extractionNotes = extraction.result.extraction_notes || null;
        suggestedLayout = extraction.result.suggested_layout || 'grouped';
        suggestedGroupingField = extraction.result.suggested_grouping_field || 'category';
        totalUsage = extraction.usage || totalUsage;
      }
    }

    // Normalize: map "group" field to "category" for frontend consistency
    allControls = allControls.map((c) => ({
      ...c,
      category: c.group || c.category || null,
    }));

    const categoriesFound = [...new Set(allControls.map((c) => c.category).filter(Boolean))];

    const memEnd = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`✅ Framework extraction complete: ${allControls.length} controls, ${categoriesFound.length} categories, layout: ${suggestedLayout} [${memEnd}MB heap]`);

    // Unified response shape for ALL file types
    const responseData = {
      controls: allControls,
      groups: allGroups,
      suggestedLayout,
      suggestedGroupingField,
      frameworkDetected,
      versionDetected,
      totalControls: allControls.length,
      categoriesFound,
      extractionNotes,
      metadata: {
        model: 'gpt-4o',
        tokensUsed: totalUsage,
        chunked,
        chunkCount,
      },
    };

    // Include raw preview for tabular files
    if (rawPreview) {
      responseData.rawPreview = rawPreview;
    }

    // Include document info for PDFs
    if (parsed.type === 'document') {
      responseData.documentInfo = {
        pageCount: parsed.pageCount,
        charCount: parsed.charCount,
      };
    }

    return res.json({
      success: true,
      fileType: parsed.type === 'tabular' ? 'tabular' : 'document',
      fileName,
      data: responseData,
    });
  } catch (err) {
    console.error('❌ Framework parse error:', err.message);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 20MB.' });
    }

    res.status(500).json({
      error: 'Failed to parse framework file',
      details: err.message,
    });
  } finally {
    cleanupFile(filePath);
  }
});

// POST /api/framework/enhance — AI-enhance extracted controls
// Fills missing categories, descriptions, infers hierarchy
router.post('/enhance', async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);

  try {
    const { controls, context } = req.body;

    if (!controls || !Array.isArray(controls) || controls.length === 0) {
      return res.status(400).json({ error: 'controls array is required and must not be empty' });
    }

    if (controls.length > 500) {
      return res.status(400).json({
        error: 'Too many controls for enhancement. Maximum is 500. Consider enhancing in batches.',
      });
    }

    console.log(`\n✨ Enhancing ${controls.length} controls...`);

    let allEnhanced = [];
    let totalSummary = {
      categories_added: 0,
      descriptions_generated: 0,
      hierarchy_inferred: 0,
      numbers_standardized: 0,
    };
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const batchSize = 100;
    const batches = [];
    for (let i = 0; i < controls.length; i += batchSize) {
      batches.push(controls.slice(i, i + batchSize));
    }

    for (let i = 0; i < batches.length; i++) {
      if (batches.length > 1) {
        console.log(`🔄 Enhancing batch ${i + 1}/${batches.length}...`);
      }

      const enhancement = await enhanceFrameworkControls(batches[i], context || {});
      allEnhanced.push(...enhancement.result.controls);

      if (enhancement.result.summary) {
        totalSummary.categories_added += enhancement.result.summary.categories_added || 0;
        totalSummary.descriptions_generated += enhancement.result.summary.descriptions_generated || 0;
        totalSummary.hierarchy_inferred += enhancement.result.summary.hierarchy_inferred || 0;
        totalSummary.numbers_standardized += enhancement.result.summary.numbers_standardized || 0;
      }

      totalUsage.prompt_tokens += enhancement.usage?.prompt_tokens || 0;
      totalUsage.completion_tokens += enhancement.usage?.completion_tokens || 0;
      totalUsage.total_tokens += enhancement.usage?.total_tokens || 0;
    }

    console.log(`✅ Enhancement complete: ${allEnhanced.length} controls enhanced`);

    const normalizedControls = allEnhanced.map((c) => ({
      ...c,
      category: c.group || c.category || null,
    }));

    return res.json({
      success: true,
      data: {
        controls: normalizedControls,
        summary: totalSummary,
        metadata: {
          model: 'gpt-4o',
          tokensUsed: totalUsage,
        },
      },
    });
  } catch (err) {
    console.error('❌ Framework enhance error:', err.message);
    res.status(500).json({
      error: 'Failed to enhance controls',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

module.exports = router;
