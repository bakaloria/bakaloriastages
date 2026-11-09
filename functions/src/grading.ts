import { AnswerInput, QuestionPrivate, QuestionPublic, SelfScore } from "./types";

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "نعم", "صح", "صحيح"].includes(normalized)) return true;
    if (["false", "0", "no", "لا", "خطأ", "خطا"].includes(normalized)) return false;
  }
  return null;
}

export function gradeAnswer(
  question: QuestionPublic,
  privateData: QuestionPrivate,
  input?: AnswerInput,
): { isCorrect: boolean | null; selfScore?: SelfScore } {
  if (privateData.grading === "self") {
    const selfScore = input?.selfScore ?? "wrong";
    return { isCorrect: selfScore === "correct", selfScore };
  }
  if (privateData.grading === "manual") {
    return { isCorrect: null };
  }

  const answer = input?.answer;

  if (question.type === "mcq") {
    const answerIndex = Number(
      typeof answer === "object" && answer !== null ? asRecord(answer).index : answer,
    );
    const correctIndex = Number(
      typeof privateData.correct === "object" && privateData.correct !== null
        ? asRecord(privateData.correct).index
        : privateData.correct,
    );
    return { isCorrect: Number.isFinite(answerIndex) && answerIndex === correctIndex };
  }

  if (question.type === "true_false") {
    const answerValue = asBoolean(
      typeof answer === "object" && answer !== null ? asRecord(answer).value : answer,
    );
    const correctValue = asBoolean(
      typeof privateData.correct === "object" && privateData.correct !== null
        ? asRecord(privateData.correct).value
        : privateData.correct,
    );
    return { isCorrect: answerValue !== null && correctValue !== null && answerValue === correctValue };
  }

  if (question.type === "fill_blank") {
    const answerText =
      typeof answer === "object" && answer !== null ? asRecord(answer).text : answer;
    const correctText =
      typeof privateData.correct === "object" && privateData.correct !== null
        ? asRecord(privateData.correct).text
        : privateData.correct;
    const normalizedAnswer = normalizeText(answerText);
    return {
      isCorrect: normalizedAnswer !== "" && normalizedAnswer === normalizeText(correctText),
    };
  }

  return {
    isCorrect: stableStringify(answer ?? null) === stableStringify(privateData.correct ?? null),
  };
}
