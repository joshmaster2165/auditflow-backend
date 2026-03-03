const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { pdfToPng } = require('pdf-to-png-converter');

const SUPPORTED_TYPES = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
};

// Maximum pages to convert from a scanned PDF for vision analysis
const SCANNED_PDF_MAX_PAGES = 10;

/**
 * Check if a MIME type is an image that requires vision-based analysis.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isImageType(mimeType) {
  return SUPPORTED_TYPES[mimeType] === 'image';
}

/**
 * Convert a scanned/image-based PDF into PNG page images for GPT vision analysis.
 * Uses pdfjs-dist (via pdf-to-png-converter) with OffscreenCanvas — no native deps.
 *
 * @param {string} filePath - Path to the PDF file
 * @param {number} maxPages - Maximum number of pages to convert (default: 10)
 * @returns {Promise<Array<{ pageNumber: number, base64: string, mimeType: string }>>}
 */
async function convertPdfToImages(filePath, maxPages = SCANNED_PDF_MAX_PAGES) {
  const dataBuffer = fs.readFileSync(filePath);
  const pagesToProcess = Array.from({ length: maxPages }, (_, i) => i + 1);

  console.log(`🔄 Converting scanned PDF to images (up to ${maxPages} pages, scale 2.0x)...`);

  const pngPages = await pdfToPng(dataBuffer, {
    pagesToProcess,
    viewportScale: 2.0,
    strictPagesToProcess: false, // Skip page numbers beyond actual page count
    disableFontFace: true,
  });

  console.log(`✅ Converted ${pngPages.length} PDF page(s) to PNG images`);

  return pngPages.map(page => ({
    pageNumber: page.pageNumber,
    base64: page.content.toString('base64'),
    mimeType: 'image/png',
  }));
}

/**
 * Parse a document and return a structured result.
 *
 * Return shapes:
 *   { type: 'text', text: string }         — normal text-based document
 *   { type: 'scanned_pdf', pages: Array }  — scanned PDF converted to page images
 *   { type: 'image' }                      — native image file (caller routes to vision API)
 *
 * @param {string} filePath - Path to the downloaded temp file
 * @param {string} mimeType - File MIME type
 * @returns {Promise<{ type: string, text?: string, pages?: Array }>}
 */
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
      case 'image':
        // Images cannot be text-parsed locally — signal caller to use vision API
        console.log(`🖼️ Image file detected (${mimeType}) — requires vision analysis`);
        return { type: 'image' };
    }
  } catch (err) {
    throw new Error(`Failed to parse ${type} file: ${err.message}`);
  }

  if (!text || text.trim().length === 0) {
    // ── SCANNED PDF FALLBACK ──
    if (type === 'pdf') {
      console.log('📸 PDF has no text layer — attempting scanned PDF conversion to images...');
      try {
        const pages = await convertPdfToImages(filePath);
        if (pages.length === 0) {
          throw new Error('PDF conversion produced no pages');
        }
        console.log(`📸 Scanned PDF: ${pages.length} page(s) converted to images for vision analysis`);
        return { type: 'scanned_pdf', pages };
      } catch (convErr) {
        console.error(`❌ Scanned PDF conversion failed: ${convErr.message}`);
        throw new Error('No text content could be extracted and PDF-to-image conversion failed. The file may be corrupted.');
      }
    }

    console.warn('⚠️ Document text extraction returned empty content.');
    throw new Error('No text content could be extracted from the document.');
  }

  console.log(`✅ Extracted ${text.length} characters from document`);
  return { type: 'text', text: text.trim() };
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
    case 'image':
      // Images are displayed via signed URL — no text parsing needed
      // OCR text is stored in analysis.diff_data.extracted_text by the GPT vision call
      console.log(`🖼️ Image file for viewer — will use signed URL`);
      return { html: null, text: null, fileType: 'image' };
  }

  if (!text || text.trim().length === 0) {
    throw new Error('No text content could be extracted from the document.');
  }

  console.log(`📄 Viewer parse: ${text.length} chars text${html ? `, ${html.length} chars HTML` : ''} (${type})`);
  return { html, text: text.trim(), fileType: type };
}

module.exports = { parseDocument, parseDocumentForViewer, isImageType, convertPdfToImages };
