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

module.exports = { parseDocument };
