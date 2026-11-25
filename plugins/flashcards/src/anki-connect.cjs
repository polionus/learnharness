'use strict';
const {
  MODEL_NAME,
  MODEL_CSS,
  ankiModelSpec,
  buildAnkiFieldsForCue,
  detectCardTypeFromAnkiModel,
  ankiHtmlToMarkdown,
  hasClozeSyntax,
  expandClozeCards,
  ankiTag,
  ankiDeckName,
  stripAnkiPrefix,
  cueFingerprint,
  ankiScheduleToFsrs,
} = require('./anki-format.cjs');

const DEFAULT_ANKI_URL = 'http://127.0.0.1:8765';
const ANKICONNECT_VERSION = 6;
const REQUEST_TIMEOUT_MS = 12000;

function validateAnkiUrl(raw) {
  const value = String(raw ?? '').trim() || DEFAULT_ANKI_URL;
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('AnkiConnect URL must be a valid http:// or https:// URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AnkiConnect URL must use http:// or https://.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function offlineHint(url) {
  return `Could not reach AnkiConnect at ${url}. Make sure Anki Desktop is open with the AnkiConnect add-on (code 2055492159) installed, or use Export .apkg to transfer decks without AnkiConnect.`;
}

async function invokeAnki(action, params = {}, config = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable in this runtime.');
  const url = validateAnkiUrl(config.url);
  const body = { action, version: ANKICONNECT_VERSION, params };
  if (config.apiKey && String(config.apiKey).trim()) body.key = String(config.apiKey).trim();

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`Timed out connecting to AnkiConnect at ${url}. ${offlineHint(url)}`);
    }
    throw new Error(offlineHint(url));
  }
  if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status} from ${url}.`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`AnkiConnect at ${url} did not return valid JSON.`); }
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'error') || !Object.hasOwn(payload, 'result')) {
    throw new Error(`Unexpected response from AnkiConnect at ${url}.`);
  }
  if (payload.error) throw new Error(`AnkiConnect (${action}): ${payload.error}`);
  return payload.result;
}

async function checkStatus(config = {}, fetchImpl = globalThis.fetch) {
  const url = validateAnkiUrl(config.url);
  try {
    const version = await invokeAnki('version', {}, config, fetchImpl);
    const [decks, models] = await Promise.all([
      invokeAnki('deckNames', {}, config, fetchImpl),
      invokeAnki('modelNames', {}, config, fetchImpl),
    ]);
    return {
      connected: true,
      url,
      version,
      decks: Array.isArray(decks) ? decks.sort((a, b) => a.localeCompare(b)) : [],
      hasLearnHarnessModel: Array.isArray(models) && models.includes(MODEL_NAME),
      error: null,
    };
  } catch (error) {
    return {
      connected: false,
      url,
      version: null,
      decks: [],
      hasLearnHarnessModel: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureModel(config = {}, fetchImpl = globalThis.fetch, cardType = 'basic') {
  const spec = ankiModelSpec(cardType);
  const models = await invokeAnki('modelNames', {}, config, fetchImpl);
  if (Array.isArray(models) && models.includes(spec.ankiModel)) return spec.ankiModel;
  await invokeAnki('createModel', {
    modelName: spec.ankiModel,
    inOrderFields: spec.fields,
    css: MODEL_CSS,
    isCloze: spec.isCloze,
    cardTemplates: spec.templates,
  }, config, fetchImpl);
  return spec.ankiModel;
}

function buildCueTags(proposition, cue, cardType = 'basic') {
  const origin = proposition.origin || 'graph';
  return [
    'learnharness',
    `lh-origin::${ankiTag(origin)}`,
    `lh-type::${ankiTag(cardType)}`,
    `lh-prop:${ankiTag(proposition.id)}`,
    `lh-cue:${ankiTag(cue.id)}`,
  ];
}

async function pushToAnki({ items, config = {}, syncAnkiWeb = false, fetchImpl = globalThis.fetch }) {
  const deckSet = new Set(items.map(item => ankiDeckName(item.deckName, config.deckPrefix)));
  for (const name of deckSet) {
    await invokeAnki('createDeck', { deck: name }, config, fetchImpl);
  }
  const existingModels = new Set(await invokeAnki('modelNames', {}, config, fetchImpl) || []);
  const neededTypes = new Set(items.map(item => buildAnkiFieldsForCue(item.cue, item.proposition).cardType));
  for (const cardType of neededTypes) {
    const spec = ankiModelSpec(cardType);
    if (!existingModels.has(spec.ankiModel)) {
      await invokeAnki('createModel', {
        modelName: spec.ankiModel,
        inOrderFields: spec.fields,
        css: MODEL_CSS,
        isCloze: spec.isCloze,
        cardTemplates: spec.templates,
      }, config, fetchImpl);
      existingModels.add(spec.ankiModel);
    }
  }

  const now = Date.now();
  const mappings = [];
  let created = 0, updated = 0, unchanged = 0, moved = 0, failed = 0;
  const errors = [];

  // Batch-check existing note IDs to verify they still exist in Anki.
  const knownIds = [...new Set(items.map(item => item.cue.anki?.noteId).filter(id => Number.isSafeInteger(id) && id > 0))];
  const existingById = new Map();
  if (knownIds.length) {
    const infos = await invokeAnki('notesInfo', { notes: knownIds }, config, fetchImpl);
    for (const info of Array.isArray(infos) ? infos : []) {
      if (info && Number.isSafeInteger(info.noteId)) existingById.set(info.noteId, info);
    }
  }

  const toCreate = [];
  const deckMoves = new Map(); // targetDeckName -> cardIds[]

  for (const item of items) {
    const targetDeck = ankiDeckName(item.deckName, config.deckPrefix);
    const { cardType, spec, fields } = buildAnkiFieldsForCue(item.cue, item.proposition);
    const hash = cueFingerprint(item.cue.question, item.cue.answer, item.proposition.name, targetDeck, cardType, item.cue.addReverse);
    const tags = buildCueTags(item.proposition, item.cue, cardType);

    let noteId = item.cue.anki?.noteId;
    if (!noteId || !existingById.has(noteId)) {
      // Fallback lookup by stable lh-cue tag so re-syncing never duplicates notes.
      const found = await invokeAnki('findNotes', { query: `tag:lh-cue:${ankiTag(item.cue.id)}` }, config, fetchImpl);
      if (Array.isArray(found) && found.length > 0) {
        noteId = found[0];
        const [info] = await invokeAnki('notesInfo', { notes: [noteId] }, config, fetchImpl);
        if (info && Number.isSafeInteger(info.noteId)) existingById.set(noteId, info);
      } else {
        noteId = null;
      }
    }

    if (noteId && existingById.has(noteId)) {
      const info = existingById.get(noteId);
      const prev = item.cue.anki;
      const contentChanged = !prev || prev.syncedHash !== hash || prev.noteId !== noteId;
      const deckChanged = prev?.deckName && prev.deckName !== targetDeck;
      if (contentChanged) {
        const updateFields = {};
        for (const [k, v] of Object.entries(fields)) {
          if (!info.fields || Object.hasOwn(info.fields, k)) updateFields[k] = v;
        }
        if (Object.keys(updateFields).length) {
          await invokeAnki('updateNoteFields', { note: { id: noteId, fields: updateFields } }, config, fetchImpl);
        }
        await invokeAnki('addTags', { notes: [noteId], tags: tags.join(' ') }, config, fetchImpl);
        updated++;
      } else {
        unchanged++;
      }
      if ((deckChanged || !prev?.deckName) && Array.isArray(info.cards) && info.cards.length) {
        if (!deckMoves.has(targetDeck)) deckMoves.set(targetDeck, []);
        deckMoves.get(targetDeck).push(...info.cards);
        if (deckChanged) moved++;
      }
      mappings.push({
        propositionId: item.proposition.id,
        cueId: item.cue.id,
        anki: { noteId, deckName: targetDeck, modelName: info.modelName || spec.ankiModel, syncedHash: hash, lastSyncedAt: now },
      });
    } else {
      toCreate.push({
        item,
        targetDeck,
        modelName: spec.ankiModel,
        hash,
        note: {
          deckName: targetDeck,
          modelName: spec.ankiModel,
          fields,
          options: { allowDuplicate: true, duplicateScope: 'deck' },
          tags,
        },
      });
    }
  }

  for (const [targetDeck, cardIds] of deckMoves) {
    if (cardIds.length) {
      await invokeAnki('changeDeck', { cards: [...new Set(cardIds)], deck: targetDeck }, config, fetchImpl);
    }
  }

  if (toCreate.length) {
    const addedIds = await invokeAnki('addNotes', { notes: toCreate.map(entry => entry.note) }, config, fetchImpl);
    toCreate.forEach((entry, index) => {
      const noteId = Array.isArray(addedIds) ? addedIds[index] : null;
      if (Number.isSafeInteger(noteId) && noteId > 0) {
        created++;
        mappings.push({
          propositionId: entry.item.proposition.id,
          cueId: entry.item.cue.id,
          anki: { noteId, deckName: entry.targetDeck, modelName: entry.modelName, syncedHash: entry.hash, lastSyncedAt: now },
        });
      } else {
        failed++;
        errors.push(`Anki rejected card "${entry.item.cue.question.slice(0, 60)}"`);
      }
    });
  }

  let ankiWebSynced = false;
  if (syncAnkiWeb) {
    await invokeAnki('sync', {}, config, fetchImpl);
    ankiWebSynced = true;
  }

  return { created, updated, unchanged, moved, failed, errors, mappings, ankiWebSynced, syncedAt: now };
}

function escapeAnkiQuery(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function extractNoteQuestionAnswer(noteInfo, cardInfo) {
  const fields = noteInfo.fields || {};
  const entries = Object.entries(fields).sort((a, b) => (a[1]?.order ?? 0) - (b[1]?.order ?? 0));
  const fieldByName = name => {
    const found = entries.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? String(found[1]?.value ?? '') : '';
  };

  const firstVal = entries[0] ? String(entries[0][1]?.value ?? '') : '';
  const secondVal = entries[1] ? String(entries[1][1]?.value ?? '') : '';
  const propVal = fieldByName('Proposition');
  const cardType = detectCardTypeFromAnkiModel(noteInfo.modelName, false, entries.map(([k]) => k), firstVal);

  if (cardType === 'cloze' || hasClozeSyntax(firstVal)) {
    const expanded = expandClozeCards(firstVal, secondVal);
    const ord = Number(cardInfo?.ord ?? 0);
    const matched = expanded.find(c => c.clozeIndex === ord + 1) || expanded[ord] || expanded[0];
    if (matched) {
      return {
        name: ankiHtmlToMarkdown(propVal) || matched.question.slice(0, 80),
        question: matched.question,
        answer: matched.answer,
        cardType: 'cloze',
      };
    }
  }

  const frontRaw = fieldByName('Front') || firstVal || String(cardInfo?.question ?? '');
  const backRaw = fieldByName('Back') || secondVal || String(cardInfo?.answer ?? '');
  const addReverse = Boolean(fieldByName('Add Reverse').trim());
  const question = ankiHtmlToMarkdown(frontRaw);
  const answer = ankiHtmlToMarkdown(backRaw);
  const name = ankiHtmlToMarkdown(propVal) || question.split('\n')[0].slice(0, 80) || 'Anki card';
  return { name, question, answer, cardType, ...(cardType === 'basic-optional-reversed' ? { addReverse } : {}) };
}

async function pullFromAnki({ deckNames, config = {}, includeScheduling = true, dayStart = 4, fetchImpl = globalThis.fetch }) {
  if (!Array.isArray(deckNames) || !deckNames.length) throw new Error('Select at least one Anki deck to pull.');
  const now = Date.now();
  const imported = [];

  for (const deckName of deckNames) {
    const cardIds = await invokeAnki('findCards', { query: `deck:"${escapeAnkiQuery(deckName)}"` }, config, fetchImpl);
    if (!Array.isArray(cardIds) || !cardIds.length) continue;
    const cards = await invokeAnki('cardsInfo', { cards: cardIds }, config, fetchImpl);
    const noteIds = [...new Set((Array.isArray(cards) ? cards : []).map(c => c.note).filter(Number.isSafeInteger))];
    const notes = noteIds.length ? await invokeAnki('notesInfo', { notes: noteIds }, config, fetchImpl) : [];
    const noteMap = new Map((Array.isArray(notes) ? notes : []).map(n => [n.noteId, n]));

    for (const card of Array.isArray(cards) ? cards : []) {
      const note = noteMap.get(card.note);
      if (!note) continue;
      const { name, question, answer, cardType, addReverse } = extractNoteQuestionAnswer(note, card);
      if (!question.trim() || !answer.trim()) continue;
      const localDeckName = stripAnkiPrefix(card.deckName || deckName, config.deckPrefix);
      const schedule = includeScheduling ? ankiScheduleToFsrs(card, now, dayStart) : null;
      imported.push({
        deckName: localDeckName,
        ankiDeckName: card.deckName || deckName,
        name,
        question,
        answer,
        cardType,
        ...(addReverse !== undefined ? { addReverse } : {}),
        ankiNoteId: note.noteId,
        ankiCardId: card.cardId,
        ankiOrd: Number(card.ord ?? 0),
        tags: Array.isArray(note.tags) ? note.tags : [],
        schedule,
      });
    }
  }
  return imported;
}

async function fetchAnkiReviewUpdates({ syncedCues, config = {}, fetchImpl = globalThis.fetch }) {
  if (!syncedCues.length) return { cardReviews: new Map(), cardInfos: new Map(), noteToCards: new Map() };
  const noteIds = [...new Set(syncedCues.map(entry => entry.noteId).filter(Number.isSafeInteger))];
  const notes = await invokeAnki('notesInfo', { notes: noteIds }, config, fetchImpl);
  const noteToCards = new Map();
  const allCardIds = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || !Number.isSafeInteger(note.noteId) || !Array.isArray(note.cards)) continue;
    noteToCards.set(note.noteId, note.cards);
    allCardIds.push(...note.cards);
  }
  const uniqueCardIds = [...new Set(allCardIds)];
  if (!uniqueCardIds.length) return { cardReviews: new Map(), cardInfos: new Map(), noteToCards };

  const cards = await invokeAnki('cardsInfo', { cards: uniqueCardIds }, config, fetchImpl);
  const cardInfos = new Map((Array.isArray(cards) ? cards : []).map(c => [c.cardId, c]));

  let reviewsByCard = {};
  try {
    reviewsByCard = await invokeAnki('getReviewsOfCards', { cards: uniqueCardIds }, config, fetchImpl) || {};
  } catch {
    // Older AnkiConnect versions may omit getReviewsOfCards; cardInfos still lets us sync schedule state.
    reviewsByCard = {};
  }
  const cardReviews = new Map();
  for (const [cardId, rows] of Object.entries(reviewsByCard)) {
    if (Array.isArray(rows)) cardReviews.set(Number(cardId), rows);
  }
  return { cardReviews, cardInfos, noteToCards };
}

module.exports = {
  DEFAULT_ANKI_URL,
  validateAnkiUrl,
  invokeAnki,
  checkStatus,
  ensureModel,
  pushToAnki,
  pullFromAnki,
  fetchAnkiReviewUpdates,
  buildCueTags,
};
