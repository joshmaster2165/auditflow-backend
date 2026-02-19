/**
 * Text chunking utility for large documents.
 *
 * GPT-4o has 128K token context window. Roughly 1 token ~ 4 chars.
 * We use ~100K chars per chunk (~25K tokens input), leaving room for
 * system prompt (~1K tokens) and output (~16K tokens).
 */

const MAX_CHARS_PER_CHUNK = 100000;
const OVERLAP_CHARS = 500;
const MIN_CHUNK_FACTOR = 0.8; // Don't shrink below 80% of target chunk size

/**
 * Split text into chunks, breaking at paragraph/line boundaries when possible.
 * Enforces a minimum chunk size to prevent micro-chunking on text with
 * frequent newlines (e.g., CSV row-per-line output).
 */
function chunkText(text, maxChars = MAX_CHARS_PER_CHUNK, overlap = OVERLAP_CHARS) {
  if (text.length <= maxChars) {
    return [text];
  }

  const minChunkSize = Math.floor(maxChars * MIN_CHUNK_FACTOR);
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      // Only search for a break point in the last 20% of the chunk
      // This ensures chunks are at least 80% of maxChars
      const searchStart = start + minChunkSize;

      if (searchStart < end) {
        const segment = text.substring(searchStart, end);

        // Look for double newline (paragraph break)
        const lastParagraph = segment.lastIndexOf('\n\n');
        if (lastParagraph >= 0) {
          end = searchStart + lastParagraph;
        } else {
          // Fall back to single newline
          const lastNewline = segment.lastIndexOf('\n');
          if (lastNewline >= 0) {
            end = searchStart + lastNewline;
          }
          // If no newline found, hard break at maxChars (end stays as-is)
        }
      }
    }

    chunks.push(text.substring(start, end));

    // Next chunk starts with some overlap for context continuity
    const nextStart = end - overlap;
    // Guarantee forward progress — always advance by at least minChunkSize
    start = Math.max(nextStart, start + minChunkSize);
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
