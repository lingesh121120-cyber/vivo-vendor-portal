/* ═══════════════════════════════════════════════════════════════
   Firebase bridge for the Vendor Onboarding Portal.
   Loaded as an ES module; exposes a small window.FB helper API that
   the classic script.js uses. The values below are the PUBLIC web
   config (safe to commit) — real security comes from Firebase Auth
   + the database.rules.json security rules, not from hiding these.
═══════════════════════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  getDatabase, ref, set, remove, onValue
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAXnd4_ET1Nvzs-M2PhVzUcG3wWU6YDVrc",
  authDomain: "vivo-vendor-portal-4f7a2.firebaseapp.com",
  databaseURL: "https://vivo-vendor-portal-4f7a2-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "vivo-vendor-portal-4f7a2",
  storageBucket: "vivo-vendor-portal-4f7a2.firebasestorage.app",
  messagingSenderId: "721311524424",
  appId: "1:721311524424:web:50a23dc9ea6926e1b31a7d"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Admin stays signed in only for the browser session — closing the browser logs them out.
setPersistence(auth, browserSessionPersistence).catch(() => {});

let vendorsUnsub = null;

// Small API surface used by script.js (a classic, non-module script).
window.FB = {
  signIn: (email, pass) => signInWithEmailAndPassword(auth, email, pass),
  signOut: () => signOut(auth),
  onAuth: (cb) => onAuthStateChanged(auth, cb),
  currentUser: () => auth.currentUser,

  // Write the full vendor object at vendors/<id>
  setVendor: (id, obj) => set(ref(db, 'vendors/' + id), obj),
  removeVendor: (id) => remove(ref(db, 'vendors/' + id)),

  // Live listener: cb receives the full vendor array on every change
  subscribeVendors: (cb) => {
    const r = ref(db, 'vendors');
    vendorsUnsub = onValue(r, snap => {
      const val = snap.val() || {};
      cb(Object.keys(val).map(k => val[k]));
    }, err => console.error('Vendor read failed:', err));
  },
  unsubscribeVendors: () => { if (vendorsUnsub) { vendorsUnsub(); vendorsUnsub = null; } }
};

window.FB_READY = true;
window.dispatchEvent(new Event('fb-ready'));
