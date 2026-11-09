# قرار الخادم: Firebase أم Supabase؟

> **ملاحظة أمنية فورية:** المفاتيح التي أرسلتها هي **إعدادات Firebase العامة** (Web Config)، وليست مفاتيح سرية. هي ليست كافية وحدها لحماية البيانات، ولا تمنح أحداً صلاحية المدير. لكن بما أنها نُشرت في المحادثة، يُفضّل تقييدها في Google Cloud Console (HTTP Referrers + APIs) أو تدويرها بعد الانتهاء.
>
> **لن أحفظ هذه المفاتيح في ملف داخل المستودع.** سنستخدم إعدادات البيئة أو لوحة Firebase، ولا نضع أبداً Service Account أو Private Key في الواجهة.

---

## 1. الخلاصة

المشروع السابق كان مقترحاً على **Supabase**. المفاتيح التي أرسلتها تخص **Firebase**، وهما نظامان مختلفان:

- **Supabase**: PostgreSQL + Auth + RLS + RPC. يستطيع تنفيذ التحقق من الإجابات وفرض الفاصل الزمني داخل قاعدة البيانات نفسها.
- **Firebase**: Auth + Firestore + Storage + Cloud Functions. لا يستطيع Firestore وحده تصحيح الإجابات أو إخفاء الحلول بأمان؛ يحتاج **Cloud Functions** (خطة Blaze) أو خادماً خارجياً.

**توصيتي للنسخة الأولى:** البقاء على **Supabase**، لأنه أسهل وأرخص لهذا النوع من التطبيقات (تحقق على الخادم + فاصل زمني + مجانية).  
**إذا كنت تريد Firebase بالتأكيد:** ننتقل إليه، لكن مع Cloud Functions + App Check، وليس Firebase Auth + Firestore فقط.

---

## 2. ماذا تعني مفاتيح Firebase؟

| المفتاح | هل هو سر؟ | ملاحظة |
|---|---|---|
| `apiKey` | لا، عام بطبيعته | يحدد المشروع، ويُقيّد بالنطاقات والـAPIs |
| `authDomain` | لا | نطاق تسجيل الدخول |
| `projectId` | لا | معرف المشروع |
| `storageBucket` | لا | حاوية الملفات |
| `messagingSenderId` | لا | معرف المراسلة |
| `appId` | لا | معرف التطبيق |

**الخطر الحقيقي ليس في هذه المفاتيح، بل في:**
- قواعد Firestore المفتوحة (`allow read, write: if true`).
- عدم تفعيل App Check.
- وضع الإجابات الصحيحة في مجموعة يقرأها العميل.
- الاعتماد على وقت الجهاز في الفاصل الزمني.
- وضع Service Account Key في المستودع.

---

## 3. المشكلة التقنية في Firebase لهذا التطبيق

تريد:
1. إخفاء الإجابة الصحيحة حتى يجيب الطالب.
2. التحقق من الإجابة على الخادم.
3. فرض `nextAvailableAt` بعد ساعتين.
4. منع الطالب من تعديل تقدمه أو نقاطه.

مع Firebase:

- **Firestore Rules** تتحقق من المسارات والصلاحيات، لكنها **لا تصحّح إجابة** ولا تنفّذ منطقاً معقداً.
- إذا سمحت للعميل بقراءة مجموعة الأسئلة، سيقرأ `correct` إن كان في نفس المستند.
- إذا سمحت للعميل بكتابة تقدمه، يستطيع تعديل النقاط والتواريخ.
- الحل: **Cloud Functions** (أو Cloud Run) مع Admin SDK:
  - `startStage`: يعيد الأسئلة بدون الإجابة.
  - `submitStage`: يصحّح على الخادم ويعيد الإجابة النموذجية.
  - `nextAvailableAt`: يُحسب على الخادم.
- Cloud Functions تحتاج خطة **Blaze** (استهلاك مدفوع، مع طبقة مجانية). هذا قد يكون عائقاً.

مع Supabase:

- `RPC` + `RLS` تفعل الشيء نفسه داخل Postgres، وغالباً ضمن الطبقة المجانية.
- لا تحتاج خدمة منفصلة للتحقق.
- هذا هو السبب الرئيسي لترجيح Supabase.

---

## 4. مقارنة سريعة

| المعيار | Supabase | Firebase |
|---|---|---|
| قاعدة البيانات | PostgreSQL | Firestore (NoSQL) |
| المصادقة | Auth + بريد صناعي | Auth + بريد صناعي |
| التحقق على الخادم | RPC/Edge Functions | Cloud Functions (Blaze) |
| إخفاء الإجابات | سهل عبر RPC | ممكن عبر Functions، صعب بدونها |
| فرض الفاصل الزمني | سهل في RPC | سهل في Functions، ضعيف في Rules |
| المجانية | سخية | Firestore جيد، Functions تحتاج Blaze |
| الاستعلامات | SQL مرن | NoSQL، تحتاج فهارس وتركيباً |
| الوقت اللازم للنسخة الأولى | أقل | أكثر |
| النشر | GitHub Pages + Supabase | Firebase Hosting أو GitHub Pages + Functions |
| الأنسب لهذا التطبيق | **نعم** | إذا لديك خبرة/بنية Firebase |

---

## 5. الخيار A — Supabase (موصى به)

### البنية

- **الواجهة**: HTML/CSS/JS أو React/Vite، PWA، RTL.
- **الاستضافة**: GitHub Pages للمستودع `bakaloria/bakaloriastages`.
- **الخادم**: Supabase (Postgres + Auth + RLS + RPC).
- **الصور**: Supabase Storage أو روابط داخل الأسئلة.

### الجداول

```text
profiles
subjects / units / lessons / questions
  questions: correct, model_answer, grading, explanation
enrollments
  coverage_count, mastery_count, total_questions
  stages_in_session, next_available_at
question_progress
  seen_count, correct_count, wrong_count
  first_attempt_correct, mastery_level, next_review_at
stage_attempts / attempt_answers
settings
```

### RPC

- `start_stage`: بدون `correct` وبدون `model_answer`.
- `submit_stage`: تصحيح + تحديث التقدم + إعادة `model_answer`.
- `get_subject_progress`.
- `claim_certificate`.
- `get_leaderboard`.

### ما أحتاجه منك

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (وليس `service_role`)

### المزايا

- تحقق آمن على الخادم.
- فاصل زمني موثوق.
- SQL مناسب للإحصاءات والتغطية.
- تكلفة أقل وتعقيد أقل.

---

## 6. الخيار B — Firebase (إذا أردت الاحتفاظ به)

### البنية

- **Firebase Auth**: اسم مستخدم + كلمة مرور عبر بريد صناعي:
  `username@students.bakaloriarace.app`
- **Firestore**:
  - `users/{uid}`
  - `subjects/{subjectId}` (قراءة فقط)
  - `questions/{questionId}` (بدون `correct`؛ الإجابات في مجموعة محمية)
  - `question_answers/{questionId}` (لا يقرأها العميل)
  - `enrollments/{uid_subject}`
  - `progress/{uid_question}`
  - `attempts/{attemptId}`
  - `settings/{key}`
- **Cloud Functions**:
  - `startStage`
  - `submitStage`
  - `getProgress`
  - `claimCertificate`
- **App Check**: reCAPTCHA v3.
- **Hosting**: Firebase Hosting (أسهل) أو GitHub Pages + Functions.
- **Emulator Suite** للتطوير المحلي.

### قواعد Firestore المقترحة (مبدأ)

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function isSelf(uid) { return signedIn() && request.auth.uid == uid; }

    match /users/{uid} {
      allow read: if isSelf(uid);
      allow write: if false; // عبر Functions فقط
    }

    match /subjects/{subjectId} {
      allow read: if signedIn();
      allow write: if false;
    }

    match /questions/{questionId} {
      allow read: if signedIn();
      allow write: if false;
    }

    // لا وصول للعميل إطلاقاً
    match /question_answers/{questionId} {
      allow read, write: if false;
    }

    match /enrollments/{id} {
      allow read: if signedIn() && resource.data.userId == request.auth.uid;
      allow write: if false; // عبر Functions
    }

    match /progress/{id} {
      allow read: if signedIn() && resource.data.userId == request.auth.uid;
      allow write: if false; // عبر Functions
    }
  }
}
```

> القواعد وحدها لا تكفي: التصحيح والفواصل يجب أن تكون في Functions.

### ما أحتاجه منك

- تأكيد أنك تريد Firebase.
- تفعيل **Blaze** إن لم يكن مفعّلاً (Cloud Functions).
- تفعيل **Firestore** و**Authentication** و**App Check**.
- تحديد نطاقات النشر (GitHub Pages/Firebase Hosting) لتقييد API Key.

### العيوب

- تعقيد أعلى.
- Functions قد تكلف.
- لا يمكن الاعتماد على Firestore Rules وحدها.
- إذا أردت GitHub Pages فقط بدون Functions، فلا يمكن حماية الإجابات ولا الفاصل الزمني بشكل موثوق.

---

## 7. توصية صريحة

| إذا كان هدفك | الخيار |
|---|---|
| أسرع نسخة آمنة بأقل تكلفة | **Supabase** |
| لديك خبرة Firebase وتريدها | Firebase + Functions + App Check |
| GitHub Pages فقط بدون خادم | **لا يوجد خيار آمن**؛ ستحتاج Supabase RPC أو Firebase Functions |

**توصيتي:** نبدأ بـ **Supabase**، ونترك Firebase كخيار لاحق.  
إذا أصررت على Firebase، سأبني عليه، لكن يجب أن نتفق مسبقاً على Cloud Functions وBlaze.

---

## 8. الخطوة التالية

أحتاج قرارك في سطر واحد:

- **«Supabase»** ← أرسل لي `SUPABASE_URL` و`SUPABASE_ANON_KEY`.
- **«Firebase»** ← أؤكد لك المتطلبات (Blaze + Firestore + Functions + App Check)، ثم أبدأ بإعداد المشروع.

في الحالتين:
- لن أعدّل التطبيق الحالي.
- لن أضع المفاتيح في المستودع.
- سأبدأ بمادة واحدة (الأحياء تقنياً أو التاريخ أدبياً) كعينة رأسية.
