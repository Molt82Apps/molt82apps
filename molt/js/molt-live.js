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
    return Boolean(c.apiKey && c.projectId && c.appId && c.databaseURL);
  }

  function paths() {
    return Object.assign({ joinCodes: 'joinCodes', molts: 'molts', liveMolts: 'liveMolts', shareDrives: 'shareDrives' }, window.MOLT_FIREBASE_PATHS || {});
  }

  async function loadFirebase() {
    if (!configReady()) throw new Error('firebase_not_configured');
    if (!firebasePromise) {
      firebasePromise = Promise.all([
        import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js'),
        import('https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js'),
        import('https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js')
      ]).then(async ([appMod, fsMod, rtdbMod, authMod]) => {
        const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(window.MOLT_FIREBASE_CONFIG);
        const firestore = fsMod.getFirestore(app);
        const database = rtdbMod.getDatabase(app);
        const auth = authMod.getAuth(app);
        let authState = 'existing';
        if (!auth.currentUser) {
          try {
            await authMod.signInAnonymously(auth);
            authState = 'anonymous';
          } catch (err) {
            // Some existing Molt rules may permit the required public reads without auth.
            // Continue and let the database rules decide; surface the real permission error later.
            authState = 'unavailable';
          }
        }
        return { appMod, fsMod, rtdbMod, authMod, app, firestore, database, auth, authState };
      });
    }
    return firebasePromise;
  }

  async function resolveJoinCode(code) {
    code = normalizeCode(code);
    if (!validCodeFormat(code)) throw new Error('invalid_code');
    if (isDemoCode(code)) return { demo: true, code: code, sessionType: 'demo' };

    const fb = await loadFirebase();
    const p = paths();

    // First try a normal Meet & Drive join code.
    const joinRef = fb.fsMod.doc(fb.firestore, p.joinCodes, code);
    const joinSnap = await fb.fsMod.getDoc(joinRef);
    if (joinSnap.exists()) {
      const joinData = joinSnap.data() || {};
      const moltId = String(joinData.moltId || '').trim();
      if (!moltId) throw new Error('missing_molt_id');

      const moltRef = fb.fsMod.doc(fb.firestore, p.molts, moltId);
      const moltSnap = await fb.fsMod.getDoc(moltRef);
      if (!moltSnap.exists()) throw new Error('molt_not_found');

      const moltData = moltSnap.data() || {};
      if (String(moltData.status || '').toLowerCase() === 'ended') throw new Error('molt_ended');
      return { code, moltId, joinData, moltData, fb, sessionType: 'meet' };
    }

    // Share My Drive tokens use the same Watch page. The live share node is
    // deliberately public-read and contains only the location data the owner
    // chose to share for this temporary trip.
    const shareRef = fb.rtdbMod.ref(fb.database, p.shareDrives + '/' + code);
    const shareSnap = await fb.rtdbMod.get(shareRef);
    if (shareSnap.exists()) {
      const shareData = shareSnap.val() || {};
      const lat = Number(shareData.latitude);
      const lng = Number(shareData.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('share_waiting_location');
      return { code, fb, sessionType: 'share', shareData };
    }

    throw new Error('code_not_found');
  }

  async function sessionExists(code) {
    try { await resolveJoinCode(code); return true; }
    catch (err) {
      if (err.message === 'share_waiting_location') return true;
      if (['invalid_code','code_not_found','missing_molt_id','molt_not_found','molt_ended'].includes(err.message)) return false;
      throw err;
    }
  }

  function timestampMillis(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (value.seconds != null) return value.seconds * 1000;
    return null;
  }

  function normalizeLiveState(snapshotValue) {
    const live = snapshotValue || {};
    const membersObj = live.members || {};
    const locationsObj = live.locations || {};
    const members = Object.keys(membersObj).map(uid => Object.assign({ uid }, membersObj[uid] || {}));
    const locations = Object.keys(locationsObj).map(uid => Object.assign({ uid }, locationsObj[uid] || {})).filter(x => Number.isFinite(Number(x.latitude)) && Number.isFinite(Number(x.longitude)));
    return { hostUid: live.hostUid || '', members, locations, raw: live };
  }

  async function grantViewerAccess(resolved) {
    const fb = resolved.fb || await loadFirebase();

    // signInAnonymously() resolves before onAuthStateChanged has necessarily
    // fired in every browser. Wait briefly for currentUser so the RTDB write
    // is always sent with the authenticated UID.
    let user = fb.auth.currentUser;
    if (!user) {
      user = await new Promise((resolve) => {
        let settled = false;
        const stop = fb.authMod.onAuthStateChanged(fb.auth, (u) => {
          if (u && !settled) {
            settled = true;
            stop();
            resolve(u);
          }
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            try { stop(); } catch (_) {}
            resolve(fb.auth.currentUser || null);
          }
        }, 2500);
      });
    }
    if (!user) throw new Error('viewer_auth_required');

    const p = paths();
    const payload = { code: resolved.code, createdAt: Date.now() };

    // Build 06 uses a dedicated top-level grant path. This avoids mixing a
    // browser's self-service grant write into the host-owned liveMolts tree.
    // The RTDB rule validates the submitted code against the hidden
    // liveMolts/<moltId>/watchCode value.
    const viewerRef = fb.rtdbMod.ref(
      fb.database,
      'watchViewers/' + resolved.moltId + '/' + user.uid
    );

    try {
      // A browser may already have a valid grant from a previous page load.
      // Build 06 rules intentionally reject overwriting an existing grant,
      // so reuse it when it belongs to the same code instead of calling set().
      const existingSnap = await fb.rtdbMod.get(viewerRef);
      const existing = existingSnap.exists() ? (existingSnap.val() || {}) : null;
      if (!existing || String(existing.code || '').toUpperCase() !== resolved.code) {
        if (existing) await fb.rtdbMod.remove(viewerRef);
        await fb.rtdbMod.set(viewerRef, payload);
      }
    } catch (err) {
      // Backward-compatible fallback for the Build 05 rules while a site and
      // database-rules deployment are briefly out of sync.
      const legacyRef = fb.rtdbMod.ref(
        fb.database,
        p.liveMolts + '/' + resolved.moltId + '/viewers/' + user.uid
      );
      try {
        const legacySnap = await fb.rtdbMod.get(legacyRef);
        if (!legacySnap.exists()) await fb.rtdbMod.set(legacyRef, payload);
        return async function revokeViewerAccess() {
          try { await fb.rtdbMod.remove(legacyRef); } catch (_) {}
        };
      } catch (_) {
        throw err;
      }
    }

    return async function revokeViewerAccess() {
      try { await fb.rtdbMod.remove(viewerRef); } catch (_) {}
    };
  }

  function normalizeShareDrive(code, live) {
    live = live || {};
    const ownerUid = String(live.ownerUid || 'shared-driver');
    const lat = Number(live.latitude);
    const lng = Number(live.longitude);
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
    const destination = String(live.destination || '').trim();
    return {
      code,
      sessionType: 'share',
      join: {},
      molt: {
        hostUid: ownerUid,
        hostName: 'Driver',
        status: 'active',
        title: 'Share My Drive',
        destination: destination || 'Live shared drive'
      },
      participants: [],
      live: {
        hostUid: ownerUid,
        members: [{ uid: ownerUid, name: 'Driver', online: true, updatedAt: live.updatedAt || null }],
        locations: hasLocation ? [{
          uid: ownerUid,
          latitude: lat,
          longitude: lng,
          heading: Number(live.heading) || 0,
          speedKmh: Number(live.speedKmh) || 0,
          updatedAt: live.updatedAt || null,
          vehicleColour: live.vehicleColour || 'White'
        }] : [],
        raw: live
      }
    };
  }

  async function subscribeShareDrive(resolved, onData, onError) {
    const fb = resolved.fb || await loadFirebase();
    const p = paths();
    const shareRef = fb.rtdbMod.ref(fb.database, p.shareDrives + '/' + resolved.code);
    let stopped = false;
    const unsub = fb.rtdbMod.onValue(shareRef, snap => {
      if (stopped) return;
      if (!snap.exists()) {
        if (onError) onError(new Error('share_ended'));
        return;
      }
      onData(normalizeShareDrive(resolved.code, snap.val()));
    }, err => { if (onError) onError(err); });
    return function unsubscribe() {
      stopped = true;
      try { unsub(); } catch (_) {}
    };
  }

  async function subscribeMeetDrive(code, onData, onError) {
    const resolved = await resolveJoinCode(code);
    if (resolved.demo) throw new Error('demo_not_live');
    if (resolved.sessionType === 'share') return subscribeShareDrive(resolved, onData, onError);
    const fb = resolved.fb || await loadFirebase();
    const p = paths();
    const revokeViewerAccess = await grantViewerAccess(resolved);
    let moltData = Object.assign({}, resolved.moltData);
    let liveData = { hostUid: '', members: [], locations: [], raw: {} };
    let participants = [];
    let stopped = false;

    function emit() {
      if (stopped) return;
      onData({
        code: resolved.code,
        moltId: resolved.moltId,
        join: resolved.joinData,
        molt: moltData,
        live: liveData,
        participants
      });
    }

    const moltRef = fb.fsMod.doc(fb.firestore, p.molts, resolved.moltId);
    const liveRef = fb.rtdbMod.ref(fb.database, p.liveMolts + '/' + resolved.moltId);
    const participantsRef = fb.fsMod.collection(fb.firestore, p.molts, resolved.moltId, 'participants');

    const unsubMolt = fb.fsMod.onSnapshot(moltRef, snap => {
      if (!snap.exists()) { if (onError) onError(new Error('molt_not_found')); return; }
      moltData = snap.data() || {};
      if (String(moltData.status || '').toLowerCase() === 'ended') {
        if (onError) onError(new Error('molt_ended'));
      }
      emit();
    }, err => { if (onError) onError(err); });

    const unsubParticipants = fb.fsMod.onSnapshot(participantsRef, snap => {
      participants = snap.docs.map(d => Object.assign({ id: d.id }, d.data() || {}));
      emit();
    }, () => { /* Participant subcollection is supplementary. */ });

    const unsubLive = fb.rtdbMod.onValue(liveRef, snap => {
      liveData = normalizeLiveState(snap.val());
      emit();
    }, err => { if (onError) onError(err); });

    emit();
    return function unsubscribe() {
      stopped = true;
      try { unsubMolt(); } catch (_) {}
      try { unsubParticipants(); } catch (_) {}
      try { unsubLive(); } catch (_) {}
      try { revokeViewerAccess(); } catch (_) {}
    };
  }

  function memberName(state, uid) {
    const member = state && state.live && state.live.members ? state.live.members.find(m => m.uid === uid) : null;
    if (member && member.name) return member.name;
    const participant = state && state.participants ? state.participants.find(p => p.uid === uid || p.id === uid) : null;
    if (participant && participant.name) return participant.name;
    if (state && state.molt && state.molt.hostUid === uid && state.molt.hostName) return state.molt.hostName;
    return 'Driver';
  }

  function destinationFrom(state) {
    const m = (state && state.molt) || {};
    const j = (state && state.join) || {};
    const lat = Number(m.destinationLatitude != null ? m.destinationLatitude : j.destinationLatitude);
    const lng = Number(m.destinationLongitude != null ? m.destinationLongitude : j.destinationLongitude);
    return {
      name: m.destination || j.destination || 'Shared destination',
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null
    };
  }

  function friendlyError(err) {
    const code = (err && (err.code || err.message)) || '';
    if (String(code).includes('permission-denied') || String(code).includes('PERMISSION_DENIED')) return 'Firebase blocked this browser Watch session. Publish the Build 06 Realtime Database rules, then reload this page.';
    if (code === 'code_not_found') return 'That Molt code was not found.';
    if (code === 'molt_ended') return 'That Molt has ended.';
    if (code === 'molt_not_found') return 'The Molt linked to that code could not be found.';
    if (code === 'missing_molt_id') return 'That code is missing its Molt session link.';
    if (code === 'viewer_auth_required') return 'Browser Watch could not sign in anonymously. Check Firebase Anonymous Authentication.';
    if (code === 'share_waiting_location') return 'That Share My Drive link is active and waiting for its first location.';
    if (code === 'share_ended') return 'That Share My Drive session has ended.';
    return 'The live Molt could not be loaded right now.';
  }

  window.MoltLive = {
    normalizeCode,
    validCodeFormat,
    isDemoCode,
    configReady,
    loadFirebase,
    resolveJoinCode,
    sessionExists,
    subscribeMeetDrive,
    memberName,
    destinationFrom,
    timestampMillis,
    friendlyError
  };
})(window);
