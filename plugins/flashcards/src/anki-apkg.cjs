'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  CARD_TYPES,
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
  guidForCue,
  fieldChecksum,
  ankiScheduleToFsrs,
  fsrsToAnkiCardState,
} = require('./anki-format.cjs');

const LEARN_HARNESS_MODEL_ID = 1710000000001;
const FIELD_SEPARATOR = '\u001f';
const MAX_APKG_ENTRY_BYTES = 64 * 1024 * 1024;

// Precomputed standard IEEE 802.3 CRC-32 lookup table for ZIP archives.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, payload);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('Invalid .apkg file: archive is too short.');

  // Locate End of Central Directory signature scanning backwards (allows trailing comment).
  const minPos = Math.max(0, buf.length - 65557);
  let eocdPos = -1;
  for (let pos = buf.length - 22; pos >= minPos; pos--) {
    if (buf.readUInt32LE(pos) === 0x06054b50) { eocdPos = pos; break; }
  }
  if (eocdPos < 0) throw new Error('Invalid .apkg file: missing ZIP directory.');

  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const centralSize = buf.readUInt32LE(eocdPos + 12);
  const centralOffset = buf.readUInt32LE(eocdPos + 16);
  if (centralOffset + centralSize > buf.length) throw new Error('Invalid .apkg file: truncated ZIP directory.');

  const files = new Map();
  let cursor = centralOffset;
  for (let idx = 0; idx < totalEntries; idx++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid .apkg file: corrupt central directory entry.');
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid .apkg file: corrupt local header for ${name}.`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) throw new Error(`Invalid .apkg file: truncated data for ${name}.`);

    // Only decompress the collection database entries to avoid excessive memory usage on large media decks.
    if (!['collection.anki2', 'collection.anki21', 'collection.anki21b', 'media'].includes(name)) continue;
    if (uncompressedSize > MAX_APKG_ENTRY_BYTES) {
      throw new Error(`Invalid .apkg file: ${name} exceeds the 64 MiB limit.`);
    }
    const slice = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(slice);
    else if (method === 8) data = zlib.inflateRawSync(slice, { maxOutputLength: MAX_APKG_ENTRY_BYTES });
    else throw new Error(`Unsupported ZIP compression method (${method}) for ${name}.`);
    files.set(name, data);
  }
  return files;
}

function deterministicId(seed, base = 1710000000000) {
  const digest = createHash('sha256').update(String(seed)).digest();
  return base + (digest.readUInt32BE(0) % 900000000);
}

function makeDeckConfig(id, name, nowSec) {
  return {
    id,
    name,
    mod: nowSec,
    usn: -1,
    lrnToday: [0, 0],
    revToday: [0, 0],
    newToday: [0, 0],
    timeToday: [0, 0],
    collapsed: false,
    browserCollapsed: false,
    desc: '',
    dyn: 0,
    conf: 1,
    extendNew: 0,
    extendRev: 0,
  };
}

function makeNoteModel(cardType, nowSec) {
  const spec = ankiModelSpec(cardType);
  const field = (name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] });
  return {
    id: spec.ankiModelId,
    name: spec.ankiModel,
    type: spec.isCloze ? 1 : 0,
    mod: nowSec,
    usn: -1,
    sortf: 0,
    did: 1,
    tmpls: spec.templates.map((tpl, ord) => ({
      name: tpl.Name,
      ord,
      qfmt: tpl.Front,
      afmt: tpl.Back,
      bqfmt: '',
      bafmt: '',
      did: null,
      bfont: '',
      bsize: 0,
    })),
    flds: spec.fields.map((name, ord) => field(name, ord)),
    css: MODEL_CSS,
    latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: spec.templates.map((_, ord) => [ord, 'all', [0]]),
    tags: [],
    vers: [],
  };
}

function makeDefaultDconf(nowSec) {
  return {
    1: {
      id: 1,
      name: 'Default',
      mod: nowSec,
      usn: 0,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
    },
  };
}

function makeCollectionConf() {
  return {
    activeDecks: [1],
    curDeck: 1,
    newSpread: 0,
    collapseTime: 1200,
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
    curModel: LEARN_HARNESS_MODEL_ID,
    nextPos: 1,
    sortType: 'noteFld',
    sortBackwards: false,
    addToCur: true,
  };
}

function createCollectionTables(db) {
  db.exec(`
    CREATE TABLE col (
      id integer primary key, crt integer not null, mod integer not null,
      scm integer not null, ver integer not null, dty integer not null,
      usn integer not null, ls integer not null, conf text not null,
      models text not null, decks text not null, dconf text not null, tags text not null
    );
    CREATE TABLE notes (
      id integer primary key, guid text not null, mid integer not null,
      mod integer not null, usn integer not null, tags text not null,
      flds text not null, sfld text not null, csum integer not null,
      flags integer not null, data text not null
    );
    CREATE TABLE cards (
      id integer primary key, nid integer not null, did integer not null,
      ord integer not null, mod integer not null, usn integer not null,
      type integer not null, queue integer not null, due integer not null,
      ivl integer not null, factor integer not null, reps integer not null,
      lapses integer not null, left integer not null, odue integer not null,
      odid integer not null, flags integer not null, data text not null
    );
    CREATE TABLE revlog (
      id integer primary key, cid integer not null, usn integer not null,
      ease integer not null, ivl integer not null, lastIvl integer not null,
      factor integer not null, time integer not null, type integer not null
    );
    CREATE TABLE graves (
      usn integer not null, oid integer not null, type integer not null
    );
    CREATE INDEX ix_notes_usn ON notes (usn);
    CREATE INDEX ix_cards_usn ON cards (usn);
    CREATE INDEX ix_revlog_usn ON revlog (usn);
    CREATE INDEX ix_cards_nid ON cards (nid);
    CREATE INDEX ix_cards_sched ON cards (did, queue, due);
    CREATE INDEX ix_revlog_cid ON revlog (cid);
    CREATE INDEX ix_notes_csum ON notes (csum);
  `);
}

function safeFilename(name) {
  const cleaned = String(name ?? 'LearnHarness-flashcards')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${cleaned || 'LearnHarness-flashcards'}.apkg`;
}

function exportApkg({ items, deckPrefix = 'LearnHarness', includeScheduling = true, filenameBase = 'LearnHarness-flashcards', now = Date.now() }) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('There are no active flashcards in this selection to export.');
  }
  const nowSec = Math.floor(now / 1000);
  // Collection creation day at local midnight for Anki due-day calculation.
  const crtDate = new Date(now);
  crtDate.setHours(4, 0, 0, 0);
  const crtSec = Math.floor(crtDate.getTime() / 1000);

  const decksObj = { 1: makeDeckConfig(1, 'Default', nowSec) };
  const deckIdByName = new Map();
  const ensureDeck = fullName => {
    if (deckIdByName.has(fullName)) return deckIdByName.get(fullName);
    let id = deterministicId(`deck:${fullName}`, 1711000000000);
    while (Object.hasOwn(decksObj, String(id))) id++;
    decksObj[String(id)] = makeDeckConfig(id, fullName, nowSec);
    deckIdByName.set(fullName, id);
    return id;
  };

  // Ensure parent decks exist when using hierarchical "::" names.
  for (const item of items) {
    const fullName = ankiDeckName(item.deckName, deckPrefix);
    const parts = fullName.split('::');
    for (let i = 1; i <= parts.length; i++) ensureDeck(parts.slice(0, i).join('::'));
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-apkg-export-'));
  const dbPath = path.join(tmpDir, 'collection.anki2');
  let db;
  try {
    db = new DatabaseSync(dbPath);
    createCollectionTables(db);

    const modelsObj = Object.fromEntries(
      CARD_TYPES.map(t => [String(t.ankiModelId), makeNoteModel(t.id, nowSec)])
    );
    db.prepare(`INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        1, crtSec, now, now, 11, 0, 0, 0,
        JSON.stringify(makeCollectionConf()),
        JSON.stringify(modelsObj),
        JSON.stringify(decksObj),
        JSON.stringify(makeDefaultDconf(nowSec)),
        '{}'
      );

    const insertNote = db.prepare(`INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertCard = db.prepare(`INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const usedNoteIds = new Set();
    const usedCardIds = new Set();
    let noteCount = 0;
    let cardCount = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const { deckName, proposition, cue } = items[idx];
      const fullDeck = ankiDeckName(deckName, deckPrefix);
      const did = ensureDeck(fullDeck);
      const { cardType, spec, fields } = buildAnkiFieldsForCue(cue, proposition);
      const orderedValues = spec.fields.map(name => fields[name] ?? '');
      const flds = orderedValues.join(FIELD_SEPARATOR);
      const sfld = proposition.name || cue.question.slice(0, 120);
      const csum = fieldChecksum(orderedValues[0]);
      const guid = guidForCue(cue.id);
      const origin = proposition.origin || 'graph';
      const tags = ` learnharness lh-origin::${ankiTag(origin)} lh-type::${ankiTag(cardType)} lh-prop:${ankiTag(proposition.id)} lh-cue:${ankiTag(cue.id)} `;

      let nid = now + idx;
      while (usedNoteIds.has(nid)) nid++;
      usedNoteIds.add(nid);

      insertNote.run(nid, guid, spec.ankiModelId, nowSec, -1, tags, flds, sfld, csum, 0, '');
      noteCount++;

      // Determine card ordinals generated by this Anki note type.
      let ordinals = [0];
      if (cardType === 'basic-reversed') ordinals = [0, 1];
      else if (cardType === 'basic-optional-reversed') ordinals = cue.addReverse ? [0, 1] : [0];
      else if (cardType === 'cloze') {
        const matches = [...String(orderedValues[0]).matchAll(/\{\{c(\d+)::/g)].map(m => Math.max(0, Number(m[1]) - 1));
        ordinals = matches.length ? [...new Set(matches)].sort((a, b) => a - b) : [0];
      }

      for (const ord of ordinals) {
        let cid = now + 100000 + cardCount;
        while (usedCardIds.has(cid)) cid++;
        usedCardIds.add(cid);

        const sched = includeScheduling
          ? fsrsToAnkiCardState(proposition.schedule, now, crtSec, cardCount + 1)
          : { type: 0, queue: 0, due: cardCount + 1, ivl: 0, factor: 2500, reps: 0, lapses: 0, data: '{}' };

        insertCard.run(
          cid, nid, did, ord, nowSec, -1,
          sched.type, sched.queue, sched.due, sched.ivl, sched.factor,
          sched.reps, sched.lapses, 0, 0, 0, 0, sched.data
        );
        cardCount++;
      }
    }

    db.close();
    db = null;
    const dbBytes = fs.readFileSync(dbPath);
    const zipBuffer = createZip([
      { name: 'collection.anki2', data: dbBytes },
      { name: 'media', data: Buffer.from('{}', 'utf8') },
    ]);

    return {
      buffer: zipBuffer,
      filename: safeFilename(filenameBase),
      deckCount: deckIdByName.size,
      noteCount,
      cardCount,
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readAnkiDatabase(dbBytes, { deckPrefix = 'LearnHarness', includeScheduling = true, dayStart = 4, now = Date.now() }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-apkg-import-'));
  const dbPath = path.join(tmpDir, 'import.sqlite');
  let db;
  try {
    fs.writeFileSync(dbPath, dbBytes);
    db = new DatabaseSync(dbPath, { readOnly: true });

    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
    );
    if (!tables.has('notes') || !tables.has('cards')) {
      throw new Error('This .apkg database is missing Anki notes/cards tables.');
    }

    const colRow = tables.has('col') ? db.prepare('SELECT crt, models, decks FROM col LIMIT 1').get() : null;
    const collectionCrtSec = colRow && Number.isFinite(Number(colRow.crt)) ? Number(colRow.crt) : null;

    // Resolve decks map (supports both legacy col.decks JSON and Anki 23.10+ decks table).
    const deckNames = new Map();
    if (tables.has('decks')) {
      for (const row of db.prepare('SELECT id, name FROM decks').all()) {
        // Anki 23.10+ separates nested deck names with \u001f.
        deckNames.set(String(row.id), String(row.name || 'Imported from Anki').replace(/\u001f/g, '::'));
      }
    }
    if (!deckNames.size && colRow?.decks) {
      try {
        const parsed = JSON.parse(colRow.decks);
        for (const [id, entry] of Object.entries(parsed)) {
          deckNames.set(String(id), String(entry?.name || 'Imported from Anki'));
        }
      } catch { /* fallback below */ }
    }

    // Resolve note models (field names + whether a model is Cloze).
    const modelMeta = new Map(); // mid -> { isCloze, fieldNames[] }
    if (tables.has('notetypes') && tables.has('fields')) {
      const fieldsByNt = new Map();
      for (const row of db.prepare('SELECT ntid, ord, name FROM fields').all()) {
        const key = String(row.ntid);
        if (!fieldsByNt.has(key)) fieldsByNt.set(key, []);
        fieldsByNt.get(key).push({ ord: Number(row.ord), name: String(row.name) });
      }
      for (const row of db.prepare('SELECT id, name FROM notetypes').all()) {
        const key = String(row.id);
        const flds = (fieldsByNt.get(key) || []).sort((a, b) => a.ord - b.ord).map(f => f.name);
        modelMeta.set(key, { name: String(row.name || ''), isCloze: /cloze/i.test(String(row.name || '')), fieldNames: flds });
      }
    }
    if (!modelMeta.size && colRow?.models) {
      try {
        const parsed = JSON.parse(colRow.models);
        for (const [id, model] of Object.entries(parsed)) {
          const flds = Array.isArray(model?.flds)
            ? [...model.flds].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0)).map(f => String(f.name || ''))
            : [];
          modelMeta.set(String(id), { name: String(model?.name || ''), isCloze: Number(model?.type) === 1 || /cloze/i.test(String(model?.name || '')), fieldNames: flds });
        }
      } catch { /* fallback below */ }
    }

    const notesById = new Map();
    for (const row of db.prepare('SELECT id, guid, mid, tags, flds FROM notes').all()) {
      notesById.set(String(row.id), row);
    }

    const cards = db.prepare('SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, data FROM cards').all();
    const results = [];
    const seenPairs = new Set();

    for (const card of cards) {
      const note = notesById.get(String(card.nid));
      if (!note) continue;
      const rawFields = String(note.flds ?? '').split(FIELD_SEPARATOR);
      const meta = modelMeta.get(String(note.mid)) || { isCloze: false, fieldNames: [] };
      const fieldByName = target => {
        const idx = meta.fieldNames.findIndex(n => n.toLowerCase() === target.toLowerCase());
        return idx >= 0 && idx < rawFields.length ? rawFields[idx] : '';
      };

      const rawDeck = deckNames.get(String(card.did)) || 'Imported from Anki';
      const localDeckName = rawDeck === 'Default' ? 'Imported from Anki' : stripAnkiPrefix(rawDeck, deckPrefix);
      const propField = ankiHtmlToMarkdown(fieldByName('Proposition'));
      const tags = String(note.tags ?? '').trim().split(/\s+/).filter(Boolean);
      const schedule = includeScheduling ? ankiScheduleToFsrs(card, now, dayStart, collectionCrtSec) : null;

      const detectedType = detectCardTypeFromAnkiModel(meta.name, meta.isCloze, meta.fieldNames, rawFields[0]);
      if (meta.isCloze || hasClozeSyntax(rawFields[0])) {
        const expanded = expandClozeCards(rawFields[0] || '', rawFields[1] || '');
        const ord = Number(card.ord ?? 0);
        const match = expanded.find(c => c.clozeIndex === ord + 1) || expanded[ord] || expanded[0];
        if (!match || !match.question.trim() || !match.answer.trim()) continue;
        const pairKey = `${note.guid}:c${ord}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        results.push({
          deckName: localDeckName,
          ankiDeckName: rawDeck,
          name: propField || match.question.split('\n')[0].slice(0, 80) || 'Anki cloze',
          question: match.question,
          answer: match.answer,
          cardType: 'cloze',
          ankiGuid: `${note.guid}:c${ord}`,
          ankiNoteId: Number(note.id),
          ankiCardId: Number(card.id),
          ankiOrd: ord,
          tags,
          schedule,
        });
        continue;
      }

      const frontRaw = fieldByName('Front') || rawFields[0] || '';
      const backRaw = fieldByName('Back') || rawFields[1] || '';
      const addRevRaw = fieldByName('Add Reverse');
      const isReversed = Number(card.ord ?? 0) === 1 && rawFields.length >= 2;
      const question = ankiHtmlToMarkdown(isReversed ? backRaw : frontRaw);
      const answer = ankiHtmlToMarkdown(isReversed ? frontRaw : backRaw);
      if (!question.trim() || !answer.trim()) continue;
      const pairKey = `${note.guid}:${card.ord}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      results.push({
        deckName: localDeckName,
        ankiDeckName: rawDeck,
        name: propField || question.split('\n')[0].slice(0, 80) || 'Anki card',
        question,
        answer,
        cardType: detectedType,
        ...(detectedType === 'basic-optional-reversed' ? { addReverse: Boolean(String(addRevRaw || '').trim()) } : {}),
        ankiGuid: Number(card.ord ?? 0) === 0 ? String(note.guid) : `${note.guid}:${card.ord}`,
        ankiNoteId: Number(note.id),
        ankiCardId: Number(card.id),
        ankiOrd: Number(card.ord ?? 0),
        tags,
        schedule,
      });
    }

    return results;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function importApkg(buffer, options = {}) {
  const entries = readZip(buffer);
  let dbBytes = null;

  // Prefer modern collection.anki21b when present and zstd is available; otherwise anki21 -> anki2.
  if (entries.has('collection.anki21b') && typeof zlib.zstdDecompressSync === 'function') {
    const decompressed = zlib.zstdDecompressSync(entries.get('collection.anki21b'));
    if (decompressed.length > MAX_APKG_ENTRY_BYTES) {
      throw new Error('Decompressed Anki collection exceeds the 64 MiB limit.');
    }
    dbBytes = decompressed;
  } else if (entries.has('collection.anki21')) {
    dbBytes = entries.get('collection.anki21');
  } else if (entries.has('collection.anki2')) {
    dbBytes = entries.get('collection.anki2');
  } else {
    throw new Error('This .apkg file does not contain a readable Anki collection database.');
  }

  return readAnkiDatabase(dbBytes, options);
}

function parseDelimitedLine(line, sep) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else if (ch === '"' && current.length === 0) {
      inQuotes = true;
    } else if (ch === sep) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function importAnkiText(rawText, { defaultDeckName = 'Imported from Anki', deckPrefix = 'LearnHarness' } = {}) {
  const lines = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let sep = '\t';
  let isHtml = false;
  let deckCol = -1;
  let tagsCol = -1;
  let notetypeCol = -1;
  let guidCol = -1;
  const dataLines = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const m = /^#([a-z ]+?):\s*(.*)$/i.exec(line);
      if (m) {
        const key = m[1].trim().toLowerCase(), val = m[2].trim().toLowerCase();
        if (key === 'separator') {
          sep = val === 'comma' ? ',' : val === 'semicolon' ? ';' : val === 'pipe' ? '|' : val === 'space' ? ' ' : '\t';
        } else if (key === 'html') {
          isHtml = val === 'true';
        } else if (key === 'deck column') {
          deckCol = Number(val) - 1;
        } else if (key === 'tags column') {
          tagsCol = Number(val) - 1;
        } else if (key === 'notetype column') {
          notetypeCol = Number(val) - 1;
        } else if (key === 'guid column') {
          guidCol = Number(val) - 1;
        }
      }
      continue;
    }
    dataLines.push(line);
  }

  const results = [];
  for (let i = 0; i < dataLines.length; i++) {
    const cols = parseDelimitedLine(dataLines[i], sep);
    const contentCols = [];
    for (let c = 0; c < cols.length; c++) {
      if (c === deckCol || c === tagsCol || c === notetypeCol || c === guidCol) continue;
      contentCols.push(cols[c]);
    }
    if (contentCols.length < 2 && !hasClozeSyntax(contentCols[0])) continue;
    const rawDeck = deckCol >= 0 && cols[deckCol]?.trim() ? cols[deckCol].trim() : defaultDeckName;
    const localDeckName = stripAnkiPrefix(rawDeck, deckPrefix);
    const tags = tagsCol >= 0 && cols[tagsCol] ? cols[tagsCol].trim().split(/\s+/).filter(Boolean) : [];
    const guid = guidCol >= 0 && cols[guidCol]?.trim() ? cols[guidCol].trim() : null;

    if (hasClozeSyntax(contentCols[0])) {
      for (const cloze of expandClozeCards(contentCols[0], contentCols[1] || '')) {
        if (!cloze.question.trim() || !cloze.answer.trim()) continue;
        results.push({
          deckName: localDeckName,
          ankiDeckName: rawDeck,
          name: cloze.question.split('\n')[0].slice(0, 80) || 'Anki cloze',
          question: cloze.question,
          answer: cloze.answer,
          ankiGuid: guid ? `${guid}:c${cloze.clozeIndex}` : null,
          tags,
          schedule: null,
        });
      }
      continue;
    }

    const question = isHtml ? ankiHtmlToMarkdown(contentCols[0]) : contentCols[0].trim();
    const answer = isHtml ? ankiHtmlToMarkdown(contentCols[1]) : contentCols[1].trim();
    if (!question || !answer) continue;
    const name = contentCols[2]?.trim()
      ? (isHtml ? ankiHtmlToMarkdown(contentCols[2]) : contentCols[2].trim())
      : question.split('\n')[0].slice(0, 80);
    results.push({
      deckName: localDeckName,
      ankiDeckName: rawDeck,
      name,
      question,
      answer,
      ankiGuid: guid,
      tags,
      schedule: null,
    });
  }
  return results;
}

module.exports = {
  createZip,
  readZip,
  exportApkg,
  importApkg,
  importAnkiText,
  LEARN_HARNESS_MODEL_ID,
};
