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
  wrongIntervalMinutes: 10,
  masteryThreshold: 1,
  finalExamRequired: false,
  stagesLocked: false,
  lockMessage: "",
};

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  stagesLocked: false,
  registrationsOpen: true,
  lockMessage: "",
  maintenanceMessage: "",
};

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
