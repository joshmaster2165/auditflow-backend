/**
 * Evidence passage matcher for document viewer highlights.
 *
 * For new analyses: GPT provides character offsets — we verify them.
 * For old analyses: GPT paraphrased quotes — we use fuzzy word-token matching.
 * Four tiers: exact offset → indexOf → whitespace-normalized → fuzzy sliding window.
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
 */
function mapNormalizedOffset(original, normOffset) {
  let normPos = 0;
  let inWhitespace = false;

  let start = 0;
  while (start < original.length && /\s/.test(original[start])) {
    start++;
  }

  for (let i = start; i < original.length; i++) {
    if (normPos >= normOffset) return i;

    if (/\s/.test(original[i])) {
      if (!inWhitespace) {
        normPos++;
        inWhitespace = true;
      }
    } else {
      normPos++;
      inWhitespace = false;
    }
  }

  return original.length;
}

/**
 * Extract word tokens from text (lowercase, alphanumeric only).
 */
function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/**
 * Compute Jaccard similarity between two sets of word tokens.
 * Returns a number between 0 and 1.
 */
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Fuzzy sliding window match — finds the best-matching region in the document
 * for a given evidence quote using word-token Jaccard similarity.
 *
 * Strategy: find the 2-3 rarest words from the quote, locate them in the
 * document to narrow the search area, then score windows near those anchors.
 */
function fuzzyMatch(documentText, quote) {
  const quoteTokens = tokenize(quote);
  if (quoteTokens.length < 3) return null; // Too short for fuzzy matching

  const docLower = documentText.toLowerCase();

  // Find anchor words: longest tokens that appear in the document (rare = distinctive)
  const anchorCandidates = [...new Set(quoteTokens)]
    .filter(t => t.length >= 4)
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);

  // Find positions of anchor words in the document
  const anchorPositions = [];
  for (const anchor of anchorCandidates) {
    let searchFrom = 0;
    while (searchFrom < docLower.length) {
      const idx = docLower.indexOf(anchor, searchFrom);
      if (idx === -1) break;
      anchorPositions.push(idx);
      searchFrom = idx + anchor.length;
    }
  }

  if (anchorPositions.length === 0) return null;

  // Deduplicate and sort anchor positions
  const uniqueAnchors = [...new Set(anchorPositions)].sort((a, b) => a - b);

  // For each anchor position, try a window around it
  const windowSize = Math.max(quote.length * 2, 200);
  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;

  for (const anchorPos of uniqueAnchors) {
    const windowStart = Math.max(0, anchorPos - windowSize);
    const windowEnd = Math.min(documentText.length, anchorPos + windowSize);
    const windowText = documentText.substring(windowStart, windowEnd);

    // Try different-sized slices within this window
    const minLen = Math.floor(quote.length * 0.5);
    const maxLen = Math.floor(quote.length * 2.0);
    const step = Math.max(20, Math.floor(quote.length * 0.15));

    for (let len = minLen; len <= maxLen; len += step) {
      for (let offset = 0; offset + len <= windowText.length; offset += step) {
        const slice = windowText.substring(offset, offset + len);
        const sliceTokens = tokenize(slice);
        const score = jaccardSimilarity(quoteTokens, sliceTokens);

        if (score > bestScore) {
          bestScore = score;
          bestStart = windowStart + offset;
          bestEnd = windowStart + offset + len;
        }
      }
    }
  }

  // Only accept if similarity is decent (0.4 = 40% word overlap)
  if (bestScore >= 0.4 && bestStart >= 0) {
    // Snap to paragraph boundaries for cleaner highlights
    const paraStart = documentText.lastIndexOf('\n', bestStart);
    const paraEnd = documentText.indexOf('\n', bestEnd);
    return {
      startOffset: paraStart >= 0 ? paraStart + 1 : bestStart,
      endOffset: paraEnd >= 0 ? paraEnd : bestEnd,
      score: bestScore,
    };
  }

  return null;
}

/**
 * Verify GPT's claimed offsets and build highlight ranges.
 *
 * Strategy:
 * 1. Check if text at GPT's offsets matches the quote (fast path — new analyses)
 * 2. Fall back to indexOf on original text
 * 3. Fall back to indexOf with whitespace normalization
 * 4. Fall back to fuzzy sliding window match (handles paraphrased old analyses)
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
    // Skip items with no evidence text to search for
    if (!req.evidence_found) continue;

    const loc = req.evidence_location || {};
    const quote = req.evidence_found;
    let startOffset = -1;
    let endOffset = -1;
    let matchQuality = 'unmatched';

    // Tier 1: Verify GPT's claimed offsets
    if (loc.start_index >= 0 && loc.end_index > loc.start_index && loc.end_index <= documentText.length) {
      const slice = documentText.substring(loc.start_index, loc.end_index);
      if (slice === quote) {
        startOffset = loc.start_index;
        endOffset = loc.end_index;
        matchQuality = 'exact';
      } else if (normalizeWs(slice) === normalizeWs(quote)) {
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

    // Tier 2.5: Extract quoted phrases from contextual evidence descriptions
    //  GPT may write: "The document's 'Information Security Policy v2.1' describes..."
    //  We extract the quoted phrase and search for it in the document.
    if (matchQuality === 'unmatched') {
      const quotedPhrases = [];
      const quoteRegex = /["']([^"']{10,}?)["']/g;
      let m;
      while ((m = quoteRegex.exec(quote)) !== null) {
        quotedPhrases.push(m[1]);
      }
      // Sort longest first — longer phrases are more distinctive
      quotedPhrases.sort((a, b) => b.length - a.length);

      for (const phrase of quotedPhrases) {
        const idx = documentText.indexOf(phrase);
        if (idx !== -1) {
          // Expand to sentence boundaries for more context
          let sentStart = documentText.lastIndexOf('.', idx);
          sentStart = sentStart >= 0 && idx - sentStart < 200 ? sentStart + 1 : idx;
          let sentEnd = documentText.indexOf('.', idx + phrase.length);
          sentEnd = sentEnd >= 0 && sentEnd - idx < 300 ? sentEnd + 1 : idx + phrase.length;
          startOffset = sentStart;
          endOffset = sentEnd;
          matchQuality = 'normalized';
          break;
        }
        // Try whitespace-normalized version of the phrase
        const normPhrase = normalizeWs(phrase);
        if (normPhrase.length >= 10) {
          const normDoc = normalizeWs(documentText);
          const nIdx = normDoc.indexOf(normPhrase);
          if (nIdx !== -1) {
            startOffset = mapNormalizedOffset(documentText, nIdx);
            endOffset = mapNormalizedOffset(documentText, nIdx + normPhrase.length);
            matchQuality = 'normalized';
            break;
          }
        }
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

    // Tier 4: Fuzzy sliding window match (for old analyses where GPT paraphrased)
    if (matchQuality === 'unmatched') {
      const fuzzyResult = fuzzyMatch(documentText, quote);
      if (fuzzyResult) {
        startOffset = fuzzyResult.startOffset;
        endOffset = fuzzyResult.endOffset;
        matchQuality = 'approximate';
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
