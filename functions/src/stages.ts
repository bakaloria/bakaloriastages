import { DocumentData, FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";
import { SelectedQuestion, StageItem, SubjectSettings } from "./types";

export const DEFAULT_SETTINGS: SubjectSettings = {
  stageSize: 5,
  newPerStage: 3,
  reviewPerStage: 2,
  sessionStages: 10,
  intervalMinutes: 120,
  masteryThreshold: 1,
  finalExamRequired: false,
};

export function enrollmentId(uid: string, subjectId: string): string {
  return `${uid}_${subjectId}`;
}

export function unitProgressId(uid: string, subjectId: string, unitId: string): string {
  return `${uid}_${subjectId}_${unitId}`;
}

export function toMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { toMillis?: () => number; seconds?: number };
    if (typeof candidate.toMillis === "function") return candidate.toMillis();
    if (typeof candidate.seconds === "number") return candidate.seconds * 1000;
  }
  return null;
}

export function masteryTarget(enrollment: DocumentData, settings: SubjectSettings): number {
  const total = Number(enrollment.totalQuestions ?? 0);
  const threshold = Number(settings.masteryThreshold ?? 1);
  return Math.ceil(total * Math.min(1, Math.max(0, threshold)));
}

export function computeMasteryLevel(
  oldLevel: number,
  isCorrect: boolean,
  oldNextReviewAt: Timestamp | null,
  now: Timestamp,
): number {
  const level = Math.max(0, Math.min(3, Math.floor(oldLevel)));
  if (!isCorrect) return level;
  const due = !oldNextReviewAt || oldNextReviewAt.toMillis() <= now.toMillis();
  if (!due && level > 0) return level;
  return Math.min(3, Math.max(1, level + 1));
}

export function computeNextReviewAt(
  isCorrect: boolean,
  oldLevel: number,
  now: Timestamp,
  intervalMinutes: number,
): Timestamp {
  if (!isCorrect) return Timestamp.fromMillis(now.toMillis() + 10 * 60 * 1000);
  // The admin interval is the base review gap. Mastered questions wait a
  // little longer at each level, so successful recall is spaced out.
  const factor = [1, 3, 7, 14][Math.max(0, Math.min(3, Math.floor(oldLevel)))];
  const baseMs = Math.max(0, intervalMinutes) * 60 * 1000;
  return Timestamp.fromMillis(now.toMillis() + baseMs * factor);
}

export async function getSettings(subjectId: string): Promise<SubjectSettings> {
  const snap = await db.doc(`subject_settings/${subjectId}`).get();
  const data = (snap.exists ? snap.data() : null) as Partial<SubjectSettings> | null;
  const merged = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  return {
    stageSize: Math.max(1, Math.min(10, Number(merged.stageSize) || DEFAULT_SETTINGS.stageSize)),
    newPerStage: Math.max(0, Math.min(10, Number(merged.newPerStage) || 0)),
    reviewPerStage: Math.max(0, Math.min(10, Number(merged.reviewPerStage) || 0)),
    sessionStages: Math.max(1, Math.min(50, Number(merged.sessionStages) || DEFAULT_SETTINGS.sessionStages)),
    intervalMinutes: Math.max(0, Math.min(7 * 24 * 60, Number(merged.intervalMinutes) || 0)),
    masteryThreshold: Math.max(0, Math.min(1, Number(merged.masteryThreshold) || 0)),
    finalExamRequired: Boolean(merged.finalExamRequired),
  };
}

export async function ensureEnrollment(
  uid: string,
  subjectId: string,
): Promise<{ id: string; data: DocumentData }> {
  const id = enrollmentId(uid, subjectId);
  const ref = db.doc(`enrollments/${id}`);
  const existing = await ref.get();
  if (existing.exists) return { id, data: existing.data()! };

  const subject = await db.doc(`subjects/${subjectId}`).get();
  if (!subject.exists || subject.data()?.active !== true) {
    throw new HttpsError("not-found", "SUBJECT_NOT_FOUND");
  }

  const settings = await getSettings(subjectId);
  const total = (
    await db
      .collection("questions")
      .where("subjectId", "==", subjectId)
      .where("active", "==", true)
      .count()
      .get()
  ).data().count;

  const user = await db.doc(`users/${uid}`).get();
  const displayName = String(user.data()?.displayName ?? user.data()?.username ?? "طالب");

  try {
    await ref.create({
      userId: uid,
      subjectId,
      displayName,
      totalQuestions: total,
      masteryTarget: masteryTarget({ totalQuestions: total }, settings),
      coverageCount: 0,
      masteryCount: 0,
      autoFirstCorrect: 0,
      sessionStages: settings.sessionStages,
      stagesCompleted: 0,
      stagesInSession: 0,
      sessionNo: 1,
      nextQuestionIndex: 0,
      nextAvailableAt: null,
      startedAt: FieldValue.serverTimestamp(),
      completedAt: null,
      masteryCompletedAt: null,
    });
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code !== 6 && code !== "already-exists" && code !== "ALREADY_EXISTS") throw error;
  }

  const created = await ref.get();
  return { id, data: created.data()! };
}

export async function selectQuestions(
  uid: string,
  subjectId: string,
  enrollment: DocumentData,
  newCount: number,
  reviewCount: number,
  stageSize: number,
): Promise<SelectedQuestion[]> {
  const selected: SelectedQuestion[] = [];
  const seen = new Set<string>();
  const push = (question: SelectedQuestion) => {
    if (seen.has(question.id)) return;
    seen.add(question.id);
    selected.push(question);
  };

  const nextQuestionIndex = Number(enrollment.nextQuestionIndex ?? 0);

  if (newCount > 0) {
    const snap = await db
      .collection("questions")
      .where("subjectId", "==", subjectId)
      .where("active", "==", true)
      .where("orderIndex", ">=", nextQuestionIndex)
      .orderBy("orderIndex", "asc")
      .limit(newCount)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      push({ id: doc.id, orderIndex: Number(data.orderIndex ?? 0), isReview: false });
    }
  }

  if (reviewCount > 0 && selected.length < stageSize) {
    const snap = await db
      .collection("progress")
      .where("userId", "==", uid)
      .where("subjectId", "==", subjectId)
      .where("nextReviewAt", "<=", Timestamp.now())
      .orderBy("nextReviewAt", "asc")
      .limit(reviewCount)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      push({
        id: String(data.questionId),
        orderIndex: Number(data.orderIndex ?? 0),
        isReview: true,
      });
      if (selected.length >= stageSize) break;
    }
  }

  // Fill any remaining slots with the next unseen questions.
  if (selected.length < stageSize) {
    const snap = await db
      .collection("questions")
      .where("subjectId", "==", subjectId)
      .where("active", "==", true)
      .where("orderIndex", ">=", nextQuestionIndex)
      .orderBy("orderIndex", "asc")
      .limit(stageSize * 2)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      push({ id: doc.id, orderIndex: Number(data.orderIndex ?? 0), isReview: false });
      if (selected.length >= stageSize) break;
    }
  }

  // If the subject is fully covered, reuse the least recently reviewed questions.
  if (selected.length < stageSize) {
    const snap = await db
      .collection("progress")
      .where("userId", "==", uid)
      .where("subjectId", "==", subjectId)
      .orderBy("nextReviewAt", "asc")
      .limit(stageSize * 3)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      push({
        id: String(data.questionId),
        orderIndex: Number(data.orderIndex ?? 0),
        isReview: true,
      });
      if (selected.length >= stageSize) break;
    }
  }

  return selected.slice(0, stageSize);
}

export async function buildStagePayload(
  attemptId: string,
  attempt: DocumentData,
  settings: SubjectSettings,
  resumed: boolean,
) {
  const items = (attempt.items ?? []) as StageItem[];
  const refs = items.map((item) => db.doc(`questions/${item.questionId}`));
  const snaps = refs.length > 0 ? await db.getAll(...refs) : [];
  const questions = new Map(snaps.map((snap) => [snap.id, snap.data()!]));

  return {
    attemptId,
    resumed,
    stageNo: Number(attempt.stageNo ?? 0),
    sessionNo: Number(attempt.sessionNo ?? 1),
    stageInSession: Number(attempt.stageInSession ?? 1),
    sessionStages: settings.sessionStages,
    questions: items.map((item) => {
      const question = questions.get(item.questionId);
      if (!question) throw new HttpsError("failed-precondition", "QUESTION_NOT_FOUND");
      return {
        questionId: item.questionId,
        position: item.position,
        isReview: item.isReview,
        type: question.type,
        text: question.text,
        options: question.options ?? null,
      };
    }),
  };
}

export async function getUnitTotals(
  subjectId: string,
  unitIds: string[],
): Promise<Map<string, { total: number; title: string }>> {
  const unique = [...new Set(unitIds)];
  if (unique.length === 0) return new Map();
  const refs = unique.map((unitId) => db.doc(`unit_totals/${subjectId}_${unitId}`));
  const snaps = await db.getAll(...refs);
  const result = new Map<string, { total: number; title: string }>();
  for (const snap of snaps) {
    const data = snap.data();
    if (data) {
      result.set(String(data.unitId), {
        total: Number(data.total ?? 0),
        title: String(data.title ?? ""),
      });
    }
  }
  return result;
}

export async function getSubjectProgress(uid: string, subjectId: string) {
  const enrollmentSnap = await db.doc(`enrollments/${enrollmentId(uid, subjectId)}`).get();
  if (!enrollmentSnap.exists) throw new HttpsError("not-found", "NOT_ENROLLED");
  const enrollment = enrollmentSnap.data()!;
  const settings = await getSettings(subjectId);

  const [unitsSnap, progressSnap] = await Promise.all([
    db.collection("units").where("subjectId", "==", subjectId).orderBy("sort", "asc").get(),
    db
      .collection("unit_progress")
      .where("userId", "==", uid)
      .where("subjectId", "==", subjectId)
      .get(),
  ]);

  const progressByUnit = new Map(
    progressSnap.docs.map((doc) => [String(doc.data().unitId), doc.data()]),
  );

  return {
    enrolled: true,
    subjectId,
    totalQuestions: Number(enrollment.totalQuestions ?? 0),
    coverageCount: Number(enrollment.coverageCount ?? 0),
    masteryCount: Number(enrollment.masteryCount ?? 0),
    masteryTarget: masteryTarget(enrollment, settings),
    sessionStages: settings.sessionStages,
    sessionNo: Number(enrollment.sessionNo ?? 1),
    stagesInSession: Number(enrollment.stagesInSession ?? 0),
    nextAvailableAt: toMillis(enrollment.nextAvailableAt),
    completedAt: toMillis(enrollment.completedAt),
    masteryCompletedAt: toMillis(enrollment.masteryCompletedAt),
    byUnit: unitsSnap.docs.map((unitDoc) => {
      const unit = unitDoc.data();
      const progress = progressByUnit.get(unitDoc.id);
      return {
        unitId: unitDoc.id,
        title: String(unit.title ?? ""),
        total: Number(progress?.total ?? unit.totalQuestions ?? 0),
        seen: Number(progress?.seen ?? 0),
        mastered: Number(progress?.mastered ?? 0),
      };
    }),
  };
}
