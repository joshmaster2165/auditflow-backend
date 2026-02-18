/**
 * Worker thread for framework file parsing.
 *
 * Runs in a separate V8 heap so that if it OOMs, the main process
 * stays alive and the job Map is preserved (job gets marked as 'failed').
 *
 * Communication:
 *   parentPort.postMessage({ type: 'progress', progress: '...' })
 *   parentPort.postMessage({ type: 'completed', result: { ... } })
 *   On error: the worker's 'error' event fires in the main thread
 */

const { workerData, parentPort } = require('worker_threads');
const { parseFrameworkFile, tabularToText } = require('../services/frameworkParser');
const { extractFrameworkControls, extractControlsFromTabular } = require('../services/gpt');
const { chunkText, needsChunking } = require('../utils/chunker');
const { cleanupFile } = require('../utils/supabase');

async function run() {
  const { filePath, fileName, mimeType, body } = workerData;

  try {
    const memStart = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`\n📄 [Worker] Parsing framework file: ${fileName} (${mimeType}) [${memStart}MB heap]`);

    let parsed = await parseFrameworkFile(filePath, mimeType);
    // Force GC after parse to reclaim pdf-parse internals
    if (global.gc) global.gc();
    const memAfterParse = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`📊 [Worker] Parse complete [${memAfterParse}MB heap]`);

    const context = {
      frameworkName: body?.frameworkName || null,
      frameworkVersion: body?.frameworkVersion || null,
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
    let docInfo = null;
    const parsedType = parsed.type;

    // ── Tabular path (CSV / XLSX) ──
    if (parsedType === 'tabular') {
      console.log(`📊 [Worker] Tabular file: ${parsed.totalRows} rows, ${parsed.headers.length} columns`);

      rawPreview = {
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, 3),
        totalRows: parsed.totalRows,
      };

      const textData = tabularToText(parsed.headers, parsed.rows);

      if (needsChunking(textData)) {
        chunked = true;
        const chunks = chunkText(textData);
        chunkCount = chunks.length;
        console.log(`📦 [Worker] Tabular data requires chunking: ${chunks.length} chunks`);

        for (let i = 0; i < chunks.length; i++) {
          console.log(`🔄 [Worker] Processing chunk ${i + 1}/${chunks.length}...`);
          parentPort.postMessage({ type: 'progress', progress: `Processing chunk ${i + 1} of ${chunks.length}` });

          const chunkContext = {
            ...context,
            chunkInfo: `This is part ${i + 1} of ${chunks.length} of the spreadsheet. Extract all controls found in this section.`,
          };
          const extraction = await extractControlsFromTabular(chunks[i], chunkContext);
          chunks[i] = null;

          // Extract only what we need, then free the extraction object
          const controls = extraction.result.controls || [];
          const usage = extraction.usage;
          // Avoid spread operator — push one at a time to prevent "Invalid array length"
          for (const c of controls) allControls.push(c);

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

          totalUsage.prompt_tokens += usage?.prompt_tokens || 0;
          totalUsage.completion_tokens += usage?.completion_tokens || 0;
          totalUsage.total_tokens += usage?.total_tokens || 0;

          // Force GC between chunks
          if (global.gc) global.gc();
          const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          console.log(`🧹 [Worker] After chunk ${i + 1}: ${memMB}MB heap`);
        }

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
    if (parsedType === 'document') {
      // Save metadata before nulling parsed object
      docInfo = {
        pageCount: parsed.pageCount,
        charCount: parsed.charCount,
        truncated: parsed.truncated,
        originalCharCount: parsed.originalCharCount,
      };

      if (needsChunking(parsed.text)) {
        chunked = true;
        const chunks = chunkText(parsed.text);
        // Free the entire parsed object — we only need chunks now
        parsed = null;
        if (global.gc) global.gc();
        chunkCount = chunks.length;
        console.log(`📦 [Worker] Document requires chunking: ${chunks.length} chunks`);
        const memAfterChunk = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log(`🧹 [Worker] After freeing parsed text: ${memAfterChunk}MB heap`);

        for (let i = 0; i < chunks.length; i++) {
          console.log(`🔄 [Worker] Processing chunk ${i + 1}/${chunks.length}...`);
          parentPort.postMessage({ type: 'progress', progress: `Processing chunk ${i + 1} of ${chunks.length}` });

          const chunkContext = {
            ...context,
            chunkInfo: `This is part ${i + 1} of ${chunks.length} of the document. Extract all controls found in this section.`,
          };
          const extraction = await extractFrameworkControls(chunks[i], chunkContext);
          chunks[i] = null;

          // Extract only what we need
          const controls = extraction.result.controls || [];
          const usage = extraction.usage;
          // Avoid spread operator — push one at a time to prevent "Invalid array length"
          for (const c of controls) allControls.push(c);

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

          totalUsage.prompt_tokens += usage?.prompt_tokens || 0;
          totalUsage.completion_tokens += usage?.completion_tokens || 0;
          totalUsage.total_tokens += usage?.total_tokens || 0;

          // Force GC between chunks
          if (global.gc) global.gc();
          const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
          console.log(`🧹 [Worker] After chunk ${i + 1}: ${memMB}MB heap`);
        }

        const seen = new Map();
        allControls = allControls.filter((c) => {
          if (seen.has(c.control_number)) return false;
          seen.set(c.control_number, true);
          return true;
        });

        extractionNotes = `Document was processed in ${chunkCount} chunks. ${allControls.length} unique controls extracted.`;
        if (docInfo.truncated) {
          extractionNotes += ` Note: Document was truncated from ${docInfo.originalCharCount} to ${docInfo.charCount} characters due to size limits. Some controls from later sections may be missing.`;
        }
      } else {
        const extraction = await extractFrameworkControls(parsed.text, context);
        parsed = null; // Free parsed after extraction
        if (global.gc) global.gc();
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

    // Normalize
    allControls = allControls.map((c) => ({
      ...c,
      category: c.group || c.category || null,
    }));

    const categoriesFound = [...new Set(allControls.map((c) => c.category).filter(Boolean))];

    const memEnd = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    console.log(`✅ [Worker] Framework extraction complete: ${allControls.length} controls, ${categoriesFound.length} categories, layout: ${suggestedLayout} [${memEnd}MB heap]`);

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

    if (rawPreview) {
      responseData.rawPreview = rawPreview;
    }

    if (parsedType === 'document') {
      responseData.documentInfo = {
        pageCount: docInfo.pageCount,
        charCount: docInfo.charCount,
      };
    }

    // Send completed result back to main thread
    parentPort.postMessage({
      type: 'completed',
      result: {
        success: true,
        fileType: parsedType === 'tabular' ? 'tabular' : 'document',
        fileName,
        data: responseData,
      },
    });
  } catch (err) {
    console.error(`❌ [Worker] Framework parse error:`, err.message);
    parentPort.postMessage({
      type: 'failed',
      error: err.message,
    });
  } finally {
    cleanupFile(filePath);
  }
}

run().catch((err) => {
  console.error('❌ [Worker] Unhandled error:', err.message);
  parentPort.postMessage({ type: 'failed', error: err.message });
});
