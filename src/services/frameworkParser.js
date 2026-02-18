const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

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
 * Parse PDF files and extract text content.
 */
async function parsePdfFile(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);

  if (!data.text || data.text.trim().length === 0) {
    throw new Error(
      'No text content could be extracted from the PDF. It may be a scanned/image-based document. ' +
        'Please convert it to CSV or XLSX format and try again.'
    );
  }

  console.log(`📄 Parsed PDF: ${data.numpages} pages, ${data.text.trim().length} characters`);

  return {
    type: 'document',
    text: data.text.trim(),
    pageCount: data.numpages,
    charCount: data.text.trim().length,
    metadata: {
      title: data.info?.Title || null,
      author: data.info?.Author || null,
    },
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
