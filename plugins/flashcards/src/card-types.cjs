'use strict';

// Canonical definitions for the 5 standard Anki basic card types.
const CARD_TYPES = Object.freeze([
  {
    id: 'basic',
    label: 'Basic',
    shortLabel: 'Basic',
    ankiModel: 'LearnHarness Basic',
    ankiModelId: 1710000000001,
    isCloze: false,
    description: 'Standard Front → Back question and answer.',
  },
  {
    id: 'basic-reversed',
    label: 'Basic (and reversed)',
    shortLabel: 'Reversed',
    ankiModel: 'LearnHarness Basic (and reversed)',
    ankiModelId: 1710000000002,
    isCloze: false,
    description: 'Tests both Front → Back and Back → Front.',
  },
  {
    id: 'basic-optional-reversed',
    label: 'Basic (optional reversed)',
    shortLabel: 'Opt. Reversed',
    ankiModel: 'LearnHarness Basic (optional reversed)',
    ankiModelId: 1710000000003,
    isCloze: false,
    description: 'Front → Back, plus Back → Front when reverse is enabled.',
  },
  {
    id: 'basic-type-answer',
    label: 'Basic (type in the answer)',
    shortLabel: 'Type Answer',
    ankiModel: 'LearnHarness Basic (type in the answer)',
    ankiModelId: 1710000000004,
    isCloze: false,
    description: 'Requires typing the exact answer and checks character diff.',
  },
  {
    id: 'cloze',
    label: 'Cloze',
    shortLabel: 'Cloze',
    ankiModel: 'LearnHarness Cloze',
    ankiModelId: 1710000000005,
    isCloze: true,
    description: 'Fill-in-the-blank deletions using {{c1::answer::hint}} syntax.',
  },
]);

const CARD_TYPE_IDS = Object.freeze(CARD_TYPES.map(t => t.id));
const CARD_TYPE_MAP = new Map(CARD_TYPES.map(t => [t.id, t]));

function normalizeCardType(value) {
  if (typeof value === 'string' && CARD_TYPE_MAP.has(value)) return value;
  return 'basic';
}

function cardTypeInfo(value) {
  return CARD_TYPE_MAP.get(normalizeCardType(value));
}

function normalizeCardTypesList(list) {
  if (!Array.isArray(list)) return ['basic'];
  const valid = [...new Set(list.filter(id => typeof id === 'string' && CARD_TYPE_MAP.has(id)))];
  return valid.length ? valid : ['basic'];
}

function inferCardTypeFromCue(cue) {
  if (cue?.cardType && CARD_TYPE_MAP.has(cue.cardType)) return cue.cardType;
  if (typeof cue?.question === 'string' && /\{\{c\d+::[\s\S]+?\}\}/.test(cue.question)) return 'cloze';
  return 'basic';
}

const PROMPT_PRESETS = Object.freeze([
  {
    id: 'default',
    label: 'Balanced (Default)',
    description: 'LearnHarness default retrieval-task framework.',
    cardTypes: ['basic'],
    prompt: null, // null resolves to canonical cardWriting
  },
  {
    id: 'cloze-heavy',
    label: 'Cloze-Heavy',
    description: 'Fast active-recall fill-in-the-blank cards with concise hints.',
    cardTypes: ['cloze', 'basic'],
    prompt: `Generate concise active-recall flashcards favoring Cloze deletions for key terms, equations, conditions, and mechanisms.
Use {{c1::target}} or {{c1::target::hint}} syntax inside complete, self-contained statements when generating Cloze cards.
Keep each deletion atomic (one concept or short phrase per cloze) and include brief context in the answer/extra field.
Use Basic cards when a direct question/answer is clearer than a fill-in-the-blank sentence.
Avoid trivial guesses, vague prompts, or multi-part lists bundled into one blank.`,
  },
  {
    id: 'exam-precision',
    label: 'Exam & Precision',
    description: 'Rigorous definitions, edge cases, conditions, and distinctions.',
    cardTypes: ['basic', 'basic-type-answer'],
    prompt: `Generate rigorous, exam-ready flashcards focused on exact definitions, necessary/sufficient conditions, formulas, and common misconceptions.
Test distinctions between easily confused concepts and ask for the exact condition under which a rule or theorem holds.
Use "basic-type-answer" for short, unambiguous terms, symbols, formulas, or exact values the learner should recall verbatim.
Use "basic" for concise conceptual explanations and cause-and-effect relationships.
Keep answers direct, unambiguous, and verifiable without guesswork.`,
  },
  {
    id: 'vocab-reversed',
    label: 'Terms & Reversed',
    description: 'Bidirectional Term ↔ Definition / Symbol ↔ Meaning recall.',
    cardTypes: ['basic-reversed', 'basic'],
    prompt: `Generate bidirectional flashcards for terminology, notation, vocabulary, and key concept pairs.
Use "basic-reversed" whenever a card maps a clear term, symbol, or formula to its concise meaning so the learner trains recall in both directions.
Keep both sides crisp and symmetric so the reverse card is unambiguous on its own.
Use standard "basic" cards for asymmetric facts or explanations that only make sense in one direction.`,
  },
  {
    id: 'type-recall',
    label: 'Type-in Exact Recall',
    description: 'Exact spelling, syntax, commands, formulas, and short facts.',
    cardTypes: ['basic-type-answer', 'cloze'],
    prompt: `Generate flashcards optimized for exact typed recall (syntax, CLI commands, API names, formulas, dates, or precise terminology).
Use "basic-type-answer" with short, single-line canonical answers so typed comparison is fair and exact.
Never ask open-ended paragraphs on a type-in card; use Cloze or Basic if nuance is needed.`,
  },
]);

module.exports = {
  CARD_TYPES,
  CARD_TYPE_IDS,
  CARD_TYPE_MAP,
  PROMPT_PRESETS,
  normalizeCardType,
  cardTypeInfo,
  normalizeCardTypesList,
  inferCardTypeFromCue,
};
