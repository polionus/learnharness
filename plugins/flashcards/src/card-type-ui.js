// Frontend helpers for the 5 basic Anki card types, Cloze rendering, type-answer diff, and system prompt editor.

export const CARD_TYPES = [
  { id: 'basic', label: 'Basic', shortLabel: 'Basic', description: 'Standard Front → Back question and answer.' },
  { id: 'basic-reversed', label: 'Basic (and reversed)', shortLabel: 'Reversed', description: 'Tests both Front → Back and Back → Front.' },
  { id: 'basic-optional-reversed', label: 'Basic (optional reversed)', shortLabel: 'Opt. Reversed', description: 'Front → Back, plus Back → Front when reverse is enabled.' },
  { id: 'basic-type-answer', label: 'Basic (type in the answer)', shortLabel: 'Type Answer', description: 'Type your answer before reveal to see a character diff.' },
  { id: 'cloze', label: 'Cloze', shortLabel: 'Cloze', description: 'Fill-in-the-blank deletions using {{c1::answer::hint}} syntax.' },
];

const TYPE_MAP = new Map(CARD_TYPES.map(t => [t.id, t]));
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::(.*?))?\}\}/g;

export function inferCardType(card) {
  if (card?.cardType && TYPE_MAP.has(card.cardType)) return card.cardType;
  if (typeof card?.question === 'string' && /\{\{c\d+::[\s\S]+?\}\}/.test(card.question)) return 'cloze';
  return 'basic';
}

export function cardTypeInfo(id) {
  return TYPE_MAP.get(id) || CARD_TYPES[0];
}

export function renderClozeQuestion(text) {
  return String(text ?? '').replace(CLOZE_RE, (_, _n, _answer, hint) => `**[${hint ? hint.trim() : '…'}]**`);
}

export function renderClozeAnswer(question, extra) {
  const revealed = String(question ?? '').replace(CLOZE_RE, (_, _n, answer) => `**${answer}**`);
  const extraText = String(extra ?? '').trim();
  return extraText ? `${revealed}\n\n${extraText}` : revealed;
}

// Plain-text strip for fair comparison on type-in-the-answer cards.
function normalizeAnswerText(markdown) {
  return String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^`+|`+$/g, '')
    .replace(/^\*\*|\*\*$/g, '')
    .trim();
}

export function buildTypeAnswerDiff(typedRaw, expectedRaw) {
  const typed = String(typedRaw ?? '').trim();
  const expected = normalizeAnswerText(expectedRaw);
  const exact = typed.length > 0 && typed.toLocaleLowerCase() === expected.toLocaleLowerCase();

  // Compute character-level LCS for clean Anki-style typed vs expected diff.
  const a = [...typed], b = [...expected];
  const m = a.length, n = b.length;
  // Cap DP table size on unexpectedly huge answers to stay instant.
  if (m * n > 40000) {
    return {
      exact,
      typedParts: typed ? [{ kind: exact ? 'match' : 'del', text: typed }] : [],
      expectedParts: expected ? [{ kind: exact ? 'match' : 'ins', text: expected }] : [],
    };
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i].toLocaleLowerCase() === b[j].toLocaleLowerCase()) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
    }
  }
  const typedParts = [], expectedParts = [];
  const push = (arr, kind, ch) => {
    if (arr.length && arr[arr.length - 1].kind === kind) arr[arr.length - 1].text += ch;
    else arr.push({ kind, text: ch });
  };
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i].toLocaleLowerCase() === b[j].toLocaleLowerCase()) {
      push(typedParts, 'match', a[i]);
      push(expectedParts, 'match', b[j]);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(typedParts, 'del', a[i++]);
    } else {
      push(expectedParts, 'ins', b[j++]);
    }
  }
  while (i < m) push(typedParts, 'del', a[i++]);
  while (j < n) push(expectedParts, 'ins', b[j++]);
  return { exact, typedParts, expectedParts };
}

export function renderTypeAnswerComparison(container, typed, expected) {
  const { exact, typedParts, expectedParts } = buildTypeAnswerDiff(typed, expected);
  const box = document.createElement('div');
  box.className = 'fc-type-diff';
  box.dataset.exact = String(exact);

  const badge = document.createElement('p');
  badge.className = exact ? 'fc-type-diff-status fc-type-diff-ok' : 'fc-type-diff-status fc-type-diff-miss';
  badge.textContent = exact ? 'Exact match' : typed.trim() ? 'Check differences' : 'No answer typed';
  box.append(badge);

  const renderRow = (labelText, parts) => {
    const row = document.createElement('div');
    row.className = 'fc-type-diff-row';
    const lbl = document.createElement('span');
    lbl.className = 'fc-muted';
    lbl.textContent = labelText;
    const code = document.createElement('code');
    code.className = 'fc-type-diff-text';
    if (!parts.length) {
      const empty = document.createElement('span');
      empty.className = 'fc-muted';
      empty.textContent = '(blank)';
      code.append(empty);
    } else {
      for (const part of parts) {
        const span = document.createElement('span');
        span.className = `fc-diff-${part.kind}`;
        span.textContent = part.text;
        code.append(span);
      }
    }
    row.append(lbl, code);
    return row;
  };

  box.append(renderRow('Your answer:', typedParts));
  if (!exact) box.append(renderRow('Expected:', expectedParts));
  container.append(box);
  return box;
}

export function mountCardTypeSelector(parent, { value = 'basic', addReverse = false, onInsertCloze, signal }) {
  let currentType = TYPE_MAP.has(value) ? value : 'basic';
  let currentAddReverse = Boolean(addReverse);

  const wrap = document.createElement('div');
  wrap.className = 'fc-card-type-picker';
  const group = document.createElement('div');
  group.className = 'fc-card-type-group';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Anki card type');

  const hint = document.createElement('p');
  hint.className = 'fc-muted fc-card-type-hint';

  const revLabel = document.createElement('label');
  revLabel.className = 'fc-check';
  const revInput = document.createElement('input');
  revInput.type = 'checkbox';
  revInput.checked = currentAddReverse;
  revInput.addEventListener('change', () => { currentAddReverse = revInput.checked; }, { signal });
  revLabel.append(revInput, document.createTextNode('Also generate reverse card (Back → Front)'));

  const clozeBtn = document.createElement('button');
  clozeBtn.type = 'button';
  clozeBtn.className = 'fc-pill-btn fc-cloze-helper';
  clozeBtn.textContent = 'Insert {{c1::…}}';
  clozeBtn.addEventListener('click', () => onInsertCloze?.(), { signal });

  const pills = CARD_TYPES.map(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fc-pill-btn';
    btn.setAttribute('role', 'radio');
    btn.dataset.cardType = t.id;
    btn.textContent = t.shortLabel;
    btn.title = `${t.label}: ${t.description}`;
    btn.addEventListener('click', () => {
      currentType = t.id;
      sync();
    }, { signal });
    group.append(btn);
    return { id: t.id, btn };
  });

  const extraRow = document.createElement('div');
  extraRow.className = 'fc-card-type-extra';
  extraRow.append(hint, clozeBtn);
  wrap.append(group, extraRow, revLabel);
  parent.append(wrap);

  function sync() {
    for (const p of pills) {
      const active = p.id === currentType;
      p.btn.setAttribute('aria-checked', String(active));
      p.btn.dataset.active = String(active);
    }
    hint.textContent = cardTypeInfo(currentType).description;
    revLabel.hidden = currentType !== 'basic-optional-reversed';
    clozeBtn.hidden = currentType !== 'cloze' || !onInsertCloze;
  }
  sync();

  return {
    get value() { return currentType; },
    get addReverse() { return currentType === 'basic-optional-reversed' ? currentAddReverse : false; },
  };
}

export function openPromptEditorDialog({ ctx, dialog, button, el, state, signal, onSaved }) {
  const defaults = state?.generationDefaults || {};
  const defaultPrompt = defaults.prompt || '';
  const presets = defaults.presets || [];
  const settings = state?.settings || {};
  const initialTypes = new Set(Array.isArray(settings.generationCardTypes) && settings.generationCardTypes.length ? settings.generationCardTypes : ['basic']);
  const initialPrompt = (settings.generationPrompt && settings.generationPrompt.trim()) ? settings.generationPrompt : defaultPrompt;

  return dialog('Generation system prompt & card types', signal, ({ root, actions, signal: ds, run, close }) => {
    root.classList.add('fc-prompt-dialog');

    // 1. Card types section
    const typesSection = el('div', 'fc-prompt-section');
    typesSection.append(el('h3', 'fc-anki-subheading', 'Anki card types to generate'));
    typesSection.append(el('p', 'fc-muted', 'Choose which standard Anki note types the generator may produce.'));
    const typesGrid = el('div', 'fc-prompt-types');
    const typeInputs = CARD_TYPES.map(t => {
      const label = el('label', 'fc-check fc-prompt-type-item');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = initialTypes.has(t.id);
      const textWrap = el('span', 'fc-prompt-type-copy');
      textWrap.append(el('strong', '', t.label), el('span', 'fc-muted', ` — ${t.description}`));
      label.append(box, textWrap);
      typesGrid.append(label);
      return { id: t.id, box };
    });
    typesSection.append(typesGrid);
    root.append(typesSection);

    // 2. Presets bar
    const presetSection = el('div', 'fc-prompt-section');
    presetSection.append(el('h3', 'fc-anki-subheading', 'Quick presets'));
    const presetRow = el('div', 'fc-actions');
    const promptInput = el('textarea', 'fc-input fc-prompt-textarea');
    promptInput.value = initialPrompt;
    promptInput.setAttribute('aria-label', 'Card generation system prompt');
    const counter = el('p', 'fc-muted fc-prompt-counter');
    const updateCounter = () => {
      const chars = promptInput.value.trim().length;
      const approxTokens = Math.ceil(chars / 4);
      const isDefault = !promptInput.value.trim() || promptInput.value.trim() === defaultPrompt.trim();
      counter.textContent = `${chars.toLocaleString()} chars (~${approxTokens.toLocaleString()} tokens) · ${isDefault ? 'Default system prompt' : 'Custom system prompt'}`;
    };

    for (const preset of presets) {
      const pill = el('button', 'fc-pill-btn', preset.label);
      pill.type = 'button';
      pill.title = preset.description;
      pill.addEventListener('click', () => {
        promptInput.value = preset.prompt ?? defaultPrompt;
        const set = new Set(preset.cardTypes || ['basic']);
        for (const item of typeInputs) item.box.checked = set.has(item.id);
        updateCounter();
      }, { signal: ds });
      presetRow.append(pill);
    }
    presetSection.append(presetRow);
    root.append(presetSection);

    // 3. Editable system prompt textarea
    const editorSection = el('div', 'fc-prompt-section');
    editorSection.append(el('h3', 'fc-anki-subheading', 'System prompt (card-writing instructions)'));
    editorSection.append(el('p', 'fc-muted', 'Controls how cards are designed for both Knowledge Graph and File generation. Source safety and output formatting are appended automatically.'));
    promptInput.addEventListener('input', updateCounter, { signal: ds });
    updateCounter();
    editorSection.append(promptInput, counter);
    root.append(editorSection);

    button(actions, 'Save prompt', run(async () => {
      const selectedTypes = typeInputs.filter(t => t.box.checked).map(t => t.id);
      if (!selectedTypes.length) throw new Error('Select at least one Anki card type.');
      const nextState = await ctx.call('save-settings', {
        generationPrompt: promptInput.value,
        generationCardTypes: selectedTypes,
      });
      if (ds.aborted) return;
      onSaved?.(nextState);
      close();
    }), ds, { variant: 'default' });

    button(actions, 'Reset to default', () => {
      promptInput.value = defaultPrompt;
      for (const item of typeInputs) item.box.checked = item.id === 'basic';
      updateCounter();
    }, ds, { variant: 'outline' });
  });
}
