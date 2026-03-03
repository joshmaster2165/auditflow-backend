/**
 * Markdown-to-DOCX and HTML-to-DOCX formatters for report export.
 *
 * Handles two content types:
 * 1. Markdown (from GPT consolidation output) — **bold**, *italic*, _italic_, - bullets
 * 2. HTML (from Tiptap editor) — <strong>, <em>, <p>, <ul><li>, <ol><li>, <h2>, <h3>, <br>
 */

const {
  Paragraph,
  TextRun,
  HeadingLevel,
} = require('docx');

// ── HTML Entity Decoding ──

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ');
}

// ── Inline Markdown Parser ──

/**
 * Parse inline markdown (**bold**, *italic*, _italic_) into TextRun[].
 * @param {string} text - Single line of text
 * @param {Object} baseOptions - Base TextRun options (size, font, color)
 * @returns {TextRun[]}
 */
function parseInlineMarkdown(text, baseOptions = {}) {
  if (!text) return [new TextRun({ text: '—', ...baseOptions })];

  const runs = [];
  const inlineRegex = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_/g;
  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      runs.push(new TextRun({
        ...baseOptions,
        text: text.substring(lastIndex, match.index),
      }));
    }

    if (match[1] !== undefined) {
      // **bold**
      runs.push(new TextRun({ ...baseOptions, text: match[1], bold: true }));
    } else if (match[2] !== undefined) {
      // *italic*
      runs.push(new TextRun({ ...baseOptions, text: match[2], italics: true }));
    } else if (match[3] !== undefined) {
      // _italic_
      runs.push(new TextRun({ ...baseOptions, text: match[3], italics: true }));
    }

    lastIndex = inlineRegex.lastIndex;
  }

  // Trailing plain text
  if (lastIndex < text.length) {
    runs.push(new TextRun({
      ...baseOptions,
      text: text.substring(lastIndex),
    }));
  }

  // Fallback: no markdown found → single run with original text
  if (runs.length === 0) {
    runs.push(new TextRun({ ...baseOptions, text }));
  }

  return runs;
}

// ── Block-Level Markdown Parser ──

/**
 * Parse multi-line markdown text into Paragraph[].
 * Handles bullet lines (- item, * item) and inline formatting.
 * @param {string} text - Multi-line markdown text
 * @param {Object} baseOptions - Base TextRun options (size, font, color)
 * @returns {Paragraph[]}
 */
function parseMarkdownToDocxChildren(text, baseOptions = {}) {
  if (!text || !text.trim()) {
    return [new Paragraph({
      children: [new TextRun({ ...baseOptions, text: '—' })],
    })];
  }

  const lines = text.split('\n').filter(l => l.trim());
  const paragraphs = [];

  for (const rawLine of lines) {
    const bulletMatch = rawLine.match(/^\s*[-*•]\s+(.+)/);

    if (bulletMatch) {
      // Bullet item
      const content = bulletMatch[1];
      const runs = parseInlineMarkdown(content, baseOptions);
      runs.unshift(new TextRun({ ...baseOptions, text: '\u2022  ' }));
      paragraphs.push(new Paragraph({
        spacing: { after: 40 },
        indent: { left: 180 },
        children: runs,
      }));
    } else {
      // Normal line with inline formatting
      const runs = parseInlineMarkdown(rawLine, baseOptions);
      paragraphs.push(new Paragraph({
        spacing: { after: 60 },
        children: runs,
      }));
    }
  }

  return paragraphs.length > 0 ? paragraphs : [new Paragraph({
    children: [new TextRun({ ...baseOptions, text: '—' })],
  })];
}

// ── Inline HTML Parser ──

/**
 * Parse inline HTML tags (<strong>, <em>, <b>, <i>) into TextRun[].
 * Uses a state-machine approach: track bold/italic flags via tag open/close.
 * @param {string} html - Inline HTML fragment
 * @param {Object} baseOptions - Base TextRun options
 * @returns {TextRun[]}
 */
function parseInlineHtml(html, baseOptions = {}) {
  const runs = [];
  let bold = false;
  let italic = false;

  const inlineRegex = /<(\/?)(\w+)[^>]*>|([^<]+)/g;
  let m;

  while ((m = inlineRegex.exec(html)) !== null) {
    if (m[3] !== undefined) {
      // Text node
      const text = decodeHtmlEntities(m[3]);
      if (text.trim() || text === ' ') {
        const runOpts = { ...baseOptions, text };
        if (bold) runOpts.bold = true;
        if (italic) runOpts.italics = true;
        runs.push(new TextRun(runOpts));
      }
    } else {
      const isClosing = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (tag === 'strong' || tag === 'b') bold = !isClosing;
      if (tag === 'em' || tag === 'i') italic = !isClosing;
      // All other inline tags (span, a, u, etc.) — ignored/stripped
    }
  }

  if (runs.length === 0) {
    const plainText = html.replace(/<[^>]*>/g, '').trim();
    runs.push(new TextRun({ ...baseOptions, text: decodeHtmlEntities(plainText) || '—' }));
  }

  return runs;
}

// ── Block-Level HTML-to-DOCX Paragraph Builder ──

/**
 * Build a single Paragraph from inline HTML content with block-level context.
 */
function buildParagraphFromInlineHtml(inlineHtml, blockTag, baseOptions, listType, listCounter) {
  const runs = parseInlineHtml(inlineHtml, baseOptions);
  const paragraphOptions = { spacing: { after: 100 }, children: runs };

  // Heading levels
  if (blockTag === 'h1') {
    paragraphOptions.heading = HeadingLevel.HEADING_1;
  } else if (blockTag === 'h2') {
    paragraphOptions.heading = HeadingLevel.HEADING_2;
  } else if (blockTag === 'h3') {
    paragraphOptions.heading = HeadingLevel.HEADING_3;
  }

  // List items
  if (blockTag === 'li') {
    if (listType === 'ul') {
      runs.unshift(new TextRun({ ...baseOptions, text: '\u2022  ' }));
      paragraphOptions.indent = { left: 360 };
      paragraphOptions.spacing = { after: 40 };
    } else if (listType === 'ol') {
      runs.unshift(new TextRun({ ...baseOptions, text: `${listCounter}.  ` }));
      paragraphOptions.indent = { left: 360 };
      paragraphOptions.spacing = { after: 40 };
    }
  }

  return new Paragraph(paragraphOptions);
}

// ── Main HTML-to-DOCX Parser ──

/**
 * Parse HTML content (from Tiptap editor) into Paragraph[].
 * Falls back to parseMarkdownToDocxChildren if no HTML tags detected.
 * @param {string} html - HTML content string
 * @param {Object} baseOptions - Base TextRun options (size, font, color)
 * @returns {Paragraph[]}
 */
function parseHtmlToDocxElements(html, baseOptions = {}) {
  if (!html || !html.trim()) {
    return [new Paragraph({
      children: [new TextRun({ ...baseOptions, text: '—' })],
    })];
  }

  // If no HTML tags at all, fall back to markdown parsing (backward compat)
  if (!/<[a-z][\s\S]*>/i.test(html)) {
    return parseMarkdownToDocxChildren(html, baseOptions);
  }

  const paragraphs = [];
  let listType = null; // 'ul' or 'ol'
  let listCounter = 0;

  // Tokenize: split into tags and text nodes
  const tokenRegex = /<(\/?)(\w+)([^>]*)>|([^<]+)/gi;
  const tokens = [];
  let tm;
  while ((tm = tokenRegex.exec(html)) !== null) {
    if (tm[4] !== undefined) {
      tokens.push({ type: 'text', content: tm[4] });
    } else {
      const tagName = tm[2].toLowerCase();
      const isClosing = tm[1] === '/';
      const attrs = tm[3] || '';
      const selfClosing = attrs.trimEnd().endsWith('/') || tagName === 'br';
      tokens.push({ type: 'tag', tagName, isClosing, selfClosing });
    }
  }

  // Process tokens to build paragraphs
  let blockTag = null;
  let blockHtml = '';

  for (const token of tokens) {
    if (token.type === 'tag') {
      const { tagName, isClosing, selfClosing } = token;

      // List wrappers
      if (tagName === 'ul' || tagName === 'ol') {
        if (!isClosing) {
          listType = tagName;
          listCounter = 0;
        } else {
          listType = null;
          listCounter = 0;
        }
        continue;
      }

      // Self-closing tags (br)
      if (selfClosing && tagName === 'br') {
        if (blockHtml.trim()) {
          paragraphs.push(buildParagraphFromInlineHtml(blockHtml, blockTag, baseOptions, listType, listCounter));
        }
        blockHtml = '';
        blockTag = null;
        continue;
      }

      // Block-level tags
      if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'div'].includes(tagName)) {
        if (!isClosing) {
          // Flush previous block
          if (blockHtml.trim()) {
            paragraphs.push(buildParagraphFromInlineHtml(blockHtml, blockTag, baseOptions, listType, listCounter));
          }
          blockTag = tagName;
          blockHtml = '';
          if (tagName === 'li') listCounter++;
        } else {
          // Closing block tag — flush
          if (blockHtml.trim()) {
            paragraphs.push(buildParagraphFromInlineHtml(blockHtml, blockTag, baseOptions, listType, listCounter));
          }
          blockHtml = '';
          blockTag = null;
        }
        continue;
      }

      // Inline tags: accumulate into blockHtml for the inline parser
      blockHtml += isClosing ? `</${tagName}>` : `<${tagName}>`;
    } else {
      // Text content
      blockHtml += token.content;
    }
  }

  // Flush any remaining content
  if (blockHtml.trim()) {
    paragraphs.push(buildParagraphFromInlineHtml(blockHtml, blockTag, baseOptions, listType, listCounter));
  }

  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({
      children: [new TextRun({ ...baseOptions, text: '—' })],
    }));
  }

  return paragraphs;
}

// ── Exports ──

module.exports = {
  parseInlineMarkdown,
  parseMarkdownToDocxChildren,
  parseHtmlToDocxElements,
};
