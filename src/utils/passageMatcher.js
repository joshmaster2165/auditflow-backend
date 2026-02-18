/**
 * Lightweight offset verifier for GPT evidence passage locations.
 *
 * GPT provides character offsets for its evidence_found quotes. This module
 * verifies those offsets are accurate and falls back to simple string search
 * if they're not. No complex fuzzy matching — GPT does the heavy lifting.
 */

/**
 * Collapse all whitespace (spaces, tabs, newlines) into single spaces and trim.
 */
function normalizeWs(str) {
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Map a character offset in the normalized (whitespace-collapsed) string
 * back to the corresponding offset in the original string.
 *
 * Walks the original string tracking how many normalized characters have
 * been consumed, then returns the original-string index.
 */
function mapNormalizedOffset(original, normOffset) {
  let normPos = 0;
  let inWhitespace = false;

  // Skip leading whitespace in original (matches trim behavior)
  let start = 0;
  while (start < original.length && /\s/.test(original[start])) {
    start++;
  }

  for (let i = start; i < original.length; i++) {
    if (normPos >= normOffset) return i;

    if (/\s/.test(original[i])) {
      if (!inWhitespace) {
        normPos++; // Collapsed whitespace = 1 char in normalized
        inWhitespace = true;
      }
      // Skip additional whitespace chars
    } else {
      normPos++;
      inWhitespace = false;
    }
  }

  return original.length;
}

/**
 * Verify GPT's claimed offsets and build highlight ranges.
 *
 * Strategy:
 * 1. Check if text at GPT's offsets matches the quote (fast path)
 * 2. Fall back to indexOf on original text
 * 3. Fall back to indexOf with whitespace normalization
 * 4. Give up and mark as 'unmatched'
 *
 * @param {string} documentText - The full extracted document text
 * @param {Array} requirementsBreakdown - GPT's requirements_breakdown array
 * @returns {Array} Sorted, non-overlapping highlight ranges
 */
function verifyAndBuildHighlightRanges(documentText, requirementsBreakdown) {
  if (!documentText || !requirementsBreakdown || !Array.isArray(requirementsBreakdown)) {
    return [];
  }

  const ranges = [];

  for (const req of requirementsBreakdown) {
    // Skip items with no evidence to highlight
    if (!req.evidence_found || req.status === 'missing') continue;

    const loc = req.evidence_location || {};
    const quote = req.evidence_found;
    let startOffset = -1;
    let endOffset = -1;
    let matchQuality = 'unmatched';

    // Tier 1: Verify GPT's claimed offsets
    if (loc.start_index >= 0 && loc.end_index > loc.start_index && loc.end_index <= documentText.length) {
      const slice = documentText.substring(loc.start_index, loc.end_index);
      if (slice === quote) {
        // Perfect match
        startOffset = loc.start_index;
        endOffset = loc.end_index;
        matchQuality = 'exact';
      } else if (normalizeWs(slice) === normalizeWs(quote)) {
        // Match with whitespace differences
        startOffset = loc.start_index;
        endOffset = loc.end_index;
        matchQuality = 'exact';
      }
    }

    // Tier 2: Simple indexOf on original text
    if (matchQuality === 'unmatched') {
      const idx = documentText.indexOf(quote);
      if (idx !== -1) {
        startOffset = idx;
        endOffset = idx + quote.length;
        matchQuality = 'exact';
      }
    }

    // Tier 3: indexOf with whitespace normalization
    if (matchQuality === 'unmatched') {
      const normDoc = normalizeWs(documentText);
      const normQuote = normalizeWs(quote);
      if (normQuote.length >= 10) {
        const idx = normDoc.indexOf(normQuote);
        if (idx !== -1) {
          startOffset = mapNormalizedOffset(documentText, idx);
          endOffset = mapNormalizedOffset(documentText, idx + normQuote.length);
          matchQuality = 'normalized';
        }
      }
    }

    if (startOffset >= 0 && endOffset > startOffset) {
      ranges.push({
        startOffset,
        endOffset,
        requirementId: req.requirement_id,
        status: req.status,
        evidenceText: quote,
        matchQuality,
        sectionContext: loc.section_context || null,
      });
    }
  }

  // Sort by position and resolve any overlaps
  return resolveOverlaps(ranges.sort((a, b) => a.startOffset - b.startOffset));
}

/**
 * Resolve overlapping highlight ranges.
 * When ranges overlap, the more concerning status wins:
 * missing > partial > met (so critical gaps are always visible).
 */
function resolveOverlaps(sortedRanges) {
  if (sortedRanges.length <= 1) return sortedRanges;

  const statusPriority = { missing: 3, partial: 2, met: 1 };
  const result = [];

  for (const range of sortedRanges) {
    if (result.length === 0) {
      result.push(range);
      continue;
    }

    const prev = result[result.length - 1];

    if (range.startOffset < prev.endOffset) {
      // Overlap detected — keep the higher-priority range's full span
      const prevPriority = statusPriority[prev.status] || 0;
      const currPriority = statusPriority[range.status] || 0;

      if (currPriority > prevPriority) {
        // Current range has higher priority — truncate prev, add current
        prev.endOffset = range.startOffset;
        if (prev.endOffset > prev.startOffset) {
          result.push(range);
        } else {
          result[result.length - 1] = range;
        }
      } else {
        // Previous range has higher or equal priority — extend it if needed
        prev.endOffset = Math.max(prev.endOffset, range.endOffset);
      }
    } else {
      result.push(range);
    }
  }

  // Remove any zero-width ranges
  return result.filter(r => r.endOffset > r.startOffset);
}

module.exports = { verifyAndBuildHighlightRanges };
