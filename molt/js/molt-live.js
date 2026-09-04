(function (window) {
  'use strict';

  const CODE_RE = /^[A-Z0-9]{4,12}$/;
  let firebasePromise = null;

  function normalizeCode(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
  }

  function validCodeFormat(value) {
    return CODE_RE.test(normalizeCode(value));
  }

  function isDemoCode(value) {
    return normalizeCode(value) === 'DEMO123';
  }

  function configReady() {
    const c = window.MOLT_FIREBASE_CONFIG || {};
    return Boolean(c.apiKey && c.projectId && c.appId);
  }

  async function loadFirebase() {
    if (!configReady()) throw new Error('firebase_not_configured');
    if (!firebasePromise) {
      firebasePromise = Promise.all([
        import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js')
      ]).then(([appMod, dbMod]) => {
        const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(window.MOLT_FIREBASE_CONFIG);
        return { appMod, dbMod, app, db: dbMod.getFirestore(app) };
      });
    }
    return firebasePromise;
  }

  async function sessionExists(code) {
    code = normalizeCode(code);
    if (!validCodeFormat(code)) return false;
    if (isDemoCode(code)) return true;
    const { dbMod, db } = await loadFirebase();
    const collection = window.MOLT_FIREBASE_COLLECTION || 'moltSessions';
    const snap = await dbMod.getDoc(dbMod.doc(db, collection, code));
    if (!snap.exists()) return false;
    const data = snap.data() || {};
    return data.shareEnabled !== false && data.status !== 'ended';
  }

  async function subscribeSession(code, onData, onError) {
    code = normalizeCode(code);
    if (!validCodeFormat(code)) throw new Error('invalid_code');
    const { dbMod, db } = await loadFirebase();
    const collection = window.MOLT_FIREBASE_COLLECTION || 'moltSessions';
    const ref = dbMod.doc(db, collection, code);
    return dbMod.onSnapshot(ref, function (snap) {
      if (!snap.exists()) {
        if (onError) onError(new Error('session_not_found'));
        return;
      }
      const data = Object.assign({ code: snap.id }, snap.data() || {});
      if (data.shareEnabled === false) {
        if (onError) onError(new Error('sharing_disabled'));
        return;
      }
      onData(data);
    }, function (err) {
      if (onError) onError(err);
    });
  }

  function safeParticipantArray(data) {
    return Array.isArray(data && data.participants) ? data.participants : [];
  }

  window.MoltLive = {
    normalizeCode,
    validCodeFormat,
    isDemoCode,
    configReady,
    sessionExists,
    subscribeSession,
    safeParticipantArray
  };
})(window);
