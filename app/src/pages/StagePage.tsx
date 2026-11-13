import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Countdown } from "../components/Countdown";
import { EmptyState } from "../components/EmptyState";
import {
  ArrowLeftIcon,
  AwardIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  FlagIcon,
  LockIcon,
  RefreshIcon,
  SparklesIcon,
  XIcon,
} from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  formatAnswer,
  formatModelAnswer,
  formatNumber,
  optionLetter,
  optionText,
  optionsList,
  questionTypeLabel,
  toMillis,
} from "../lib/format";
import type {
  GradedAnswer,
  SelfScore,
  StagePayload,
  StageQuestion,
  StartStageResponse,
} from "../lib/types";

type Phase = "loading" | "questions" | "results" | "locked" | "completed" | "error";

interface ResultMeta {
  attemptId: string;
  score: number;
  sessionComplete: boolean;
  nextAvailableAt: number | null;
  stageIntervalMinutes: number;
  totalQuestions?: number;
  coverageCount?: number;
  masteryCount?: number;
  masteryTarget?: number;
  adaptiveLevel?: number;
  adaptiveLevelName?: string;
  adaptiveLevelChanged?: "up" | "down" | null;
  nextStageNew?: number;
  nextStageReview?: number;
  nextStageIntervalMinutes?: number;
}

function answerObject(question: StageQuestion, answer: unknown): Record<string, unknown> {
  if (answer && typeof answer === "object") return answer as Record<string, unknown>;
  return {};
}

function isAnswered(question: StageQuestion, answer: unknown): boolean {
  if (answer === null || answer === undefined) return false;
  if (question.type === "mcq") {
    const index = answerObject(question, answer).index;
    return typeof index === "number" && Number.isFinite(index);
  }
  if (question.type === "true_false") {
    return typeof answerObject(question, answer).value === "boolean";
  }
  return String(answerObject(question, answer).text ?? "").trim().length > 0;
}

function correctOptionIndex(modelAnswer: unknown): number | null {
  if (!modelAnswer || typeof modelAnswer !== "object") return null;
  const index = Number((modelAnswer as Record<string, unknown>).index);
  return Number.isFinite(index) ? index : null;
}

export function StagePage() {
  const { subjectId = "" } = useParams();
  const navigate = useNavigate();
  const { settings } = useAuth();
  const [phase, setPhase] = useState<Phase>("loading");
  const [stage, setStage] = useState<StagePayload | null>(null);
  const [results, setResults] = useState<GradedAnswer[]>([]);
  const [resultMeta, setResultMeta] = useState<ResultMeta | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [selfGraded, setSelfGraded] = useState<Record<string, SelfScore>>({});
  const [startedAt, setStartedAt] = useState<Record<string, number>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [lockTarget, setLockTarget] = useState<number | null>(null);
  const [adminLocked, setAdminLocked] = useState(false);
  const [stageLocked, setStageLocked] = useState(false);
  const [dailyCapLocked, setDailyCapLocked] = useState(false);
  const [lockMessage, setLockMessage] = useState("");
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const applyResult = useCallback(
    (attemptId: string, payload: Awaited<ReturnType<typeof api.getStageResult>>, isFeedback: boolean) => {
      setResults(payload.results);
      setResultMeta({
        attemptId,
        score: payload.score,
        sessionComplete: payload.sessionComplete,
        nextAvailableAt: payload.nextAvailableAt,
        stageIntervalMinutes: payload.stageIntervalMinutes,
        adaptiveLevel: payload.adaptiveLevel,
        adaptiveLevelName: payload.adaptiveLevelName,
        adaptiveLevelChanged: payload.adaptiveLevelChanged,
        nextStageNew: payload.nextStageNew,
        nextStageReview: payload.nextStageReview,
        nextStageIntervalMinutes: payload.nextStageIntervalMinutes,
      });
      const graded: Record<string, SelfScore> = {};
      for (const result of payload.results) {
        if (result.grading === "self" && result.isCorrect !== null && result.selfScore) {
          graded[result.questionId] = result.selfScore;
        }
      }
      setSelfGraded(graded);
      setFeedbackMode(isFeedback);
      setPhase("results");
    },
    [],
  );

  const loadStage = useCallback(async () => {
    if (!subjectId) return;
    setPhase("loading");
    setError("");
    setDailyCapLocked(false);
    try {
      const data: StartStageResponse = await api.startStage(subjectId);
      if ("locked" in data) {
        setLockTarget(data.nextAvailableAt);
        setAdminLocked(Boolean(data.adminLocked));
        setStageLocked(Boolean(data.stageLocked));
        setDailyCapLocked(Boolean(data.dailyCapLocked));
        setLockMessage(String(data.lockMessage ?? ""));
        setPhase("locked");
        return;
      }
      if ("completed" in data) {
        setPhase("completed");
        return;
      }
      if ("feedbackRequired" in data) {
        const result = await api.getStageResult(data.attemptId);
        applyResult(data.attemptId, result, true);
        return;
      }
      if ("alreadySubmitted" in data) {
        const result = await api.getStageResult(data.attemptId);
        applyResult(data.attemptId, result, true);
        return;
      }

      setStage(data);
      setResults([]);
      setResultMeta(null);
      setAnswers({});
      setSelfGraded({});
      setFeedbackMode(false);
      setCurrentIndex(0);
      setStartedAt(
        Object.fromEntries(data.questions.map((question) => [question.questionId, Date.now()])),
      );
      setPhase("questions");
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("error");
    }
  }, [applyResult, subjectId]);

  useEffect(() => {
    void loadStage();
  }, [loadStage]);

  // When a countdown finishes, re-check the server instead of leaving a stale
  // "locked" card on screen until the student manually reloads.
  useEffect(() => {
    if (phase !== "locked" || adminLocked || !lockTarget) return;
    const delay = lockTarget - Date.now();
    if (delay <= 0) {
      void loadStage();
      return;
    }
    const timer = window.setTimeout(() => void loadStage(), delay + 500);
    return () => window.clearTimeout(timer);
  }, [phase, adminLocked, lockTarget, loadStage]);

  const questions = stage?.questions ?? [];
  const currentQuestion = questions[currentIndex];
  const answeredCount = questions.filter((question) => isAnswered(question, answers[question.questionId])).length;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;
  const pendingSelfGrades = useMemo(
    () =>
      results.some(
        (result) => result.grading === "self" && result.isCorrect === null && !selfGraded[result.questionId],
      ),
    [results, selfGraded],
  );

  function setAnswer(questionId: string, value: unknown) {
    setAnswers((previous) => ({ ...previous, [questionId]: value }));
    setError("");
  }

  async function submitStage() {
    if (!stage) return;
    const firstMissing = stage.questions.findIndex(
      (question) => !isAnswered(question, answers[question.questionId]),
    );
    if (firstMissing >= 0) {
      setCurrentIndex(firstMissing);
      setError("أجب عن كل الأسئلة قبل تسليم المرحلة.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const payload = stage.questions.map((question) => ({
        questionId: question.questionId,
        answer: answers[question.questionId],
        timeMs: Math.max(0, Date.now() - (startedAt[question.questionId] ?? Date.now())),
      }));
      const response = await api.submitStage(stage.attemptId, payload);
      setResults(response.results);
      setResultMeta({
        attemptId: response.attemptId,
        score: response.score,
        sessionComplete: response.sessionComplete,
        nextAvailableAt: response.nextAvailableAt,
        stageIntervalMinutes: response.stageIntervalMinutes,
        totalQuestions: response.totalQuestions,
        coverageCount: response.coverageCount,
        masteryCount: response.masteryCount,
        masteryTarget: response.masteryTarget,
        adaptiveLevel: response.adaptiveLevel,
        adaptiveLevelName: response.adaptiveLevelName,
        adaptiveLevelChanged: response.adaptiveLevelChanged,
        nextStageNew: response.nextStageNew,
        nextStageReview: response.nextStageReview,
        nextStageIntervalMinutes: response.nextStageIntervalMinutes,
      });
      setSelfGraded({});
      setFeedbackMode(false);
      setPhase("results");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function gradeSelf(questionId: string, score: SelfScore) {
    if (!resultMeta) return;
    setBusy(true);
    setError("");
    try {
      await api.selfGradeQuestion(resultMeta.attemptId, questionId, score);
      setSelfGraded((previous) => ({ ...previous, [questionId]: score }));
      setResults((previous) =>
        previous.map((result) =>
          result.questionId === questionId
            ? { ...result, selfScore: score, isCorrect: score === "correct" }
            : result,
        ),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function continueAfterResults() {
    if (!resultMeta) return;
    if (pendingSelfGrades) {
      setError("قيّم كل الإجابات الذاتية أولًا، ثم أكمل.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.markStageFeedbackSeen(resultMeta.attemptId);
      if (resultMeta.sessionComplete) {
        setLockTarget(resultMeta.nextAvailableAt ?? Date.now());
        setAdminLocked(false);
        setDailyCapLocked(false);
        setLockMessage("");
        setPhase("locked");
        return;
      }
      await loadStage();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading") {
    return (
      <div className="page">
        <InlineLoader label="نجهز مرحلتك..." />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="page">
        <EmptyState
          title="تعذر فتح المرحلة"
          description={error || "حدث خطأ غير متوقع."}
          action={
            <div className="button-row">
              <button className="button button--primary" type="button" onClick={() => void loadStage()}>
                <RefreshIcon />
                حاول مرة أخرى
              </button>
              <button className="button button--ghost" type="button" onClick={() => navigate(`/subject/${subjectId}`)}>
                العودة للمادة
              </button>
            </div>
          }
        />
      </div>
    );
  }

  if (phase === "locked") {
    return (
      <div className="page">
        <div className={`session-card${adminLocked ? " session-card--admin-lock" : ""}${stageLocked || dailyCapLocked ? " session-card--stage-lock" : ""}`}>
          <div className="session-card__icon">
            {adminLocked ? <LockIcon /> : <ClockIcon />}
          </div>
          <span className="eyebrow">
            {adminLocked
              ? "إعلان إداري"
              : dailyCapLocked
                ? "سقف اليوم"
                : stageLocked
                  ? "فاصل بين المراحل"
                  : "انتهت الجلسة"}
          </span>
          <h1>
            {adminLocked
              ? "المراحل مغلقة مؤقتًا"
              : dailyCapLocked
                ? "أخذت قسطك اليوم"
                : stageLocked
                  ? "استراحة قصيرة بين المراحل"
                  : "خذ قسطًا من الراحة"}
          </h1>
          {adminLocked ? (
            <>
              <p>{lockMessage || "أوقفت الإدارة فتح مراحل جديدة حاليًا. يمكنك مراجعة نتائجك السابقة والعودة لاحقًا."}</p>
              <div className="inline-alert inline-alert--gold">
                <LockIcon />
                <span>سيُرفع الإغلاق من لوحة تحكم الإدارة، وسيعمل زر المرحلة مباشرة بعدها.</span>
              </div>
            </>
          ) : (
            <>
              <p>
                {dailyCapLocked
                  ? lockMessage ||
                    "وصلت إلى سقف الأسئلة اليومي. هذه استراحة لحماية تركيزك، وسيعود السقف بعد منتصف الليل."
                  : stageLocked
                    ? "الخطة تحدد فاصلًا زمنيًا بين المراحل حتى يثبت ما تعلمته. المرحلة التالية تبدأ بعد:"
                    : "المراجعة المتباعدة تحتاج فاصلًا حتى يثبت ما تعلمته. الجلسة التالية تبدأ بعد:"}
              </p>
              <div className="session-card__countdown">
                <Countdown target={lockTarget} />
              </div>
              <p className="muted small">
                {dailyCapLocked
                  ? "عد بعد منتصف الليل لتكمل بسقف جديد. لا تحتاج إلى البقاء في الصفحة."
                  : "لا تحتاج إلى البقاء في الصفحة؛ سيعود العدّاد عند فتحها مرة أخرى."}
              </p>
            </>
          )}
          <div className="button-row">
            <Link to={`/subject/${subjectId}`} className="button button--primary">
              العودة للمادة
            </Link>
            <Link to="/" className="button button--ghost">
              الرئيسية
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "completed") {
    return (
      <div className="page">
        <div className="session-card session-card--success">
          <div className="session-card__icon"><AwardIcon /></div>
          <span className="eyebrow">أكملت المادة</span>
          <h1>تغطية كاملة وإتقان!</h1>
          <p>لقد مررت على كل أسئلة المادة ووصلت إلى نسبة الإتقان المطلوبة.</p>
          {settings.finalExamReminder ? (
            <p className="muted small">{settings.finalExamReminder}</p>
          ) : null}
          <p className="muted small">{settings.certificateNotice}</p>
          <div className="button-row">
            <Link to={`/completion/${subjectId}`} className="button button--gold">
              <AwardIcon />
              {settings.certificateClaimsEnabled ? "عرض الشهادة" : "عرض سجل الإتمام"}
            </Link>
            <Link to={`/subject/${subjectId}`} className="button button--ghost">
              بطاقة المادة
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "results") {
    const nextAvailableAt = toMillis(resultMeta?.nextAvailableAt);
    const gradedResults = results.filter((result) => result.isCorrect !== null);
    const displayScore = gradedResults.length
      ? Math.round(
          (gradedResults.filter((result) => result.isCorrect === true).length /
            gradedResults.length) *
            100,
        )
      : null;
    const pendingSelf = results.some(
      (result) => result.grading === "self" && result.isCorrect === null,
    );
    const perfect = displayScore === 100 && !pendingSelf;
    return (
      <div className="page results-page">
        <div className="result-summary">
          <div className={`result-summary__score${perfect ? " is-perfect" : ""}`}>
            <span>{displayScore === null ? "—" : formatNumber(displayScore)}</span>
            {displayScore === null ? null : <small>%</small>}
          </div>
          <div className="result-summary__text">
            <span className="eyebrow">
              <SparklesIcon />
              {feedbackMode ? "مراجعة المرحلة السابقة" : "تم تسليم المرحلة"}
            </span>
            <h1>{perfect ? "أداء ممتاز!" : "خطوة أخرى نحو الإتقان"}</h1>
            <p>
              راجع الإجابات النموذجية أدناه. لن تبدأ المرحلة التالية حتى تؤكد أنك اطلعت عليها.
            </p>
            {resultMeta?.sessionComplete ? (
              <div className="inline-alert inline-alert--gold">
                <ClockIcon />
                <span>
                  انتهت الجلسة. المرحلة التالية متاحة بعد{" "}
                  <Countdown target={nextAvailableAt} />
                </span>
              </div>
            ) : (resultMeta?.nextStageIntervalMinutes ??
              resultMeta?.stageIntervalMinutes) ? (
              <div className="inline-alert inline-alert--gold">
                <ClockIcon />
                <span>
                  بعد تأكيد الاطلاع، تبدأ المرحلة التالية بعد{" "}
                  <strong>
                    {formatNumber(
                      resultMeta.nextStageIntervalMinutes ??
                        resultMeta.stageIntervalMinutes,
                    )}
                  </strong>{" "}
                  دقيقة.
                </span>
              </div>
            ) : null}
            {resultMeta?.adaptiveLevelChanged ? (
              <div className="inline-alert inline-alert--gold">
                <SparklesIcon />
                <span>
                  {resultMeta.adaptiveLevelChanged === "up"
                    ? `ترقيت إلى مستوى «${resultMeta.adaptiveLevelName ?? ""}».`
                    : `عدنا بك إلى مستوى «${resultMeta.adaptiveLevelName ?? ""}» لزيادة المراجعة.`}
                </span>
              </div>
            ) : null}
            {!resultMeta?.sessionComplete &&
            resultMeta?.nextStageNew !== undefined &&
            resultMeta?.nextStageReview !== undefined ? (
              <div className="inline-alert">
                <RefreshIcon />
                <span>
                  المرحلة القادمة: {formatNumber(resultMeta.nextStageNew)} جديد +{" "}
                  {formatNumber(resultMeta.nextStageReview)} مراجعة.
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {error ? <div className="alert alert--error">{error}</div> : null}

        <div className="result-list">
          {results.map((result, index) => {
            const chosenSelf = selfGraded[result.questionId] ?? result.selfScore ?? null;
            const selfPending = result.grading === "self" && result.isCorrect === null;
            const isCorrect = result.isCorrect === true;
            const isWrong = result.isCorrect === false;
            const optionIndex = correctOptionIndex(result.modelAnswer);
            const options = optionsList(result.options);

            return (
              <article className={`result-card${isCorrect ? " is-correct" : isWrong ? " is-wrong" : ""}`} key={result.questionId}>
                <div className="result-card__top">
                  <span className="result-card__number">سؤال {formatNumber(index + 1)}</span>
                  <span className="result-card__type">{questionTypeLabel(result.type)}</span>
                  <span className={`badge ${isCorrect ? "badge--green" : isWrong ? "badge--red" : "badge--gold"}`}>
                    {isCorrect ? <><CheckIcon /> صحيح</> : isWrong ? <><XIcon /> يحتاج مراجعة</> : <><SparklesIcon /> تقييم ذاتي</>}
                  </span>
                </div>

                <h2>{result.text || "سؤال"}</h2>

                {result.type === "mcq" && options.length > 0 ? (
                  <div className="result-options">
                    {options.map((option, optionIndexValue) => (
                      <div
                        className={`result-option${optionIndex === optionIndexValue ? " is-correct-answer" : ""}`}
                        key={optionIndexValue}
                      >
                        <span className="result-option__letter">
                          {optionLetter(optionIndexValue)}
                        </span>
                        <span>{optionText(option, optionIndexValue)}</span>
                        {optionIndex === optionIndexValue ? <CheckIcon /> : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="answer-box">
                  <span>إجابتك</span>
                  <p>{formatAnswer(result.answer, result.options)}</p>
                </div>

                <div className="answer-box answer-box--model">
                  <span>الإجابة النموذجية</span>
                  <p>{formatModelAnswer(result.modelAnswer, result.options)}</p>
                </div>

                {result.explanation ? (
                  <div className="explanation">
                    <strong>شرح</strong>
                    <p>{result.explanation}</p>
                  </div>
                ) : null}

                {selfPending ? (
                  <div className="self-grade">
                    <div>
                      <strong>قيّم إجابتك بعد مقارنتها بالنموذج</strong>
                      <p>التقييم الذاتي يحدد هل يُحتسب السؤال متقنًا.</p>
                    </div>
                    <div className="self-grade__buttons">
                      <button
                        className={`button button--sm${chosenSelf === "correct" ? " button--primary" : " button--ghost"}`}
                        type="button"
                        disabled={busy || Boolean(chosenSelf)}
                        onClick={() => void gradeSelf(result.questionId, "correct")}
                      >
                        <CheckIcon /> صحيح
                      </button>
                      <button
                        className={`button button--sm${chosenSelf === "partial" ? " button--gold" : " button--ghost"}`}
                        type="button"
                        disabled={busy || Boolean(chosenSelf)}
                        onClick={() => void gradeSelf(result.questionId, "partial")}
                      >
                        جزئي
                      </button>
                      <button
                        className={`button button--sm${chosenSelf === "wrong" ? " button--danger" : " button--ghost"}`}
                        type="button"
                        disabled={busy || Boolean(chosenSelf)}
                        onClick={() => void gradeSelf(result.questionId, "wrong")}
                      >
                        <XIcon /> خطأ
                      </button>
                    </div>
                  </div>
                ) : null}

                {result.grading === "self" && chosenSelf ? (
                  <div className="self-grade self-grade--done">
                    <span>تقييمك: <strong>{chosenSelf === "correct" ? "صحيح" : chosenSelf === "partial" ? "جزئي" : "خطأ"}</strong></span>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        <div className="sticky-actions">
          <div className="sticky-actions__info">
            {pendingSelfGrades ? (
              <span className="muted">قيّم كل الإجابات الذاتية للمتابعة.</span>
            ) : resultMeta?.sessionComplete ? (
              <span className="muted">انتهت الجلسة الحالية.</span>
            ) : (
              <span className="muted">الإجابة النموذجية ظاهرة الآن.</span>
            )}
          </div>
          <button
            className="button button--primary button--lg"
            type="button"
            onClick={() => void continueAfterResults()}
            disabled={busy || pendingSelfGrades}
          >
            {busy ? "لحظة..." : resultMeta?.sessionComplete ? "تم الاطلاع، أنهِ الجلسة" : "تم الاطلاع، المرحلة التالية"}
            <ChevronLeftIcon />
          </button>
        </div>
      </div>
    );
  }

  if (!stage || !currentQuestion) {
    return (
      <div className="page">
        <EmptyState
          title="لا توجد أسئلة"
          description="هذه المرحلة لا تحتوي على أسئلة قابلة للعرض."
          action={<Link to={`/subject/${subjectId}`} className="button button--primary">العودة للمادة</Link>}
        />
      </div>
    );
  }

  const isLast = currentIndex === questions.length - 1;
  const currentAnswer = answers[currentQuestion.questionId];
  const currentAnswered = isAnswered(currentQuestion, currentAnswer);
  const options = optionsList(currentQuestion.options);

  return (
    <div className="page stage-page">
      <div className="stage-topbar">
        <button className="icon-button icon-button--text" type="button" onClick={() => navigate(`/subject/${subjectId}`)} aria-label="العودة للمادة">
          <ArrowLeftIcon />
          <span>المادة</span>
        </button>
        <div className="stage-topbar__meta">
          <span>المرحلة {formatNumber(stage.stageNo)}</span>
          <span className="dot" />
          <span>الجلسة {formatNumber(stage.sessionNo)}</span>
        </div>
        <span className="badge badge--soft">{formatNumber(answeredCount)} / {formatNumber(questions.length)}</span>
      </div>

      <div className="stage-progress">
        {questions.map((question, index) => (
          <button
            key={question.questionId}
            type="button"
            className={`stage-dot${index === currentIndex ? " is-current" : ""}${isAnswered(question, answers[question.questionId]) ? " is-answered" : ""}`}
            onClick={() => setCurrentIndex(index)}
            aria-label={`السؤال ${index + 1}`}
          >
            {isAnswered(question, answers[question.questionId]) ? <CheckIcon /> : formatNumber(index + 1)}
          </button>
        ))}
      </div>

      <article className="question-card" key={currentQuestion.questionId}>
        <div className="question-card__top">
          <div>
            <span className="eyebrow">
              {currentQuestion.isReview ? <><RefreshIcon /> مراجعة</> : <><SparklesIcon /> سؤال جديد</>}
            </span>
            <span className="question-card__type">{questionTypeLabel(currentQuestion.type)}</span>
          </div>
          <span className="question-card__position">
            {formatNumber(currentQuestion.position)} / {formatNumber(questions.length)}
          </span>
        </div>

        <h1>{currentQuestion.text}</h1>

        {currentQuestion.type === "mcq" ? (
          <div className="option-list">
            {options.length > 0 ? options.map((option, index) => {
              const selected = answerObject(currentQuestion, currentAnswer).index === index;
              return (
                <button
                  key={index}
                  type="button"
                  className={`option-button${selected ? " is-selected" : ""}`}
                  onClick={() => setAnswer(currentQuestion.questionId, { index })}
                >
                  <span className="option-button__letter">{optionLetter(index)}</span>
                  <span>{optionText(option, index)}</span>
                  <span className="option-button__check">{selected ? <CheckIcon /> : null}</span>
                </button>
              );
            }) : (
              <div className="alert alert--error">هذا السؤال لا يحتوي على خيارات. أبلغ المشرف.</div>
            )}
          </div>
        ) : currentQuestion.type === "true_false" ? (
          <div className="tf-list">
            {[
              { value: true, label: "صح", icon: <CheckIcon /> },
              { value: false, label: "خطأ", icon: <XIcon /> },
            ].map((choice) => {
              const selected = answerObject(currentQuestion, currentAnswer).value === choice.value;
              return (
                <button
                  key={choice.label}
                  type="button"
                  className={`tf-button${selected ? " is-selected" : ""}`}
                  onClick={() => setAnswer(currentQuestion.questionId, { value: choice.value })}
                >
                  {choice.icon}
                  <span>{choice.label}</span>
                </button>
              );
            })}
          </div>
        ) : currentQuestion.type === "fill_blank" ? (
          <label className="field">
            <span>أكمل الفراغ</span>
            <input
              className="input input--lg"
              value={String(answerObject(currentQuestion, currentAnswer).text ?? "")}
              onChange={(event) => setAnswer(currentQuestion.questionId, { text: event.target.value })}
              placeholder="اكتب الإجابة هنا..."
              autoFocus
            />
          </label>
        ) : (
          <label className="field">
            <span>{currentQuestion.type === "essay" ? "اكتب إجابتك المقالية" : "اكتب إجابتك"}</span>
            <textarea
              className="textarea"
              rows={currentQuestion.type === "essay" ? 8 : 4}
              value={String(answerObject(currentQuestion, currentAnswer).text ?? "")}
              onChange={(event) => setAnswer(currentQuestion.questionId, { text: event.target.value })}
              placeholder="اكتب ما تتذكره، ثم قارنه بالإجابة النموذجية بعد التسليم."
              autoFocus
            />
          </label>
        )}

        <div className="question-card__hint">
          <FlagIcon />
          <span>
            {currentQuestion.isReview
              ? "سؤال مراجعة: ظهر سابقًا، والهدف تثبيته."
              : "سؤال جديد: سيظهر مرة أخرى لاحقًا ضمن المراجعة."}
          </span>
        </div>
      </article>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <div className="stage-nav">
        <button
          className="button button--ghost"
          type="button"
          disabled={currentIndex === 0}
          onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
        >
          السابق
        </button>
        <span className="muted small">
          {formatNumber(answeredCount)} من {formatNumber(questions.length)} تمت الإجابة
        </span>
        {isLast ? (
          <button
            className="button button--primary"
            type="button"
            disabled={!allAnswered || busy}
            onClick={() => void submitStage()}
          >
            {busy ? "جارٍ التسليم..." : "تسليم المرحلة"}
            <ChevronLeftIcon />
          </button>
        ) : (
          <button
            className="button button--primary"
            type="button"
            disabled={!currentAnswered}
            onClick={() => setCurrentIndex((index) => Math.min(questions.length - 1, index + 1))}
          >
            التالي
            <ChevronLeftIcon />
          </button>
        )}
      </div>
    </div>
  );
}
