import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const uid = process.argv[2];
if (!uid) {
  console.error("Usage: node functions/scripts/set-admin.mjs <uid>");
  process.exit(1);
}

initializeApp({
  credential: applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || "bakaloriarace",
});

await getAuth().setCustomUserClaims(uid, { role: "admin" });
await getFirestore().doc(`users/${uid}`).set({ role: "admin" }, { merge: true });

console.log(`Admin role set for ${uid}.`);
console.log("The user must sign out and sign in again (or refresh the ID token).");
