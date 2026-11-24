import type { ToolCallMessage, ToolInputAnswers, ToolInputQuestion } from './types';

export function parseToolCallInput(inputValue: ToolCallMessage['input']): {
  input: string;
  inputObject: Record<string, unknown> | null;
  filePath: string | undefined;
} {
  const input =
    typeof inputValue === 'string'
      ? inputValue
      : inputValue
        ? JSON.stringify(inputValue, null, 2)
        : '';
  let inputObject: Record<string, unknown> | null = null;
  if (inputValue && typeof inputValue !== 'string') inputObject = inputValue;
  else if (input)
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        inputObject = Object.fromEntries(Object.entries(parsed));
    } catch {}
  const filePath = inputObject
    ? [inputObject.file_path, inputObject.filePath, inputObject.path, inputObject.filename, inputObject.file].find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
    : undefined;
  return {
    input,
    inputObject,
    filePath: filePath ?? input.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1],
  };
}

function toggleQuestionOption(question: Pick<ToolInputQuestion, 'multiSelect'>, selected: readonly string[], optionId: string): string[] {
  if (!question.multiSelect) return selected[0] === optionId ? [] : [optionId];
  return selected.includes(optionId) ? selected.filter((id) => id !== optionId) : [...selected, optionId];
}

function buildToolInputAnswers(questions: readonly ToolInputQuestion[], selections: Record<string, string[]>, customAnswers: Record<string, string>): ToolInputAnswers {
  return Object.fromEntries(questions.map((question) => {
    const custom = question.allowCustom === false ? '' : (customAnswers[question.id] ?? '').trim();
    return [question.id, custom ? { custom } : { options: selections[question.id] ?? [] }];
  }));
}

export interface ToolInputDraft {
  currentIdx: number;
  selections: Record<string, string[]>;
  customAnswers: Record<string, string>;
}

export const EMPTY_TOOL_INPUT_DRAFT: ToolInputDraft = { currentIdx: 0, selections: {}, customAnswers: {} };

export function pickToolInputOption<T extends ToolInputDraft>(draft: T, question: ToolInputQuestion, optionId: string): T {
  return {
    ...draft,
    selections: { ...draft.selections, [question.id]: toggleQuestionOption(question, draft.selections[question.id] ?? [], optionId) },
    customAnswers: { ...draft.customAnswers, [question.id]: '' },
  };
}

export function writeToolInputAnswer<T extends ToolInputDraft>(draft: T, question: ToolInputQuestion, text: string): T {
  return {
    ...draft,
    customAnswers: { ...draft.customAnswers, [question.id]: text },
    selections: text.trim() ? { ...draft.selections, [question.id]: [] } : draft.selections,
  };
}

export function toolInputDraftStep(questions: readonly ToolInputQuestion[], draft: ToolInputDraft) {
  const currentIdx = Math.min(draft.currentIdx, questions.length - 1);
  const question = questions[currentIdx];
  const selected = draft.selections[question.id] ?? [];
  const custom = question.allowCustom === false ? '' : (draft.customAnswers[question.id] ?? '').trim();
  const isLast = currentIdx === questions.length - 1;
  return {
    currentIdx,
    question,
    selected,
    custom,
    isLast,
    isAnswered: Boolean(custom || selected.length),
    answers: isLast ? JSON.stringify(buildToolInputAnswers(questions, draft.selections, draft.customAnswers)) : null,
  };
}
