# Firebase Setup — مراحل البكالوريا

## القرار

تم اختيار **Firebase** بدل Supabase.

- Supabase schema الموجود في `supabase/schema.sql` يبقى كنسخة بديلة غير مستخدمة.
- التنفيذ الفعلي أصبح في:
  - `firebase.json`
  - `.firebaserc`
  - `firestore.rules`
  - `firestore.indexes.json`
  - `functions/`
- مشروع Firebase: `bakaloriarace` (من إعدادات الويب التي أرسلتها).
- لا يتم تخزين أي مفتاح سري أو service account داخل المشروع.

## لماذا Firebase؟

- الطالب يسجل بـ username/password، وFirebase Auth يستخدم بريدًا صناعيًا داخليًا.
- Firestore يحفظ التقدم والاستجابات.
- Cloud Functions هي التي تصحح الإجابات وتفرض الفواصل الزمنية وتمنع الغش، لأنها تعمل بـ Admin SDK.
- الطالب لا يقرأ `question_answers` ولا يكتب `progress` مباشرة.
- App Check يقلل استدعاءات السكربتات من خارج التطبيق.

## المتطلبات في Firebase Console

افتح المشروع `bakaloriarace` ونفّذ:

1. **Authentication**
   - Enable sign-in method: **Email/Password**.
   - لا نحتاج Email verification أو password reset بالبريد في MVP، لأن البريد صناعي.

2. **Firestore Database**
   - Create database.
   - اختر نفس region الذي ستستخدمه للـ Functions إن أمكن.
   - Production mode.

3. **Functions**
   - Firebase Functions تحتاج خطة **Blaze** (الاستخدام ضمن الحصة المجانية غالبًا).
   - لا تضع service account JSON في المستودع.

4. **App Check (اختياري الآن، موصى به قبل الإطلاق)**
   - سجّل تطبيق الويب بـ **reCAPTCHA v3**.
   - ضع مفتاح الموقع في `app/public/firebase-config.js` ضمن `appCheckSiteKey`، أو في متغير `VITE_FIREBASE_APP_CHECK_SITE_KEY`.
   - الدوال لا تفرض App Check افتراضيًا حتى تتوفر المهلة. بعد التسجيل:
     - انشر الدوال مع `ENFORCE_APP_CHECK=true` (متغير بيئة للدوال).
     - فعّل Enforcement على Firestore وCloud Functions من Firebase Console.
   - أثناء التطوير المحلي استخدم debug token.
   - بدون App Check يبقى الأمان الأساسي في Firebase Auth + Firestore Rules + التصحيح داخل الخادم.

5. **Hosting**
   - غير مطلوب الآن. يمكن نشر الواجهة لاحقًا على GitHub Pages أو Firebase Hosting.
   - `firebase.json` الحالي لا يحتوي Hosting حتى لا يفشل النشر قبل وجود الواجهة.

## إعداد الويب (مطلوب قبل النشر)

من Firebase Console → **Project settings → Your apps → Web app** انسخ كائن `firebaseConfig` إلى:

```js
// app/public/firebase-config.js
window.__FIREBASE_CONFIG__ = {
  apiKey: "...",
  authDomain: "bakaloriarace.firebaseapp.com",
  projectId: "bakaloriarace",
  storageBucket: "bakaloriarace.firebasestorage.app",
  messagingSenderId: "...",
  appId: "...",
  appCheckSiteKey: "" // املأه فقط بعد تفعيل App Check
};
```

هذه القيم عامة وليست أسرارًا. لا تضع Service Account أو Private Key هنا. بعد تعديل الملف:

```bash
cd app
npm run build
cd ..
git add docs
git commit -m "build: update Firebase web config"
git push origin main
```

بديل مؤقت: شاشة الإعداد داخل التطبيق تحفظ الإعدادات في `localStorage` للمتصفح الحالي فقط.

## نشر القواعد والدوال

من جذر المشروع:

```bash
cd functions
npm install
npm run build
cd ..

npx firebase-tools login
npx firebase-tools use bakaloriarace
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions
```

أو بعد تثبيت CLI:

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions
```

### تشغيل محلي

```bash
cd functions
npm install
npm run build
cd ..
firebase emulators:start --only auth,firestore,functions
```

لتجاوز App Check محليًا:

```bash
export FIREBASE_APPCHECK_DEBUG_TOKEN=true
```

## أول حساب Admin

1. سجّل حسابًا عاديًا من التطبيق.
2. من Firebase Console → Authentication انسخ `uid`.
3. من Cloud Shell أو جهاز فيه Application Default Credentials:

```bash
node scripts/set-admin.mjs <UID>
```

أو يدويًا:

```js
const admin = require("firebase-admin");
admin.initializeApp();
await admin.auth().setCustomUserClaims("<UID>", { role: "admin" });
await admin.firestore().doc("users/<UID>").set({ role: "admin" }, { merge: true });
```

بعدها يجب أن يسجل المستخدم خروجه ودخوله، أو يعمل refresh للـ token، حتى يظهر custom claim.

## نموذج البيانات

### `subjects/{subjectId}`

```json
{
  "slug": "history",
  "name": "التاريخ",
  "branches": ["literary"],
  "active": true,
  "sort": 1,
  "totalQuestions": 4048
}
```

### `units/{unitId}`

```json
{
  "subjectId": "history",
  "title": "الوحدة الأولى",
  "sort": 1,
  "totalQuestions": 120
}
```

### `lessons/{lessonId}`

```json
{
  "subjectId": "history",
  "unitId": "history-u1",
  "title": "الدرس الأول",
  "sort": 1
}
```

### `questions/{questionId}`

هذه بيانات عامة فقط. لا يوجد فيها الجواب الصحيح.

```json
{
  "subjectId": "history",
  "unitId": "history-u1",
  "lessonId": "history-u1-l1",
  "type": "mcq",
  "text": "نص السؤال",
  "options": ["أ", "ب", "ج", "د"],
  "orderIndex": 1,
  "active": true
}
```

### `question_answers/{questionId}`

هذه لا يقرأها الطالب إطلاقًا.

```json
{
  "grading": "auto",
  "correct": { "index": 2 },
  "modelAnswer": { "index": 2, "text": "الإجابة النموذجية" },
  "explanation": "شرح مختصر"
}
```

### `unit_totals/{subjectId}_{unitId}`

تستخدمها الدالة لتحديث تقدم الوحدة دون قراءة كل الأسئلة.

```json
{
  "subjectId": "history",
  "unitId": "history-u1",
  "total": 120,
  "title": "الوحدة الأولى"
}
```

### `subject_settings/{subjectId}`

القيم الافتراضية موجودة في الكود، وهذا المستند اختياري للتخصيص:

```json
{
  "stageSize": 5,
  "newPerStage": 3,
  "reviewPerStage": 2,
  "sessionStages": 10,
  "intervalMinutes": 120,
  "masteryThreshold": 1,
  "finalExamRequired": false
}
```

- `stageSize`: سقف عدد الأسئلة في المرحلة.
- المراحل 1–4 تصعد تلقائيًا: 1، 2، 3، 4 أسئلة.
- من المرحلة 5: 3 جديدة + 2 مراجعة.
- `sessionStages`: عدد المراحل في الجلسة قبل الفاصل.
- `intervalMinutes`: الفاصل بين الجلسات، وليس بين كل مرحلة.
- `masteryThreshold`: 1 = إتقان 100%، 0.9 = 90%.

### مجموعات الطالب

- `users/{uid}`
- `enrollments/{uid}_{subjectId}`
- `progress/{uid}_{questionId}`
- `unit_progress/{uid}_{subjectId}_{unitId}`
- `stage_attempts/{uid}_{subjectId}_{stageNo}`
- `certificates/{uid}_{subjectId}`
- `final_exam_attempts/{attemptId}` (لاحقًا)

## ترتيب الأسئلة مهم

`orderIndex` هو مؤشر تقدم الطالب داخل المادة:

- يجب أن يكون فريدًا وتصاعديًا داخل كل مادة.
- الدالة تختار الأسئلة الجديدة بـ `orderIndex >= nextQuestionIndex`.
- لا تغيّر `orderIndex` بعد بدء الطلاب، وإلا قد تتكرر أسئلة أو تُتخطى.
- عند إضافة أسئلة جديدة، أعطها أرقامًا أكبر من آخر `orderIndex` في المادة.

## الدوال المتاحة (Callable)

| الدالة | المدخل | الناتج المختصر |
|---|---|---|
| `register` | `username, password, displayName, branch` | `{ uid, email }` ثم تسجيل الدخول بالبريد |
| `joinSubject` | `subjectId` | `{ enrolled, totalQuestions, ... }` |
| `startStage` | `subjectId` | `locked` أو `feedbackRequired` أو `completed` أو أسئلة المرحلة |
| `submitStage` | `attemptId, answers[]` | التصحيح + الإجابة النموذجية + حالة الجلسة (الأسئلة الذاتية ترجع `isCorrect: null`) |
| `getStageResult` | `attemptId` | إعادة عرض نتيجة مرحلة مُسلّمة |
| `selfGradeQuestion` | `attemptId, questionId, selfScore` | `correct` أو `partial` أو `wrong` لتقييم سؤال مقالي/قصير |
| `markStageFeedbackSeen` | `attemptId` | تأكيد أن الطالب شاهد الإجابة النموذجية، ويرفض المتابعة قبل اكتمال التقييم الذاتي |
| `getSubjectProgress` | `subjectId` | التقدم الكلي وحسب الوحدات |
| `getLeaderboard` | `subjectId` | ترتيب الطلاب في المادة |
| `claimCertificate` | `subjectId` | شهادة بعد اكتمال التغطية والإتقان |

### تسجيل الدخول من الواجهة

`register` ينشئ الحساب ويعيد `email`. بعدها:

```js
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const auth = getAuth(app);
await signInWithEmailAndPassword(auth, email, password);
```

### دورة المرحلة

1. `startStage({ subjectId })`
2. إذا رجع `feedbackRequired`: اعرض نتيجة المرحلة السابقة ثم `markStageFeedbackSeen`.
3. اعرض الأسئلة، ثم `submitStage({ attemptId, answers })`.
4. اعرض `results[].modelAnswer` و`results[].explanation`.
5. للأسئلة ذات `grading: "self"`: بعد مقارنة إجابة الطالب بالنموذج، استدعِ
   `selfGradeQuestion({ attemptId, questionId, selfScore })`. لا تُحتسب الأسئلة
   الذاتية في الإتقان قبل هذا التقييم.
6. عندما يضغط الطالب «تم الاطلاع»: `markStageFeedbackSeen({ attemptId })`.
7. `startStage` مرة أخرى للمرحلة التالية.

لا يمكن بدء مرحلة جديدة قبل `markStageFeedbackSeen`، ولا تنجح هذه الدعوة قبل
تقييم كل الأسئلة الذاتية. وهذا يضمن رؤية الإجابة النموذجية.

> إذا انتهت الجلسة (آخر مرحلة قبل الفاصل) تُعرض نتيجة المرحلة أولًا، ثم يدخل
> الطالب شاشة العدّاد. لا يضيع الاطلاع على الإجابات النموذجية بسبب الفاصل.

## الأمان

- `firestore.rules` تمنع الطالب من:
  - قراءة `question_answers`.
  - كتابة `enrollments` أو `progress` أو `stage_attempts` أو `certificates`.
  - قراءة بيانات طالب آخر.
- التصحيح والفواصل الزمنية وتحديث التقدم كلها داخل Cloud Functions.
- `questions` للقراءة الإدارية فقط؛ الطالب يستلم نص السؤال من الدالة.
- `app_check` مفعّل على كل callable.
- لا تضع `service_role` أو service account في الواجهة.
- لا تعتمد على Firebase Web API key كسر؛ هو معرف عام، والحماية الحقيقية في Rules + App Check.

## ملاحظات مهمة

- البريد `username@students.bakaloriarace.app` صناعي. لا تستخدم «نسيت كلمة المرور» بالبريد في MVP.
- لإعادة تعيين كلمة المرور: أضف لاحقًا دالة إدارية أو رمز استعادة.
- `getLeaderboard` يعتمد على `autoFirstCorrect` للأسئلة المصححة آليًا فقط، لأن أسئلة المقال والتقصير ذاتية.
- الواجهة العربية PWA مبنية في `app/` وتُخرج إلى `docs/` للنشر على GitHub Pages.
- إذا تقرر لاحقًا الرجوع إلى Supabase، ملف `supabase/schema.sql` موجود لكنه غير مفعّل.

## ما تبقّى قبل الإطلاق

1. وضع `firebaseConfig` الحقيقي في `app/public/firebase-config.js`.
2. استيراد بنك الأسئلة إلى Firestore بالصيغة أعلاه (`subjects`, `units`, `lessons`, `questions`, `question_answers`, `unit_totals`).
3. نشر `firestore.rules` و`firestore.indexes.json` والدوال على مشروع `bakaloriarace`.
4. إنشاء أول حساب ثم منحه صلاحية مشرف عبر `scripts/set-admin.mjs`.
5. اختبار مسار كامل: تسجيل، انضمام، مرحلة، تقييم ذاتي، إجابة نموذجية، مرحلة تالية.
6. تفعيل App Check بعد تسجيل reCAPTCHA v3.
7. إضافة الامتحان النهائي ولوحة تحكم المشرف لاحقًا.
