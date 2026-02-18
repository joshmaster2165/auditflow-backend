const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const SUPPORTED_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
};

async function parseDocument(filePath, mimeType) {
  console.log(`📝 Parsing document: ${path.basename(filePath)} (${mimeType})`);

  const type = SUPPORTED_TYPES[mimeType];
  if (!type) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Supported types: ${Object.keys(SUPPORTED_TYPES).join(', ')}`
    );
  }

  let text = '';

  try {
    switch (type) {
      case 'pdf':
        text = await parsePdf(filePath);
        break;
      case 'docx':
        text = await parseDocx(filePath);
        break;
      case 'text':
        text = await parseText(filePath);
        break;
    }
  } catch (err) {
    throw new Error(`Failed to parse ${type} file: ${err.message}`);
  }

  if (!text || text.trim().length === 0) {
    console.warn('⚠️ Document text extraction returned empty content. This may be a scanned PDF or image-based document.');
    throw new Error('No text content could be extracted from the document. It may be a scanned/image-based file.');
  }

  console.log(`✅ Extracted ${text.length} characters from document`);
  return text.trim();
}

async function parsePdf(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  if (result.messages && result.messages.length > 0) {
    console.log('📋 DOCX parse messages:', result.messages.map(m => m.message).join('; '));
  }
  return result.value;
}

async function parseText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Parse a document for the document viewer.
 * Returns both HTML (for DOCX) and plain text (for all types).
 * PDF files return html: null — the frontend renders PDFs via react-pdf.
 *
 * @param {string} filePath - Path to the downloaded temp file
 * @param {string} mimeType - File MIME type
 * @returns {{ html: string|null, text: string, fileType: string }}
 */
async function parseDocumentForViewer(filePath, mimeType) {
  const type = SUPPORTED_TYPES[mimeType];
  if (!type) {
    throw new Error(
      `Unsupported file type: ${mimeType}. Supported types: ${Object.keys(SUPPORTED_TYPES).join(', ')}`
    );
  }

  let html = null;
  let text = '';

  switch (type) {
    case 'docx': {
      // Get both HTML (preserves formatting) and raw text (for highlight matching)
      const htmlResult = await mammoth.convertToHtml({ path: filePath });
      html = htmlResult.value;
      const textResult = await mammoth.extractRawText({ path: filePath });
      text = textResult.value;
      break;
    }
    case 'pdf':
      // html stays null — frontend uses react-pdf for real PDF rendering
      text = await parsePdf(filePath);
      break;
    case 'text':
      // html stays null — frontend renders plain text directly
      text = await parseText(filePath);
      break;
  }

  if (!text || text.trim().length === 0) {
    throw new Error('No text content could be extracted from the document.');
  }

  console.log(`📄 Viewer parse: ${text.length} chars text${html ? `, ${html.length} chars HTML` : ''} (${type})`);
  return { html, text: text.trim(), fileType: type };
}

module.exports = { parseDocument, parseDocumentForViewer };
