import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import type {
  Certificate,
  LeaderboardRow,
  RegisterInput,
  StageResultResponse,
  StartStageResponse,
  SubjectProgress,
  SubmitStageResponse,
} from "./types";

async function call<T>(name: string, data?: unknown): Promise<T> {
  if (!functions) throw new Error("FIREBASE_NOT_CONFIGURED");
  const callable = httpsCallable(functions, name);
  const result = await callable(data);
  return result.data as T;
}

export const api = {
  register(input: RegisterInput) {
    return call<{ uid: string; email: string }>("register", input);
  },
  joinSubject(subjectId: string) {
    return call<{ enrolled: boolean; totalQuestions: number }>("joinSubject", { subjectId });
  },
  startStage(subjectId: string) {
    return call<StartStageResponse>("startStage", { subjectId });
  },
  submitStage(attemptId: string, answers: unknown[]) {
    return call<SubmitStageResponse>("submitStage", { attemptId, answers });
  },
  getStageResult(attemptId: string) {
    return call<StageResultResponse>("getStageResult", { attemptId });
  },
  markStageFeedbackSeen(attemptId: string) {
    return call<{ ok: boolean }>("markStageFeedbackSeen", { attemptId });
  },
  selfGradeQuestion(attemptId: string, questionId: string, selfScore: "correct" | "partial" | "wrong") {
    return call<{
      ok: boolean;
      isCorrect: boolean;
      totalQuestions: number;
      coverageCount: number;
      masteryCount: number;
      masteryTarget: number;
      completed: boolean;
    }>("selfGradeQuestion", { attemptId, questionId, selfScore });
  },
  getSubjectProgress(subjectId: string) {
    return call<SubjectProgress>("getSubjectProgress", { subjectId });
  },
  getLeaderboard(subjectId: string) {
    return call<{ subjectId: string; rows: LeaderboardRow[] }>("getLeaderboard", { subjectId });
  },
  claimCertificate(subjectId: string) {
    return call<{ certificate: Certificate }>("claimCertificate", { subjectId });
  },
};
