'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { buildSync } = require('esbuild');
const { activate } = require('../src/backend.cjs');
const {
  markdownToAnkiHtml,
  ankiHtmlToMarkdown,
  expandClozeCards,
  ankiDeckName,
  stripAnkiPrefix,
  guidForCue,
  fieldChecksum,
  ankiScheduleToFsrs,
  fsrsToAnkiCardState,
} = require('../src/anki-format.cjs');
const { createZip, readZip, exportApkg, importApkg, importAnkiText } = require('../src/anki-apkg.cjs');
const { validateAnkiUrl, MODEL_NAME } = { ...require('../src/anki-connect.cjs'), ...require('../src/anki-format.cjs') };
const { fixture, flush, createDocument } = require('./ui-fixture.cjs');

function createBackendHarness(t, { ankiFetch } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcards-anki-test-'));
  const graph = {
    propositions: [
      { id: 'p1', name: 'Bayes Theorem', statement: 'Posterior is proportional to likelihood times prior.', provenance: [{ chatId: 'chat-1' }] },
    ],
    chains: [],
    sessions: { 'chat-1': 'Probability Basics' },
    fileSources: {},
  };
  const handlers = new Map();
  const cleanups = [];
  const controller = new AbortController();
  const workers = {
    register() { return () => {}; },
    list() { return []; },
    get() { throw new Error('no task'); },
    subscribe() { return () => {}; },
    wait() { return Promise.resolve(); },
    start() { throw new Error('unused'); },
    cancel() {},
  };
  activate({
    dataDirectory: directory,
    signal: controller.signal,
    workers,
    learning: { graph: () => structuredClone(graph) },
    inference: { catalog: async () => ({ slots: {}, models: [] }) },
    events: { emit() {} },
    handle: (name, fn) => handlers.set(name, fn),
    cleanup: fn => cleanups.push(fn),
    ankiFetch,
  });
  t.after(() => {
    for (const fn of cleanups.splice(0).reverse()) fn();
    controller.abort();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    call: async (name, input = {}) => {
      assert.ok(handlers.has(name), `Missing handler ${name}`);
      return handlers.get(name)(input);
    },
    state: () => handlers.get('get-state')({}),
  };
}

function createMockAnkiServer() {
  const decks = new Set(['Default']);
  const models = new Set(['Basic']);
  const notes = new Map(); // noteId -> { noteId, modelName, fields, tags, cards: [cardId] }
  const cards = new Map(); // cardId -> { cardId, note, deckName, ord, type, queue, due, interval, factor, reps, lapses, data }
  const revlogs = new Map(); // cardId -> [{ id, usn, ease, ivl, lastIvl, factor, time, type }]
  let nextNoteId = 1000;
  let nextCardId = 5000;
  const calls = [];
  let ankiWebSyncs = 0;

  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const { action, params = {} } = req;
    let result = null;
    let error = null;

    if (action === 'version') result = 6;
    else if (action === 'deckNames') result = [...decks];
    else if (action === 'modelNames') result = [...models];
    else if (action === 'createDeck') { decks.add(params.deck); result = 1; }
    else if (action === 'createModel') { models.add(params.modelName); result = { id: 1 }; }
    else if (action === 'addNotes') {
      result = params.notes.map(n => {
        const nid = ++nextNoteId;
        const cid = ++nextCardId;
        decks.add(n.deckName);
        const fieldsObj = {};
        Object.entries(n.fields).forEach(([k, v], order) => { fieldsObj[k] = { value: v, order }; });
        notes.set(nid, { noteId: nid, modelName: n.modelName, fields: fieldsObj, tags: [...(n.tags || [])], cards: [cid] });
        cards.set(cid, { cardId: cid, note: nid, deckName: n.deckName, ord: 0, type: 0, queue: 0, due: 1, interval: 0, factor: 2500, reps: 0, lapses: 0, data: '{}' });
        return nid;
      });
    } else if (action === 'notesInfo') {
      result = (params.notes || []).map(id => notes.get(id)).filter(Boolean);
    } else if (action === 'findNotes') {
      const m = /^tag:(.+)$/.exec(params.query || '');
      result = m
        ? [...notes.values()].filter(n => n.tags.includes(m[1])).map(n => n.noteId)
        : [...notes.keys()];
    } else if (action === 'updateNoteFields') {
      const note = notes.get(params.note.id);
      if (!note) error = 'note not found';
      else {
        for (const [k, v] of Object.entries(params.note.fields)) {
          if (note.fields[k]) note.fields[k].value = v;
        }
      }
    } else if (action === 'addTags') {
      const toAdd = String(params.tags || '').split(/\s+/).filter(Boolean);
      for (const id of params.notes || []) {
        const note = notes.get(id);
        if (note) note.tags = [...new Set([...note.tags, ...toAdd])];
      }
    } else if (action === 'changeDeck') {
      decks.add(params.deck);
      for (const cid of params.cards || []) {
        const card = cards.get(cid);
        if (card) card.deckName = params.deck;
      }
    } else if (action === 'findCards') {
      const m = /^deck:"(.+)"$/.exec(params.query || '');
      const deckName = m ? m[1].replace(/\\"/g, '"') : null;
      result = [...cards.values()]
        .filter(c => !deckName || c.deckName === deckName)
        .map(c => c.cardId);
    } else if (action === 'cardsInfo') {
      result = (params.cards || []).map(cid => cards.get(cid)).filter(Boolean);
    } else if (action === 'getReviewsOfCards') {
      result = Object.fromEntries((params.cards || []).map(cid => [String(cid), revlogs.get(cid) || []]));
    } else if (action === 'sync') {
      ankiWebSyncs++;
      result = null;
    } else {
      error = `unsupported action: ${action}`;
    }

    return {
      ok: true,
      status: 200,
      async json() { return { result, error }; },
    };
  };

  return {
    fetchImpl,
    decks,
    models,
    notes,
    cards,
    revlogs,
    calls,
    get ankiWebSyncs() { return ankiWebSyncs; },
    seedExternalCard({ deckName, modelName = 'Basic', fields, tags = [], card = {} }) {
      decks.add(deckName);
      models.add(modelName);
      const nid = ++nextNoteId;
      const cid = ++nextCardId;
      const fieldsObj = {};
      Object.entries(fields).forEach(([k, v], order) => { fieldsObj[k] = { value: v, order }; });
      notes.set(nid, { noteId: nid, modelName, fields: fieldsObj, tags, cards: [cid] });
      cards.set(cid, { cardId: cid, note: nid, deckName, ord: 0, type: 2, queue: 2, due: 10, interval: 14, factor: 2500, reps: 5, lapses: 1, data: '{"s":14.2,"d":4.8}', ...card });
      return { noteId: nid, cardId: cid };
    },
  };
}

test('markdown <-> Anki HTML conversion preserves math, code, tables, escaping, and cloze deletions', () => {
  const md = [
    'What is **Bayes** for $P(A|B)$? Costs \\$5.',
    '',
    '$$',
    'P(A|B) = \\frac{P(B|A)P(A)}{P(B)}',
    '$$',
    '',
    '```js',
    'const ok = 1 < 2 && 3 > 1;',
    '```',
    '',
    '| X | Y |',
    '|---|---|',
    '| `a` | *b* |',
  ].join('\n');

  const html = markdownToAnkiHtml(md);
  assert.ok(html.includes('<strong>Bayes</strong>'));
  assert.ok(html.includes('\\(P(A|B)\\)'));
  assert.ok(html.includes('Costs $5.'));
  assert.ok(html.includes('\\[P(A|B) = \\frac{P(B|A)P(A)}{P(B)}\\]'));
  assert.ok(html.includes('<pre><code class="language-js">const ok = 1 &lt; 2 &amp;&amp; 3 &gt; 1;</code></pre>'));
  assert.ok(html.includes('<table><thead><tr><th>X</th><th>Y</th></tr></thead>'));

  const backToMd = ankiHtmlToMarkdown(html);
  assert.ok(backToMd.includes('**Bayes**'));
  assert.ok(backToMd.includes('$P(A|B)$'));
  assert.ok(backToMd.includes('const ok = 1 < 2 && 3 > 1;'));

  const clozes = expandClozeCards('The {{c1::mitochondria::organelle}} generates {{c2::ATP}}.', 'Bio 101');
  assert.equal(clozes.length, 2);
  assert.equal(clozes[0].question, 'The [organelle] generates ATP.');
  assert.ok(clozes[0].answer.includes('**mitochondria**') && clozes[0].answer.includes('Bio 101'));
  assert.equal(clozes[1].question, 'The mitochondria generates [...].');
  assert.ok(clozes[1].answer.includes('**ATP**'));

  assert.equal(ankiDeckName('Calculus', 'LearnHarness'), 'LearnHarness::Calculus');
  assert.equal(ankiDeckName('LearnHarness::Calculus', 'LearnHarness'), 'LearnHarness::Calculus');
  assert.equal(ankiDeckName('Calculus', ''), 'Calculus');
  assert.equal(stripAnkiPrefix('LearnHarness::Calculus', 'LearnHarness'), 'Calculus');
  assert.equal(guidForCue('cue-1'), guidForCue('cue-1'));
  assert.notEqual(guidForCue('cue-1'), guidForCue('cue-2'));
  assert.ok(Number.isInteger(fieldChecksum('<b>Hello</b> world')));
});

test('FSRS <-> Anki card state conversion round-trips review stability and difficulty', () => {
  const now = Date.UTC(2026, 10, 24, 15, 0, 0);
  const crt = Math.floor(Date.UTC(2026, 10, 24, 4, 0, 0) / 1000);
  const fsrs = {
    state: 2,
    stability: 12.5,
    difficulty: 4.25,
    scheduled_days: 12,
    reps: 4,
    lapses: 1,
    due: now + 12 * 86400000,
    last_review: now,
  };
  const anki = fsrsToAnkiCardState(fsrs, now, crt, 1);
  assert.equal(anki.type, 2);
  assert.equal(anki.ivl, 12);
  assert.equal(anki.reps, 4);
  assert.equal(anki.lapses, 1);
  assert.deepEqual(JSON.parse(anki.data), { s: 12.5, d: 4.25 });

  const restored = ankiScheduleToFsrs(anki, now, 4, crt);
  assert.equal(restored.state, 2);
  assert.equal(restored.stability, 12.5);
  assert.equal(restored.difficulty, 4.25);
  assert.equal(restored.scheduled_days, 12);
  assert.equal(restored.reps, 4);
  assert.equal(restored.lapses, 1);
});

test('APKG export produces valid SQLite collection and round-trips through APKG import without duplicates', async t => {
  const h1 = createBackendHarness(t);
  await h1.call('create-deck', { name: 'Linear Algebra' });
  const deck = h1.state().decks[0];
  const created = await h1.call('create-card', {
    deckId: deck.id,
    name: 'Eigenvalue definition',
    question: 'Define an eigenvalue $\\lambda$ of $A$.',
    answer: 'A scalar $\\lambda$ with $Av = \\lambda v$ for some nonzero $v$.',
    requestId: 'req-1',
  });
  // Rate the card once so it has non-zero FSRS progress.
  const next = await h1.call('next-review', { deckIds: [deck.id] });
  await h1.call('reveal-review', { ticketId: next.ticket.id });
  await h1.call('rate-review', { ticketId: next.ticket.id, rating: 4, requestId: 'rate-1' });

  const exported = await h1.call('anki-export-apkg', { includeScheduling: true, deckPrefix: 'LearnHarness' });
  assert.equal(exported.filename, 'LearnHarness-flashcards.apkg');
  assert.equal(exported.noteCount, 1);
  assert.equal(exported.cardCount, 1);

  const zipBytes = Buffer.from(exported.base64, 'base64');
  const entries = readZip(zipBytes);
  assert.ok(entries.has('collection.anki2'));
  assert.equal(entries.get('media').toString('utf8'), '{}');

  // Import into a brand new backend and verify round-trip + idempotency.
  const h2 = createBackendHarness(t);
  const firstImport = await h2.call('anki-import', {
    filename: exported.filename,
    base64: exported.base64,
    includeScheduling: true,
  });
  assert.equal(firstImport.summary.decksCreated, 1);
  assert.equal(firstImport.summary.cardsCreated, 1);
  const importedDeck = h2.state().decks.find(d => d.name === 'Linear Algebra');
  assert.ok(importedDeck);
  const importedProp = h2.state().propositions.find(p => p.origin === 'anki');
  assert.ok(importedProp);
  assert.equal(importedProp.archived, false);
  assert.equal(importedProp.name, 'Eigenvalue definition');
  assert.ok(importedProp.cues[0].question.includes('$\\lambda$'));
  assert.equal(importedProp.schedule.state, 2);
  assert.equal(importedProp.schedule.reps, 1);
  assert.equal(h2.state().statistics.states.review, 1);

  // Re-importing the same .apkg skips duplicates cleanly.
  const secondImport = await h2.call('anki-import', {
    filename: exported.filename,
    base64: exported.base64,
    includeScheduling: true,
  });
  assert.equal(secondImport.summary.cardsCreated, 0);
  assert.equal(secondImport.summary.cardsSkipped, 1);
  assert.equal(h2.state().propositions.length, 1);
  assert.ok(created.cueId);
});

test('APKG import supports modern Anki 23.10+ zstd collection.anki21b and Cloze notes, plus Anki text/TSV', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-anki21b-'));
  try {
    const dbPath = path.join(tmpDir, 'modern.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE decks (id integer primary key, name text not null);
      CREATE TABLE notetypes (id integer primary key, name text not null);
      CREATE TABLE fields (ntid integer not null, ord integer not null, name text not null);
      CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, tags text not null, flds text not null);
      CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, data text not null);
    `);
    db.prepare('INSERT INTO decks VALUES (10, ?)').run('LearnHarness\u001fBiology');
    db.prepare('INSERT INTO notetypes VALUES (20, ?)').run('Cloze');
    db.prepare('INSERT INTO fields VALUES (20, 0, ?), (20, 1, ?)').run('Text', 'Back Extra');
    db.prepare('INSERT INTO notes VALUES (100, ?, 20, ?, ?)').run('guid-cloze-1', ' bio ', 'DNA uses {{c1::adenine}} paired with {{c2::thymine}}.\u001fBase pairs');
    db.prepare('INSERT INTO cards VALUES (200, 100, 10, 0, 2, 2, 5, 7, 2500, 3, 0, ?)').run('{"s":7.5,"d":4.1}');
    db.prepare('INSERT INTO cards VALUES (201, 100, 10, 1, 0, 0, 1, 0, 2500, 0, 0, ?)').run('{}');
    db.close();

    const compressed = zlib.zstdCompressSync(fs.readFileSync(dbPath));
    const apkg = createZip([
      { name: 'collection.anki21b', data: compressed },
      { name: 'media', data: Buffer.from('{}') },
    ]);

    const parsed = importApkg(apkg, { deckPrefix: 'LearnHarness', includeScheduling: true });
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].deckName, 'Biology');
    assert.equal(parsed[0].question, 'DNA uses [...] paired with thymine.');
    assert.ok(parsed[0].answer.includes('**adenine**') && parsed[0].answer.includes('Base pairs'));
    assert.equal(parsed[0].schedule.stability, 7.5);
    assert.equal(parsed[1].question, 'DNA uses adenine paired with [...].');
    assert.equal(parsed[1].schedule.state, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const tsv = [
    '#separator:tab',
    '#html:true',
    '#deck column:3',
    '#tags column:4',
    'What is \\(2+2\\)?\t<b>4</b>\tLearnHarness::Arithmetic\tmath basic',
    'Capital of France?\tParis\tGeography\tgeo',
  ].join('\n');
  const rows = importAnkiText(tsv, { deckPrefix: 'LearnHarness' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].deckName, 'Arithmetic');
  assert.equal(rows[0].question, 'What is $2+2$?');
  assert.equal(rows[0].answer, '**4**');
  assert.equal(rows[1].deckName, 'Geography');
});

test('AnkiConnect live push, deck move, review sync, pull, auto-push, and offline handling', async t => {
  // 1. Offline status returns actionable guidance.
  const offline = createBackendHarness(t, {
    ankiFetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  const down = await offline.call('anki-status');
  assert.equal(down.connected, false);
  assert.match(down.error, /2055492159/);
  assert.match(down.error, /\.apkg/);

  // 2. Live mock AnkiConnect server.
  const mock = createMockAnkiServer();
  const h = createBackendHarness(t, { ankiFetch: mock.fetchImpl });

  // Validate Anki settings without staling review tickets.
  await h.call('create-deck', { name: 'Physics' });
  const deck = h.state().decks[0];
  const created = await h.call('create-card', {
    deckId: deck.id,
    name: 'Newton Second Law',
    question: 'State Newton’s second law.',
    answer: '$F = ma$',
    requestId: 'phys-1',
  });
  const ticket = (await h.call('next-review', { deckIds: [deck.id] })).ticket;
  await h.call('save-settings', { ankiDeckPrefix: 'LH', ankiAutoPush: false });
  assert.equal(h.state().settings.ankiDeckPrefix, 'LH');
  // Ticket remains valid after changing Anki settings!
  const revealed = await h.call('reveal-review', { ticketId: ticket.id });
  assert.equal(revealed.answer, '$F = ma$');
  await assert.rejects(h.call('save-settings', { ankiUrl: 'ftp://bad.host' }), /http/);
  assert.equal(validateAnkiUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');

  // Push to Anki (first push creates deck, model, and note).
  const push1 = await h.call('anki-sync-push', { syncAnkiWeb: true });
  assert.equal(push1.summary.created, 1);
  assert.equal(push1.summary.updated, 0);
  assert.equal(push1.summary.ankiWebSynced, true);
  assert.equal(mock.ankiWebSyncs, 1);
  assert.ok(mock.models.has(MODEL_NAME));
  assert.ok(mock.decks.has('LH::Physics'));
  assert.equal(h.state().anki.syncedCueCount, 1);

  // Second push without edits is a no-op.
  const push2 = await h.call('anki-sync-push', {});
  assert.equal(push2.summary.created, 0);
  assert.equal(push2.summary.updated, 0);
  assert.equal(push2.summary.unchanged, 1);

  // Edit cue + rename deck -> updates note fields and moves card in Anki without duplicating.
  const prop = h.state().propositions[0];
  await h.call('save-cue', {
    propositionId: prop.id,
    cueId: created.cueId,
    question: 'State Newton’s second law (vector form).',
    answer: '$\\vec{F} = m\\vec{a}$',
    version: prop.version,
  });
  await h.call('save-deck', { id: deck.id, name: 'Mechanics' });
  const push3 = await h.call('anki-sync-push', {});
  assert.equal(push3.summary.created, 0);
  assert.equal(push3.summary.updated, 1);
  assert.equal(push3.summary.moved, 1);
  assert.equal(mock.notes.size, 1);

  // Simulate two reviews performed inside Anki Desktop and sync them back into LearnHarness FSRS-6.
  const [ankiNote] = [...mock.notes.values()];
  const ankiCardId = ankiNote.cards[0];
  const revTime1 = Date.now() - 60000;
  const revTime2 = Date.now() - 1000;
  mock.revlogs.set(ankiCardId, [
    { id: revTime1, usn: -1, ease: 3, ivl: -600, lastIvl: 0, factor: 2500, time: 4000, type: 0 },
    { id: revTime2, usn: -1, ease: 4, ivl: 4, lastIvl: -600, factor: 2500, time: 3000, type: 0 },
  ]);
  const revSync1 = await h.call('anki-sync-reviews', {});
  assert.equal(revSync1.summary.reviewsApplied, 2);
  assert.equal(revSync1.summary.schedulesUpdated, 1);
  assert.equal(h.state().propositions[0].schedule.reps, 2);
  assert.equal(h.state().propositions[0].schedule.state, 2);
  assert.equal(h.state().statistics.activity.at(-1).count, 2);

  // Repeating review sync is idempotent.
  const revSync2 = await h.call('anki-sync-reviews', {});
  assert.equal(revSync2.summary.reviewsApplied, 0);

  // Pull an external deck from Anki into LearnHarness.
  mock.seedExternalCard({
    deckName: 'Japanese::Core',
    fields: { Front: '水', Back: 'water (<i>mizu</i>)' },
  });
  const pulled = await h.call('anki-sync-pull', { deckNames: ['Japanese::Core'], includeScheduling: true });
  assert.equal(pulled.summary.decksCreated, 1);
  assert.equal(pulled.summary.cardsCreated, 1);
  const jpDeck = h.state().decks.find(d => d.name === 'Japanese::Core');
  assert.ok(jpDeck);
  const jpProp = h.state().propositions.find(p => p.id === jpDeck.propositionIds[0]);
  assert.equal(jpProp.cues[0].question, '水');
  assert.equal(jpProp.cues[0].answer, 'water (*mizu*)');
  assert.equal(jpProp.schedule.stability, 14.2);

  // Enable auto-push and create a manual card -> automatically pushed to AnkiConnect!
  await h.call('save-settings', { ankiAutoPush: true });
  const beforeNotes = mock.notes.size;
  await h.call('create-card', {
    deckId: deck.id,
    name: 'Work-Energy Theorem',
    question: 'What equals the net work done on an object?',
    answer: 'Change in kinetic energy $\\Delta K$.',
    requestId: 'phys-2',
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(mock.notes.size, beforeNotes + 1);
});

test('Flashcards frontend exposes Anki panel, deck menu items, dialogs, and Anki settings', async () => {
  const source = buildSync({
    entryPoints: [path.join(__dirname, '../src/main.js')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
  }).outputFiles[0].text;
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const document = createDocument();
  const { activate: activateUi } = await import(moduleUrl);
  const h = fixture(document);
  h.state.anki = { syncedCueCount: 0, totalCueCount: 1, lastSyncedAt: null };
  h.overrides['anki-status'] = async () => ({
    connected: true,
    url: 'http://127.0.0.1:8765',
    version: 6,
    decks: ['LearnHarness::Notes', 'External Deck'],
    hasLearnHarnessModel: true,
    syncedCueCount: 0,
    totalCueCount: 1,
    lastSyncedAt: null,
  });
  h.overrides['anki-sync-push'] = async () => {
    h.state.anki.syncedCueCount = 1;
    h.state.revision++;
    return { state: JSON.parse(JSON.stringify(h.state)), summary: { created: 1, updated: 0, unchanged: 0, moved: 0, failed: 0, ankiWebSynced: false } };
  };
  h.overrides['anki-export-apkg'] = async () => ({
    filename: 'LearnHarness-flashcards.apkg',
    base64: Buffer.from('PK\x03\x04test').toString('base64'),
    deckCount: 1,
    noteCount: 1,
    cardCount: 1,
  });
  const origCreateObj = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};

  activateUi(h.ctx);
  h.mount();
  await flush();
  try {
    const ankiPanel = h.app.querySelector('section.fc-anki-panel');
    assert.ok(ankiPanel, 'Anki panel renders in library');
    const panelButtons = [...ankiPanel.querySelectorAll('button')].map(b => b.textContent);
    assert.deepEqual(panelButtons, ['Sync with Anki…', 'Export .apkg…', 'Import from Anki…']);

    // Open Export dialog and trigger download.
    const exportBtn = [...ankiPanel.querySelectorAll('button')].find(b => b.textContent === 'Export .apkg…');
    exportBtn.click();
    let dlg = document.querySelector('[role=dialog]');
    assert.equal(dlg.getAttribute('aria-label'), 'Export to Anki (.apkg)');
    const dlBtn = [...dlg.querySelectorAll('button')].find(b => b.textContent === 'Download .apkg');
    dlBtn.click();
    await flush();
    assert.ok(h.calls.some(([op]) => op === 'anki-export-apkg'));
    assert.ok(ankiPanel.textContent.includes('Exported 1 card'));

    // Open Sync dialog and push to AnkiConnect.
    const syncBtn = [...ankiPanel.querySelectorAll('button')].find(b => b.textContent === 'Sync with Anki…');
    syncBtn.click();
    await flush();
    dlg = document.querySelector('[role=dialog]');
    assert.equal(dlg.getAttribute('aria-label'), 'Sync with Anki');
    assert.ok(dlg.textContent.includes('Connected to AnkiConnect v6'));
    const pushBtn = [...dlg.querySelectorAll('button')].find(b => b.textContent.startsWith('Push '));
    pushBtn.click();
    await flush();
    assert.ok(h.calls.some(([op]) => op === 'anki-sync-push'));
    assert.ok(dlg.textContent.includes('1 created'));
    const closeBtn = [...dlg.querySelectorAll('button')].find(b => b.textContent === 'Close');
    closeBtn.click();

    // Verify deck gear menu includes Anki actions.
    const deckRow = [...h.app.querySelectorAll('[data-fixture-row]')].find(n => n.dataset.fixtureRow === 'deck:d1');
    const gear = [...deckRow.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Deck actions');
    gear.click();
    const popup = document.querySelector('[role=menu]');
    assert.ok(popup.textContent.includes('Export to Anki (.apkg)…'));
    assert.ok(popup.textContent.includes('Sync deck to Anki…'));
    h.handles.findLast(handle => handle.kind === 'menu').dispose();

    // Mount Settings and verify Anki configuration rows + test button.
    h.mountSettings();
    await flush();
    const ankiSettingsSection = h.settings.querySelector('.fc-anki-settings');
    assert.ok(ankiSettingsSection);
    const testConnBtn = [...ankiSettingsSection.querySelectorAll('button')].find(b => b.textContent === 'Test AnkiConnect');
    assert.ok(testConnBtn);
    testConnBtn.click();
    await flush();
    assert.ok(ankiSettingsSection.textContent.includes('Connected to AnkiConnect v6'));
  } finally {
    URL.createObjectURL = origCreateObj;
    URL.revokeObjectURL = origRevoke;
    h.dispose();
  }
});
