# Firebase Setup — مراحل البكالوريا

## القرار

تم اختيار **Firebase** كـ backend وحيد.

- لا يوجد backend بديل مفعّل.
- التنفيذ الفعلي أصبح في:
  - `firebase.json`
  - `.firebaserc`
  - `firestore.rules`
  - `firestore.indexes.json`
  - `functions/`
- مشروع Firebase: `bakaloriarace` (من إعدادات الويب التي أرسلتها).
- الوضع الافتراضي **Spark المجاني**: لا Cloud Functions، والتصحيح يتم في الواجهة عبر
  `app/src/lib/spark.ts`. هذا يكفي للخطة المجانية بدون بطاقة.
- وضع **Functions** محفوظ في `functions/` للترقية الاختيارية إلى Blaze.
- لا يتم تخزين أي مفتاح سري أو service account داخل المشروع.

## لماذا Firebase؟

- الطالب يسجل بـ username/password، وFirebase Auth يستخدم بريدًا صناعيًا داخليًا.
- Firestore يحفظ التقدم والاستجابات.
- في وضع Spark: التطبيق يقرأ الإجابة من مستند السؤال (`grading`, `correct`,
  `modelAnswer`) ويصحح ويكتب التقدم مباشرة، مع قواعد Firestore تقصر كل سجل على
  صاحبه. `question_answers` يبقى خيارًا احتياطيًا للأسئلة القديمة. الترتيب غير
  محصّن ضد التلاعب.
- في وضع Functions: Cloud Functions تصحح الإجابات وتفرض الفواصل الزمنية وتمنع الغش،
  لأنها تعمل بـ Admin SDK.
- App Check اختياري، ويحمي Firestore من الاستدعاءات خارج التطبيق.

## المتطلبات في Firebase Console

افتح المشروع `bakaloriarace` ونفّذ:

1. **Authentication**
   - Enable sign-in method: **Email/Password**.
   - لا نحتاج Email verification أو password reset بالبريد في MVP، لأن البريد صناعي.
   - من **Authentication → Settings → Authorized domains** أضف
     `bakaloria.github.io` بعد نشر GitHub Pages (مطلوب لبعض عمليات Auth وApp Check).
     **تمت إضافته بالفعل** إلى جانب `localhost` ونطاقات المشروع.

2. **Firestore Database**
   - الرابط المباشر: <https://console.firebase.google.com/project/bakaloriarace/firestore>
   - Create database.
   - اختر نفس region الذي ستستخدمه للـ Functions إن أمكن.
   - Production mode.
   - **تم إنشاء القاعدة `(default)` في `europe-west9`، ونُشرت القواعد والفهارس.**
   - **تم استيراد البنك الحقيقي** (6 مواد، 11,901 سؤالًا) وحُذفت المادة التجريبية.

3. **Functions (اختياري)**
   - لا تحتاجها في وضع Spark المجاني.
   - إذا أردت التصحيح الخادمي، رقّ إلى **Blaze** (الاستخدام ضمن الحصة المجانية غالبًا).
   - لا تضع service account JSON في المستودع.

4. **App Check (اختياري الآن، موصى به قبل الإطلاق)**
   - سجّل تطبيق الويب بـ **reCAPTCHA v3**.
   - ضع مفتاح الموقع في `app/public/firebase-config.js` ضمن `appCheckSiteKey`، أو في متغير `VITE_FIREBASE_APP_CHECK_SITE_KEY`.
   - الدوال لا تفرض App Check افتراضيًا حتى تتوفر المهلة. بعد التسجيل:
     - انشر الدوال مع `ENFORCE_APP_CHECK=true` (متغير بيئة للدوال).
     - فعّل Enforcement على Firestore وCloud Functions من Firebase Console.
   - أثناء التطوير المحلي استخدم debug token.
   - بدون App Check يبقى الأمان الأساسي في Firebase Auth + Firestore Rules، مع
     التصحيح في الواجهة في وضع Spark أو داخل الخادم في وضع Functions.

5. **Hosting**
   - الواجهة منشورة على GitHub Pages من فرع `main` ومجلد `docs`:
     <https://bakaloria.github.io/bakaloriastages/>
   - يمكن استخدام Firebase Hosting لاحقًا كمرآة إضافية، لكنه غير مطلوب الآن.
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
  backendMode: "spark", // "spark" مجاني، أو "functions" بعد Blaze
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

## نشر القواعد (وضع Spark المجاني)

من جذر المشروع:

```bash
npx firebase-tools login
npx firebase-tools use bakaloriarace
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

لا تحتاج `functions/` في هذا الوضع. تأكد أن `backendMode` في `firebase-config.js`
هو `"spark"`.

### الترقية إلى وضع Functions (اختياري)

```bash
cp firestore.functions.rules firestore.rules
cd functions
npm install
npm run build
cd ..
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions
```

ثم بدّل `backendMode` إلى `"functions"` وأعد بناء `docs/`.

### تشغيل محلي

وضع Spark لا يحتاج محاكي Functions:

```bash
firebase emulators:start --only auth,firestore
```

وضع Functions:

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

## حساب Admin الأول

تم إنشاء الحساب الأول مسبقًا في مشروع `bakaloriarace`:

- اسم المستخدم: `admin`
- كلمة المرور: `admin123` (Firebase يفرض 6 أحرف على الأقل)
- البريد الداخلي: `admin@students.bakaloriarace.app`
- الدور: `admin` في Auth custom claim وفي `users/{uid}.role`
- `users/{uid}.mustChangePassword = true`

عند أول دخول إلى `#/admin` تُفتح صفحة **أمان الحساب** وحدها، ولا تُتاح بقية أقسام
اللوحة حتى يغيّر المدير اسم المستخدم وكلمة المرور. بعد الحفظ تُصفَّر
`mustChangePassword` وتُحدَّث `usernames/{username}` وبريد Auth معًا.

إذا احتجت إعادة إنشاء الحساب أو إعادة تعيينه من جهاز فيه Application Default
Credentials:

```bash
npm --prefix functions install
node functions/scripts/set-admin.mjs <UID>
```

أو يدويًا:

```js
const admin = require("firebase-admin");
admin.initializeApp();
await admin.auth().setCustomUserClaims("<UID>", { role: "admin" });
await admin.firestore().doc("users/<UID>").set(
  { role: "admin", mustChangePassword: true },
  { merge: true },
);
```

بعدها يجب أن يسجل المدير خروجه ودخوله حتى يظهر custom claim الجديد.

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

في وضع Functions هذه بيانات عامة فقط ولا يوجد فيها الجواب الصحيح. في وضع Spark
تُضاف حقول التصحيح إلى مستند السؤال نفسه، لأن التصحيح يجري في المتصفح ولأن ذلك
يخفض عدد الكتابات عند استيراد بنك كامل إلى النصف.

```json
{
  "subjectId": "history",
  "unitId": "history-u1",
  "lessonId": "history-u1-l1",
  "type": "mcq",
  "text": "نص السؤال",
  "options": ["أ", "ب", "ج", "د"],
  "orderIndex": 1,
  "active": true,
  "grading": "auto",
  "correct": { "index": 2 },
  "modelAnswer": "الإجابة النموذجية",
  "explanation": "شرح مختصر"
}
```

### `question_answers/{questionId}`

في وضع Functions لا يقرأها الطالب إطلاقًا، وهي إلزامية هناك. في وضع Spark تُستخدم
كخيار احتياطي للأسئلة القديمة أو التجريبية فقط؛ الأسئلة المستوردة حديثًا تحمل
`grading` و`correct` و`modelAnswer` و`explanation` داخل مستند السؤال.

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
  "failedNewPerStage": 2,
  "failedReviewPerStage": 3,
  "passThreshold": 60,
  "sessionStages": 10,
  "intervalMinutes": 120,
  "wrongIntervalMinutes": 10,
  "masteryThreshold": 1,
  "finalExamRequired": false,
  "stagesLocked": false,
  "lockMessage": ""
}
```

- `newPerStage` و`reviewPerStage`: عدد الأسئلة الجديدة وأسئلة المراجعة في كل مرحلة.
  لا يوجد تصعيد تلقائي مخفي؛ هذه القيم تُطبَّق على كل المراحل وتُضبط من لوحة المدير.
- `stageSize` يُحسب تلقائيًا كمجموع `newPerStage + reviewPerStage`.
- إذا كانت نتيجة المرحلة أقل من `passThreshold`، تستخدم المرحلة التالية
  `failedNewPerStage` و`failedReviewPerStage`، ثم تعود القيم العادية بعد النجاح.
- إذا لم تتوفر أسئلة مراجعة مستحقة، يكمل التطبيق العدد من الأسئلة الجديدة حسب
  حدود المادة.
- `sessionStages`: عدد المراحل في الجلسة قبل الفاصل.
- `intervalMinutes`: الفاصل بين الجلسات، ويُستخدم أيضًا كأساس لجدولة عودة السؤال
  الصحيح للمراجعة (120 = ساعتان). الأسئلة الخاطئة تعود بعد
  `wrongIntervalMinutes`، والأسئلة المتقنة تتضاعف مدة مراجعتها تدريجيًا.
- `masteryThreshold`: 1 = إتقان 100%، 0.9 = 90%.
- `stagesLocked` و`lockMessage`: إغلاق بدء المراحل لهذه المادة مع رسالة للطالب.
- `finalExamRequired`: يبقى الامتحان النهائي اختياريًا ومعطلًا افتراضيًا.

### `settings/global`

إعدادات المنصة العامة، وهي مقروءة للمسجلين ويكتبها المدير فقط:

```json
{
  "stagesLocked": false,
  "registrationsOpen": true,
  "lockMessage": "",
  "maintenanceMessage": ""
}
```

### `announcements/{announcementId}`

```json
{
  "title": "عنوان الإعلان",
  "body": "نص الإعلان",
  "tone": "info",
  "active": true,
  "pinned": false,
  "expiresAt": null,
  "createdAt": "serverTimestamp",
  "createdBy": "<admin uid>"
}
```

`tone` هو `info` أو `success` أو `warning` أو `danger`. تظهر الإعلانات النشطة
وغير المنتهية في رئيسية الطالب ومركز الإشعارات.

### `admin_audit/{entryId}`

سجل مختصر لآخر إجراءات المدير (`action`, `detail`, `adminUid`, `adminName`,
`createdAt`). قراءته وإنشاؤه للمدير فقط، ولا يمكن تعديله أو حذفه.

### مجموعات الطالب

- `users/{uid}`
- `enrollments/{uid}_{subjectId}`
- `progress/{uid}_{questionId}`
- `unit_progress/{uid}_{subjectId}_{unitId}`
- `stage_attempts/{uid}_{subjectId}_{stageNo}`
- `certificates/{uid}_{subjectId}`
- `final_exam_attempts/{attemptId}` (لاحقًا)

## استيراد آلي

`functions/scripts/import-bank.mjs` يقرأ ملف JSON واحدًا بالشكل الموضح في README،
ويقسمه إلى `questions` العامة و`question_answers` السرية، ويحسب `unit_totals` و
`totalQuestions`. جرّبه أولًا بـ `--dry-run`، ثم نفّذه بعد ضبط
`GOOGLE_APPLICATION_CREDENTIALS`:

> استيراد وضع Spark المستخدم لبنك هذا التطبيق يضع الإجابة داخل مستند السؤال
> (`questions`) ولا يكتب `question_answers`، ليبقى عدد الكتابات ضمن الحصة المجانية.
> يمكن لاحقًا إعادة الاستيراد بوضع Functions لإخراج الإجابات إلى المجموعة المنفصلة.

```bash
GCLOUD_PROJECT=bakaloriarace node functions/scripts/import-bank.mjs bank.json --dry-run
GCLOUD_PROJECT=bakaloriarace node functions/scripts/import-bank.mjs bank.json
```

## ترتيب الأسئلة مهم

`orderIndex` هو مؤشر تقدم الطالب داخل المادة:

- يجب أن يكون فريدًا وتصاعديًا داخل كل مادة.
- الدالة تختار الأسئلة الجديدة بـ `orderIndex >= nextQuestionIndex`.
- لا تغيّر `orderIndex` بعد بدء الطلاب، وإلا قد تتكرر أسئلة أو تُتخطى.
- عند إضافة أسئلة جديدة، أعطها أرقامًا أكبر من آخر `orderIndex` في المادة.

## الدوال المتاحة (Callable — وضع Functions فقط)

> في وضع Spark لا تُستخدم هذه الدوال؛ الواجهة تستدعي `app/src/lib/spark.ts`
> مباشرة. الأسماء والنتائج متطابقة تقريبًا لتسهيل التبديل.

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
   الذاتية في الإتقان قبل هذا التقييم، وتُعاد حساب نتيجة المرحلة بعده حتى لا
   يُحسب الطالب راسبًا بسبب أسئلة لم تُقيَّم بعد.
6. عندما يضغط الطالب «تم الاطلاع»: `markStageFeedbackSeen({ attemptId })`.
7. `startStage` مرة أخرى للمرحلة التالية.

لا يمكن بدء مرحلة جديدة قبل `markStageFeedbackSeen`، ولا تنجح هذه الدعوة قبل
تقييم كل الأسئلة الذاتية. وهذا يضمن رؤية الإجابة النموذجية.

> إذا انتهت الجلسة (آخر مرحلة قبل الفاصل) تُعرض نتيجة المرحلة أولًا، ثم يدخل
> الطالب شاشة العدّاد. لا يضيع الاطلاع على الإجابات النموذجية بسبب الفاصل.

## الأمان

### وضع Spark (الافتراضي المجاني)

- `firestore.rules` تسمح للطالب المسجل بقراءة `question_answers` لأن التصحيح في الواجهة.
- `enrollments` مقروءة للمسجلين لبناء الترتيب، والكتابة لصاحب السجل فقط.
- `progress` و`stage_attempts` و`unit_progress` و`certificates` خاصة بصاحبها، مع
  السماح بـ `get` عندما يكون المستند غير موجود (`resource == null`). هذا شرط لازم
  حتى ينجح أول استدعاء داخل `startStage` قبل إنشاء السجل.
- `settings/global` و`subject_settings` و`announcements` و`admin_audit` وكتابة بنك
  الأسئلة للمدير فقط. الإعلانات النشطة فقط ظاهرة للطلاب.
- يمكن لطالب متمكن تعديل درجاته عبر SDK. هذا مقبول لتطبيق تعليمي وليس اختبارًا رسميًا.
- لا توجد حماية خادمية للفواصل الزمنية أو الترتيب.

### وضع Functions

- `firestore.functions.rules` تمنع الطالب من:
  - قراءة `question_answers`.
  - كتابة `enrollments` أو `progress` أو `stage_attempts` أو `certificates`.
  - قراءة بيانات طالب آخر.
- التصحيح والفواصل الزمنية وتحديث التقدم كلها داخل Cloud Functions.
- `questions` للقراءة الإدارية فقط؛ الطالب يستلم نص السؤال من الدالة.
- `app_check` مفعّل على كل callable بعد ضبطه.
- لا تضع service account أو مفاتيح إدارية في الواجهة.
- لا تعتمد على Firebase Web API key كسر؛ هو معرف عام، والحماية الحقيقية في Rules + App Check.

## ملاحظات مهمة

- البريد `username@students.bakaloriarace.app` صناعي. لا تستخدم «نسيت كلمة المرور» بالبريد في MVP.
- لإعادة تعيين كلمة المرور: أضف لاحقًا دالة إدارية أو رمز استعادة.
- `getLeaderboard` يعتمد على `autoFirstCorrect` للأسئلة المصححة آليًا فقط، لأن أسئلة المقال والتقصير ذاتية.
- الواجهة العربية PWA مبنية في `app/` وتُخرج إلى `docs/` للنشر على GitHub Pages.
- Firebase هو الـ backend الوحيد في هذا المشروع.

## ما تبقّى قبل الإطلاق

1. ~~تفعيل Firestore ونشر القواعد والفهارس~~ — تم:
   <https://console.firebase.google.com/project/bakaloriarace/firestore>
2. ~~استيراد بنك الأسئلة~~ — تم استيراد 6 مواد و11,901 سؤالًا.
3. ~~اختبار المسار الكامل عبر SDK~~ — تم: تسجيل، انضمام، بدء، تسليم، تقييم ذاتي،
   نموذج إجابة، انتقال للمرحلة التالية، واسترجاع بعد رسوب.
4. ~~لوحة تحكم المدير والإعلانات وإغلاق المراحل~~ — تم.
5. ~~GitHub Pages والنطاق المصرّح~~ — تم:
   <https://bakaloria.github.io/bakaloriastages/>
6. إجراء اختبار بصري/يدوي من المتصفح على الهاتف والحاسوب قبل بدء الطلاب.
7. (اختياري) تفعيل App Check بعد تسجيل reCAPTCHA v3 ووضع مفتاح الموقع.
8. (اختياري) الترقية إلى Blaze ووضع Functions للتصحيح الخادمي.
9. الامتحان النهائي الاختياري (موجود كإعداد ومجموعة بيانات، ولم يُفعّل بعد).
10. استيراد الجغرافيا عند عودة حصة القراءة في المشروع القديم.
