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
import { fetchGlobalSettings, fetchSubjectSettings } from "./settings";
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

  const data = {
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

  if (selected.length < stageSize) {
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
    sessionStages: settings.sessionStages,
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

  const globalSettings = await fetchGlobalSettings();
  if (!globalSettings.registrationsOpen) {
    throw appError("REGISTRATIONS_CLOSED", "failed-precondition");
  }

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
  const stageInSession = Number(enrollment.data.stagesInSession ?? 0) + 1;

  // A student who did not reach the configured pass mark gets a recovery stage:
  // more review, fewer new questions. Once they pass, the normal split returns.
  const lastScore = Number(lastSubmittedData?.score);
  const failedLast =
    lastSubmittedData !== null &&
    Number.isFinite(lastScore) &&
    lastScore < settings.passThreshold;
  const newCount = failedLast ? settings.failedNewPerStage : settings.newPerStage;
  const reviewCount = failedLast ? settings.failedReviewPerStage : settings.reviewPerStage;
  const stageSize = Math.max(1, Math.min(20, newCount + reviewCount));

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
      });
      tx.update(enrollmentRef, { nextQuestionIndex });
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
  const sessionComplete = Number(attempt.stageInSession ?? 0) >= settings.sessionStages;
  const nextAvailableAt = sessionComplete
    ? Timestamp.fromMillis(now.toMillis() + settings.intervalMinutes * 60 * 1000)
    : null;

  const enrollmentRef = doc(firestore, "enrollments", enrollmentId(uid, subjectId));
  const progressRefs = items.map((item) => doc(firestore, "progress", `${uid}_${item.questionId}`));
  const unitProgressRefs = unitIds.map((unitId) =>
    doc(firestore, "unit_progress", unitProgressId(uid, subjectId, unitId)),
  );

  let coverageCount = 0;
  let masteryCount = 0;
  let totalQuestions = 0;
  let masteryTargetValue = 0;

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
      sessionStages: settings.sessionStages,
      autoFirstCorrect,
      stagesCompleted: Number(enrollment.stagesCompleted ?? 0) + 1,
      stagesInSession: sessionComplete ? 0 : Number(currentAttemptData.stageInSession ?? 1),
      sessionNo: sessionComplete
        ? Number(enrollment.sessionNo ?? 1) + 1
        : Number(enrollment.sessionNo ?? 1),
      completedAt,
      masteryCompletedAt,
      ...(sessionComplete ? { nextAvailableAt } : {}),
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
    });
  });

  const correctCount = graded.filter((answer) => answer.isCorrect === true).length;
  return {
    attemptId,
    score: Math.round((correctCount / Math.max(1, graded.length)) * 100),
    results: graded,
    sessionComplete,
    nextAvailableAt: nextAvailableAt ? nextAvailableAt.toMillis() : null,
    totalQuestions,
    coverageCount,
    masteryCount,
    masteryTarget: masteryTargetValue,
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
      sessionStages: settings.sessionStages,
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

  return {
    attemptId,
    score: Number(attempt.score ?? 0),
    results: (attempt.answers ?? []) as GradedAnswer[],
    sessionComplete: Number(attempt.stageInSession ?? 0) >= settings.sessionStages,
    nextAvailableAt: toMillis(enrollment.nextAvailableAt),
    feedbackSeen: Boolean(attempt.feedbackSeenAt),
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
    stagesLocked: Boolean(globalSettings.stagesLocked || settings.stagesLocked),
    lockMessage:
      globalSettings.lockMessage ||
      settings.lockMessage ||
      "أوقفت الإدارة فتح مراحل جديدة حاليًا.",
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
  const snap = await getDocs(
    query(
      collection(firestore, "enrollments"),
      where("subjectId", "==", subjectId),
      orderBy("autoFirstCorrect", "desc"),
      orderBy("masteryCount", "desc"),
      orderBy("coverageCount", "desc"),
      limit(50),
    ),
  );

  return {
    subjectId,
    rows: snap.docs.map((enrollment, index): LeaderboardRow => {
      const data = enrollment.data();
      return {
        rank: index + 1,
        userId: String(data.userId ?? enrollment.id),
        displayName: String(data.displayName ?? "طالب"),
        autoFirstCorrect: Number(data.autoFirstCorrect ?? 0),
        masteryCount: Number(data.masteryCount ?? 0),
        coverageCount: Number(data.coverageCount ?? 0),
        totalQuestions: Number(data.totalQuestions ?? 0),
        completedAt: toMillis(data.completedAt),
      };
    }),
  };
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
