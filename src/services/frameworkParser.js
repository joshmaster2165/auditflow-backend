const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// Use pdfjs-dist directly for page-by-page extraction (memory-safe)
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

// Safety limits
const MAX_PDF_CHARS = 500000; // ~125K tokens, covers ~200+ pages of dense text
const MAX_PDF_PAGES = 200;    // Hard cap on pages to parse

/**
 * Parse a framework file into a uniform intermediate format.
 *
 * For CSV/XLSX: returns { type: 'tabular', headers, rows, totalRows, sheetName, allSheetNames }
 * For PDF:      returns { type: 'document', text, pageCount, charCount, metadata }
 */
async function parseFrameworkFile(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.csv') {
    return parseTabularFile(filePath);
  } else if (ext === '.xlsx' || ext === '.xls') {
    return parseTabularFile(filePath);
  } else if (ext === '.pdf') {
    return parsePdfFile(filePath);
  } else {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
}

/**
 * Parse CSV or XLSX files using SheetJS.
 * SheetJS handles both CSV and XLSX identically through readFile.
 */
function parseTabularFile(filePath) {
  const workbook = XLSX.readFile(filePath, {
    type: 'file',
    cellDates: false,
    raw: true,
  });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('No sheets found in the uploaded file');
  }

  const sheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  if (jsonData.length < 2) {
    throw new Error('File must contain at least a header row and one data row');
  }

  const headers = jsonData[0].map((h) => {
    const val = h;
    if (val === undefined || val === null) return '';
    return String(val).trim();
  }).filter((h) => h !== '');

  const rows = jsonData.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      const val = row[i];
      obj[h] = (val !== undefined && val !== null) ? String(val).trim() : '';
    });
    return obj;
  });

  // Filter out completely empty rows
  const nonEmptyRows = rows.filter((row) =>
    Object.values(row).some((v) => v !== '')
  );

  console.log(`📊 Parsed tabular file: ${headers.length} columns, ${nonEmptyRows.length} rows`);

  return {
    type: 'tabular',
    headers,
    rows: nonEmptyRows,
    totalRows: nonEmptyRows.length,
    sheetName,
    sheetCount: workbook.SheetNames.length,
    allSheetNames: workbook.SheetNames,
  };
}

/**
 * Parse PDF files page-by-page using pdfjs-dist.
 * Unlike pdf-parse which loads ALL pages into memory at once,
 * this extracts text one page at a time and frees each page after use.
 * This keeps peak memory low enough for Railway's 512MB limit.
 */
async function parsePdfFile(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const uint8Array = new Uint8Array(dataBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pagesToParse = Math.min(totalPages, MAX_PDF_PAGES);

  console.log(`📄 PDF has ${totalPages} pages, parsing ${pagesToParse} page-by-page`);

  let allText = '';

  for (let i = 1; i <= pagesToParse; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    allText += pageText + '\n\n';
    page.cleanup();

    // Log progress every 25 pages
    if (i % 25 === 0) {
      const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`📄 Parsed ${i}/${pagesToParse} pages (${memMB}MB heap)`);
    }
  }

  pdf.cleanup();

  allText = allText.trim();

  if (!allText || allText.length === 0) {
    throw new Error(
      'No text content could be extracted from the PDF. It may be a scanned/image-based document. ' +
        'Please convert it to CSV or XLSX format and try again.'
    );
  }

  let truncated = false;
  const originalLength = allText.length;

  if (allText.length > MAX_PDF_CHARS) {
    console.warn(`⚠️ PDF text is ${allText.length} chars — truncating to ${MAX_PDF_CHARS} chars`);
    allText = allText.substring(0, MAX_PDF_CHARS);
    truncated = true;
  }

  console.log(`📄 Parsed PDF: ${totalPages} pages, ${originalLength} chars${truncated ? ` (truncated to ${MAX_PDF_CHARS})` : ''}`);

  return {
    type: 'document',
    text: allText,
    pageCount: totalPages,
    charCount: allText.length,
    originalCharCount: originalLength,
    truncated,
    metadata: { title: null, author: null },
  };
}

/**
 * Convert tabular data (headers + rows) into a text format for GPT consumption.
 * Sends all rows so GPT can map every row to a control.
 */
function tabularToText(headers, rows) {
  let text = `SPREADSHEET DATA\n`;
  text += `Columns: ${headers.join(' | ')}\n`;
  text += `Total rows: ${rows.length}\n\n`;

  rows.forEach((row, i) => {
    const fields = headers
      .map((h) => {
        const val = row[h];
        return val ? `${h}: ${val}` : null;
      })
      .filter(Boolean)
      .join(' | ');
    text += `Row ${i + 1}: ${fields}\n`;
  });

  return text;
}

module.exports = { parseFrameworkFile, tabularToText };
