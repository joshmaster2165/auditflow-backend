/**
 * Text chunking utility for large PDFs.
 *
 * GPT-4-turbo has ~128K token context. Roughly 1 token ~ 4 chars.
 * We reserve ~4K tokens for system prompt + output = ~16K chars.
 * Conservative chunk size: ~100K chars (~25K tokens input).
 */

const MAX_CHARS_PER_CHUNK = 50000;
const OVERLAP_CHARS = 500;

/**
 * Split text into chunks, breaking at paragraph boundaries when possible.
 */
function chunkText(text, maxChars = MAX_CHARS_PER_CHUNK, overlap = OVERLAP_CHARS) {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChars;

    if (end < text.length) {
      // Try to break at a paragraph boundary near the end
      const searchStart = Math.max(end - 500, start);
      const segment = text.substring(searchStart, end);

      // Look for double newline (paragraph break)
      const lastParagraph = segment.lastIndexOf('\n\n');
      if (lastParagraph > 0) {
        end = searchStart + lastParagraph;
      } else {
        // Fall back to single newline
        const lastNewline = segment.lastIndexOf('\n');
        if (lastNewline > 0) {
          end = searchStart + lastNewline;
        }
      }
    } else {
      end = text.length;
    }

    chunks.push(text.substring(start, end));
    start = end - overlap;
  }

  console.log(`📦 Chunked ${text.length} chars into ${chunks.length} chunks`);
  return chunks;
}

/**
 * Check if text exceeds the single-pass limit and needs chunking.
 */
function needsChunking(text) {
  return text.length > MAX_CHARS_PER_CHUNK;
}

module.exports = { chunkText, needsChunking, MAX_CHARS_PER_CHUNK };
