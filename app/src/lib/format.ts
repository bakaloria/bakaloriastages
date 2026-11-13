import type { Branch, QuestionType } from "./types";

const numberFormatter = new Intl.NumberFormat("ar-EG");
const percentFormatter = new Intl.NumberFormat("ar-EG", {
  style: "percent",
  maximumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat("ar-EG", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const dateTimeFormatter = new Intl.DateTimeFormat("ar-EG", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatNumber(value: number): string {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

export function formatPercent(value: number, total: number): string {
  if (!total) return percentFormatter.format(0);
  return percentFormatter.format(Math.min(1, Math.max(0, value / total)));
}

export function formatDurationMinutes(value: unknown): string {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  if (minutes < 60) return `${formatNumber(minutes)} دقيقة`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${formatNumber(hours)} ساعة`;
  return `${formatNumber(hours)} ساعة و${formatNumber(rest)} دقيقة`;
}

export function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "object") {
    const candidate = value as { toMillis?: () => number; seconds?: number };
    if (typeof candidate.toMillis === "function") return candidate.toMillis();
    if (typeof candidate.seconds === "number") return candidate.seconds * 1000;
  }
  return null;
}

export function formatDate(value: unknown): string {
  const millis = toMillis(value);
  return millis ? dateFormatter.format(new Date(millis)) : "—";
}

export function formatDateTime(value: unknown): string {
  const millis = toMillis(value);
  return millis ? dateTimeFormatter.format(new Date(millis)) : "—";
}

export function formatCountdown(target: number | null, now = Date.now()): string {
  if (!target) return "الآن";
  const remaining = Math.max(0, target - now);
  if (remaining <= 0) return "الآن";
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function branchLabel(branch: Branch | string | undefined): string {
  if (branch === "scientific") return "الفرع العلمي";
  if (branch === "literary") return "الفرع الأدبي";
  return "غير محدد";
}

export function questionTypeLabel(type: QuestionType | string | undefined): string {
  const labels: Record<string, string> = {
    mcq: "اختيار من متعدد",
    true_false: "صح أو خطأ",
    fill_blank: "أكمل الفراغ",
    matching: "مطابقة",
    ordering: "ترتيب",
    comparison: "مقارنة",
    short_answer: "إجابة قصيرة",
    essay: "مقال",
  };
  return labels[type ?? ""] ?? "سؤال";
}

const OPTION_LETTERS = ["أ", "ب", "ج", "د", "هـ", "و", "ز", "ح", "ط", "ي"];

export function optionLetter(index: number): string {
  return OPTION_LETTERS[index] ?? String(index + 1);
}

export function optionText(option: unknown, index: number): string {
  if (typeof option === "string") return option;
  if (typeof option === "number" || typeof option === "boolean") return String(option);
  if (option && typeof option === "object") {
    const record = option as Record<string, unknown>;
    return String(record.text ?? record.label ?? record.value ?? `الخيار ${index + 1}`);
  }
  return `الخيار ${index + 1}`;
}

export function optionsList(options: unknown): unknown[] {
  return Array.isArray(options) ? options : [];
}

export function formatAnswer(value: unknown, options?: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "boolean") return value ? "صح" : "خطأ";
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value
      .map((item, index) => `${index + 1}. ${formatAnswer(item, options)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("text" in record && record.text !== null && record.text !== undefined) {
      return String(record.text);
    }
    if ("value" in record && typeof record.value === "boolean") {
      return record.value ? "صح" : "خطأ";
    }
    if ("index" in record) {
      const index = Number(record.index);
      const list = optionsList(options);
      if (Number.isFinite(index) && list[index] !== undefined) {
        return optionText(list[index], index);
      }
      return `الخيار ${index + 1}`;
    }
    if ("answer" in record) return formatAnswer(record.answer, options);
    return Object.entries(record)
      .map(([key, item]) => `${key}: ${formatAnswer(item, options)}`)
      .join(" • ");
  }
  return "—";
}

export function formatModelAnswer(modelAnswer: unknown, options?: unknown): string {
  if (modelAnswer && typeof modelAnswer === "object" && !Array.isArray(modelAnswer)) {
    const record = modelAnswer as Record<string, unknown>;
    if ("text" in record && record.text) return String(record.text);
    if ("value" in record && typeof record.value === "boolean") {
      return record.value ? "صح" : "خطأ";
    }
    if ("index" in record) {
      const index = Number(record.index);
      const list = optionsList(options);
      if (Number.isFinite(index) && list[index] !== undefined) {
        return optionText(list[index], index);
      }
      return `الخيار ${index + 1}`;
    }
  }
  return formatAnswer(modelAnswer, options);
}

export function progressRatio(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(1, Math.max(0, value / total));
}
