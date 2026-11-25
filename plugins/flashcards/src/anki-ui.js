// Anki export (.apkg), import (.apkg / .txt / .tsv), and live AnkiConnect sync UI.

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export function downloadBase64File(filename, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function readFileAsBase64(file) {
  const buffer = typeof file.arrayBuffer === 'function'
    ? await file.arrayBuffer()
    : await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
        reader.readAsArrayBuffer(file);
      });
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function openExportDialog({ ctx, dialog, button, field, el, scope = {}, scopeLabel = 'all decks', settings = {}, signal, onExported }) {
  return dialog('Export to Anki (.apkg)', signal, ({ root, actions, signal: ds, run, close }) => {
    root.append(el('p', 'fc-muted', `Export ${scopeLabel} as a standard Anki package (.apkg) compatible with Anki Desktop, AnkiMobile, and AnkiDroid.`));
    const prefixInput = field(root, 'Anki deck prefix (optional)', settings.ankiDeckPrefix ?? 'LearnHarness');
    const schedLabel = el('label', 'fc-check');
    const schedCheck = el('input');
    schedCheck.type = 'checkbox';
    schedCheck.checked = settings.ankiIncludeScheduling ?? true;
    schedLabel.append(schedCheck, document.createTextNode('Include FSRS-6 scheduling progress'));
    root.append(schedLabel);

    button(actions, 'Download .apkg', run(async () => {
      const result = await ctx.call('anki-export-apkg', {
        ...scope,
        deckPrefix: prefixInput.value,
        includeScheduling: schedCheck.checked,
      });
      if (ds.aborted) return;
      downloadBase64File(result.filename, result.base64);
      onExported?.(`Exported ${result.cardCount} ${result.cardCount === 1 ? 'card' : 'cards'} (${result.filename}).`);
      close();
    }), ds, { variant: 'default' });
  });
}

export function openImportDialog({ ctx, dialog, button, field, el, settings = {}, signal, onImported }) {
  return dialog('Import from Anki', signal, ({ root, actions, signal: ds, run, close }) => {
    root.append(el('p', 'fc-muted', 'Import flashcards from an Anki package (.apkg) or Anki text export (.txt / .tsv). Cards already linked to Anki update in place without duplicating.'));

    const pickerWrapper = el('label', 'fc-field');
    pickerWrapper.append(el('span', 'fc-label', 'Anki file (.apkg, .txt, .tsv)'));
    const input = el('input', 'fc-input');
    input.type = 'file';
    input.accept = '.apkg,.txt,.tsv';
    input.setAttribute('aria-label', 'Choose an Anki file');
    pickerWrapper.append(input);
    root.append(pickerWrapper);

    const deckInput = field(root, 'Fallback deck name (for .txt / .tsv without deck column)', '');
    deckInput.placeholder = 'Optional — uses filename if blank';

    const schedLabel = el('label', 'fc-check');
    const schedCheck = el('input');
    schedCheck.type = 'checkbox';
    schedCheck.checked = settings.ankiIncludeScheduling ?? true;
    schedLabel.append(schedCheck, document.createTextNode('Import Anki scheduling progress into FSRS-6'));
    root.append(schedLabel);

    button(actions, 'Import', run(async () => {
      const file = input.files?.[0];
      if (!file) throw new Error('Choose an Anki .apkg, .txt, or .tsv file first.');
      const base64 = await readFileAsBase64(file);
      if (ds.aborted) return;
      const result = await ctx.call('anki-import', {
        filename: file.name,
        base64,
        includeScheduling: schedCheck.checked,
        ...(deckInput.value.trim() ? { deckName: deckInput.value.trim() } : {}),
      });
      if (ds.aborted) return;
      const s = result.summary;
      const summaryText = `Imported ${s.cardsCreated} new, ${s.cardsUpdated} updated (${s.cardsSkipped} skipped).`;
      onImported?.(result.state, summaryText, s.deckIds?.[0]);
      close();
    }), ds, { variant: 'default' });
  });
}

export function openSyncDialog({ ctx, dialog, button, el, scope = {}, scopeLabel = 'all decks', settings = {}, signal, onSynced, onOpenExport }) {
  return dialog('Sync with Anki', signal, ({ root, actions, signal: ds, run, close }) => {
    const statusLine = el('p', 'fc-muted', 'Checking AnkiConnect…');
    statusLine.setAttribute('role', 'status');
    const body = el('div', 'fc-anki-sync-body');
    const resultNote = el('p', 'fc-anki-result');
    resultNote.setAttribute('role', 'status');
    root.append(statusLine, body, resultNote);

    let bodyScope = null;
    const resetBody = () => {
      bodyScope?.abort();
      bodyScope = new AbortController();
      ds.addEventListener('abort', () => bodyScope?.abort(), { once: true });
      body.replaceChildren();
      return bodyScope.signal;
    };

    const loadStatus = async () => {
      statusLine.textContent = `Checking AnkiConnect at ${settings.ankiUrl || 'http://127.0.0.1:8765'}…`;
      resultNote.textContent = '';
      const bs = resetBody();
      const status = await ctx.call('anki-status', {});
      if (ds.aborted || bs.aborted) return;

      if (!status.connected) {
        statusLine.textContent = `AnkiConnect not detected at ${status.url}.`;
        const guide = el('ol', 'fc-anki-guide');
        for (const step of [
          'Open Anki Desktop.',
          'Install the AnkiConnect add-on (Tools → Add-ons → Get Add-ons → code 2055492159) and restart Anki.',
          'Click Retry connection below, or export a portable .apkg file instead.',
        ]) {
          guide.append(el('li', '', step));
        }
        body.append(guide);
        const offlineActions = el('div', 'fc-actions');
        body.append(offlineActions);
        button(offlineActions, 'Retry connection', run(loadStatus), bs, { variant: 'default' });
        if (onOpenExport) {
          button(offlineActions, 'Export .apkg instead…', () => { close(); onOpenExport(); }, bs);
        }
        return;
      }

      statusLine.textContent = `Connected to AnkiConnect v${status.version} · ${status.syncedCueCount}/${status.totalCueCount} cards linked`;

      // 1. Push section
      const pushSection = el('div', 'fc-anki-section');
      pushSection.append(el('h3', 'fc-anki-subheading', 'Push to Anki'));
      pushSection.append(el('p', 'fc-muted', `Creates or updates notes for ${scopeLabel} in Anki without overwriting Anki scheduling.`));
      const webSyncLabel = el('label', 'fc-check');
      const webSyncCheck = el('input');
      webSyncCheck.type = 'checkbox';
      webSyncCheck.checked = false;
      webSyncLabel.append(webSyncCheck, document.createTextNode('Trigger AnkiWeb sync after pushing'));
      const pushActions = el('div', 'fc-actions');
      pushSection.append(webSyncLabel, pushActions);
      button(pushActions, `Push ${scopeLabel}`, run(async () => {
        const res = await ctx.call('anki-sync-push', { ...scope, syncAnkiWeb: webSyncCheck.checked });
        if (ds.aborted) return;
        const s = res.summary;
        const parts = [`${s.created} created`, `${s.updated} updated`, `${s.unchanged} unchanged`];
        if (s.moved) parts.push(`${s.moved} moved`);
        if (s.failed) parts.push(`${s.failed} failed`);
        if (s.ankiWebSynced) parts.push('AnkiWeb synced');
        const text = `Pushed to Anki: ${parts.join(', ')}.`;
        resultNote.textContent = text;
        onSynced?.(res.state, text);
      }), bs, { variant: 'default' });
      body.append(pushSection);

      // 2. Two-way review sync section
      const reviewSection = el('div', 'fc-anki-section');
      reviewSection.append(el('h3', 'fc-anki-subheading', 'Sync review progress'));
      reviewSection.append(el('p', 'fc-muted', 'Pull recent reviews completed in Anki Desktop or AnkiMobile into LearnHarness FSRS-6 schedules and statistics.'));
      const reviewActions = el('div', 'fc-actions');
      reviewSection.append(reviewActions);
      button(reviewActions, 'Sync reviews from Anki', run(async () => {
        const res = await ctx.call('anki-sync-reviews', {});
        if (ds.aborted) return;
        const s = res.summary;
        const text = s.reviewsApplied > 0 || s.schedulesUpdated > 0
          ? `Synced ${s.reviewsApplied} ${s.reviewsApplied === 1 ? 'review' : 'reviews'} across ${s.schedulesUpdated} ${s.schedulesUpdated === 1 ? 'card' : 'cards'} from Anki.`
          : `Checked ${s.cardsChecked} linked ${s.cardsChecked === 1 ? 'card' : 'cards'}; no newer Anki reviews found.`;
        resultNote.textContent = text;
        onSynced?.(res.state, text);
      }), bs, { disabled: status.syncedCueCount === 0 });
      body.append(reviewSection);

      // 3. Pull decks from Anki section
      if (status.decks.length) {
        const pullSection = el('div', 'fc-anki-section');
        pullSection.append(el('h3', 'fc-anki-subheading', 'Pull decks from Anki'));
        const list = el('div', 'fc-anki-deck-list');
        const deckChecks = status.decks.map(name => {
          const label = el('label', 'fc-check');
          const box = el('input');
          box.type = 'checkbox';
          label.append(box, document.createTextNode(name));
          list.append(label);
          return { name, box };
        });
        const pullSchedLabel = el('label', 'fc-check');
        const pullSchedCheck = el('input');
        pullSchedCheck.type = 'checkbox';
        pullSchedCheck.checked = settings.ankiIncludeScheduling ?? true;
        pullSchedLabel.append(pullSchedCheck, document.createTextNode('Import Anki scheduling progress'));
        const pullActions = el('div', 'fc-actions');
        pullSection.append(list, pullSchedLabel, pullActions);
        button(pullActions, 'Pull selected decks', run(async () => {
          const selectedDecks = deckChecks.filter(d => d.box.checked).map(d => d.name);
          if (!selectedDecks.length) throw new Error('Select at least one Anki deck to pull.');
          const res = await ctx.call('anki-sync-pull', { deckNames: selectedDecks, includeScheduling: pullSchedCheck.checked });
          if (ds.aborted) return;
          const s = res.summary;
          const text = `Pulled from Anki: ${s.cardsCreated} new, ${s.cardsUpdated} updated (${s.cardsSkipped} skipped).`;
          resultNote.textContent = text;
          onSynced?.(res.state, text, s.deckIds?.[0]);
        }), bs);
        body.append(pullSection);
      }
    };

    button(actions, 'Refresh status', run(loadStatus), ds, { variant: 'outline' });
    void loadStatus().catch(cause => {
      if (!ds.aborted) statusLine.textContent = message(cause);
    });
  }, 'Close');
}
