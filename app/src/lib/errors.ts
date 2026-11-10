const MESSAGES: Record<string, string> = {
  FIREBASE_NOT_CONFIGURED: "لم يتم إعداد Firebase بعد. أضف إعدادات المشروع أولًا.",
  AUTH_REQUIRED: "جلستك انتهت. سجّل الدخول من جديد.",
  "auth/invalid-credential": "اسم المستخدم أو كلمة المرور غير صحيحة.",
  "auth/user-not-found": "اسم المستخدم أو كلمة المرور غير صحيحة.",
  "auth/wrong-password": "اسم المستخدم أو كلمة المرور غير صحيحة.",
  "auth/invalid-email": "اسم المستخدم غير صالح.",
  "auth/too-many-requests": "محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.",
  "auth/network-request-failed": "تعذر الاتصال بالشبكة. تحقق من الإنترنت.",
  "auth/email-already-in-use": "اسم المستخدم محجوز.",
  "auth/configuration-not-found": "خدمة تسجيل الدخول غير مفعّلة في مشروع Firebase بعد. فعّل Email/Password من Firebase Console.",
  "auth/operation-not-allowed": "تسجيل الدخول بالبريد غير مفعّل في Firebase. فعّل Email/Password أولًا.",
  "auth/app-not-authorized": "هذا النطاق غير مصرّح به في Firebase Authentication.",
  "permission-denied": "لا تملك صلاحية لهذا الإجراء.",
  "unavailable": "تعذر الاتصال بخدمة Firebase. تحقق من إعداد المشروع والإنترنت.",
  "functions/already-exists": "اسم المستخدم محجوز.",
  "functions/unauthenticated": "جلستك انتهت. سجّل الدخول من جديد.",
  "functions/permission-denied": "لا تملك صلاحية لهذا الإجراء.",
  "functions/not-found": "العنصر المطلوب غير موجود.",
  "functions/unavailable": "الخادم غير متاح حاليًا. حاول لاحقًا.",
  "functions/internal": "حدث خطأ في الخادم. حاول مرة أخرى.",
  USERNAME_TAKEN: "اسم المستخدم محجوز. اختر اسمًا آخر.",
  USERNAME_INVALID: "اسم المستخدم يجب أن يكون 3–20 حرفًا إنجليزيًا أو أرقامًا أو _.",
  PASSWORD_INVALID: "كلمة المرور يجب أن تكون 6 أحرف على الأقل.",
  BRANCH_INVALID: "اختر الفرع الدراسي.",
  SUBJECT_NOT_FOUND: "المادة غير موجودة أو غير مفعّلة.",
  SUBJECT_ID_REQUIRED: "لم يتم تحديد المادة.",
  NO_QUESTIONS_AVAILABLE: "لا توجد أسئلة متاحة في هذه المادة بعد.",
  ATTEMPT_ID_REQUIRED: "جلسة المرحلة غير صالحة.",
  ATTEMPT_NOT_FOUND: "جلسة المرحلة غير موجودة.",
  ATTEMPT_NOT_OWNED: "جلسة المرحلة لا تخص حسابك.",
  ATTEMPT_ALREADY_SUBMITTED: "تم تسليم هذه المرحلة بالفعل.",
  ATTEMPT_NOT_SUBMITTED: "لم يتم تسليم هذه المرحلة بعد.",
  ATTEMPT_EMPTY: "المرحلة لا تحتوي على أسئلة.",
  QUESTION_NOT_FOUND: "تعذر تحميل أحد الأسئلة.",
  SELF_GRADE_REQUIRED: "قيّم إجاباتك الذاتية أولًا قبل المتابعة.",
  SELF_GRADE_NOT_PENDING: "تم تقييم هذا السؤال بالفعل.",
  SELF_SCORE_INVALID: "اختر تقييمًا صحيحًا.",
  NOT_ENROLLED: "أنت غير منضم لهذه المادة.",
  ENROLLMENT_NOT_FOUND: "لم يتم العثور على سجل المادة.",
  PROGRESS_NOT_FOUND: "لم يتم العثور على تقدم هذا السؤال.",
  COVERAGE_INCOMPLETE: "لم تُكمل كل أسئلة المادة بعد.",
  MASTERY_INCOMPLETE: "لم تصل إلى نسبة الإتقان المطلوبة بعد.",
  FINAL_EXAM_REQUIRED: "يجب اجتياز الامتحان الختامي أولًا.",
  SUBJECT_EMPTY: "المادة لا تحتوي على أسئلة.",
  SUBJECT_NOT_COMPLETED: "لم تكتمل شروط الشهادة بعد.",
  REGISTRATION_FAILED: "تعذر إنشاء الحساب. حاول مرة أخرى.",
};

export function errorMessage(error: unknown): string {
  if (!error) return "حدث خطأ غير متوقع.";
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : typeof error === "string"
        ? error
        : "";

  if (code === "FIREBASE_NOT_CONFIGURED") return MESSAGES.FIREBASE_NOT_CONFIGURED;
  if (MESSAGES[message]) return MESSAGES[message];
  if (MESSAGES[code]) return MESSAGES[code];

  const detail = message.split("/").pop()?.trim();
  if (detail && MESSAGES[detail]) return MESSAGES[detail];

  if (code.startsWith("functions/") || code.startsWith("auth/")) {
    return "تعذر تنفيذ الطلب. تحقق من البيانات وحاول مرة أخرى.";
  }
  return message || "حدث خطأ غير متوقع. حاول مرة أخرى.";
}
