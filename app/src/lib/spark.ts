import {
  createUserWithEmailAndPassword,
  deleteUser,
  updateProfile,
  type User,
} from "firebase/auth";
import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type DocumentData,
} from "firebase/firestore";
import { auth, db, STUDENT_EMAIL_DOMAIN } from "./firebase";
import { fetchGlobalSettings, fetchSubjectSettings, getAdaptiveLevel } from "./settings";
import type {
  Branch,
  Certificate,
  GradedAnswer,
  Grading,
  LeaderboardRow,
  QuestionType,
  RegisterInput,
  SelfScore,
  StageResultResponse,
  StartStageResponse,
  SubjectProgress,
  SubjectSettings,
  SubmitStageResponse,
} from "./types";

/*
 * Spark backend.
 *
 * Firebase's free plan does not run Cloud Functions, so this module performs
 * grading and progress updates in the browser while keeping Auth and Firestore
 * as the source of truth. It is intentionally a mirror of functions/src so the
 * app can switch to the hardened callable backend by setting
 * `backendMode: "functions"` in firebase-config.js.
 */

interface QuestionPublic {
  id: string;
  subjectId: string;
  unitId: string;
  lessonId?: string;
  type: QuestionType;
  text: string;
  options?: unknown;
  orderIndex: number;
  active: boolean;
  // Spark mode stores the answer key inline so a full bank import stays inside
  // the free write quota. The hardened backend keeps these fields out of the
  // question document and uses `question_answers` instead.
  grading?: Grading;
  correct?: unknown;
  modelAnswer?: unknown;
  explanation?: string | null;
}

interface QuestionPrivate {
  grading: Grading;
  correct?: unknown;
  modelAnswer?: unknown;
  explanation?: string | null;
}

interface StageItem {
  questionId: string;
  position: number;
  isReview: boolean;
}

interface AnswerInput {
  questionId: string;
  answer?: unknown;
  selfScore?: SelfScore;
  timeMs?: number;
}

interface SelectedQuestion {
  id: string;
  orderIndex: number;
  isReview: boolean;
}

interface UnitTotal {
  total: number;
  title: string;
}

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const BRANCHES = new Set(["scientific", "literary"]);

function appError(message: string, code = "failed-precondition"): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

function database() {
  if (!db) throw appError("FIREBASE_NOT_CONFIGURED", "FIREBASE_NOT_CONFIGURED");
  return db;
}

function currentUser(): User {
  if (!auth?.currentUser) throw appError("AUTH_REQUIRED", "auth/unauthenticated");
  return auth.currentUser;
}

function enrollmentId(uid: string, subjectId: string): string {
  return `${uid}_${subjectId}`;
}

function unitProgressId(uid: string, subjectId: string, unitId: string): string {
  return `${uid}_${subjectId}_${unitId}`;
}

function toMillis(value: unknown): number | null {
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

function masteryTarget(
  enrollment: Record<string, unknown>,
  settings: SubjectSettings,
): number {
  const total = Number(enrollment.totalQuestions ?? 0);
  const threshold = Number(settings.masteryThreshold ?? 1);
  return Math.ceil(total * Math.min(1, Math.max(0, threshold)));
}

function computeMasteryLevel(
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

function computeNextReviewAt(
  isCorrect: boolean,
  oldLevel: number,
  now: Timestamp,
  intervalMinutes: number,
  wrongIntervalMinutes: number,
): Timestamp {
  if (!isCorrect) {
    return Timestamp.fromMillis(now.toMillis() + Math.max(1, wrongIntervalMinutes) * 60 * 1000);
  }
  const factor = [1, 3, 7, 14][Math.max(0, Math.min(3, Math.floor(oldLevel)))];
  const baseMs = Math.max(0, intervalMinutes) * 60 * 1000;
  return Timestamp.fromMillis(now.toMillis() + baseMs * factor);
}

function normalizeText(value: unknown): string {
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

function stableStringify(value: unknown): string {
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

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextLocalMidnight(date: Date): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

interface AdaptivePlanState {
  enabled: boolean;
  migrated: boolean;
  level: number;
  levelName: string;
  stageSize: number;
  newPerStage: number;
  reviewPerStage: number;
  sessionStages: number;
  stageIntervalMinutes: number;
  intervalMinutes: number;
  passThreshold: number;
  strongSessions: number;
}

function adaptivePlanState(
  enrollment: Record<string, unknown>,
  settings: SubjectSettings,
): AdaptivePlanState {
  const levels = Array.isArray(settings.adaptiveLevels) ? settings.adaptiveLevels : [];
  const maxLevel = Math.max(0, levels.length - 1);
  const hasAdaptiveLevel = Number.isFinite(Number(enrollment.adaptiveLevel));
  const rawLevel = hasAdaptiveLevel
    ? Number(enrollment.adaptiveLevel)
    : settings.adaptiveInitialLevel;
  const level = clampNumber(rawLevel, 0, maxLevel, settings.adaptiveInitialLevel);
  const levelSettings = getAdaptiveLevel(settings, level);

  if (!settings.adaptiveEnabled) {
    const legacyNew = Math.max(0, Math.floor(Number(settings.newPerStage) || 0));
    const legacyReview = Math.max(0, Math.floor(Number(settings.reviewPerStage) || 0));
    return {
      enabled: false,
      migrated: !hasAdaptiveLevel,
      level,
      levelName: "الخطة اليدوية",
      stageSize: Math.max(
        1,
        Math.min(20, legacyNew + legacyReview || Number(settings.stageSize) || 5),
      ),
      newPerStage: legacyNew,
      reviewPerStage: legacyReview,
      sessionStages: Math.max(1, Math.min(50, Number(settings.sessionStages) || 10)),
      stageIntervalMinutes: Math.max(0, Number(settings.stageIntervalMinutes) || 0),
      intervalMinutes: Math.max(0, Number(settings.intervalMinutes) || 120),
      passThreshold: Math.max(0, Math.min(100, Number(settings.passThreshold) || 60)),
      strongSessions: 0,
    };
  }

  const stageSize = Math.max(
    1,
    Math.min(
      20,
      Math.floor(levelSettings.newPerStage) + Math.floor(levelSettings.reviewPerStage),
    ),
  );
  const rawNew = hasAdaptiveLevel ? enrollment.adaptiveStageNew : levelSettings.newPerStage;
  const rawReview = hasAdaptiveLevel
    ? enrollment.adaptiveStageReview
    : levelSettings.reviewPerStage;
  let newPerStage = clampNumber(rawNew, 0, stageSize, levelSettings.newPerStage);
  let reviewPerStage = clampNumber(rawReview, 0, stageSize, levelSettings.reviewPerStage);
  if (newPerStage + reviewPerStage !== stageSize) {
    newPerStage = Math.min(newPerStage, stageSize);
    reviewPerStage = Math.max(0, stageSize - newPerStage);
  }

  return {
    enabled: true,
    migrated: !hasAdaptiveLevel,
    level,
    levelName: levelSettings.name,
    stageSize,
    newPerStage,
    reviewPerStage,
    sessionStages: hasAdaptiveLevel
      ? clampNumber(enrollment.sessionStages, 1, 50, levelSettings.sessionStages)
      : Math.max(1, Math.min(50, levelSettings.sessionStages)),
    stageIntervalMinutes: clampNumber(
      enrollment.adaptiveStageInterval,
      0,
      60,
      levelSettings.stageIntervalMinutes,
    ),
    intervalMinutes: Math.max(30, Number(levelSettings.intervalMinutes) || 300),
    passThreshold: Math.max(0, Math.min(100, Number(levelSettings.passThreshold) || 60)),
    strongSessions: Math.max(0, Math.floor(Number(enrollment.adaptiveStrongSessions) || 0)),
  };
}

function gradeAnswer(
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
    return {
      isCorrect: answerValue !== null && correctValue !== null && answerValue === correctValue,
    };
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
      isCorrect:
        normalizedAnswer !== "" && normalizedAnswer === normalizeText(correctText),
    };
  }

  return {
    isCorrect:
      stableStringify(answer ?? null) === stableStringify(privateData.correct ?? null),
  };
}

async function getSettings(subjectId: string): Promise<SubjectSettings> {
  return fetchSubjectSettings(subjectId);
}

async function ensureEnrollment(
  uid: string,
  subjectId: string,
): Promise<{ id: string; data: DocumentData }> {
  const firestore = database();
  const id = enrollmentId(uid, subjectId);
  const ref = doc(firestore, "enrollments", id);
  const existing = await getDoc(ref);
  if (existing.exists()) return { id, data: existing.data() };

  const subject = await getDoc(doc(firestore, "subjects", subjectId));
  if (!subject.exists() || subject.data().active !== true) {
    throw appError("SUBJECT_NOT_FOUND", "not-found");
  }

  const settings = await getSettings(subjectId);
  const countSnap = await getCountFromServer(
    query(
      collection(firestore, "questions"),
      where("subjectId", "==", subjectId),
      where("active", "==", true),
    ),
  );
  const total = countSnap.data().count;
  const user = await getDoc(doc(firestore, "users", uid));
  const displayName = String(user.data()?.displayName ?? user.data()?.username ?? "طالب");
  const initialLevel = getAdaptiveLevel(settings, settings.adaptiveInitialLevel);

  const data = {
    userId: uid,
    subjectId,
    displayName,
    totalQuestions: total,
    masteryTarget: masteryTarget({ totalQuestions: total }, settings),
    coverageCount: 0,
    masteryCount: 0,
    autoFirstCorrect: 0,
    sessionStages: settings.adaptiveEnabled
      ? initialLevel.sessionStages
      : settings.sessionStages,
    stagesCompleted: 0,
    stagesInSession: 0,
    sessionNo: 1,
    nextQuestionIndex: 0,
    nextAvailableAt: null,
    adaptiveLevel: settings.adaptiveInitialLevel,
    adaptiveStrongSessions: 0,
    adaptiveStageNew: initialLevel.newPerStage,
    adaptiveStageReview: initialLevel.reviewPerStage,
    adaptiveStageInterval: initialLevel.stageIntervalMinutes,
    adaptiveSessionScoreSum: 0,
    adaptiveSessionScoreCount: 0,
    adaptiveSessionMinScore: null,
    adaptiveSessionReviewCorrect: 0,
    adaptiveSessionReviewTotal: 0,
    dailyQuestionDate: "",
    dailyQuestionCount: 0,
    adaptiveLevelReason: settings.adaptiveEnabled
      ? `بدأت من مستوى «${initialLevel.name}»، وستتغير الخطة تلقائيًا حسب أدائك.`
      : "",
    startedAt: serverTimestamp(),
    completedAt: null,
    masteryCompletedAt: null,
  };

  await runTransaction(firestore, async (tx) => {
    const current = await tx.get(ref);
    if (current.exists()) return;
    tx.set(ref, data);
  });

  const created = await getDoc(ref);
  return { id, data: created.data() ?? data };
}

async function selectQuestions(
  uid: string,
  subjectId: string,
  enrollment: DocumentData,
  newCount: number,
  reviewCount: number,
  stageSize: number,
): Promise<SelectedQuestion[]> {
  const firestore = database();
  const selected: SelectedQuestion[] = [];
  const seen = new Set<string>();
  const push = (question: SelectedQuestion) => {
    if (seen.has(question.id)) return;
    seen.add(question.id);
    selected.push(question);
  };

  const nextQuestionIndex = Number(enrollment.nextQuestionIndex ?? 0);

  if (newCount > 0) {
    const snap = await getDocs(
      query(
        collection(firestore, "questions"),
        where("subjectId", "==", subjectId),
        where("active", "==", true),
        where("orderIndex", ">=", nextQuestionIndex),
        orderBy("orderIndex", "asc"),
        limit(newCount),
      ),
    );
    for (const question of snap.docs) {
      const data = question.data();
      push({
        id: question.id,
        orderIndex: Number(data.orderIndex ?? 0),
        isReview: false,
      });
    }
  }

  if (reviewCount > 0 && selected.length < stageSize) {
    const snap = await getDocs(
      query(
        collection(firestore, "progress"),
        where("userId", "==", uid),
        where("subjectId", "==", subjectId),
        where("nextReviewAt", "<=", Timestamp.now()),
        orderBy("nextReviewAt", "asc"),
        limit(reviewCount),
      ),
    );
    for (const progress of snap.docs) {
      const data = progress.data();
      push({
        id: String(data.questionId),
        orderIndex: Number(data.orderIndex ?? 0),
        isReview: true,
      });
      if (selected.length >= stageSize) break;
    }
  }

  // If the plan asks for a review-only stage, do not quietly turn the extra
  // slots into new questions. The emergency fallback below still keeps the app
  // usable when no review item is due at all.
  if (selected.length < stageSize && (newCount > 0 || selected.length === 0)) {
    const snap = await getDocs(
      query(
        collection(firestore, "questions"),
        where("subjectId", "==", subjectId),
        where("active", "==", true),
        where("orderIndex", ">=", nextQuestionIndex),
        orderBy("orderIndex", "asc"),
        limit(stageSize * 2),
      ),
    );
    for (const question of snap.docs) {
      const data = question.data();
      push({
        id: question.id,
        orderIndex: Number(data.orderIndex ?? 0),
        isReview: false,
      });
      if (selected.length >= stageSize) break;
    }
  }

  if (selected.length < stageSize) {
    const snap = await getDocs(
      query(
        collection(firestore, "progress"),
        where("userId", "==", uid),
        where("subjectId", "==", subjectId),
        orderBy("nextReviewAt", "asc"),
        limit(stageSize * 3),
      ),
    );
    for (const progress of snap.docs) {
      const data = progress.data();
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

async function buildStagePayload(
  attemptId: string,
  attempt: DocumentData,
  settings: SubjectSettings,
  resumed: boolean,
) {
  const firestore = database();
  const items = (attempt.items ?? []) as StageItem[];
  const snaps = await Promise.all(
    items.map((item) => getDoc(doc(firestore, "questions", item.questionId))),
  );
  const questions = new Map(
    snaps.map((snap) => [snap.id, snap.exists() ? snap.data() : null]),
  );

  return {
    attemptId,
    resumed,
    stageNo: Number(attempt.stageNo ?? 0),
    sessionNo: Number(attempt.sessionNo ?? 1),
    stageInSession: Number(attempt.stageInSession ?? 1),
    sessionStages: Number(attempt.sessionStagesTarget ?? settings.sessionStages),
    questions: items.map((item) => {
      const question = questions.get(item.questionId);
      if (!question) throw appError("QUESTION_NOT_FOUND", "failed-precondition");
      return {
        questionId: item.questionId,
        position: item.position,
        isReview: item.isReview,
        type: question.type as QuestionType,
        text: String(question.text ?? ""),
        options: question.options ?? null,
      };
    }),
  };
}

async function getUnitTotals(
  subjectId: string,
  unitIds: string[],
): Promise<Map<string, UnitTotal>> {
  const firestore = database();
  const unique = [...new Set(unitIds)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const snaps = await Promise.all(
    unique.map((unitId) => getDoc(doc(firestore, "unit_totals", `${subjectId}_${unitId}`))),
  );
  const result = new Map<string, UnitTotal>();
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

async function register(input: RegisterInput) {
  if (!auth) throw appError("FIREBASE_NOT_CONFIGURED", "FIREBASE_NOT_CONFIGURED");
  const firestore = database();

  const username = input.username.trim();
  const usernameLower = username.toLowerCase();
  const password = input.password;
  const displayName = input.displayName.trim() || username;
  const branch: Branch = input.branch === "literary" ? "literary" : "scientific";

  if (!USERNAME_RE.test(usernameLower)) throw appError("USERNAME_INVALID", "invalid-argument");
  if (password.length < 6 || password.length > 128) {
    throw appError("PASSWORD_INVALID", "invalid-argument");
  }
  if (!BRANCHES.has(branch)) throw appError("BRANCH_INVALID", "invalid-argument");

  const email = `${usernameLower}@${STUDENT_EMAIL_DOMAIN}`;
  let user: User;
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    user = credential.user;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/email-already-in-use") {
      throw appError("USERNAME_TAKEN", "auth/email-already-in-use");
    }
    throw error;
  }

  try {
    // settings/global is readable only to signed-in users, so registration
    // checks the switch after Firebase Auth has produced a token. If the
    // switch is off, the temporary account is removed in the catch below.
    const globalSettings = await fetchGlobalSettings();
    if (!globalSettings.registrationsOpen) {
      throw appError("REGISTRATIONS_CLOSED", "failed-precondition");
    }

    await updateProfile(user, { displayName });
    const usernameRef = doc(firestore, "usernames", usernameLower);
    const userRef = doc(firestore, "users", user.uid);

    await runTransaction(firestore, async (tx) => {
      const currentUsername = await tx.get(usernameRef);
      if (currentUsername.exists()) {
        throw appError("USERNAME_TAKEN", "auth/email-already-in-use");
      }
      tx.set(usernameRef, {
        uid: user.uid,
        username: usernameLower,
        email,
        createdAt: serverTimestamp(),
      });
      tx.set(userRef, {
        username,
        usernameLower,
        displayName,
        branch,
        role: "student",
        createdAt: serverTimestamp(),
      });
    });
  } catch (error) {
    await deleteUser(user).catch(() => undefined);
    throw error;
  }

  return { uid: user.uid, email };
}

async function joinSubject(subjectId: string) {
  const uid = currentUser().uid;
  const enrollment = await ensureEnrollment(uid, subjectId);
  const settings = await getSettings(subjectId);
  return {
    enrolled: true,
    subjectId,
    totalQuestions: Number(enrollment.data.totalQuestions ?? 0),
    coverageCount: Number(enrollment.data.coverageCount ?? 0),
    masteryCount: Number(enrollment.data.masteryCount ?? 0),
    masteryTarget: masteryTarget(enrollment.data, settings),
  };
}

async function startStage(subjectId: string): Promise<StartStageResponse> {
  const uid = currentUser().uid;
  const firestore = database();
  const enrollment = await ensureEnrollment(uid, subjectId);
  const [settings, globalSettings] = await Promise.all([
    getSettings(subjectId),
    fetchGlobalSettings(),
  ]);
  const adaptive = adaptivePlanState(enrollment.data, settings);
  const now = Timestamp.now();

  const lastSubmitted = await getDocs(
    query(
      collection(firestore, "stage_attempts"),
      where("userId", "==", uid),
      where("subjectId", "==", subjectId),
      where("status", "==", "submitted"),
      orderBy("submittedAt", "desc"),
      limit(1),
    ),
  );

  const lastSubmittedData = lastSubmitted.empty ? null : lastSubmitted.docs[0].data();
  if (lastSubmittedData && !lastSubmittedData.feedbackSeenAt) {
    return { feedbackRequired: true, attemptId: lastSubmitted.docs[0].id };
  }

  const nextAvailableAt = toMillis(enrollment.data.nextAvailableAt);
  if (nextAvailableAt !== null && nextAvailableAt > now.toMillis()) {
    return {
      locked: true,
      nextAvailableAt,
      sessionNo: Number(enrollment.data.sessionNo ?? 1),
      stagesInSession: Number(enrollment.data.stagesInSession ?? 0),
    };
  }

  // A configurable pause can run between stages as well as between sessions.
  // It starts when the student confirms they have reviewed the model answers,
  // so it does not punish a student who leaves the results page open.
  const lastFeedbackSeenAt = toMillis(lastSubmittedData?.feedbackSeenAt);
  if (adaptive.stageIntervalMinutes > 0 && lastFeedbackSeenAt !== null) {
    const stageAvailableAt =
      lastFeedbackSeenAt + adaptive.stageIntervalMinutes * 60 * 1000;
    if (stageAvailableAt > now.toMillis()) {
      return {
        locked: true,
        stageLocked: true,
        nextAvailableAt: stageAvailableAt,
        sessionNo: Number(enrollment.data.sessionNo ?? 1),
        stagesInSession: Number(enrollment.data.stagesInSession ?? 0),
      };
    }
  }

  const inProgress = await getDocs(
    query(
      collection(firestore, "stage_attempts"),
      where("userId", "==", uid),
      where("subjectId", "==", subjectId),
      where("status", "==", "in_progress"),
      orderBy("startedAt", "desc"),
      limit(1),
    ),
  );

  if (!inProgress.empty) {
    const attempt = inProgress.docs[0];
    return buildStagePayload(attempt.id, attempt.data(), settings, true);
  }

  const globalLocked = Boolean(globalSettings.stagesLocked || settings.stagesLocked);
  if (globalLocked) {
    return {
      locked: true,
      adminLocked: true,
      nextAvailableAt: 0,
      lockMessage:
        globalSettings.lockMessage ||
        settings.lockMessage ||
        "أوقفت الإدارة فتح مراحل جديدة حاليًا. يمكنك مراجعة نتائجك السابقة والعودة لاحقًا.",
      sessionNo: Number(enrollment.data.sessionNo ?? 1),
      stagesInSession: Number(enrollment.data.stagesInSession ?? 0),
    };
  }

  const totalQuestions = Number(enrollment.data.totalQuestions ?? 0);
  const target = masteryTarget(enrollment.data, settings);
  if (
    totalQuestions > 0 &&
    Number(enrollment.data.coverageCount ?? 0) >= totalQuestions &&
    Number(enrollment.data.masteryCount ?? 0) >= target
  ) {
    return {
      completed: true,
      totalQuestions,
      coverageCount: Number(enrollment.data.coverageCount ?? 0),
      masteryCount: Number(enrollment.data.masteryCount ?? 0),
      masteryTarget: target,
    };
  }

  const stageNo = Number(enrollment.data.stagesCompleted ?? 0) + 1;
  const sessionNo = Number(enrollment.data.sessionNo ?? 1);
  const migratingToAdaptive = adaptive.enabled && adaptive.migrated;
  const stageInSession = migratingToAdaptive
    ? 1
    : Number(enrollment.data.stagesInSession ?? 0) + 1;

  const dailyQuestionCap = adaptive.enabled
    ? Math.max(0, Math.floor(Number(settings.adaptiveDailyQuestionCap) || 0))
    : 0;
  const todayKey = localDateKey(now.toDate());
  const dailyQuestionCount =
    enrollment.data.dailyQuestionDate === todayKey
      ? Math.max(0, Number(enrollment.data.dailyQuestionCount ?? 0))
      : 0;
  if (dailyQuestionCap > 0 && dailyQuestionCount >= dailyQuestionCap) {
    return {
      locked: true,
      dailyCapLocked: true,
      nextAvailableAt: nextLocalMidnight(now.toDate()),
      lockMessage: `وصلت إلى سقف اليوم: ${dailyQuestionCap} سؤالًا. سيعود السقف للصفر بعد منتصف الليل، وننصحك بالراحة الآن.`,
      sessionNo,
      stagesInSession: Number(enrollment.data.stagesInSession ?? 0),
    };
  }

  // The adaptive plan stores the next stage mix after every submitted stage.
  // The manual mode keeps the older recovery split for compatibility.
  const lastScore = Number(lastSubmittedData?.score);
  const failedLast =
    lastSubmittedData !== null &&
    Number.isFinite(lastScore) &&
    lastScore < adaptive.passThreshold;
  const plannedNew = adaptive.enabled
    ? adaptive.newPerStage
    : failedLast
      ? settings.failedNewPerStage
      : settings.newPerStage;
  const plannedReview = adaptive.enabled
    ? adaptive.reviewPerStage
    : failedLast
      ? settings.failedReviewPerStage
      : settings.reviewPerStage;
  let newCount = plannedNew;
  let reviewCount = plannedReview;
  let stageSize = Math.max(1, Math.min(20, newCount + reviewCount));
  if (dailyQuestionCap > 0) {
    const remainingToday = dailyQuestionCap - dailyQuestionCount;
    if (remainingToday < stageSize) {
      stageSize = Math.max(1, remainingToday);
      newCount = Math.min(newCount, stageSize);
      reviewCount = Math.max(0, stageSize - newCount);
    }
  }
  const sessionStagesTarget = adaptive.sessionStages;
  const stageIntervalMinutes = adaptive.stageIntervalMinutes;

  const selected = await selectQuestions(
    uid,
    subjectId,
    enrollment.data,
    newCount,
    reviewCount,
    stageSize,
  );
  if (selected.length === 0) {
    throw appError("NO_QUESTIONS_AVAILABLE", "failed-precondition");
  }

  const attemptId = `${uid}_${subjectId}_${stageNo}`;
  const attemptRef = doc(firestore, "stage_attempts", attemptId);
  const existingAttempt = await getDoc(attemptRef);
  if (existingAttempt.exists()) {
    const attempt = existingAttempt.data();
    if (attempt.status === "submitted") {
      return {
        attemptId,
        alreadySubmitted: true,
        feedbackSeen: Boolean(attempt.feedbackSeenAt),
      };
    }
    return buildStagePayload(attemptId, attempt, settings, true);
  }

  const nextQuestionIndex = selected
    .filter((question) => !question.isReview)
    .reduce(
      (max, question) => Math.max(max, question.orderIndex + 1),
      Number(enrollment.data.nextQuestionIndex ?? 0),
    );

  const enrollmentRef = doc(firestore, "enrollments", enrollmentId(uid, subjectId));

  try {
    await runTransaction(firestore, async (tx) => {
      const current = await tx.get(enrollmentRef);
      if (!current.exists()) throw appError("ENROLLMENT_NOT_FOUND", "not-found");
      const enrollmentData = current.data();
      const currentStageNo = Number(enrollmentData.stagesCompleted ?? 0) + 1;
      if (currentStageNo !== stageNo) throw appError("STAGE_RACE", "aborted");

      // A second tab may have created the same stage after the pre-check above.
      // Never overwrite its questions or reset its timer.
      const currentAttempt = await tx.get(attemptRef);
      if (currentAttempt.exists()) throw appError("STAGE_RACE", "aborted");

      tx.set(attemptRef, {
        userId: uid,
        subjectId,
        stageNo,
        sessionNo,
        stageInSession,
        sessionStagesTarget,
        stageIntervalMinutes,
        status: "in_progress",
        items: selected.map((question, index) => ({
          questionId: question.id,
          position: index + 1,
          isReview: question.isReview,
        })),
        startedAt: serverTimestamp(),
        submittedAt: null,
        feedbackSeenAt: null,
        answers: [],
        score: null,
        adaptiveLevel: adaptive.level,
        adaptiveStageNew: plannedNew,
        adaptiveStageReview: plannedReview,
      });
      tx.update(enrollmentRef, {
        nextQuestionIndex,
        sessionStages: sessionStagesTarget,
        ...(adaptive.enabled
          ? {
              adaptiveLevel: adaptive.level,
              adaptiveStageNew: plannedNew,
              adaptiveStageReview: plannedReview,
              adaptiveStageInterval: stageIntervalMinutes,
              adaptiveStrongSessions: adaptive.strongSessions,
              ...(migratingToAdaptive
                ? {
                    adaptiveSessionScoreSum: 0,
                    adaptiveSessionScoreCount: 0,
                    adaptiveSessionMinScore: null,
                    adaptiveSessionReviewCorrect: 0,
                    adaptiveSessionReviewTotal: 0,
                  }
                : {}),
            }
          : {}),
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "aborted") {
      const raced = await getDoc(attemptRef);
      if (raced.exists()) {
        const attempt = raced.data();
        if (attempt.status === "submitted") {
          return {
            attemptId,
            alreadySubmitted: true,
            feedbackSeen: Boolean(attempt.feedbackSeenAt),
          };
        }
        return buildStagePayload(attemptId, attempt, settings, true);
      }
    }
    throw error;
  }

  const created = await getDoc(attemptRef);
  return buildStagePayload(attemptId, created.data() ?? {}, settings, false);
}

async function submitStage(
  attemptId: string,
  answers: unknown[],
): Promise<SubmitStageResponse> {
  const uid = currentUser().uid;
  const firestore = database();
  const attemptRef = doc(firestore, "stage_attempts", attemptId);
  const attemptSnap = await getDoc(attemptRef);
  if (!attemptSnap.exists()) throw appError("ATTEMPT_NOT_FOUND", "not-found");
  const attempt = attemptSnap.data();
  if (attempt.userId !== uid) throw appError("ATTEMPT_NOT_OWNED", "permission-denied");
  if (attempt.status !== "in_progress") {
    throw appError("ATTEMPT_ALREADY_SUBMITTED", "failed-precondition");
  }

  const subjectId = String(attempt.subjectId);
  const settings = await getSettings(subjectId);
  const items = (attempt.items ?? []) as StageItem[];
  if (items.length === 0) throw appError("ATTEMPT_EMPTY", "failed-precondition");

  const answerList = Array.isArray(answers) ? (answers as AnswerInput[]) : [];
  const answersByQuestion = new Map(
    answerList.map((answer) => [String(answer.questionId), answer]),
  );

  const questionSnaps = await Promise.all(
    items.map((item) => getDoc(doc(firestore, "questions", item.questionId))),
  );

  const questions = new Map(
    questionSnaps.map((snap) => [
      snap.id,
      (snap.exists() ? { id: snap.id, ...snap.data() } : null) as QuestionPublic | null,
    ]),
  );

  // New Spark imports embed the answer key in the question document. Older
  // demo/imported questions still use the separate question_answers collection,
  // so fall back only for those questions.
  const privateData = new Map<string, QuestionPrivate | null>();
  const missingAnswerIds: string[] = [];
  for (const item of items) {
    const question = questions.get(item.questionId);
    if (question?.grading) {
      privateData.set(item.questionId, {
        grading: question.grading,
        correct: question.correct,
        modelAnswer: question.modelAnswer,
        explanation: question.explanation ?? null,
      });
    } else {
      missingAnswerIds.push(item.questionId);
    }
  }
  const privateSnaps = await Promise.all(
    missingAnswerIds.map((questionId) =>
      getDoc(doc(firestore, "question_answers", questionId)),
    ),
  );
  privateSnaps.forEach((snap, index) => {
    privateData.set(
      missingAnswerIds[index],
      (snap.exists() ? snap.data() : null) as QuestionPrivate | null,
    );
  });

  const graded: GradedAnswer[] = items.map((item) => {
    const question = questions.get(item.questionId);
    const secret = privateData.get(item.questionId);
    if (!question || !secret) {
      throw appError("QUESTION_NOT_FOUND", "failed-precondition");
    }
    const input = answersByQuestion.get(item.questionId);
    const result = gradeAnswer(question, secret, input);
    const isSelf = secret.grading === "self";
    return {
      questionId: item.questionId,
      answer: input?.answer,
      selfScore: isSelf ? undefined : result.selfScore,
      timeMs: input?.timeMs,
      isCorrect: isSelf ? null : result.isCorrect,
      grading: secret.grading,
      modelAnswer: secret.modelAnswer,
      explanation: secret.explanation ?? null,
      text: question.text,
      type: question.type,
      options: question.options ?? null,
    };
  });

  const unitIds = [
    ...new Set(
      items
        .map((item) => questions.get(item.questionId)?.unitId)
        .filter((unitId): unitId is string => Boolean(unitId)),
    ),
  ];
  const unitTotals = await getUnitTotals(subjectId, unitIds);
  const now = Timestamp.now();
  const stageIntervalMinutes = Math.max(
    0,
    Number(attempt.stageIntervalMinutes ?? settings.stageIntervalMinutes) || 0,
  );
  const autoGraded = graded.filter(
    (answer) => answer.grading === "auto" && answer.isCorrect !== null,
  );
  const stageAutoScore = autoGraded.length
    ? Math.round(
        (autoGraded.filter((answer) => answer.isCorrect === true).length /
          autoGraded.length) *
          100,
      )
    : null;
  const reviewAuto = items
    .map((item, index) => ({ item, answer: graded[index] }))
    .filter(
      ({ item, answer }) =>
        item.isReview && answer.grading === "auto" && answer.isCorrect !== null,
    );
  const reviewCorrectDelta = reviewAuto.filter(
    ({ answer }) => answer.isCorrect === true,
  ).length;
  const reviewTotalDelta = reviewAuto.length;
  const legacyScore = Math.round(
    (graded.filter((answer) => answer.isCorrect === true).length /
      Math.max(1, graded.length)) *
      100,
  );

  const enrollmentRef = doc(firestore, "enrollments", enrollmentId(uid, subjectId));
  const progressRefs = items.map((item) => doc(firestore, "progress", `${uid}_${item.questionId}`));
  const unitProgressRefs = unitIds.map((unitId) =>
    doc(firestore, "unit_progress", unitProgressId(uid, subjectId, unitId)),
  );

  let coverageCount = 0;
  let masteryCount = 0;
  let totalQuestions = 0;
  let masteryTargetValue = 0;
  let sessionComplete = false;
  let nextAvailableAt: Timestamp | null = null;
  let adaptiveLevelAfter = Number(attempt.adaptiveLevel ?? settings.adaptiveInitialLevel);
  let adaptiveLevelNameValue = getAdaptiveLevel(settings, adaptiveLevelAfter).name;
  let adaptiveLevelChanged: "up" | "down" | null = null;
  let nextStageNewValue = Number(attempt.adaptiveStageNew ?? 0);
  let nextStageReviewValue = Number(attempt.adaptiveStageReview ?? 0);
  let nextStageIntervalValue = stageIntervalMinutes;

  await runTransaction(firestore, async (tx) => {
    const currentAttempt = await tx.get(attemptRef);
    if (!currentAttempt.exists()) throw appError("ATTEMPT_NOT_FOUND", "not-found");
    const currentAttemptData = currentAttempt.data();
    if (currentAttemptData.userId !== uid) {
      throw appError("ATTEMPT_NOT_OWNED", "permission-denied");
    }
    if (currentAttemptData.status !== "in_progress") {
      throw appError("ATTEMPT_ALREADY_SUBMITTED", "failed-precondition");
    }

    const enrollmentSnap = await tx.get(enrollmentRef);
    if (!enrollmentSnap.exists()) throw appError("ENROLLMENT_NOT_FOUND", "not-found");
    const enrollment = enrollmentSnap.data();
    const adaptive = adaptivePlanState(enrollment, settings);
    const todayKey = localDateKey(now.toDate());
    const currentDailyQuestionCount =
      enrollment.dailyQuestionDate === todayKey
        ? Math.max(0, Number(enrollment.dailyQuestionCount ?? 0))
        : 0;
    const nextDailyQuestionCount = currentDailyQuestionCount + items.length;
    const sessionStagesTarget = Number(
      currentAttemptData.sessionStagesTarget ??
        enrollment.sessionStages ??
        adaptive.sessionStages,
    );
    sessionComplete =
      Number(currentAttemptData.stageInSession ?? 1) >= Math.max(1, sessionStagesTarget);

    let nextAdaptiveLevel = adaptive.level;
    let nextAdaptiveLevelName = adaptive.levelName;
    let nextAdaptiveStrong = adaptive.strongSessions;
    let nextAdaptiveNew = adaptive.newPerStage;
    let nextAdaptiveReview = adaptive.reviewPerStage;
    let nextAdaptiveStageInterval = adaptive.stageIntervalMinutes;
    let nextAdaptiveSessionStages = adaptive.sessionStages;
    let nextAdaptiveSessionInterval = adaptive.intervalMinutes;
    let nextAdaptiveReason = String(enrollment.adaptiveLevelReason ?? "");
    let nextSessionScoreSum = Number(enrollment.adaptiveSessionScoreSum ?? 0);
    let nextSessionScoreCount = Number(enrollment.adaptiveSessionScoreCount ?? 0);
    let nextSessionMinScore =
      enrollment.adaptiveSessionMinScore === null ||
      enrollment.adaptiveSessionMinScore === undefined
        ? null
        : Number(enrollment.adaptiveSessionMinScore);
    let nextSessionReviewCorrect = Number(
      enrollment.adaptiveSessionReviewCorrect ?? 0,
    );
    let nextSessionReviewTotal = Number(enrollment.adaptiveSessionReviewTotal ?? 0);
    let levelChange: "up" | "down" | null = null;

    if (adaptive.enabled) {
      const scoreSum = nextSessionScoreSum + (stageAutoScore ?? 0);
      const scoreCount = nextSessionScoreCount + (stageAutoScore === null ? 0 : 1);
      const minScore =
        stageAutoScore === null
          ? nextSessionMinScore
          : nextSessionMinScore === null
            ? stageAutoScore
            : Math.min(nextSessionMinScore, stageAutoScore);
      const reviewCorrect = nextSessionReviewCorrect + reviewCorrectDelta;
      const reviewTotal = nextSessionReviewTotal + reviewTotalDelta;

      if (sessionComplete) {
        const sessionScore =
          scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null;
        const reviewAccuracy =
          reviewTotal > 0 ? Math.round((reviewCorrect / reviewTotal) * 100) : 100;
        const strong =
          sessionScore !== null &&
          sessionScore >= settings.adaptiveUpThreshold &&
          (minScore === null || minScore >= settings.adaptiveMinStageScore) &&
          reviewAccuracy >= settings.adaptiveMinReviewAccuracy;
        const weak =
          sessionScore !== null &&
          (sessionScore < settings.adaptiveDownThreshold ||
            (minScore !== null && minScore < settings.adaptiveCriticalStageScore));

        if (strong) {
          const streak = adaptive.strongSessions + 1;
          if (streak >= settings.adaptiveStrongSessions) {
            const maxLevel = Math.max(0, settings.adaptiveLevels.length - 1);
            nextAdaptiveLevel = Math.min(maxLevel, adaptive.level + 1);
            if (nextAdaptiveLevel > adaptive.level) {
              levelChange = "up";
              nextAdaptiveLevelName = getAdaptiveLevel(settings, nextAdaptiveLevel).name;
              nextAdaptiveReason = `ترقيت إلى مستوى «${nextAdaptiveLevelName}» بعد أداء مرتفع في ${settings.adaptiveStrongSessions} جلسات متتالية.`;
            } else {
              nextAdaptiveLevelName = adaptive.levelName;
              nextAdaptiveReason =
                "أنت في أعلى مستوى في الخطة، واصل المحافظة على الإتقان.";
            }
            nextAdaptiveStrong = 0;
          } else {
            nextAdaptiveStrong = streak;
            nextAdaptiveLevelName = adaptive.levelName;
            nextAdaptiveReason = `أداء مرتفع. تحتاج ${settings.adaptiveStrongSessions - streak} جلسة أخرى للترقي.`;
          }
        } else if (weak) {
          nextAdaptiveLevel = Math.max(0, adaptive.level - 1);
          if (nextAdaptiveLevel < adaptive.level) {
            levelChange = "down";
            nextAdaptiveLevelName = getAdaptiveLevel(settings, nextAdaptiveLevel).name;
            nextAdaptiveReason = `عدنا بك إلى مستوى «${nextAdaptiveLevelName}» بعد تعثر الجلسة الأخيرة.`;
          } else {
            nextAdaptiveLevelName = adaptive.levelName;
            nextAdaptiveReason =
              "أنت في مستوى التأسيس، وسنزيد المراجعة في الجلسة القادمة.";
          }
          nextAdaptiveStrong = 0;
        } else {
          nextAdaptiveStrong = 0;
          nextAdaptiveLevelName = adaptive.levelName;
          nextAdaptiveReason =
            "حافظت على مستواك. ستواصل الخطة بنفس الإيقاع.";
        }

        const nextLevelSettings = getAdaptiveLevel(settings, nextAdaptiveLevel);
        nextAdaptiveNew = nextLevelSettings.newPerStage;
        nextAdaptiveReview = nextLevelSettings.reviewPerStage;
        nextAdaptiveStageInterval = nextLevelSettings.stageIntervalMinutes;
        nextAdaptiveSessionStages = nextLevelSettings.sessionStages;
        nextAdaptiveSessionInterval = nextLevelSettings.intervalMinutes;
        nextAvailableAt = Timestamp.fromMillis(
          now.toMillis() + nextAdaptiveSessionInterval * 60 * 1000,
        );
        nextSessionScoreSum = 0;
        nextSessionScoreCount = 0;
        nextSessionMinScore = null;
        nextSessionReviewCorrect = 0;
        nextSessionReviewTotal = 0;
      } else {
        nextSessionScoreSum = scoreSum;
        nextSessionScoreCount = scoreCount;
        nextSessionMinScore = minScore;
        nextSessionReviewCorrect = reviewCorrect;
        nextSessionReviewTotal = reviewTotal;
        nextAdaptiveNew = adaptive.newPerStage;
        nextAdaptiveReview = adaptive.reviewPerStage;
        nextAdaptiveStageInterval = adaptive.stageIntervalMinutes;

        if (stageAutoScore !== null) {
          const maxNew = Math.max(0, adaptive.stageSize - 1);
          if (stageAutoScore >= 90) {
            nextAdaptiveNew = Math.min(maxNew, nextAdaptiveNew + 1);
            nextAdaptiveStageInterval = Math.max(
              0,
              nextAdaptiveStageInterval - 1,
            );
          } else if (stageAutoScore >= 75) {
            // 75–89%: hold the mix and the pause as they are.
          } else if (stageAutoScore >= 60) {
            nextAdaptiveNew = Math.max(0, nextAdaptiveNew - 1);
            nextAdaptiveStageInterval = Math.min(
              60,
              nextAdaptiveStageInterval + 1,
            );
          } else {
            nextAdaptiveNew = Math.max(0, nextAdaptiveNew - 1);
            nextAdaptiveStageInterval = Math.min(
              60,
              nextAdaptiveStageInterval + 2,
            );
          }
          nextAdaptiveReview = Math.max(0, adaptive.stageSize - nextAdaptiveNew);
        }
      }
    } else {
      if (sessionComplete) {
        nextAvailableAt = Timestamp.fromMillis(
          now.toMillis() + settings.intervalMinutes * 60 * 1000,
        );
      }
      const legacyFailed = legacyScore < settings.passThreshold;
      nextAdaptiveNew = legacyFailed
        ? settings.failedNewPerStage
        : settings.newPerStage;
      nextAdaptiveReview = legacyFailed
        ? settings.failedReviewPerStage
        : settings.reviewPerStage;
    }

    const adaptiveLevelForWrite = adaptive.enabled ? nextAdaptiveLevel : adaptive.level;
    adaptiveLevelAfter = adaptiveLevelForWrite;
    adaptiveLevelNameValue = adaptive.enabled
      ? nextAdaptiveLevelName
      : adaptive.levelName;
    adaptiveLevelChanged = levelChange;
    nextStageNewValue = nextAdaptiveNew;
    nextStageReviewValue = nextAdaptiveReview;
    nextStageIntervalValue = nextAdaptiveStageInterval;

    const progressSnaps = await Promise.all(progressRefs.map((ref) => tx.get(ref)));
    const unitProgressSnaps = await Promise.all(unitProgressRefs.map((ref) => tx.get(ref)));
    const unitProgressByUnit = new Map(
      unitIds.map((unitId, index) => [unitId, unitProgressSnaps[index]]),
    );

    let coverageDelta = 0;
    let masteryDelta = 0;
    let autoFirstDelta = 0;
    const unitDeltas = new Map<
      string,
      { seen: number; mastered: number; total: number; title: string }
    >();

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const result = graded[index];
      const question = questions.get(item.questionId)!;
      const secret = privateData.get(item.questionId)!;
      const isSelfPending = secret.grading === "self";
      const isCorrect = !isSelfPending && result.isCorrect === true;
      const isWrong = !isSelfPending && result.isCorrect === false;

      const progressSnap = progressSnaps[index];
      const old = progressSnap.exists() ? progressSnap.data() : null;
      const oldSeen = Number(old?.seenCount ?? 0);
      const oldCorrect = Number(old?.correctCount ?? 0);
      const oldMastery = Number(old?.masteryLevel ?? 0);
      const oldNextReviewAt = (old?.nextReviewAt as Timestamp | undefined) ?? null;

      const firstSeen = oldSeen === 0;
      const firstCorrect = isCorrect && oldCorrect === 0;
      const nextLevel = computeMasteryLevel(oldMastery, isCorrect, oldNextReviewAt, now);
      const nextReviewAt = computeNextReviewAt(
        isCorrect,
        oldMastery,
        now,
        settings.intervalMinutes,
        settings.wrongIntervalMinutes,
      );
      const firstAttemptCorrect = old ? Boolean(old.firstAttemptCorrect) : isCorrect;

      if (firstSeen) coverageDelta += 1;
      if (firstCorrect) masteryDelta += 1;
      if (!old && isCorrect && secret.grading === "auto") autoFirstDelta += 1;

      tx.set(progressRefs[index], {
        userId: uid,
        enrollmentId: enrollmentRef.id,
        subjectId,
        questionId: item.questionId,
        unitId: question.unitId,
        orderIndex: Number(question.orderIndex ?? 0),
        seenCount: oldSeen + 1,
        correctCount: oldCorrect + (isCorrect ? 1 : 0),
        wrongCount: Number(old?.wrongCount ?? 0) + (isWrong ? 1 : 0),
        firstAttemptCorrect,
        mastered: isCorrect || Boolean(old?.mastered),
        pendingSelfGrade: isSelfPending,
        selfScore: isSelfPending ? null : (result.selfScore ?? null),
        isCorrect: isSelfPending ? null : result.isCorrect,
        masteryLevel: nextLevel,
        lastSeenAt: now,
        nextReviewAt,
      });

      const unitId = question.unitId;
      if (!unitId) continue;
      const unitProgressSnap = unitProgressByUnit.get(unitId);
      const oldUnit = unitProgressSnap?.exists() ? unitProgressSnap.data() : null;
      const totalInfo = unitTotals.get(unitId);
      const unitDelta = unitDeltas.get(unitId) ?? {
        seen: 0,
        mastered: 0,
        total: Number(oldUnit?.total ?? totalInfo?.total ?? 0),
        title: String(oldUnit?.title ?? totalInfo?.title ?? ""),
      };
      if (firstSeen) unitDelta.seen += 1;
      if (firstCorrect) unitDelta.mastered += 1;
      unitDeltas.set(unitId, unitDelta);
    }

    for (const [unitId, delta] of unitDeltas) {
      const snap = unitProgressByUnit.get(unitId);
      const old = snap?.exists() ? snap.data() : null;
      tx.set(
        doc(firestore, "unit_progress", unitProgressId(uid, subjectId, unitId)),
        {
          userId: uid,
          subjectId,
          unitId,
          title: delta.title || String(old?.title ?? ""),
          total: Number(old?.total ?? delta.total ?? 0),
          seen: Number(old?.seen ?? 0) + delta.seen,
          mastered: Number(old?.mastered ?? 0) + delta.mastered,
        },
        { merge: true },
      );
    }

    totalQuestions = Number(enrollment.totalQuestions ?? 0);
    masteryTargetValue = masteryTarget(enrollment, settings);
    coverageCount = Number(enrollment.coverageCount ?? 0) + coverageDelta;
    masteryCount = Number(enrollment.masteryCount ?? 0) + masteryDelta;
    const autoFirstCorrect = Number(enrollment.autoFirstCorrect ?? 0) + autoFirstDelta;
    const completedAt =
      totalQuestions > 0 && coverageCount >= totalQuestions && masteryCount >= masteryTargetValue
        ? (enrollment.completedAt ?? now)
        : (enrollment.completedAt ?? null);
    const masteryCompletedAt =
      totalQuestions > 0 && masteryCount >= totalQuestions
        ? (enrollment.masteryCompletedAt ?? now)
        : (enrollment.masteryCompletedAt ?? null);

    tx.update(enrollmentRef, {
      coverageCount,
      masteryCount,
      masteryTarget: masteryTargetValue,
      sessionStages: nextAdaptiveSessionStages,
      dailyQuestionDate: todayKey,
      dailyQuestionCount: nextDailyQuestionCount,
      autoFirstCorrect,
      stagesCompleted: Number(enrollment.stagesCompleted ?? 0) + 1,
      stagesInSession: sessionComplete ? 0 : Number(currentAttemptData.stageInSession ?? 1),
      sessionNo: sessionComplete
        ? Number(enrollment.sessionNo ?? 1) + 1
        : Number(enrollment.sessionNo ?? 1),
      completedAt,
      masteryCompletedAt,
      ...(adaptive.enabled
        ? {
            adaptiveLevel: adaptiveLevelForWrite,
            adaptiveStrongSessions: nextAdaptiveStrong,
            adaptiveStageNew: nextAdaptiveNew,
            adaptiveStageReview: nextAdaptiveReview,
            adaptiveStageInterval: nextAdaptiveStageInterval,
            adaptiveSessionScoreSum: nextSessionScoreSum,
            adaptiveSessionScoreCount: nextSessionScoreCount,
            adaptiveSessionMinScore: nextSessionMinScore,
            adaptiveSessionReviewCorrect: nextSessionReviewCorrect,
            adaptiveSessionReviewTotal: nextSessionReviewTotal,
            adaptiveLevelReason: nextAdaptiveReason,
          }
        : {}),
      ...(sessionComplete && nextAvailableAt ? { nextAvailableAt } : {}),
    });

    const correctCount = graded.filter((answer) => answer.isCorrect === true).length;
    tx.update(attemptRef, {
      status: "submitted",
      submittedAt: now,
      score: Math.round((correctCount / Math.max(1, graded.length)) * 100),
      answers: graded.map((answer) => ({
        questionId: answer.questionId,
        answer: answer.answer ?? null,
        selfScore: answer.selfScore ?? null,
        timeMs: answer.timeMs ?? null,
        isCorrect: answer.isCorrect,
        grading: answer.grading,
        modelAnswer: answer.modelAnswer ?? null,
        explanation: answer.explanation,
        text: answer.text,
        type: answer.type,
        options: answer.options ?? null,
      })),
      adaptiveLevelAfter: adaptiveLevelForWrite,
      adaptiveLevelChange: levelChange,
      nextStageNew: nextAdaptiveNew,
      nextStageReview: nextAdaptiveReview,
      nextStageIntervalMinutes: nextAdaptiveStageInterval,
    });
  });

  const correctCount = graded.filter((answer) => answer.isCorrect === true).length;
  return {
    attemptId,
    score: Math.round((correctCount / Math.max(1, graded.length)) * 100),
    results: graded,
    sessionComplete,
    nextAvailableAt: toMillis(nextAvailableAt),
    stageIntervalMinutes,
    totalQuestions,
    coverageCount,
    masteryCount,
    masteryTarget: masteryTargetValue,
    adaptiveLevel: adaptiveLevelAfter,
    adaptiveLevelName: adaptiveLevelNameValue,
    adaptiveLevelChanged,
    nextStageNew: nextStageNewValue,
    nextStageReview: nextStageReviewValue,
    nextStageIntervalMinutes: nextStageIntervalValue,
  };
}

async function selfGradeQuestion(
  attemptId: string,
  questionId: string,
  selfScore: "correct" | "partial" | "wrong",
) {
  const uid = currentUser().uid;
  const firestore = database();
  if (!["correct", "partial", "wrong"].includes(selfScore)) {
    throw appError("SELF_SCORE_INVALID", "invalid-argument");
  }

  const attemptRef = doc(firestore, "stage_attempts", attemptId);
  const attemptSnap = await getDoc(attemptRef);
  if (!attemptSnap.exists()) throw appError("ATTEMPT_NOT_FOUND", "not-found");
  const attempt = attemptSnap.data();
  if (attempt.userId !== uid) throw appError("ATTEMPT_NOT_OWNED", "permission-denied");
  if (attempt.status !== "submitted") {
    throw appError("ATTEMPT_NOT_SUBMITTED", "failed-precondition");
  }

  const subjectId = String(attempt.subjectId);
  const settings = await getSettings(subjectId);
  const progressRef = doc(firestore, "progress", `${uid}_${questionId}`);
  const progressSnap = await getDoc(progressRef);
  if (!progressSnap.exists()) throw appError("PROGRESS_NOT_FOUND", "not-found");
  const progress = progressSnap.data();
  if (progress.subjectId !== subjectId || !progress.pendingSelfGrade) {
    throw appError("SELF_GRADE_NOT_PENDING", "failed-precondition");
  }

  const unitId = String(progress.unitId);
  const unitTotalSnap = await getDoc(
    doc(firestore, "unit_totals", `${subjectId}_${unitId}`),
  );
  const unitTotal = unitTotalSnap.data() ?? {};
  const enrollmentRef = doc(firestore, "enrollments", enrollmentId(uid, subjectId));
  const unitProgressRef = doc(
    firestore,
    "unit_progress",
    unitProgressId(uid, subjectId, unitId),
  );
  const now = Timestamp.now();
  const isCorrect = selfScore === "correct";

  let coverageCount = 0;
  let masteryCount = 0;
  let totalQuestions = 0;
  let target = 0;
  let completed = false;

  await runTransaction(firestore, async (tx) => {
    const currentAttempt = await tx.get(attemptRef);
    if (!currentAttempt.exists()) throw appError("ATTEMPT_NOT_FOUND", "not-found");
    const currentAttemptData = currentAttempt.data();
    if (currentAttemptData.userId !== uid) {
      throw appError("ATTEMPT_NOT_OWNED", "permission-denied");
    }
    if (currentAttemptData.status !== "submitted") {
      throw appError("ATTEMPT_NOT_SUBMITTED", "failed-precondition");
    }

    const currentProgress = await tx.get(progressRef);
    if (!currentProgress.exists()) throw appError("PROGRESS_NOT_FOUND", "not-found");
    const current = currentProgress.data();
    if (!current.pendingSelfGrade) {
      throw appError("SELF_GRADE_NOT_PENDING", "failed-precondition");
    }

    const enrollmentSnap = await tx.get(enrollmentRef);
    if (!enrollmentSnap.exists()) throw appError("ENROLLMENT_NOT_FOUND", "not-found");
    const enrollment = enrollmentSnap.data();
    const adaptive = adaptivePlanState(enrollment, settings);
    const unitProgressSnap = await tx.get(unitProgressRef);
    const oldUnit = unitProgressSnap.exists() ? unitProgressSnap.data() : null;

    const alreadyMastered = Boolean(current.mastered);
    const masteryDelta = isCorrect && !alreadyMastered ? 1 : 0;
    const oldMastery = Number(current.masteryLevel ?? 0);
    const nextLevel = isCorrect ? Math.min(3, Math.max(1, oldMastery + 1)) : oldMastery;
    const nextReviewAt = computeNextReviewAt(
      isCorrect,
      oldMastery,
      now,
      settings.intervalMinutes,
      settings.wrongIntervalMinutes,
    );

    tx.update(progressRef, {
      pendingSelfGrade: false,
      selfScore,
      isCorrect,
      correctCount: Number(current.correctCount ?? 0) + (isCorrect ? 1 : 0),
      wrongCount:
        Number(current.wrongCount ?? 0) + (isCorrect || selfScore === "partial" ? 0 : 1),
      mastered: isCorrect ? true : alreadyMastered,
      firstAttemptCorrect: Boolean(current.firstAttemptCorrect) || isCorrect,
      masteryLevel: nextLevel,
      nextReviewAt,
    });

    const oldAnswers = (currentAttemptData.answers ?? []) as Array<Record<string, unknown>>;
    const updatedAnswers = oldAnswers.map((answer) =>
      answer.questionId === questionId
        ? { ...answer, selfScore, isCorrect, gradedAt: now }
        : answer,
    );
    const correctAfterSelfGrade = updatedAnswers.filter(
      (answer) => answer.isCorrect === true,
    ).length;
    tx.update(attemptRef, {
      answers: updatedAnswers,
      // The submit step can only grade objective questions. Recompute the
      // stage score after self-grading so a student is not marked as failed
      // merely because short answers were pending review.
      score: Math.round((correctAfterSelfGrade / Math.max(1, updatedAnswers.length)) * 100),
    });

    if (masteryDelta > 0) {
      tx.set(
        unitProgressRef,
        {
          userId: uid,
          subjectId,
          unitId,
          title: String(oldUnit?.title ?? unitTotal.title ?? ""),
          total: Number(oldUnit?.total ?? unitTotal.total ?? 0),
          seen: Number(oldUnit?.seen ?? 0),
          mastered: Number(oldUnit?.mastered ?? 0) + 1,
        },
        { merge: true },
      );
    }

    totalQuestions = Number(enrollment.totalQuestions ?? 0);
    target = masteryTarget(enrollment, settings);
    coverageCount = Number(enrollment.coverageCount ?? 0);
    masteryCount = Number(enrollment.masteryCount ?? 0) + masteryDelta;
    completed =
      totalQuestions > 0 && coverageCount >= totalQuestions && masteryCount >= target;

    const completedAt = completed
      ? (enrollment.completedAt ?? now)
      : (enrollment.completedAt ?? null);
    const masteryCompletedAt =
      totalQuestions > 0 && masteryCount >= totalQuestions
        ? (enrollment.masteryCompletedAt ?? now)
        : (enrollment.masteryCompletedAt ?? null);
    tx.update(enrollmentRef, {
      masteryCount,
      masteryTarget: target,
      ...(adaptive.enabled ? {} : { sessionStages: settings.sessionStages }),
      completedAt,
      masteryCompletedAt,
    });
  });

  return {
    ok: true,
    questionId,
    selfScore,
    isCorrect,
    totalQuestions,
    coverageCount,
    masteryCount,
    masteryTarget: target,
    completed,
  };
}

async function getStageResult(attemptId: string): Promise<StageResultResponse> {
  const uid = currentUser().uid;
  const firestore = database();
  const attemptSnap = await getDoc(doc(firestore, "stage_attempts", attemptId));
  if (!attemptSnap.exists()) throw appError("ATTEMPT_NOT_FOUND", "not-found");
  const attempt = attemptSnap.data();
  if (attempt.userId !== uid) throw appError("ATTEMPT_NOT_OWNED", "permission-denied");
  if (attempt.status !== "submitted") {
    throw appError("ATTEMPT_NOT_SUBMITTED", "failed-precondition");
  }

  const subjectId = String(attempt.subjectId);
  const settings = await getSettings(subjectId);
  const enrollmentSnap = await getDoc(
    doc(firestore, "enrollments", enrollmentId(uid, subjectId)),
  );
  const enrollment = enrollmentSnap.exists() ? enrollmentSnap.data() : {};
  const adaptive = adaptivePlanState(enrollment, settings);
  const sessionStagesTarget = Number(
    attempt.sessionStagesTarget ?? enrollment.sessionStages ?? adaptive.sessionStages,
  );
  const level = Number(
    attempt.adaptiveLevelAfter ?? enrollment.adaptiveLevel ?? adaptive.level,
  );
  const levelSettings = getAdaptiveLevel(settings, level);

  return {
    attemptId,
    score: Number(attempt.score ?? 0),
    results: (attempt.answers ?? []) as GradedAnswer[],
    sessionComplete:
      Number(attempt.stageInSession ?? 0) >= Math.max(1, sessionStagesTarget),
    nextAvailableAt: toMillis(enrollment.nextAvailableAt),
    stageIntervalMinutes: Number(
      attempt.stageIntervalMinutes ?? adaptive.stageIntervalMinutes,
    ),
    feedbackSeen: Boolean(attempt.feedbackSeenAt),
    adaptiveLevel: level,
    adaptiveLevelName: adaptive.enabled ? levelSettings.name : adaptive.levelName,
    adaptiveLevelChanged:
      (attempt.adaptiveLevelChange as "up" | "down" | null | undefined) ?? null,
    nextStageNew: Number(attempt.nextStageNew ?? adaptive.newPerStage),
    nextStageReview: Number(attempt.nextStageReview ?? adaptive.reviewPerStage),
    nextStageIntervalMinutes: Number(
      attempt.nextStageIntervalMinutes ?? adaptive.stageIntervalMinutes,
    ),
  };
}

async function markStageFeedbackSeen(attemptId: string) {
  const uid = currentUser().uid;
  const firestore = database();
  const ref = doc(firestore, "stage_attempts", attemptId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw appError("ATTEMPT_NOT_FOUND", "not-found");
  const attempt = snap.data();
  if (attempt.userId !== uid) throw appError("ATTEMPT_NOT_OWNED", "permission-denied");
  if (attempt.status !== "submitted") {
    throw appError("ATTEMPT_NOT_SUBMITTED", "failed-precondition");
  }

  const answers = (attempt.answers ?? []) as Array<{
    grading?: string;
    isCorrect?: boolean | null;
  }>;
  if (answers.some((answer) => answer.grading === "self" && answer.isCorrect === null)) {
    throw appError("SELF_GRADE_REQUIRED", "failed-precondition");
  }

  if (!attempt.feedbackSeenAt) {
    await updateDoc(ref, { feedbackSeenAt: serverTimestamp() });
  }
  return { ok: true };
}

async function getSubjectProgress(subjectId: string): Promise<SubjectProgress> {
  const uid = currentUser().uid;
  const firestore = database();
  const enrollmentSnap = await getDoc(
    doc(firestore, "enrollments", enrollmentId(uid, subjectId)),
  );
  if (!enrollmentSnap.exists()) throw appError("NOT_ENROLLED", "not-found");
  const enrollment = enrollmentSnap.data();
  const [settings, globalSettings] = await Promise.all([
    getSettings(subjectId),
    fetchGlobalSettings(),
  ]);
  const adaptive = adaptivePlanState(enrollment, settings);
  const todayKey = localDateKey(new Date());
  const dailyQuestionCap = adaptive.enabled
    ? Math.max(0, Math.floor(Number(settings.adaptiveDailyQuestionCap) || 0))
    : 0;
  const dailyQuestionCount =
    enrollment.dailyQuestionDate === todayKey
      ? Math.max(0, Number(enrollment.dailyQuestionCount ?? 0))
      : 0;

  const [unitsSnap, progressSnap] = await Promise.all([
    getDocs(
      query(
        collection(firestore, "units"),
        where("subjectId", "==", subjectId),
        orderBy("sort", "asc"),
      ),
    ),
    getDocs(
      query(
        collection(firestore, "unit_progress"),
        where("userId", "==", uid),
        where("subjectId", "==", subjectId),
      ),
    ),
  ]);

  const progressByUnit = new Map(
    progressSnap.docs.map((progress) => [String(progress.data().unitId), progress.data()]),
  );

  let stageAvailableAt: number | null = null;
  if (adaptive.stageIntervalMinutes > 0) {
    const lastSubmitted = await getDocs(
      query(
        collection(firestore, "stage_attempts"),
        where("userId", "==", uid),
        where("subjectId", "==", subjectId),
        where("status", "==", "submitted"),
        orderBy("submittedAt", "desc"),
        limit(1),
      ),
    );
    const feedbackSeenAt = lastSubmitted.empty
      ? null
      : toMillis(lastSubmitted.docs[0].data().feedbackSeenAt);
    if (feedbackSeenAt !== null) {
      stageAvailableAt =
        feedbackSeenAt + adaptive.stageIntervalMinutes * 60 * 1000;
    }
  }

  return {
    enrolled: true,
    subjectId,
    totalQuestions: Number(enrollment.totalQuestions ?? 0),
    coverageCount: Number(enrollment.coverageCount ?? 0),
    masteryCount: Number(enrollment.masteryCount ?? 0),
    masteryTarget: masteryTarget(enrollment, settings),
    sessionStages: adaptive.sessionStages,
    sessionNo: Number(enrollment.sessionNo ?? 1),
    stagesInSession: Number(enrollment.stagesInSession ?? 0),
    nextAvailableAt: toMillis(enrollment.nextAvailableAt),
    stageAvailableAt,
    completedAt: toMillis(enrollment.completedAt),
    masteryCompletedAt: toMillis(enrollment.masteryCompletedAt),
    stagesLocked: Boolean(globalSettings.stagesLocked || settings.stagesLocked),
    lockMessage:
      globalSettings.lockMessage ||
      settings.lockMessage ||
      "أوقفت الإدارة فتح مراحل جديدة حاليًا.",
    adaptiveEnabled: adaptive.enabled,
    adaptiveLevel: adaptive.level,
    adaptiveLevelName: adaptive.levelName,
    adaptiveLevelNames: settings.adaptiveLevels.map((level) => level.name),
    adaptiveLevelReason: String(enrollment.adaptiveLevelReason ?? ""),
    nextStageNew: adaptive.newPerStage,
    nextStageReview: adaptive.reviewPerStage,
    stageIntervalMinutes: adaptive.stageIntervalMinutes,
    sessionIntervalMinutes: adaptive.intervalMinutes,
    dailyQuestionCap,
    dailyQuestionCount,
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

async function getLeaderboard(subjectId: string) {
  const firestore = database();
  // Rank by the share of auto-graded questions answered correctly on the
  // first attempt, not by raw question volume. Self-graded questions never
  // enter this score. We fetch a generous candidate set and sort in the browser
  // so existing enrollments without a derived percentage field still work.
  const snap = await getDocs(
    query(
      collection(firestore, "enrollments"),
      where("subjectId", "==", subjectId),
      limit(500),
    ),
  );

  const rows = snap.docs
    .map((enrollment): LeaderboardRow => {
      const data = enrollment.data();
      return {
        rank: 0,
        userId: String(data.userId ?? enrollment.id),
        displayName: String(data.displayName ?? "طالب"),
        autoFirstCorrect: Number(data.autoFirstCorrect ?? 0),
        masteryCount: Number(data.masteryCount ?? 0),
        coverageCount: Number(data.coverageCount ?? 0),
        totalQuestions: Number(data.totalQuestions ?? 0),
        completedAt: toMillis(data.completedAt),
      };
    })
    .sort((left, right) => {
      const leftRatio =
        left.totalQuestions > 0 ? left.autoFirstCorrect / left.totalQuestions : 0;
      const rightRatio =
        right.totalQuestions > 0 ? right.autoFirstCorrect / right.totalQuestions : 0;
      if (rightRatio !== leftRatio) return rightRatio - leftRatio;
      if (right.autoFirstCorrect !== left.autoFirstCorrect) {
        return right.autoFirstCorrect - left.autoFirstCorrect;
      }
      if (right.coverageCount !== left.coverageCount) {
        return right.coverageCount - left.coverageCount;
      }
      return left.displayName.localeCompare(right.displayName, "ar");
    })
    .slice(0, 50)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return { subjectId, rows };
}

function certificateCode(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  }
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function claimCertificate(subjectId: string) {
  const uid = currentUser().uid;
  const firestore = database();
  const enrollmentSnap = await getDoc(
    doc(firestore, "enrollments", enrollmentId(uid, subjectId)),
  );
  if (!enrollmentSnap.exists()) throw appError("NOT_ENROLLED", "not-found");
  const enrollment = enrollmentSnap.data();
  const settings = await getSettings(subjectId);
  const total = Number(enrollment.totalQuestions ?? 0);
  const target = masteryTarget(enrollment, settings);

  if (total <= 0) throw appError("SUBJECT_EMPTY", "failed-precondition");
  if (Number(enrollment.coverageCount ?? 0) < total) {
    throw appError("COVERAGE_INCOMPLETE", "failed-precondition");
  }
  if (Number(enrollment.masteryCount ?? 0) < target) {
    throw appError("MASTERY_INCOMPLETE", "failed-precondition");
  }

  if (settings.finalExamRequired) {
    const passedExam = await getDocs(
      query(
        collection(firestore, "final_exam_attempts"),
        where("userId", "==", uid),
        where("subjectId", "==", subjectId),
        where("passed", "==", true),
        limit(1),
      ),
    );
    if (passedExam.empty) {
      throw appError("FINAL_EXAM_REQUIRED", "failed-precondition");
    }
  }

  const certificateRef = doc(firestore, "certificates", `${uid}_${subjectId}`);
  const existing = await getDoc(certificateRef);
  if (existing.exists()) return { certificate: existing.data() as Certificate };

  const certificate = {
    userId: uid,
    subjectId,
    displayName: String(enrollment.displayName ?? "طالب"),
    coverageCount: Number(enrollment.coverageCount ?? 0),
    masteryCount: Number(enrollment.masteryCount ?? 0),
    totalQuestions: total,
    code: certificateCode(),
    issuedAt: Timestamp.now(),
  };

  await runTransaction(firestore, async (tx) => {
    const current = await tx.get(certificateRef);
    if (current.exists()) return;
    tx.set(certificateRef, certificate);
  });

  const saved = await getDoc(certificateRef);
  return { certificate: (saved.data() ?? certificate) as Certificate };
}

export const sparkApi = {
  register,
  joinSubject,
  startStage,
  submitStage,
  getStageResult,
  markStageFeedbackSeen,
  selfGradeQuestion,
  getSubjectProgress,
  getLeaderboard,
  claimCertificate,
};

export type SparkApi = typeof sparkApi;
