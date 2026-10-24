/**
 * The last word on which kind of lesson starts. The model picks `lesson_kind` after classifying
 * the scene; this only steps in when it left the field empty or chose against a one-sided signal:
 * a how-to in the tool they're working in is never a concept model, and an "explain" while they
 * watch a lecture is never an app lesson on the video player. Mixed requests keep the model's call.
 * Mirrored in Swift (`LessonRouting`) so the native fallback behaves the same.
 */
export type Scene = "watching" | "reading" | "working" | "other";
export type LessonKind = "app" | "concept";

const WANTS_TO_DO =
  /\b(show me how|how (do|can|would|should) (i|we|you)|how to|walk me through|teach me (how )?to|guide me|help me (make|build|create|add|set ?up|do|wire|draw|design|write|connect))\b/i;

const WANTS_TO_UNDERSTAND =
  /\b(explain|what (is|are|was|were|does|did|do|means?)\b|what's|whats|why\b|how\b[^?.!]{0,60}\bworks?\b|meaning of|understand|tell me about|summari[sz]e|what (is|was) (he|she|they|this|that) (saying|talking|about|on about)|what is (this|that|the) (video|lecture|talk|page|about))/i;

export function normalizeScene(value: unknown): Scene | undefined {
  return value === "watching" || value === "reading" || value === "working" || value === "other" ? value : undefined;
}

export function normalizeLessonKind(value: unknown): LessonKind | undefined {
  return value === "app" || value === "concept" ? value : undefined;
}

export function wantsToDo(text: string): boolean {
  return WANTS_TO_DO.test(text);
}

export function wantsToUnderstand(text: string): boolean {
  return WANTS_TO_UNDERSTAND.test(text);
}

export function resolveLessonKind(chosen: LessonKind | undefined, scene: Scene | undefined, text: string): LessonKind {
  const doing = wantsToDo(text);
  const understanding = wantsToUnderstand(text);
  const onlyDoing = doing && !understanding;
  const onlyUnderstanding = understanding && !doing;

  if (scene === "working") {
    if (chosen === "concept" && onlyDoing) return "app";
    if (chosen) return chosen;
    return onlyUnderstanding ? "concept" : "app";
  }
  if (scene === "watching" || scene === "reading") {
    if (chosen === "app" && onlyUnderstanding) return "concept";
    if (chosen) return chosen;
    return onlyDoing ? "app" : "concept";
  }
  if (chosen) return chosen;
  return onlyUnderstanding ? "concept" : "app";
}
