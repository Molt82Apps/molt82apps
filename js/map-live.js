(function(){
  'use strict';

  const FIREBASE_TIMEOUT = 10000;
  const STALE_MS = 15 * 60 * 1000;
  const DEFAULT_CENTER = [115.8613, -31.9523];
  const DEFAULT_ZOOM = 10.8;
  const COLOURS = new Set(['white','black','silver','grey','blue','red','green','yellow','orange','brown']);
  const REPORT_FILES = {
    'Crash':'crash_map.png',
    'Hazard':'hazard_map.png',
    'Roadworks':'roadworks_map.png',
    'Police':'police_map.png',
    'Mobile Camera':'camera_map.png',
    'Traffic':'traffic_map.png',
    'Road Closure':'road_closure_map.png',
    'Broken-down Vehicle':'breakdown_map.png'
  };

  const $ = id => document.getElementById(id);
  const panel = $('mapCodePanel');
  const form = $('mapCodeForm');
  const input = $('mapLinkCode');
  const message = $('mapCodeMessage');
  const badge = $('liveMapBadge');
  const badgeTitle = $('liveMapBadgeTitle');
  const badgeSub = $('liveMapBadgeSub');
  const errorCard = $('mapLoadError');
  const sessionPanel = $('liveSessionPanel');
  const sessionTitle = $('liveSessionTitle');
  const sessionStatus = $('liveSessionStatus');
  const sessionDestination = $('liveSessionDestination');
  const sessionSpeed = $('liveSessionSpeed');
  const sessionUpdated = $('liveSessionUpdated');
  const sessionDrivers = $('liveSessionDrivers');
  const sessionOpenApp = $('liveSessionOpenApp');
  const sessionOpenMaps = $('liveSessionOpenMaps');
  const closeSessionButton = $('closeLiveSession');

  let map = null;
  let db = null;
  let auth = null;
  let sourcesReady = false;
  let hazardRaw = {};
  let hazardCount = 0;
  let hazardUnsubscribe = null;
  let sessionUnsubscribers = [];
  let viewerGrantRef = null;
  let activeId = '';
  let activeMode = '';
  let latestDrivers = [];
  let lastHeading = 0;
  let userGesture = false;
  let programmaticMove = false;
  let resumeTimer = null;
  let openedOnce = false;

  function setHeaderHeight(){
    const header = document.querySelector('.site-header');
    if(header) document.documentElement.style.setProperty('--molt-header-height', Math.ceil(header.getBoundingClientRect().height) + 'px');
  }
  setHeaderHeight();
  window.addEventListener('resize', setHeaderHeight);

  function withTimeout(promise, ms, text){
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(text || 'timeout')), ms))]);
  }

  function extractCode(raw){
    let value = String(raw || '').trim();
    if(!value) return '';
    try{
      if(/^https?:\/\//i.test(value)){
        const url = new URL(value);
        value = url.searchParams.get('id') || url.searchParams.get('token') || url.searchParams.get('code') || '';
      }
    }catch(_){ }
    return value.trim().replace(/\s+/g,'').toUpperCase();
  }

  function validCode(value){ return /^[A-Z0-9]{4,24}$/.test(value); }
  function cleanColour(value){ const c = String(value || 'blue').toLowerCase(); return COLOURS.has(c) ? c : 'blue'; }
  function finite(value){ const n = Number(value); return Number.isFinite(n) ? n : null; }
  function ageLabel(ms){
    if(!Number.isFinite(ms)) return '—';
    const sec = Math.max(0, Math.round(ms / 1000));
    return sec < 60 ? sec + ' sec' : Math.round(sec / 60) + ' min';
  }

  function setBadge(connected, title, sub){
    badge.classList.toggle('connected', !!connected);
    badgeTitle.textContent = title;
    badgeSub.textContent = sub;
  }

  function updateHazardBadge(){
    const suffix = hazardCount === 1 ? '1 active hazard' : hazardCount + ' active hazards';
    setBadge(true, 'LIVE MAP', suffix);
  }

  function hideMapClutter(){
    try{
      for(const layer of (map.getStyle().layers || [])){
        const sourceLayer = String(layer['source-layer'] || '').toLowerCase();
        const hay = (String(layer.id || '') + ' ' + sourceLayer + ' ' + JSON.stringify(layer.filter || '')).toLowerCase();
        const place = sourceLayer === 'poi' || sourceLayer === 'landuse';
        const parking = place && (hay.includes('parking') || hay.includes('parking_entrance'));
        const sport = place && (hay.includes('stadium') || hay.includes('sports_centre') || hay.includes('pitch') || hay.includes('golf') || hay.includes('swimming_pool'));
        if(parking || sport){ try{ map.setLayoutProperty(layer.id, 'visibility', 'none'); }catch(_){ } }
      }
    }catch(_){ }
  }

  async function loadMapAssets(){
    for(const colour of COLOURS){
      try{
        const img = await map.loadImage('/map-assets/vehicles/' + colour + '.png?v=14');
        if(!map.hasImage('molt-' + colour)) map.addImage('molt-' + colour, img.data);
      }catch(_){ }
    }
    for(const [type, file] of Object.entries(REPORT_FILES)){
      try{
        const img = await map.loadImage('/map-assets/reports/' + file + '?v=14');
        if(!map.hasImage('report-' + type)) map.addImage('report-' + type, img.data);
      }catch(_){ }
    }
  }

  function addMapSources(){
    map.addSource('hazards',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'hazards',type:'symbol',source:'hazards',layout:{
      'icon-image':['concat','report-',['get','type']],
      'icon-size':0.42,
      'icon-allow-overlap':true,
      'icon-ignore-placement':true
    }});

    map.addSource('targets',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'targets-circles',type:'circle',source:'targets',paint:{
      'circle-radius':['case',['==',['get','kind'],'meet'],14,11],
      'circle-color':['case',['==',['get','kind'],'meet'],'#268a37','#155a58'],
      'circle-stroke-color':'#fff','circle-stroke-width':2
    }});
    map.addLayer({id:'targets-labels',type:'symbol',source:'targets',layout:{
      'text-field':['get','label'],'text-size':11,'text-offset':[0,2.0],'text-allow-overlap':true
    },paint:{'text-color':'#fff','text-halo-color':'#111','text-halo-width':2}});

    // Drivers are added last so vehicles stay visually above hazard/report markers.
    map.addSource('drivers',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'drivers',type:'symbol',source:'drivers',layout:{
      'icon-image':['concat','molt-',['get','colour']],
      'icon-size':0.55,
      'icon-allow-overlap':true,
      'icon-ignore-placement':true,
      'icon-rotation-alignment':'map',
      'icon-rotate':['+', ['get','heading'], 90],
      'text-field':['get','name'],
      'text-offset':[0,2.4],
      'text-size':11,
      'text-allow-overlap':true
    },paint:{'text-color':'#fff','text-halo-color':'#111','text-halo-width':2}});
  }

  function renderHazards(){
    if(!sourcesReady) return;
    const now = Date.now();
    const features = [];
    for(const [id, report] of Object.entries(hazardRaw || {})){
      if(!report || !REPORT_FILES[report.type]) continue;
      const lat = finite(report.latitude), lng = finite(report.longitude), expiresAt = finite(report.expiresAt);
      if(lat === null || lng === null || (expiresAt !== null && expiresAt <= now)) continue;
      const confirmations = report.confirmations && typeof report.confirmations === 'object' ? Object.keys(report.confirmations).length : 0;
      features.push({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]},properties:{
        id, type:report.type, expiresAt:expiresAt || 0, confirmations
      }});
    }
    hazardCount = features.length;
    map.getSource('hazards').setData({type:'FeatureCollection',features});
    updateHazardBadge();
  }

  async function connectFirebase(){
    if(!window.MOLT_FIREBASE_CONFIG) throw new Error('firebase_config_missing');
    if(!firebase.apps.length) firebase.initializeApp(window.MOLT_FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.database();
    setBadge(false,'LIVE MAP','Connecting hazards…');
    if(!auth.currentUser) await withTimeout(auth.signInAnonymously(), FIREBASE_TIMEOUT, 'Anonymous sign-in timed out');
    await watchHazards();
  }

  async function watchHazards(){
    const ref = db.ref('communityReports');
    const callback = snap => {
      hazardRaw = snap.val() || {};
      renderHazards();
    };
    const cancel = err => {
      console.error(err);
      setBadge(false,'LIVE MAP','Hazards unavailable');
    };
    ref.on('value', callback, cancel);
    hazardUnsubscribe = () => ref.off('value', callback);
  }

  function clearSessionSources(){
    if(!sourcesReady) return;
    try{ map.getSource('drivers').setData({type:'FeatureCollection',features:[]}); }catch(_){ }
    try{ map.getSource('targets').setData({type:'FeatureCollection',features:[]}); }catch(_){ }
  }

  function stopSession(removeQuery){
    for(const fn of sessionUnsubscribers.splice(0)){ try{ fn(); }catch(_){ } }
    if(viewerGrantRef){ try{ viewerGrantRef.remove(); }catch(_){ } viewerGrantRef = null; }
    activeId = ''; activeMode = ''; latestDrivers = []; openedOnce = false;
    clearSessionSources();
    sessionPanel.hidden = true;
    panel.hidden = false;
    sessionDestination.textContent = '';
    if(removeQuery){
      const u = new URL(location.href); u.searchParams.delete('id');u.searchParams.delete('token');u.searchParams.delete('code');
      history.replaceState({},'',u.pathname + (u.search ? u.search : '') + u.hash);
      input.value = '';
      message.textContent = '';
    }
    map.easeTo({center:DEFAULT_CENTER,zoom:DEFAULT_ZOOM,bearing:0,pitch:0,duration:650,essential:true});
  }

  function setTargets(data){
    if(!sourcesReady) return;
    const features = [];
    const destLat = finite(data.destinationLatitude), destLng = finite(data.destinationLongitude);
    if(destLat !== null && destLng !== null){ features.push({type:'Feature',geometry:{type:'Point',coordinates:[destLng,destLat]},properties:{kind:'destination',label:'Destination'}}); }
    const meetLat = finite(data.meetingLatitude), meetLng = finite(data.meetingLongitude);
    if(meetLat !== null && meetLng !== null){ features.push({type:'Feature',geometry:{type:'Point',coordinates:[meetLng,meetLat]},properties:{kind:'meet',label:'Meet'}}); }
    const stops = Array.isArray(data.stops) ? data.stops : (data.stops && typeof data.stops === 'object' ? Object.values(data.stops) : []);
    stops.forEach((stop,index) => {
      if(!stop) return;
      const lat = finite(stop.latitude), lng = finite(stop.longitude);
      if(lat !== null && lng !== null){ features.push({type:'Feature',geometry:{type:'Point',coordinates:[lng,lat]},properties:{kind:'stop',label:String(index+1)}}); }
    });
    map.getSource('targets').setData({type:'FeatureCollection',features});
  }

  function beginUserGesture(){ if(programmaticMove) return; userGesture = true; if(resumeTimer) clearTimeout(resumeTimer); }
  function scheduleFollow(){
    if(!userGesture) return;
    if(resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { userGesture = false; followLatest(650); }, 5000);
  }

  function zoomForSpeed(kmh){ if(kmh>=100)return 14.7;if(kmh>=80)return 15;if(kmh>=60)return 15.35;if(kmh>=40)return 15.8;if(kmh>=20)return 16.25;return 16.7; }
  function followLatest(duration){
    if(!latestDrivers.length || userGesture) return;
    const moving = latestDrivers[0];
    if(moving.speed >= 5 && Number.isFinite(moving.heading)) lastHeading = moving.heading;
    const h = map.getContainer().clientHeight;
    programmaticMove = true;
    map.easeTo({center:[moving.lng,moving.lat],bearing:lastHeading,zoom:zoomForSpeed(moving.speed),pitch:0,offset:[0,Math.round(h*0.18)],duration:duration || 600,essential:true});
    setTimeout(() => { programmaticMove = false; }, Math.max(350,(duration || 600)+100));
  }

  function showActiveSession(data, drivers, mode, id){
    const now = Date.now();
    const fresh = drivers.filter(d => d.updatedAt && now - d.updatedAt < STALE_MS);
    if(!fresh.length){ failSession('Location is no longer updating.'); return; }
    fresh.sort((a,b) => b.updatedAt - a.updatedAt);
    latestDrivers = fresh;
    activeMode = mode;
    activeId = id;

    map.getSource('drivers').setData({type:'FeatureCollection',features:fresh.map(d => ({type:'Feature',geometry:{type:'Point',coordinates:[d.lng,d.lat]},properties:{
      name:d.name || '', colour:cleanColour(d.colour), heading:Number.isFinite(d.heading) ? d.heading : 0
    }}))});
    setTargets(data || {});

    panel.hidden = true;
    sessionPanel.hidden = false;
    message.textContent = '';
    sessionTitle.textContent = mode === 'molt' ? 'MEET & DRIVE LIVE' : 'SHARE MY DRIVE LIVE';
    sessionStatus.textContent = mode === 'molt' ? 'Molt Live Map connected' : 'Live shared vehicle connected';
    sessionDestination.textContent = data && data.destination ? 'Destination: ' + data.destination : '';
    sessionDestination.style.display = sessionDestination.textContent ? 'block' : 'none';
    sessionSpeed.textContent = Math.round(fresh[0].speed || 0) + ' km/h';
    sessionUpdated.textContent = ageLabel(now - fresh[0].updatedAt);
    sessionDrivers.textContent = String(fresh.length);
    sessionOpenMaps.href = 'https://www.google.com/maps/search/?api=1&query=' + fresh[0].lat + ',' + fresh[0].lng;
    sessionOpenApp.href = mode === 'molt' ? 'molt://join?code=' + encodeURIComponent(id) : 'molt://drive?token=' + encodeURIComponent(id);

    if(!openedOnce){
      const u = new URL(location.href); u.searchParams.set('id',id); u.searchParams.delete('token'); u.searchParams.delete('code');
      history.replaceState({},'',u.pathname + '?' + u.searchParams.toString() + u.hash);
      openedOnce = true;
    }
    followLatest(openedOnce ? 650 : 0);
  }

  function failSession(text){
    for(const fn of sessionUnsubscribers.splice(0)){ try{ fn(); }catch(_){ } }
    if(viewerGrantRef){ try{ viewerGrantRef.remove(); }catch(_){ } viewerGrantRef = null; }
    activeId = ''; activeMode = ''; latestDrivers = []; openedOnce = false;
    clearSessionSources();
    sessionPanel.hidden = true;
    panel.hidden = false;
    message.textContent = text || 'That shared drive could not be opened.';
  }

  async function startShare(token){
    const ref = db.ref('shareDrives/' + token);
    let first = true;
    const timer = setTimeout(() => { if(first) failSession('Shared Drive did not respond. Check the link and try again.'); }, FIREBASE_TIMEOUT);
    const callback = snap => {
      first = false; clearTimeout(timer);
      const d = snap.val();
      if(!d || finite(d.latitude) === null || finite(d.longitude) === null){ failSession('This Share My Drive has ended or has no live location.'); return; }
      const driver = {lat:Number(d.latitude),lng:Number(d.longitude),heading:finite(d.heading) || 0,speed:Math.max(0,finite(d.speedKmh) || 0),colour:d.vehicleColour || 'blue',name:'',updatedAt:finite(d.updatedAt) || 0};
      showActiveSession(d,[driver],'share',token);
    };
    const cancel = err => { first=false;clearTimeout(timer);console.error(err);failSession('Unable to read this Shared Drive.'); };
    ref.on('value',callback,cancel);
    sessionUnsubscribers.push(() => { clearTimeout(timer);ref.off('value',callback); });
  }

  async function startMolt(code){
    const codeSnap = await withTimeout(db.ref('watchCodes/' + code).once('value'),8000,'Molt code lookup timed out');
    const entry = codeSnap.val();
    if(!entry || entry.active !== true || !entry.moltId) throw new Error('Molt code not found or no longer active.');
    const moltId = String(entry.moltId);
    const user = auth.currentUser;
    if(!user) throw new Error('Browser live-map sign-in is not available.');
    viewerGrantRef = db.ref('watchViewers/' + moltId + '/' + user.uid);
    await withTimeout(viewerGrantRef.set({code:code,createdAt:firebase.database.ServerValue.TIMESTAMP}),8000,'Viewer access timed out');

    const ref = db.ref('watchMolts/' + moltId);
    let first = true;
    const timer = setTimeout(() => { if(first) failSession('Live Molt did not respond. Check the code and try again.'); }, FIREBASE_TIMEOUT);
    const callback = snap => {
      first = false; clearTimeout(timer);
      const d = snap.val();
      if(!d || d.status !== 'active'){ failSession('This Molt has ended.'); return; }
      const participants = d.participants || {};
      const locations = d.locations || {};
      const drivers = [];
      for(const [uid, loc] of Object.entries(locations)){
        if(!loc || finite(loc.latitude) === null || finite(loc.longitude) === null) continue;
        drivers.push({lat:Number(loc.latitude),lng:Number(loc.longitude),heading:finite(loc.heading)||0,speed:Math.max(0,finite(loc.speedKmh)||0),colour:loc.vehicleColour||'blue',name:(participants[uid]&&participants[uid].name)||'',updatedAt:finite(loc.updatedAt)||0});
      }
      showActiveSession(d,drivers,'molt',code);
    };
    const cancel = err => { first=false;clearTimeout(timer);console.error(err);failSession('Unable to read this Molt Live Map.'); };
    ref.on('value',callback,cancel);
    sessionUnsubscribers.push(() => { clearTimeout(timer);ref.off('value',callback); });
  }

  async function openShared(raw){
    const id = extractCode(raw);
    if(!validCode(id)){ message.textContent = 'Enter a Molt code or paste a valid Molt shared link.';input.focus();return; }
    message.textContent = 'Opening live map…';
    form.querySelector('button[type="submit"]').disabled = true;
    try{
      for(const fn of sessionUnsubscribers.splice(0)){ try{ fn(); }catch(_){ } }
      if(viewerGrantRef){ try{ await viewerGrantRef.remove(); }catch(_){ } viewerGrantRef = null; }
      clearSessionSources(); openedOnce = false;
      if(id.length === 6) await startMolt(id); else await startShare(id);
    }catch(err){
      console.error(err);
      failSession(err && err.message ? err.message : 'Unable to open this live map.');
    }finally{
      form.querySelector('button[type="submit"]').disabled = false;
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); openShared(input.value); });
  input.addEventListener('input', () => { message.textContent = ''; });
  closeSessionButton.addEventListener('click', () => stopSession(true));

  async function boot(){
    try{
      if(!window.maplibregl) throw new Error('MapLibre did not load');
      map = new maplibregl.Map({container:'publicMap',center:DEFAULT_CENTER,zoom:DEFAULT_ZOOM,bearing:0,pitch:0,style:'https://tiles.openfreemap.org/styles/liberty',attributionControl:true});
      map.addControl(new maplibregl.NavigationControl({showCompass:true,showZoom:true}),'bottom-right');
      map.on('style.load',hideMapClutter);
      for(const event of ['dragstart','zoomstart','rotatestart','pitchstart']) map.on(event,e => { if(e && e.originalEvent) beginUserGesture(); });
      map.on('moveend',() => { if(programmaticMove){programmaticMove=false;return;} if(userGesture) scheduleFollow(); });
      map.on('load', async () => {
        try{
          hideMapClutter();
          await loadMapAssets();
          addMapSources();
          sourcesReady = true;
          renderHazards();

          map.on('click','hazards',e => {
            const f = e.features && e.features[0]; if(!f) return;
            const expiresAt = Number(f.properties.expiresAt)||0;
            const remaining = expiresAt ? Math.max(0,expiresAt-Date.now()) : 0;
            const mins = Math.ceil(remaining/60000);
            const meta = (Number(f.properties.confirmations)||0) + ' confirmation' + ((Number(f.properties.confirmations)||0)===1?'':'s') + (expiresAt ? ' · about ' + mins + ' min remaining' : '');
            new maplibregl.Popup({offset:18,closeButton:false}).setLngLat(e.lngLat).setHTML('<div class="hazard-popup-title">'+String(f.properties.type||'Hazard')+'</div><div class="hazard-popup-meta">'+meta+'</div>').addTo(map);
          });
          map.on('mouseenter','hazards',() => { map.getCanvas().style.cursor='pointer'; });
          map.on('mouseleave','hazards',() => { map.getCanvas().style.cursor=''; });

          try{
            await connectFirebase();
          }catch(firebaseErr){
            console.error(firebaseErr);
            setBadge(false,'LIVE MAP','Hazards unavailable');
            // Firebase initialization happens before anonymous sign-in. Public Share My Drive
            // sessions can still be read even if anonymous authentication is temporarily unavailable.
            if(!db && firebase.apps.length){ db = firebase.database(); auth = firebase.auth(); }
          }
          const params = new URLSearchParams(location.search);
          const supplied = extractCode(params.get('id') || params.get('token') || params.get('code') || '');
          if(supplied && db){ input.value = supplied; await openShared(supplied); }
        }catch(err){
          console.error(err);
          if(String(err && err.message || '').toLowerCase().includes('firebase')) setBadge(false,'LIVE MAP','Hazards unavailable');
          else { errorCard.hidden=false; }
        }
      });
      map.on('error', e => { if(e && e.error) console.warn('MapLibre:',e.error); });
    }catch(err){
      console.error(err);
      errorCard.hidden = false;
    }
  }

  setInterval(renderHazards,30000);
  window.addEventListener('beforeunload',() => {
    if(hazardUnsubscribe) try{hazardUnsubscribe();}catch(_){ }
    for(const fn of sessionUnsubscribers) try{fn();}catch(_){ }
  });

  boot();
})();
