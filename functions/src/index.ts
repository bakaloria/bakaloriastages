import { randomBytes } from "crypto";
import { DocumentData, FieldValue, Timestamp } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { CallableRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import { auth, db } from "./firebase";
import { gradeAnswer } from "./grading";
import {
  buildStagePayload,
  computeMasteryLevel,
  computeNextReviewAt,
  enrollmentId,
  ensureEnrollment,
  getSettings,
  getSubjectProgress as loadSubjectProgress,
  getUnitTotals,
  masteryTarget,
  selectQuestions,
  toMillis,
  unitProgressId,
} from "./stages";
import {
  AnswerInput,
  GradedAnswer,
  QuestionPrivate,
  QuestionPublic,
  SelfScore,
  StageItem,
} from "./types";

setGlobalOptions({ maxInstances: 20 });

// App Check enforcement is opt-in because the project may not have a
// reCAPTCHA v3 site key yet. Set ENFORCE_APP_CHECK=true on the functions
// runtime after the web app has a site key and App Check is registered.
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === "true";

const APP_DOMAIN = "students.bakaloriarace.app";
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const BRANCHES = new Set(["scientific", "literary"]);

function requireAuth(request: CallableRequest): string {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "AUTH_REQUIRED");
  return request.auth.uid;
}

function requiredSubjectId(request: CallableRequest): string {
  const subjectId = String((request.data as { subjectId?: unknown } | undefined)?.subjectId ?? "");
  if (!subjectId) throw new HttpsError("invalid-argument", "SUBJECT_ID_REQUIRED");
  return subjectId;
}

/**
 * Creates a student account with a username and password.
 * Firebase Auth uses a synthetic email; the student never sees it.
 */
export const register = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const data = (request.data ?? {}) as {
    username?: unknown;
    password?: unknown;
    displayName?: unknown;
    branch?: unknown;
  };

  const username = String(data.username ?? "").trim();
  const usernameLower = username.toLowerCase();
  const password = String(data.password ?? "");
  const displayName = String(data.displayName ?? "").trim() || username;
  const branch = String(data.branch ?? "");

  if (!USERNAME_RE.test(usernameLower)) {
    throw new HttpsError("invalid-argument", "USERNAME_INVALID");
  }
  if (password.length < 6 || password.length > 128) {
    throw new HttpsError("invalid-argument", "PASSWORD_INVALID");
  }
  if (!BRANCHES.has(branch)) {
    throw new HttpsError("invalid-argument", "BRANCH_INVALID");
  }

  const usernameRef = db.doc(`usernames/${usernameLower}`);
  if ((await usernameRef.get()).exists) {
    throw new HttpsError("already-exists", "USERNAME_TAKEN");
  }

  const email = `${usernameLower}@${APP_DOMAIN}`;
  let user;
  try {
    user = await auth.createUser({ email, password, displayName });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "USERNAME_TAKEN");
    }
    throw new HttpsError("internal", "REGISTRATION_FAILED");
  }

  try {
    await db.runTransaction(async (tx) => {
      const currentUsername = await tx.get(usernameRef);
      if (currentUsername.exists) {
        throw new HttpsError("already-exists", "USERNAME_TAKEN");
      }
      tx.set(usernameRef, {
        uid: user.uid,
        username: usernameLower,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.doc(`users/${user.uid}`), {
        username,
        usernameLower,
        displayName,
        branch,
        role: "student",
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    await auth.deleteUser(user.uid).catch(() => undefined);
    throw error;
  }

  await auth.setCustomUserClaims(user.uid, { role: "student" });
  return { uid: user.uid, email };
});

export const joinSubject = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const subjectId = requiredSubjectId(request);
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
});

export const startStage = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const subjectId = requiredSubjectId(request);
  const enrollment = await ensureEnrollment(uid, subjectId);
  const settings = await getSettings(subjectId);
  const now = Timestamp.now();

  // Review feedback comes before the session lock: a student who has just
  // finished the last stage of a session must still see the model answers
  // before the next stage unlocks.
  const lastSubmitted = await db
    .collection("stage_attempts")
    .where("userId", "==", uid)
    .where("subjectId", "==", subjectId)
    .where("status", "==", "submitted")
    .orderBy("submittedAt", "desc")
    .limit(1)
    .get();

  if (!lastSubmitted.empty && !lastSubmitted.docs[0].data().feedbackSeenAt) {
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

  const inProgress = await db
    .collection("stage_attempts")
    .where("userId", "==", uid)
    .where("subjectId", "==", subjectId)
    .where("status", "==", "in_progress")
    .orderBy("startedAt", "desc")
    .limit(1)
    .get();

  if (!inProgress.empty) {
    const attempt = inProgress.docs[0];
    return buildStagePayload(attempt.id, attempt.data(), settings, true);
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
  const newCount = stageNo <= 4 ? 1 : settings.newPerStage;
  const reviewCount = stageNo <= 4 ? stageNo - 1 : settings.reviewPerStage;
  const stageSize = Math.max(1, settings.stageSize);

  const selected = await selectQuestions(
    uid,
    subjectId,
    enrollment.data,
    newCount,
    reviewCount,
    stageSize,
  );
  if (selected.length === 0) {
    throw new HttpsError("failed-precondition", "NO_QUESTIONS_AVAILABLE");
  }

  const attemptId = `${uid}_${subjectId}_${stageNo}`;
  const attemptRef = db.doc(`stage_attempts/${attemptId}`);
  const existingAttempt = await attemptRef.get();
  if (existingAttempt.exists) {
    const attempt = existingAttempt.data()!;
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

  await db.runTransaction(async (tx) => {
    const enrollmentRef = db.doc(`enrollments/${enrollmentId(uid, subjectId)}`);
    const current = await tx.get(enrollmentRef);
    if (!current.exists) throw new HttpsError("not-found", "ENROLLMENT_NOT_FOUND");
    const enrollmentData = current.data()!;
    const currentStageNo = Number(enrollmentData.stagesCompleted ?? 0) + 1;
    if (currentStageNo !== stageNo) throw new HttpsError("aborted", "STAGE_RACE");

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
      startedAt: FieldValue.serverTimestamp(),
      submittedAt: null,
      feedbackSeenAt: null,
      answers: [],
      score: null,
    });
    tx.update(enrollmentRef, { nextQuestionIndex });
  });

  const created = await attemptRef.get();
  return buildStagePayload(attemptId, created.data()!, settings, false);
});

export const submitStage = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const data = (request.data ?? {}) as { attemptId?: unknown; answers?: unknown };
  const attemptId = String(data.attemptId ?? "");
  if (!attemptId) throw new HttpsError("invalid-argument", "ATTEMPT_ID_REQUIRED");
  const answers = Array.isArray(data.answers) ? (data.answers as AnswerInput[]) : [];

  const attemptRef = db.doc(`stage_attempts/${attemptId}`);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) throw new HttpsError("not-found", "ATTEMPT_NOT_FOUND");
  const attempt = attemptSnap.data()!;
  if (attempt.userId !== uid) throw new HttpsError("permission-denied", "ATTEMPT_NOT_OWNED");
  if (attempt.status !== "in_progress") {
    throw new HttpsError("failed-precondition", "ATTEMPT_ALREADY_SUBMITTED");
  }

  const subjectId = String(attempt.subjectId);
  const settings = await getSettings(subjectId);
  const items = (attempt.items ?? []) as StageItem[];
  if (items.length === 0) throw new HttpsError("failed-precondition", "ATTEMPT_EMPTY");

  const answersByQuestion = new Map(
    answers.map((answer) => [String(answer.questionId), answer]),
  );

  const questionRefs = items.map((item) => db.doc(`questions/${item.questionId}`));
  const privateRefs = items.map((item) => db.doc(`question_answers/${item.questionId}`));
  const [questionSnaps, privateSnaps] = await Promise.all([
    db.getAll(...questionRefs),
    db.getAll(...privateRefs),
  ]);

  const questions = new Map(
    questionSnaps.map((snap) => [
      snap.id,
      { id: snap.id, ...snap.data() } as QuestionPublic & { id: string },
    ]),
  );
  const privateData = new Map(
    privateSnaps.map((snap) => [snap.id, snap.data() as QuestionPrivate]),
  );

  const graded: GradedAnswer[] = items.map((item) => {
    const question = questions.get(item.questionId);
    const secret = privateData.get(item.questionId);
    if (!question || !secret) {
      throw new HttpsError("failed-precondition", "QUESTION_NOT_FOUND");
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
      items.map((item) => questions.get(item.questionId)!.unitId).filter(Boolean),
    ),
  ];
  const unitTotals = await getUnitTotals(subjectId, unitIds);
  const now = Timestamp.now();
  const sessionComplete = Number(attempt.stageInSession ?? 0) >= settings.sessionStages;
  const nextAvailableAt = sessionComplete
    ? Timestamp.fromMillis(now.toMillis() + settings.intervalMinutes * 60 * 1000)
    : null;

  const enrollmentRef = db.doc(`enrollments/${enrollmentId(uid, subjectId)}`);
  const progressRefs = items.map((item) => db.doc(`progress/${uid}_${item.questionId}`));
  const unitProgressRefs = unitIds.map((unitId) =>
    db.doc(`unit_progress/${unitProgressId(uid, subjectId, unitId)}`),
  );

  let coverageCount = 0;
  let masteryCount = 0;
  let totalQuestions = 0;
  let masteryTargetValue = 0;

  await db.runTransaction(async (tx) => {
    const currentAttempt = await tx.get(attemptRef);
    if (!currentAttempt.exists) throw new HttpsError("not-found", "ATTEMPT_NOT_FOUND");
    const currentAttemptData = currentAttempt.data()!;
    if (currentAttemptData.userId !== uid) {
      throw new HttpsError("permission-denied", "ATTEMPT_NOT_OWNED");
    }
    if (currentAttemptData.status !== "in_progress") {
      throw new HttpsError("failed-precondition", "ATTEMPT_ALREADY_SUBMITTED");
    }

    const enrollmentSnap = await tx.get(enrollmentRef);
    if (!enrollmentSnap.exists) throw new HttpsError("not-found", "ENROLLMENT_NOT_FOUND");
    const enrollment = enrollmentSnap.data()!;

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
      const old = progressSnap.exists ? progressSnap.data()! : null;
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
      const unitProgressSnap = unitProgressByUnit.get(unitId);
      const oldUnit = unitProgressSnap?.exists ? unitProgressSnap.data()! : null;
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
      const old = snap?.exists ? snap.data()! : null;
      tx.set(
        db.doc(`unit_progress/${unitProgressId(uid, subjectId, unitId)}`),
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
});

export const selfGradeQuestion = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const data = (request.data ?? {}) as {
    attemptId?: unknown;
    questionId?: unknown;
    selfScore?: unknown;
  };
  const attemptId = String(data.attemptId ?? "");
  const questionId = String(data.questionId ?? "");
  const selfScore = String(data.selfScore ?? "") as SelfScore;

  if (!attemptId || !questionId) {
    throw new HttpsError("invalid-argument", "ATTEMPT_AND_QUESTION_REQUIRED");
  }
  if (!["correct", "partial", "wrong"].includes(selfScore)) {
    throw new HttpsError("invalid-argument", "SELF_SCORE_INVALID");
  }

  const attemptRef = db.doc(`stage_attempts/${attemptId}`);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) throw new HttpsError("not-found", "ATTEMPT_NOT_FOUND");
  const attempt = attemptSnap.data()!;
  if (attempt.userId !== uid) throw new HttpsError("permission-denied", "ATTEMPT_NOT_OWNED");
  if (attempt.status !== "submitted") {
    throw new HttpsError("failed-precondition", "ATTEMPT_NOT_SUBMITTED");
  }

  const subjectId = String(attempt.subjectId);
  const settings = await getSettings(subjectId);
  const progressRef = db.doc(`progress/${uid}_${questionId}`);
  const progressSnap = await progressRef.get();
  if (!progressSnap.exists) throw new HttpsError("not-found", "PROGRESS_NOT_FOUND");
  const progress = progressSnap.data()!;
  if (progress.subjectId !== subjectId || !progress.pendingSelfGrade) {
    throw new HttpsError("failed-precondition", "SELF_GRADE_NOT_PENDING");
  }

  const unitId = String(progress.unitId);
  const unitTotalSnap = await db.doc(`unit_totals/${subjectId}_${unitId}`).get();
  const unitTotal = unitTotalSnap.data() ?? {};
  const enrollmentRef = db.doc(`enrollments/${enrollmentId(uid, subjectId)}`);
  const unitProgressRef = db.doc(`unit_progress/${unitProgressId(uid, subjectId, unitId)}`);
  const now = Timestamp.now();
  const isCorrect = selfScore === "correct";

  let coverageCount = 0;
  let masteryCount = 0;
  let totalQuestions = 0;
  let target = 0;
  let completed = false;

  await db.runTransaction(async (tx) => {
    const currentAttempt = await tx.get(attemptRef);
    if (!currentAttempt.exists) throw new HttpsError("not-found", "ATTEMPT_NOT_FOUND");
    const currentAttemptData = currentAttempt.data()!;
    if (currentAttemptData.userId !== uid) {
      throw new HttpsError("permission-denied", "ATTEMPT_NOT_OWNED");
    }
    if (currentAttemptData.status !== "submitted") {
      throw new HttpsError("failed-precondition", "ATTEMPT_NOT_SUBMITTED");
    }

    const currentProgress = await tx.get(progressRef);
    if (!currentProgress.exists) throw new HttpsError("not-found", "PROGRESS_NOT_FOUND");
    const current = currentProgress.data()!;
    if (!current.pendingSelfGrade) {
      throw new HttpsError("failed-precondition", "SELF_GRADE_NOT_PENDING");
    }

    const enrollmentSnap = await tx.get(enrollmentRef);
    if (!enrollmentSnap.exists) throw new HttpsError("not-found", "ENROLLMENT_NOT_FOUND");
    const enrollment = enrollmentSnap.data()!;
    const unitProgressSnap = await tx.get(unitProgressRef);
    const oldUnit = unitProgressSnap.exists ? unitProgressSnap.data()! : null;

    const alreadyMastered = Boolean(current.mastered);
    const masteryDelta = isCorrect && !alreadyMastered ? 1 : 0;
    const oldMastery = Number(current.masteryLevel ?? 0);
    const nextLevel = isCorrect ? Math.min(3, Math.max(1, oldMastery + 1)) : oldMastery;
    const nextReviewAt = computeNextReviewAt(
      isCorrect,
      oldMastery,
      now,
      settings.intervalMinutes,
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
    tx.update(attemptRef, {
      answers: oldAnswers.map((answer) =>
        answer.questionId === questionId
          ? { ...answer, selfScore, isCorrect, gradedAt: now }
          : answer,
      ),
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
    completed = totalQuestions > 0 && coverageCount >= totalQuestions && masteryCount >= target;

    const completedAt = completed ? (enrollment.completedAt ?? now) : (enrollment.completedAt ?? null);
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
});

export const getStageResult = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const attemptId = String((request.data as { attemptId?: unknown } | undefined)?.attemptId ?? "");
  if (!attemptId) throw new HttpsError("invalid-argument", "ATTEMPT_ID_REQUIRED");

  const attemptSnap = await db.doc(`stage_attempts/${attemptId}`).get();
  if (!attemptSnap.exists) throw new HttpsError("not-found", "ATTEMPT_NOT_FOUND");
  const attempt = attemptSnap.data()!;
  if (attempt.userId !== uid) throw new HttpsError("permission-denied", "ATTEMPT_NOT_OWNED");
  if (attempt.status !== "submitted") {
    throw new HttpsError("failed-precondition", "ATTEMPT_NOT_SUBMITTED");
  }

  const subjectId = String(attempt.subjectId);
  const settings = await getSettings(subjectId);
  const enrollmentSnap = await db.doc(`enrollments/${enrollmentId(uid, subjectId)}`).get();
  const enrollment = enrollmentSnap.exists ? enrollmentSnap.data()! : {};

  return {
    attemptId,
    score: Number(attempt.score ?? 0),
    results: attempt.answers ?? [],
    sessionComplete: Number(attempt.stageInSession ?? 0) >= settings.sessionStages,
    nextAvailableAt: toMillis(enrollment.nextAvailableAt),
    feedbackSeen: Boolean(attempt.feedbackSeenAt),
  };
});

export const markStageFeedbackSeen = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const attemptId = String((request.data as { attemptId?: unknown } | undefined)?.attemptId ?? "");
  if (!attemptId) throw new HttpsError("invalid-argument", "ATTEMPT_ID_REQUIRED");

  const ref = db.doc(`stage_attempts/${attemptId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "ATTEMPT_NOT_FOUND");
  const attempt = snap.data()!;
  if (attempt.userId !== uid) throw new HttpsError("permission-denied", "ATTEMPT_NOT_OWNED");
  if (attempt.status !== "submitted") {
    throw new HttpsError("failed-precondition", "ATTEMPT_NOT_SUBMITTED");
  }

  const answers = (attempt.answers ?? []) as Array<{
    grading?: string;
    isCorrect?: boolean | null;
  }>;
  if (answers.some((answer) => answer.grading === "self" && answer.isCorrect === null)) {
    throw new HttpsError("failed-precondition", "SELF_GRADE_REQUIRED");
  }

  if (!attempt.feedbackSeenAt) {
    await ref.update({ feedbackSeenAt: FieldValue.serverTimestamp() });
  }
  return { ok: true };
});

export const getSubjectProgress = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const subjectId = requiredSubjectId(request);
  return loadSubjectProgress(uid, subjectId);
});

export const getLeaderboard = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  requireAuth(request);
  const subjectId = requiredSubjectId(request);
  const limitValue = Number(
    (request.data as { limit?: unknown } | undefined)?.limit ?? 50,
  );
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitValue) ? limitValue : 50));

  const snap = await db
    .collection("enrollments")
    .where("subjectId", "==", subjectId)
    .orderBy("autoFirstCorrect", "desc")
    .orderBy("masteryCount", "desc")
    .orderBy("coverageCount", "desc")
    .limit(limit)
    .get();

  return {
    subjectId,
    rows: snap.docs.map((doc, index) => {
      const data = doc.data();
      return {
        rank: index + 1,
        userId: String(data.userId ?? doc.id),
        displayName: String(data.displayName ?? "طالب"),
        autoFirstCorrect: Number(data.autoFirstCorrect ?? 0),
        masteryCount: Number(data.masteryCount ?? 0),
        coverageCount: Number(data.coverageCount ?? 0),
        totalQuestions: Number(data.totalQuestions ?? 0),
        completedAt: toMillis(data.completedAt),
      };
    }),
  };
});

export const claimCertificate = onCall({ enforceAppCheck: ENFORCE_APP_CHECK }, async (request) => {
  const uid = requireAuth(request);
  const subjectId = requiredSubjectId(request);

  const enrollmentSnap = await db.doc(`enrollments/${enrollmentId(uid, subjectId)}`).get();
  if (!enrollmentSnap.exists) throw new HttpsError("not-found", "NOT_ENROLLED");
  const enrollment = enrollmentSnap.data()!;
  const settings = await getSettings(subjectId);
  const total = Number(enrollment.totalQuestions ?? 0);
  const target = masteryTarget(enrollment, settings);

  if (total <= 0) {
    throw new HttpsError("failed-precondition", "SUBJECT_EMPTY");
  }
  if (Number(enrollment.coverageCount ?? 0) < total) {
    throw new HttpsError("failed-precondition", "COVERAGE_INCOMPLETE");
  }
  if (Number(enrollment.masteryCount ?? 0) < target) {
    throw new HttpsError("failed-precondition", "MASTERY_INCOMPLETE");
  }

  if (settings.finalExamRequired) {
    const passedExam = await db
      .collection("final_exam_attempts")
      .where("userId", "==", uid)
      .where("subjectId", "==", subjectId)
      .where("passed", "==", true)
      .limit(1)
      .get();
    if (passedExam.empty) throw new HttpsError("failed-precondition", "FINAL_EXAM_REQUIRED");
  }

  const certificateRef = db.doc(`certificates/${uid}_${subjectId}`);
  const existing = await certificateRef.get();
  if (existing.exists) return { certificate: existing.data() };

  const certificate: DocumentData = {
    userId: uid,
    subjectId,
    displayName: String(enrollment.displayName ?? "طالب"),
    coverageCount: Number(enrollment.coverageCount ?? 0),
    masteryCount: Number(enrollment.masteryCount ?? 0),
    totalQuestions: total,
    code: randomBytes(8).toString("hex"),
    issuedAt: FieldValue.serverTimestamp(),
  };
  await certificateRef.create(certificate);
  const saved = await certificateRef.get();
  return { certificate: saved.data() };
});
