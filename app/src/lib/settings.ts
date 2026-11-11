import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import type { GlobalSettings, SubjectSettings } from "./types";

export const DEFAULT_SUBJECT_SETTINGS: SubjectSettings = {
  // Five questions per stage remains the recommended default, but the split is
  // now fully editable from the admin dashboard.
  stageSize: 5,
  newPerStage: 3,
  reviewPerStage: 2,
  failedNewPerStage: 2,
  failedReviewPerStage: 3,
  passThreshold: 60,
  sessionStages: 10,
  intervalMinutes: 120,
  // Optional pause between two stages. Zero keeps the original behaviour:
  // the next stage opens as soon as the student confirms they saw feedback.
  stageIntervalMinutes: 0,
  wrongIntervalMinutes: 10,
  masteryThreshold: 1,
  finalExamRequired: false,
  stagesLocked: false,
  lockMessage: "",
};

export const DEFAULT_BACKGROUND_COLOR = "#f7f3ea";

export const BACKGROUND_PRESETS = [
  { label: "ورقي دافئ", value: "#f7f3ea" },
  { label: "أبيض هادئ", value: "#f5f7f6" },
  { label: "رملي فاتح", value: "#f6efe3" },
  { label: "أزرق سماوي", value: "#eaf2f8" },
  { label: "أخضر نعناعي", value: "#eaf5ef" },
  { label: "وردي ناعم", value: "#faeef0" },
  { label: "بنفسجي فاتح", value: "#f1edf8" },
  { label: "رمادي فضي", value: "#eef1f2" },
] as const;

export const DEFAULT_CERTIFICATE_NOTICE =
  "الشهادة الرسمية تحتاج إلى اعتماد من الجهات المختصة. إتمام المراجعة داخل المنصة سجل تدريبي، ولا يعني الحصول على شهادة رسمية.";

export const DEFAULT_FINAL_EXAM_REMINDER =
  "من اقترب من إتمام المراجعة أصبح أقرب إلى النجاح في امتحان الشهادة الأخير؛ فليواصل بثبات.";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  stagesLocked: false,
  registrationsOpen: true,
  lockMessage: "",
  maintenanceMessage: "",
  backgroundColor: DEFAULT_BACKGROUND_COLOR,
  certificateClaimsEnabled: false,
  certificateNotice: DEFAULT_CERTIFICATE_NOTICE,
  finalExamReminder: DEFAULT_FINAL_EXAM_REMINDER,
};

export function normalizeBackgroundColor(value: unknown): string {
  const color = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : DEFAULT_BACKGROUND_COLOR;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function shiftColor(hex: string, amount: number): string {
  const channels = hexToRgb(hex).map((channel) =>
    Math.max(0, Math.min(255, channel + amount)),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function applyBackgroundColor(value: unknown): void {
  if (typeof document === "undefined") return;
  const color = normalizeBackgroundColor(value);
  const [r, g, b] = hexToRgb(color);
  const root = document.documentElement;
  root.style.setProperty("--bg", color);
  root.style.setProperty("--bg-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty(
    "--bg-deep",
    color === DEFAULT_BACKGROUND_COLOR ? "#efe9dc" : shiftColor(color, -14),
  );
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeSubjectSettings(data: Partial<SubjectSettings> | null): SubjectSettings {
  const merged = { ...DEFAULT_SUBJECT_SETTINGS, ...(data ?? {}) };
  const newPerStage = clamp(merged.newPerStage, 0, 10, DEFAULT_SUBJECT_SETTINGS.newPerStage);
  const reviewPerStage = clamp(
    merged.reviewPerStage,
    0,
    10,
    DEFAULT_SUBJECT_SETTINGS.reviewPerStage,
  );
  return {
    stageSize: Math.max(
      1,
      Math.min(20, newPerStage + reviewPerStage || Number(merged.stageSize) || 5),
    ),
    newPerStage,
    reviewPerStage,
    failedNewPerStage: clamp(
      merged.failedNewPerStage,
      0,
      10,
      DEFAULT_SUBJECT_SETTINGS.failedNewPerStage,
    ),
    failedReviewPerStage: clamp(
      merged.failedReviewPerStage,
      0,
      10,
      DEFAULT_SUBJECT_SETTINGS.failedReviewPerStage,
    ),
    passThreshold: clamp(
      merged.passThreshold,
      0,
      100,
      DEFAULT_SUBJECT_SETTINGS.passThreshold,
    ),
    sessionStages: clamp(
      merged.sessionStages,
      1,
      50,
      DEFAULT_SUBJECT_SETTINGS.sessionStages,
    ),
    intervalMinutes: clamp(
      merged.intervalMinutes,
      0,
      7 * 24 * 60,
      DEFAULT_SUBJECT_SETTINGS.intervalMinutes,
    ),
    stageIntervalMinutes: clamp(
      merged.stageIntervalMinutes,
      0,
      7 * 24 * 60,
      DEFAULT_SUBJECT_SETTINGS.stageIntervalMinutes,
    ),
    wrongIntervalMinutes: clamp(
      merged.wrongIntervalMinutes,
      1,
      7 * 24 * 60,
      DEFAULT_SUBJECT_SETTINGS.wrongIntervalMinutes,
    ),
    masteryThreshold: clamp(
      merged.masteryThreshold,
      0,
      1,
      DEFAULT_SUBJECT_SETTINGS.masteryThreshold,
    ),
    finalExamRequired: Boolean(merged.finalExamRequired),
    stagesLocked: Boolean(merged.stagesLocked),
    lockMessage: String(merged.lockMessage ?? "").trim(),
  };
}

export function normalizeGlobalSettings(data: Partial<GlobalSettings> | null): GlobalSettings {
  const merged = { ...DEFAULT_GLOBAL_SETTINGS, ...(data ?? {}) };
  return {
    stagesLocked: Boolean(merged.stagesLocked),
    registrationsOpen: merged.registrationsOpen !== false,
    lockMessage: String(merged.lockMessage ?? "").trim(),
    maintenanceMessage: String(merged.maintenanceMessage ?? "").trim(),
    backgroundColor: normalizeBackgroundColor(merged.backgroundColor),
    certificateClaimsEnabled: merged.certificateClaimsEnabled === true,
    certificateNotice: String(
      merged.certificateNotice ?? DEFAULT_CERTIFICATE_NOTICE,
    ).trim(),
    finalExamReminder: String(
      merged.finalExamReminder ?? DEFAULT_FINAL_EXAM_REMINDER,
    ).trim(),
  };
}

export async function fetchSubjectSettings(subjectId: string): Promise<SubjectSettings> {
  if (!db) return normalizeSubjectSettings(null);
  const snap = await getDoc(doc(db, "subject_settings", subjectId));
  return normalizeSubjectSettings(snap.exists() ? (snap.data() as Partial<SubjectSettings>) : null);
}

export async function fetchGlobalSettings(): Promise<GlobalSettings> {
  if (!db) return normalizeGlobalSettings(null);
  const snap = await getDoc(doc(db, "settings", "global"));
  return normalizeGlobalSettings(snap.exists() ? (snap.data() as Partial<GlobalSettings>) : null);
}

export async function saveSubjectSettings(
  subjectId: string,
  settings: SubjectSettings,
  updatedBy: string,
): Promise<SubjectSettings> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const normalized = normalizeSubjectSettings(settings);
  await setDoc(
    doc(db, "subject_settings", subjectId),
    {
      ...normalized,
      updatedAt: serverTimestamp(),
      updatedBy,
    },
    { merge: true },
  );
  return normalized;
}

export async function saveGlobalSettings(
  settings: GlobalSettings,
  updatedBy: string,
): Promise<GlobalSettings> {
  if (!db) throw new Error("FIREBASE_NOT_CONFIGURED");
  const normalized = normalizeGlobalSettings(settings);
  await setDoc(
    doc(db, "settings", "global"),
    {
      ...normalized,
      updatedAt: serverTimestamp(),
      updatedBy,
    },
    { merge: true },
  );
  return normalized;
}
