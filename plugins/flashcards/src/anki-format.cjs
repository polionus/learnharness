'use strict';
const { createHash } = require('node:crypto');
const { CARD_TYPES, cardTypeInfo, inferCardTypeFromCue } = require('./card-types.cjs');

const MODEL_NAME = 'LearnHarness Basic';
const MODEL_CSS = [
  '.card { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 18px; line-height: 1.55; color: #1c1917; background: #ffffff; max-width: 42rem; margin: 0 auto; padding: 24px 16px; text-align: left; }',
  '.nightMode .card, .night_mode .card { color: #f5f5f4; background: #1c1917; }',
  'hr#answer { border: 0; border-top: 1px solid #d6d3d1; margin: 20px 0; }',
  '.nightMode hr#answer, .night_mode hr#answer { border-top-color: #44403c; }',
  'code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; background: rgba(128,128,128,0.12); padding: 0.1em 0.35em; border-radius: 4px; }',
  'pre { background: rgba(128,128,128,0.1); padding: 12px; border-radius: 8px; overflow-x: auto; text-align: left; }',
  'pre code { background: transparent; padding: 0; }',
  'table { border-collapse: collapse; margin: 12px 0; width: 100%; }',
  'th, td { border: 1px solid rgba(128,128,128,0.3); padding: 6px 10px; text-align: left; }',
  'blockquote { border-left: 3px solid rgba(128,128,128,0.4); margin: 10px 0; padding: 2px 12px; opacity: 0.9; }',
  '.cloze { font-weight: 700; color: #2563eb; }',
  '.nightMode .cloze, .night_mode .cloze { color: #60a5fa; }',
  '.lh-prop { margin-top: 18px; font-size: 12px; color: #78716c; }',
].join('\n');

const FRONT_TEMPLATE = '{{Front}}';
const BACK_TEMPLATE = '{{FrontSide}}<hr id="answer">{{Back}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}';

function ankiModelSpec(cardType) {
  const info = cardTypeInfo(cardType);
  if (info.id === 'basic-reversed') {
    return {
      ...info,
      fields: ['Front', 'Back', 'Proposition'],
      templates: [
        { Name: 'Card 1', Front: '{{Front}}', Back: '{{FrontSide}}<hr id="answer">{{Back}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}' },
        { Name: 'Card 2', Front: '{{Back}}', Back: '{{FrontSide}}<hr id="answer">{{Front}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}' },
      ],
    };
  }
  if (info.id === 'basic-optional-reversed') {
    return {
      ...info,
      fields: ['Front', 'Back', 'Add Reverse', 'Proposition'],
      templates: [
        { Name: 'Card 1', Front: '{{Front}}', Back: '{{FrontSide}}<hr id="answer">{{Back}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}' },
        { Name: 'Card 2', Front: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}', Back: '{{FrontSide}}<hr id="answer">{{Front}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}' },
      ],
    };
  }
  if (info.id === 'basic-type-answer') {
    return {
      ...info,
      fields: ['Front', 'Back', 'Proposition'],
      templates: [
        { Name: 'Card 1', Front: '{{Front}}<br><br>{{type:Back}}', Back: '{{Front}}<hr id="answer">{{type:Back}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}' },
      ],
    };
  }
  if (info.id === 'cloze') {
    return {
      ...info,
      fields: ['Text', 'Back Extra', 'Proposition'],
      templates: [
        { Name: 'Cloze', Front: '{{cloze:Text}}', Back: '{{cloze:Text}}<br><br>{{Back Extra}}{{#Proposition}}<div class="lh-prop">{{Proposition}}</div>{{/Proposition}}' },
      ],
    };
  }
  return {
    ...info,
    fields: ['Front', 'Back', 'Proposition'],
    templates: [
      { Name: 'Card 1', Front: FRONT_TEMPLATE, Back: BACK_TEMPLATE },
    ],
  };
}

function buildAnkiFieldsForCue(cue, proposition) {
  const cardType = inferCardTypeFromCue(cue);
  const spec = ankiModelSpec(cardType);
  const propHtml = proposition?.name ? markdownToAnkiHtml(proposition.name) : '';
  if (cardType === 'cloze') {
    const rawQuestion = String(cue.question ?? '');
    const textHtml = hasClozeSyntax(rawQuestion)
      ? markdownToAnkiHtml(rawQuestion)
      : markdownToAnkiHtml(`${rawQuestion} {{c1::${String(cue.answer ?? '').trim()}}}`);
    const extraHtml = hasClozeSyntax(rawQuestion) ? markdownToAnkiHtml(cue.answer) : '';
    return { cardType, spec, fields: { Text: textHtml, 'Back Extra': extraHtml, Proposition: propHtml } };
  }
  if (cardType === 'basic-optional-reversed') {
    return {
      cardType,
      spec,
      fields: {
        Front: markdownToAnkiHtml(cue.question),
        Back: markdownToAnkiHtml(cue.answer),
        'Add Reverse': cue.addReverse ? 'yes' : '',
        Proposition: propHtml,
      },
    };
  }
  if (cardType === 'basic-type-answer') {
    // Anki's {{type:Back}} compares plain text, so keep Back cleanly escaped without extra block wrappers when simple.
    const rawAns = String(cue.answer ?? '').trim();
    const isSimple = !rawAns.includes('\n') && !/[`*_[\]$]/.test(rawAns);
    return {
      cardType,
      spec,
      fields: {
        Front: markdownToAnkiHtml(cue.question),
        Back: isSimple ? escapeHtml(rawAns) : markdownToAnkiHtml(rawAns),
        Proposition: propHtml,
      },
    };
  }
  return {
    cardType,
    spec,
    fields: {
      Front: markdownToAnkiHtml(cue.question),
      Back: markdownToAnkiHtml(cue.answer),
      Proposition: propHtml,
    },
  };
}

function detectCardTypeFromAnkiModel(modelName, isCloze, fieldNames = [], rawFirstField = '') {
  const lower = String(modelName || '').toLowerCase();
  if (isCloze || lower.includes('cloze') || hasClozeSyntax(rawFirstField)) return 'cloze';
  if (lower.includes('type in the answer') || lower.includes('type-answer')) return 'basic-type-answer';
  if (lower.includes('optional reversed') || fieldNames.some(f => f.toLowerCase() === 'add reverse')) return 'basic-optional-reversed';
  if (lower.includes('and reversed') || lower.includes('reversed')) return 'basic-reversed';
  return 'basic';
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeHtml(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

function renderInlineMarkdown(input) {
  const placeholders = [];
  const hold = html => {
    const token = `\u0000LH${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };
  let text = String(input ?? '');
  // Preserve inline code spans first so math/markdown inside code is never altered.
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  // Preserve escaped dollar signs.
  text = text.replace(/\\\$/g, () => hold('$'));
  // Display math $$...$$ -> \[...\]
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => hold(`\\[${escapeHtml(math.trim())}\\]`));
  // Inline math $...$ -> \(...\)
  text = text.replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, prefix, math) => `${prefix}${hold(`\\(${escapeHtml(math)}\\)`)}`);
  // Escape remaining raw HTML before applying inline formatting.
  text = escapeHtml(text);
  // Safe http/https links.
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`);
  // Bold, italic, strikethrough.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return text.replace(/\u0000LH(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)]);
}

function isTableDivider(line) {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function markdownToAnkiHtml(markdown) {
  const raw = String(markdown ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';
  const lines = raw.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Fenced code blocks.
    const fence = /^(`{3,}|~{3,})\s*([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0], minLen = fence[1].length, lang = fence[2];
      const codeLines = [];
      i++;
      while (i < lines.length && !(new RegExp(`^${marker}{${minLen},}\\s*$`).test(lines[i]))) {
        codeLines.push(lines[i++]);
      }
      if (i < lines.length) i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      blocks.push(`<pre><code${cls}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Standalone display math block.
    if (/^\s*\$\$\s*$/.test(line)) {
      const mathLines = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) mathLines.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(`<div>\\[${escapeHtml(mathLines.join('\n').trim())}\\]</div>`);
      continue;
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // GFM tables.
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitTableRow(lines[i++]));
      }
      const thead = `<thead><tr>${headers.map(h => `<th>${renderInlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows.map(r => `<tr>${headers.map((_, idx) => `<td>${renderInlineMarkdown(r[idx] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      blocks.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Blockquotes.
    if (/^\s*>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      blocks.push(`<blockquote>${markdownToAnkiHtml(quoteLines.join('\n'))}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMarkdown(lines[i++].replace(/^\s*[-*+]\s+/, ''))}</li>`);
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInlineMarkdown(lines[i++].replace(/^\s*\d+\.\s+/, ''))}</li>`);
      }
      blocks.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(`{3,}|~{3,})/.test(lines[i]) &&
      !/^\s*\$\$\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    blocks.push(para.map(renderInlineMarkdown).join('<br>'));
  }

  return blocks.join('<br><br>');
}

function ankiHtmlToMarkdown(html) {
  let text = String(html ?? '');
  if (!text.trim()) return '';
  const placeholders = [];
  const hold = value => {
    const token = `\u0000LHM${placeholders.length}\u0000`;
    placeholders.push(value);
    return token;
  };
  // Remove embedded style/script tags completely.
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  // Convert and protect Anki MathJax / LaTeX blocks before stripping tags.
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => hold(`\n$$\n${unescapeHtml(m).trim()}\n$$\n`));
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => hold(`$${unescapeHtml(m).trim()}$`));
  text = text.replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/gi, (_, m) => hold(`\n$$\n${unescapeHtml(m).trim()}\n$$\n`));
  text = text.replace(/\[\$\]([\s\S]*?)\[\/\$\]/gi, (_, m) => hold(`$${unescapeHtml(m).trim()}$`));
  text = text.replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (_, m) => hold(`\n$$\n${unescapeHtml(m).trim()}\n$$\n`));
  // Convert and protect code blocks & inline code so `<`/`>` inside code are never stripped as HTML tags.
  text = text.replace(/<pre\b[^>]*>\s*<code(?:\s+class="language-([^"]+)")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, lang, code) => hold(`\n\`\`\`${lang || ''}\n${unescapeHtml(code)}\n\`\`\`\n`));
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => hold(`\n\`\`\`\n${unescapeHtml(code)}\n\`\`\`\n`));
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => hold(`\`${unescapeHtml(code)}\``));
  // Headings, lists, blockquotes, links, emphasis.
  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n${'#'.repeat(Number(level))} ${inner.trim()}\n`);
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => `\n> ${inner.trim().replace(/\n/g, '\n> ')}\n`);
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inner.trim()}`);
  text = text.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n');
  text = text.replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');
  text = text.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*');
  text = text.replace(/<(?:s|del|strike)\b[^>]*>([\s\S]*?)<\/(?:s|del|strike)>/gi, '~~$1~~');
  // Line & block breaks.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:div|p|tr)>/gi, '\n');
  text = text.replace(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi, ' | $1');
  // Strip any remaining HTML tags, unescape remaining text, then restore protected code/math blocks.
  text = text.replace(/<[^>]+>/g, '');
  text = unescapeHtml(text);
  text = text.replace(/\u0000LHM(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)]);
  // Strip Anki audio syntax if alone, or leave readable reference.
  text = text.replace(/\[sound:[^\]]+\]/g, '').replace(/\r\n?/g, '\n');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::(.*?))?\}\}/g;

function hasClozeSyntax(text) {
  CLOZE_RE.lastIndex = 0;
  return CLOZE_RE.test(String(text ?? ''));
}

function expandClozeCards(rawText, extraText = '') {
  const source = String(rawText ?? '');
  const ordinals = new Set();
  for (const match of source.matchAll(CLOZE_RE)) ordinals.add(Number(match[1]));
  if (!ordinals.size) return [];
  const extra = ankiHtmlToMarkdown(extraText);
  return [...ordinals].sort((a, b) => a - b).map(num => {
    const maskedHtml = source.replace(CLOZE_RE, (_, n, answer, hint) =>
      Number(n) === num ? `[${hint ? hint.trim() : '...'}]` : answer
    );
    const revealedHtml = source.replace(CLOZE_RE, (_, n, answer) =>
      Number(n) === num ? `<strong>${answer}</strong>` : answer
    );
    const question = ankiHtmlToMarkdown(maskedHtml);
    const revealed = ankiHtmlToMarkdown(revealedHtml);
    const answer = extra ? `${revealed}\n\n${extra}` : revealed;
    return { clozeIndex: num, question, answer };
  });
}

function ankiTag(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_:./-]/g, '');
  return cleaned || 'learnharness';
}

function normalizePrefix(prefix) {
  return String(prefix ?? '')
    .trim()
    .replace(/^:+|:+$/g, '')
    .replace(/:{3,}/g, '::');
}

function ankiDeckName(deckName, prefix) {
  const cleanDeck = String(deckName ?? 'LearnHarness').trim() || 'LearnHarness';
  const cleanPrefix = normalizePrefix(prefix);
  if (!cleanPrefix) return cleanDeck;
  if (cleanDeck === cleanPrefix || cleanDeck.startsWith(`${cleanPrefix}::`)) return cleanDeck;
  return `${cleanPrefix}::${cleanDeck}`;
}

function stripAnkiPrefix(deckName, prefix) {
  const cleanDeck = String(deckName ?? 'Imported from Anki').trim() || 'Imported from Anki';
  const cleanPrefix = normalizePrefix(prefix);
  if (cleanPrefix && cleanDeck.startsWith(`${cleanPrefix}::`)) {
    const rest = cleanDeck.slice(cleanPrefix.length + 2).trim();
    if (rest) return rest;
  }
  return cleanDeck;
}

function cueFingerprint(question, answer, propositionName, deckName, cardType = 'basic', addReverse = false) {
  return createHash('sha256')
    .update(JSON.stringify([question ?? '', answer ?? '', propositionName ?? '', deckName ?? '', cardType ?? 'basic', Boolean(addReverse)]))
    .digest('hex');
}

const BASE91_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';

function guidForCue(cueId) {
  const digest = createHash('sha256').update(`learnharness:cue:${cueId}`).digest();
  let num = digest.readBigUInt64BE(0);
  const base = BigInt(BASE91_CHARS.length);
  let out = '';
  while (num > 0n) {
    out = BASE91_CHARS[Number(num % base)] + out;
    num /= base;
  }
  return out || 'lh0';
}

function fieldChecksum(firstFieldHtml) {
  const stripped = unescapeHtml(String(firstFieldHtml ?? '').replace(/<[^>]+>/g, ''));
  const hex = createHash('sha1').update(stripped).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16);
}

function ankiScheduleToFsrs(card, now = Date.now(), dayStart = 4, collectionCrtSec = null) {
  const dayMs = 86400000;
  const base = {
    due: now, stability: 0, difficulty: 0, elapsed_days: 0,
    scheduled_days: 0, reps: 0, lapses: 0, learning_steps: 0,
    state: 0, last_review: null,
  };
  if (!card) return base;
  const type = Number(card.type ?? 0);
  const ivl = Number(card.ivl ?? card.interval ?? 0);
  const reps = Math.max(0, Math.trunc(Number(card.reps ?? 0)));
  const lapses = Math.max(0, Math.trunc(Number(card.lapses ?? 0)));
  let parsedData = null;
  if (typeof card.data === 'string' && card.data.trim().startsWith('{')) {
    try { parsedData = JSON.parse(card.data); } catch { /* ignore malformed metadata */ }
  } else if (card.data && typeof card.data === 'object') {
    parsedData = card.data;
  }
  if (type === 0 && reps === 0) return base;

  const fsrsStability = Number(parsedData?.s);
  const fsrsDifficulty = Number(parsedData?.d);
  const stability = Number.isFinite(fsrsStability) && fsrsStability > 0
    ? +fsrsStability.toFixed(8)
    : Math.max(0.1, ivl > 0 ? ivl : 1);
  const easeFactor = Number(card.factor ?? 2500);
  const derivedDifficulty = Number.isFinite(easeFactor) && easeFactor > 0
    ? Math.min(10, Math.max(1, +(11 - (easeFactor / 250)).toFixed(4)))
    : 5;
  const difficulty = Number.isFinite(fsrsDifficulty) && fsrsDifficulty >= 1 && fsrsDifficulty <= 10
    ? +fsrsDifficulty.toFixed(8)
    : derivedDifficulty;

  let state = 2;
  if (type === 1) state = 1;
  else if (type === 3) state = 3;
  else if (type === 2 || ivl > 0) state = 2;
  else state = 0;

  let due = now;
  const rawDue = Number(card.due ?? 0);
  if (state === 1 || state === 3) {
    due = rawDue > 1e12 ? rawDue : rawDue > 1e9 ? rawDue * 1000 : now;
  } else if (state === 2) {
    if (collectionCrtSec && Number.isFinite(rawDue) && rawDue >= 0 && rawDue < 1e7) {
      due = (collectionCrtSec + rawDue * 86400) * 1000;
    } else if (Number.isFinite(ivl) && ivl > 0) {
      due = now + ivl * dayMs;
    }
  }
  const scheduledDays = state === 2 ? Math.max(1, Math.round(ivl > 0 ? ivl : stability)) : 0;
  const lastReview = state === 2 && scheduledDays > 0 ? Math.min(now, due - scheduledDays * dayMs) : reps > 0 ? now : null;

  const schedule = {
    due,
    stability,
    difficulty,
    elapsed_days: 0,
    scheduled_days: scheduledDays,
    reps,
    lapses,
    learning_steps: 0,
    state,
    last_review: lastReview,
  };
  if (state === 2) {
    const d = new Date(due);
    if (d.getHours() < dayStart) d.setDate(d.getDate() - 1);
    schedule.dueDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return schedule;
}

function fsrsToAnkiCardState(schedule, now = Date.now(), collectionCrtSec = Math.floor(now / 1000), cardOrd = 1) {
  const s = schedule || { state: 0, reps: 0, lapses: 0, stability: 0, difficulty: 0, scheduled_days: 0, due: now };
  if (s.state === 0) {
    return { type: 0, queue: 0, due: cardOrd, ivl: 0, factor: 2500, reps: 0, lapses: 0, data: '{}' };
  }
  const factor = Math.round(Math.min(3500, Math.max(1300, (11 - (s.difficulty || 5)) * 250)));
  const data = s.stability > 0 && s.difficulty > 0
    ? JSON.stringify({ s: +s.stability.toFixed(4), d: +s.difficulty.toFixed(4) })
    : '{}';
  if (s.state === 1 || s.state === 3) {
    return {
      type: s.state,
      queue: 1,
      due: Math.max(1, Math.floor((s.due || now) / 1000)),
      ivl: 0,
      factor,
      reps: s.reps || 0,
      lapses: s.lapses || 0,
      data,
    };
  }
  const ivl = Math.max(1, Math.round(s.scheduled_days || s.stability || 1));
  const dueDays = Math.max(0, Math.round(((s.due || now) / 1000 - collectionCrtSec) / 86400));
  return {
    type: 2,
    queue: 2,
    due: dueDays,
    ivl,
    factor,
    reps: s.reps || 1,
    lapses: s.lapses || 0,
    data,
  };
}

module.exports = {
  CARD_TYPES,
  MODEL_NAME,
  MODEL_CSS,
  FRONT_TEMPLATE,
  BACK_TEMPLATE,
  ankiModelSpec,
  buildAnkiFieldsForCue,
  detectCardTypeFromAnkiModel,
  escapeHtml,
  unescapeHtml,
  markdownToAnkiHtml,
  ankiHtmlToMarkdown,
  hasClozeSyntax,
  expandClozeCards,
  ankiTag,
  normalizePrefix,
  ankiDeckName,
  stripAnkiPrefix,
  cueFingerprint,
  guidForCue,
  fieldChecksum,
  ankiScheduleToFsrs,
  fsrsToAnkiCardState,
};
