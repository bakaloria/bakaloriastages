import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { Countdown } from "../components/Countdown";
import { EmptyState } from "../components/EmptyState";
import {
  ArrowLeftIcon,
  AwardIcon,
  BookIcon,
  ChevronLeftIcon,
  ClockIcon,
  LockIcon,
  PlayIcon,
  SparklesIcon,
  TrophyIcon,
} from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import { ProgressRing } from "../components/ProgressRing";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { db } from "../lib/firebase";
import { errorMessage } from "../lib/errors";
import {
  branchLabel,
  formatNumber,
  formatPercent,
  progressRatio,
  toMillis,
} from "../lib/format";
import type { Subject, SubjectProgress } from "../lib/types";

export function SubjectPage() {
  const { subjectId = "" } = useParams();
  const navigate = useNavigate();
  const { settings } = useAuth();
  const [subject, setSubject] = useState<Subject | null>(null);
  const [progress, setProgress] = useState<SubjectProgress | null>(null);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  const loadProgress = useCallback(async () => {
    if (!subjectId) return;
    try {
      const nextProgress = await api.getSubjectProgress(subjectId);
      setProgress(nextProgress);
      setEnrolled(true);
    } catch (caught) {
      const message = errorMessage(caught);
      if (message === "أنت غير منضم لهذه المادة.") {
        setProgress(null);
        setEnrolled(false);
      } else {
        setError(message);
      }
    }
  }, [subjectId]);

  useEffect(() => {
    const targets = [
      toMillis(progress?.nextAvailableAt),
      toMillis(progress?.stageAvailableAt),
    ].filter((value): value is number => value !== null);
    if (targets.length === 0) return;
    const next = Math.min(...targets);
    const delay = next - Date.now();
    if (delay <= 0) {
      void loadProgress();
      return;
    }
    const timer = window.setTimeout(() => void loadProgress(), delay + 500);
    return () => window.clearTimeout(timer);
  }, [progress?.nextAvailableAt, progress?.stageAvailableAt, loadProgress]);

  useEffect(() => {
    let active = true;
    async function load() {
      if (!db || !subjectId) return;
      setLoading(true);
      setError("");
      try {
        const subjectSnap = await getDoc(doc(db, "subjects", subjectId));
        if (!active) return;
        if (subjectSnap.exists()) {
          setSubject({ id: subjectSnap.id, ...(subjectSnap.data() as Omit<Subject, "id">) });
        } else {
          setError("المادة غير موجودة.");
        }
        await loadProgress();
      } catch (caught) {
        if (active) setError(errorMessage(caught));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [subjectId, loadProgress]);

  async function join() {
    setJoining(true);
    setError("");
    try {
      await api.joinSubject(subjectId);
      await loadProgress();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setJoining(false);
    }
  }

  if (loading) {
    return (
      <div className="page">
        <InlineLoader label="نفتح المادة..." />
      </div>
    );
  }

  if (!subject) {
    return (
      <div className="page">
        <EmptyState
          title="المادة غير موجودة"
          description={error || "تحقق من الرابط أو عُد إلى الصفحة الرئيسية."}
          action={
            <Link to="/" className="button button--primary">
              العودة للرئيسية
            </Link>
          }
        />
      </div>
    );
  }

  const total = Number(progress?.totalQuestions ?? subject.totalQuestions ?? 0);
  const covered = Number(progress?.coverageCount ?? 0);
  const mastered = Number(progress?.masteryCount ?? 0);
  const masteryTarget = Number(progress?.masteryTarget ?? total);
  const nextAvailableAt = toMillis(progress?.nextAvailableAt);
  const stageAvailableAt = toMillis(progress?.stageAvailableAt);
  const locked = Boolean(nextAvailableAt && nextAvailableAt > Date.now());
  const stageLocked = Boolean(stageAvailableAt && stageAvailableAt > Date.now());
  const stagesLocked = Boolean(progress?.stagesLocked);
  const completed = Boolean(progress?.completedAt);
  const canClaim = completed || (total > 0 && covered >= total && mastered >= masteryTarget);

  return (
    <div className="page subject-page">
      <div className="breadcrumb">
        <Link to="/">
          <ArrowLeftIcon />
          الرئيسية
        </Link>
        <span>/</span>
        <span>{subject.name}</span>
      </div>

      <section className="subject-hero" style={{ "--subject-color": subject.color || "#0f5a4e" } as CSSProperties}>
        <div className="subject-hero__info">
          <span className="eyebrow">
            <BookIcon />
            {subject.branches?.length
              ? subject.branches.map((branch) => branchLabel(branch)).join(" • ")
              : "مادة دراسية"}
          </span>
          <h1>{subject.name}</h1>
          <p>{subject.description || "مادة تراكمية: كل مرحلة تضيف أسئلة جديدة وتراجع ما تعلمته."}</p>
          <div className="subject-hero__meta">
            <span><strong>{formatNumber(total)}</strong> سؤالًا</span>
            <span><strong>{formatNumber(progress?.byUnit?.length ?? 0)}</strong> وحدات</span>
            <span><strong>{formatNumber(progress?.sessionNo ?? 1)}</strong> الجلسة الحالية</span>
          </div>
        </div>

        <div className="subject-hero__ring">
          <ProgressRing
            value={covered}
            total={total}
            size={164}
            stroke={12}
            label="التغطية"
            sublabel={`${formatNumber(covered)} / ${formatNumber(total)}`}
          />
        </div>
      </section>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <div className="subject-actions">
        {enrolled === false ? (
          <button className="button button--primary button--lg" type="button" onClick={() => void join()} disabled={joining}>
            {joining ? "جارٍ الانضمام..." : "انضم إلى المادة وابدأ"}
            <SparklesIcon />
          </button>
        ) : canClaim ? (
          <div className="completion-callout">
            <span className="completion-callout__icon"><AwardIcon /></span>
            <div className="completion-callout__text">
              <strong>أكملت مراجعة المادة</strong>
              <span>
                {settings.finalExamReminder ||
                  "واصل المراجعة استعدادًا لامتحان الشهادة الأخير."}
              </span>
              <small>{settings.certificateNotice}</small>
            </div>
            <Link to={`/completion/${subject.id}`} className="button button--gold">
              <AwardIcon />
              {settings.certificateClaimsEnabled ? "عرض شهادة الإتمام" : "عرض سجل الإتمام"}
            </Link>
          </div>
        ) : stagesLocked ? (
          <div className="locked-action locked-action--admin">
            <span className="locked-action__icon"><LockIcon /></span>
            <div>
              <strong>المراحل مغلقة مؤقتًا</strong>
              <span className="muted small">
                {progress?.lockMessage || "أوقفت الإدارة فتح مراحل جديدة حاليًا."}
              </span>
            </div>
          </div>
        ) : locked ? (
          <div className="locked-action">
            <span className="locked-action__icon"><LockIcon /></span>
            <div>
              <strong>الجلسة التالية بعد</strong>
              <Countdown target={nextAvailableAt} />
            </div>
            <span className="muted small">فاصل الجلسة الذي حددته الإدارة.</span>
          </div>
        ) : stageLocked ? (
          <div className="locked-action">
            <span className="locked-action__icon"><ClockIcon /></span>
            <div>
              <strong>المرحلة التالية بعد</strong>
              <Countdown target={stageAvailableAt} />
            </div>
            <span className="muted small">فاصل بين المراحل حددته الإدارة.</span>
          </div>
        ) : (
          <button className="button button--primary button--lg" type="button" onClick={() => navigate(`/stage/${subject.id}`)}>
            <PlayIcon />
            {covered === 0 ? "ابدأ المرحلة الأولى" : "تابع المرحلة التالية"}
          </button>
        )}

        <Link to={`/leaderboard/${subject.id}`} className="button button--ghost">
          <TrophyIcon />
          ترتيب المادة
        </Link>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-card__label">التغطية</span>
          <strong>{formatPercent(covered, total)}</strong>
          <div className="progress-bar"><span style={{ width: `${Math.round(progressRatio(covered, total) * 100)}%` }} /></div>
          <small>{formatNumber(covered)} من {formatNumber(total)} سؤالًا</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__label">الإتقان</span>
          <strong>{formatPercent(mastered, total)}</strong>
          <div className="progress-bar progress-bar--gold"><span style={{ width: `${Math.round(progressRatio(mastered, total) * 100)}%` }} /></div>
          <small>{formatNumber(mastered)} متقن، الهدف {formatNumber(masteryTarget)}</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__label">داخل الجلسة</span>
          <strong>{formatNumber(progress?.stagesInSession ?? 0)} / {formatNumber(progress?.sessionStages ?? 10)}</strong>
          <small>مراحل مكتملة في الجلسة الحالية</small>
        </div>
        <div className="stat-card">
          <span className="stat-card__label">حالة المادة</span>
          <strong className="stat-card__status">
            {completed ? "مكتملة" : enrolled ? "قيد التقدم" : "لم تنضم بعد"}
          </strong>
          <small>
            {completed
              ? settings.certificateClaimsEnabled
                ? "يمكنك عرض الشهادة"
                : "مراجعة المادة مكتملة"
              : "أكمل التغطية والإتقان"}
          </small>
        </div>
      </div>

      <section className="section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">الوحدات</span>
            <h2>خريطة تقدمك</h2>
          </div>
          <span className="muted small">
            <ClockIcon /> الجلسة {formatNumber(progress?.sessionNo ?? 1)}
          </span>
        </div>

        {progress?.byUnit?.length ? (
          <div className="unit-list">
            {progress.byUnit.map((unit, index) => (
              <div className="unit-row" key={unit.unitId}>
                <span className="unit-row__index">{formatNumber(index + 1)}</span>
                <div className="unit-row__content">
                  <div className="unit-row__heading">
                    <h3>{unit.title || `الوحدة ${index + 1}`}</h3>
                    <span>{formatPercent(unit.seen, unit.total)}</span>
                  </div>
                  <div className="progress-bar">
                    <span style={{ width: `${Math.round(progressRatio(unit.seen, unit.total) * 100)}%` }} />
                  </div>
                  <div className="unit-row__meta">
                    <span>{formatNumber(unit.seen)} / {formatNumber(unit.total)} مغطى</span>
                    <span>{formatNumber(unit.mastered)} متقن</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="ستظهر الوحدات هنا"
            description="بعد استيراد الأسئلة وتقسيمها إلى وحدات، سترى تقدمك في كل وحدة."
            icon={<BookIcon />}
          />
        )}
      </section>
    </div>
  );
}
