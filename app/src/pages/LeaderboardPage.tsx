import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { EmptyState } from "../components/EmptyState";
import { AwardIcon, SparklesIcon, TrophyIcon } from "../components/Icons";
import { InlineLoader } from "../components/Loading";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { db } from "../lib/firebase";
import { errorMessage } from "../lib/errors";
import { formatNumber } from "../lib/format";
import type { LeaderboardRow, Subject } from "../lib/types";

export function LeaderboardPage() {
  const { subjectId } = useParams();
  const { profile } = useAuth();
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedId, setSelectedId] = useState(subjectId ?? "");
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!db || !profile) return;
    const subjectsQuery = query(
      collection(db, "subjects"),
      where("branches", "array-contains", profile.branch),
      where("active", "==", true),
      orderBy("sort", "asc"),
    );
    return onSnapshot(
      subjectsQuery,
      (snapshot) => {
        const nextSubjects = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as Omit<Subject, "id">),
        }));
        setSubjects(nextSubjects);
        setSelectedId((current) => current || subjectId || nextSubjects[0]?.id || "");
      },
      () => undefined,
    );
  }, [profile, subjectId]);

  useEffect(() => {
    if (subjectId && subjectId !== selectedId) setSelectedId(subjectId);
  }, [subjectId, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    api
      .getLeaderboard(selectedId)
      .then((response) => {
        if (active) setRows(response.rows);
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  const selectedSubject = useMemo(
    () => subjects.find((subject) => subject.id === selectedId),
    [subjects, selectedId],
  );

  const topThree = rows.slice(0, 3);

  return (
    <div className="page leaderboard-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">
            <TrophyIcon />
            ترتيب المادة
          </span>
          <h1>المتصدرون</h1>
          <p>الترتيب يعتمد على الإجابات الصحيحة من أول محاولة في الأسئلة المصححة آليًا.</p>
        </div>
        <div className="page-heading__badge">
          <AwardIcon />
          <span>الأسئلة الآلية فقط</span>
        </div>
      </section>

      <div className="subject-tabs" role="tablist" aria-label="اختر المادة">
        {subjects.map((subject) => (
          <button
            key={subject.id}
            type="button"
            role="tab"
            aria-selected={subject.id === selectedId}
            className={subject.id === selectedId ? "is-active" : ""}
            onClick={() => setSelectedId(subject.id)}
          >
            <span>{subject.icon || "📘"}</span>
            {subject.name}
          </button>
        ))}
      </div>

      {error ? <div className="alert alert--error">{error}</div> : null}

      {loading ? (
        <InlineLoader label="نحمّل الترتيب..." />
      ) : !selectedId || rows.length === 0 ? (
        <EmptyState
          title="لا يوجد متصدرون بعد"
          description={
            selectedSubject
              ? `كن أول من يبدأ في مادة ${selectedSubject.name}.`
              : "اختر مادة للبدء، أو انضم إلى مادة من الصفحة الرئيسية."
          }
          action={<Link to="/" className="button button--primary">اختر مادة</Link>}
          icon={<TrophyIcon />}
        />
      ) : (
        <>
          <div className="podium">
            {topThree.map((row, index) => {
              const medals = ["🥇", "🥈", "🥉"];
              const own = row.userId === profile?.uid;
              return (
                <div className={`podium-card podium-card--${index + 1}${own ? " is-own" : ""}`} key={row.userId}>
                  <span className="podium-card__medal">{medals[index]}</span>
                  <span className="podium-card__rank">#{formatNumber(row.rank)}</span>
                  <strong>{row.displayName}</strong>
                  <span className="podium-card__score">
                    {formatNumber(row.autoFirstCorrect)}
                    <small>إجابة أولى صحيحة</small>
                  </span>
                  <div className="podium-card__meta">
                    <span>{formatNumber(row.masteryCount)} متقن</span>
                    <span>{formatNumber(row.coverageCount)} مغطى</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="leaderboard-table">
            <div className="leaderboard-table__head">
              <span>الترتيب</span>
              <span>الطالب</span>
              <span>أول محاولة</span>
              <span>الإتقان</span>
              <span>التغطية</span>
            </div>
            {rows.map((row) => {
              const own = row.userId === profile?.uid;
              return (
                <div className={`leaderboard-row${own ? " is-own" : ""}`} key={row.userId}>
                  <span className="leaderboard-row__rank">
                    {row.rank <= 3 ? ["🥇", "🥈", "🥉"][row.rank - 1] : formatNumber(row.rank)}
                  </span>
                  <span className="leaderboard-row__name">
                    <span className="avatar">{(row.displayName || "ط").slice(0, 1)}</span>
                    <span>
                      <strong>{row.displayName}</strong>
                      {own ? <small><SparklesIcon /> أنت</small> : null}
                    </span>
                  </span>
                  <span><strong>{formatNumber(row.autoFirstCorrect)}</strong></span>
                  <span>{formatNumber(row.masteryCount)}</span>
                  <span>{formatNumber(row.coverageCount)} / {formatNumber(row.totalQuestions)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
