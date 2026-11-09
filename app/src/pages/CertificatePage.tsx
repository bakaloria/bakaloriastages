import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { doc, getDoc } from "firebase/firestore";
import { AwardIcon, CheckIcon, ChevronLeftIcon, SparklesIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";
import { FullScreenLoader } from "../components/Loading";
import { BrandMark } from "../components/Layout";
import { api } from "../lib/api";
import { db } from "../lib/firebase";
import { errorMessage } from "../lib/errors";
import { formatDate, formatNumber } from "../lib/format";
import type { Certificate, Subject } from "../lib/types";

export function CertificatePage() {
  const { subjectId = "" } = useParams();
  const [certificate, setCertificate] = useState<Certificate | null>(null);
  const [subject, setSubject] = useState<Subject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        if (db && subjectId) {
          const subjectSnap = await getDoc(doc(db, "subjects", subjectId));
          if (active && subjectSnap.exists()) {
            setSubject({ id: subjectSnap.id, ...(subjectSnap.data() as Omit<Subject, "id">) });
          }
        }
        const response = await api.claimCertificate(subjectId);
        if (active) setCertificate(response.certificate);
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
  }, [subjectId]);

  if (loading) return <FullScreenLoader label="نصدر شهادتك..." />;

  if (error || !certificate) {
    return (
      <div className="page">
        <EmptyState
          title="الشهادة غير متاحة بعد"
          description={error || "أكمل تغطية المادة والإتقان المطلوب أولًا."}
          icon={<AwardIcon />}
          action={
            <div className="button-row">
              <Link to={`/subject/${subjectId}`} className="button button--primary">
                العودة للمادة
              </Link>
              <Link to="/progress" className="button button--ghost">
                عرض تقدمي
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="page certificate-page">
      <div className="certificate-toolbar">
        <Link to={`/subject/${subjectId}`} className="button button--ghost">
          <ChevronLeftIcon />
          العودة للمادة
        </Link>
        <button className="button button--primary" type="button" onClick={() => window.print()}>
          طباعة / حفظ PDF
        </button>
      </div>

      <article className="certificate" id="certificate">
        <div className="certificate__pattern" aria-hidden="true" />
        <div className="certificate__border" aria-hidden="true" />

        <header className="certificate__header">
          <div className="certificate__brand">
            <BrandMark />
            <span>مراحل البكالوريا</span>
          </div>
          <span className="certificate__label">شهادة إتمام</span>
        </header>

        <div className="certificate__body">
          <span className="certificate__eyebrow">
            <SparklesIcon />
            شهادة معتمدة داخل التطبيق
          </span>
          <h1>شهادة إتمام المادة</h1>
          <p className="certificate__intro">تشهد منصة مراحل البكالوريا بأن الطالب</p>
          <strong className="certificate__name">{certificate.displayName}</strong>
          <p className="certificate__intro">قد أكمل بنجاح متطلبات مادة</p>
          <strong className="certificate__subject">{subject?.name || certificate.subjectId}</strong>

          <div className="certificate__stats">
            <div>
              <span>التغطية</span>
              <strong>{formatNumber(certificate.coverageCount)} / {formatNumber(certificate.totalQuestions)}</strong>
            </div>
            <div>
              <span>الإتقان</span>
              <strong>{formatNumber(certificate.masteryCount)} سؤالًا</strong>
            </div>
            <div>
              <span>تاريخ الإصدار</span>
              <strong>{formatDate(certificate.issuedAt)}</strong>
            </div>
          </div>

          <div className="certificate__footer">
            <div>
              <span>رمز التحقق</span>
              <strong dir="ltr">{certificate.code}</strong>
            </div>
            <div className="certificate__seal">
              <AwardIcon />
              <span>مكتملة</span>
            </div>
            <div>
              <span>الحالة</span>
              <strong><CheckIcon /> معتمدة</strong>
            </div>
          </div>
        </div>
      </article>

      <p className="muted small certificate-note">
        هذه الشهادة توثّق إتمامك داخل التطبيق، وليست شهادة رسمية من وزارة التربية.
      </p>
    </div>
  );
}
