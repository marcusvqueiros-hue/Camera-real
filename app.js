/* Câmera Real: fotos com data, hora e localização gravadas na imagem,
   fila offline em IndexedDB e sincronização com Supabase (banco + storage). */
'use strict';

const SUPABASE_URL = 'https://iseiyimtboqfhmheyfmb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2tTrxMmKVvyflHlOUsl8RQ_pnJz9qBV';
const BUCKET = 'fotos';
const MAX_SIDE = 2560;
const THUMB_SIDE = 400;

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const $ = (id) => document.getElementById(id);
const state = {
  user: JSON.parse(localStorage.getItem('cr_user') || 'null'), // {id,email}, mantido p/ uso offline
  stream: null,
  facing: localStorage.getItem('cr_facing') || 'environment',
  fix: null,          // última posição GPS
  watchId: null,
  syncing: false,
  cloud: [],          // fotos já na nuvem
  current: null       // foto aberta no visualizador
};

/* ---------------- IndexedDB (fila offline) ---------------- */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('camera-real', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('pending', mode);
      const req = fn(t.objectStore('pending'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    put: (v) => tx('readwrite', (s) => s.put(v)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    all: () => tx('readonly', (s) => s.getAll())
  };
})();

/* ---------------- utilidades ---------------- */
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(d) { return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtTz(d) {
  const o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-', a = Math.abs(o);
  return `GMT${s}${Math.floor(a / 60)}${a % 60 ? ':' + pad(a % 60) : ''}`;
}
function fmtCoords(lat, lon) { return `${lat.toFixed(6)}, ${lon.toFixed(6)}`; }
function fileName(iso) {
  const d = new Date(iso);
  return `foto_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.jpg`;
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

function show(id) {
  for (const s of ['login', 'camera', 'gallery', 'viewer']) $(s).hidden = s !== id;
  if (id === 'camera') startCamera(); else stopCamera();
  if (typeof showInstall === 'function') showInstall();
}

function netBanner(msg, ok) {
  const n = $('net');
  n.textContent = msg; n.className = 'net' + (ok ? ' ok' : ''); n.hidden = false;
  clearTimeout(netBanner.t);
  if (ok) netBanner.t = setTimeout(() => { n.hidden = true; }, 2500);
}
function updateNet() {
  if (navigator.onLine) { if (!$('net').hidden) netBanner('Online', true); }
  else netBanner('Sem internet: as fotos ficam guardadas no celular');
}

/* ---------------- login ---------------- */
async function doAuth(signup) {
  const email = $('email').value.trim(), password = $('password').value;
  const msg = $('loginMsg'); msg.className = 'msg';
  if (!navigator.onLine) { msg.textContent = 'Conecte-se à internet para entrar pela primeira vez.'; msg.className = 'msg err'; return; }
  msg.textContent = signup ? 'Criando conta…' : 'Entrando…';
  const fn = signup
    ? sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
    : sb.auth.signInWithPassword({ email, password });
  const { data, error } = await fn;
  if (error) {
    msg.className = 'msg err';
    msg.textContent = /confirm/i.test(error.message) ? 'Confirme seu e-mail pelo link que enviamos e depois toque em Entrar.'
      : /invalid/i.test(error.message) ? 'E-mail ou senha incorretos.' : error.message;
    return;
  }
  if (signup && !data.session) { msg.textContent = 'Conta criada! Abra o link de confirmação no seu e-mail e depois toque em Entrar.'; return; }
  setUser(data.user);
}

function setUser(u) {
  state.user = u ? { id: u.id, email: u.email } : null;
  if (state.user) localStorage.setItem('cr_user', JSON.stringify(state.user));
  else localStorage.removeItem('cr_user');
  $('userEmail').textContent = state.user?.email || '';
  if (state.user) { show('camera'); refreshBadge(); sync(); } else show('login');
}

/* ---------------- câmera ---------------- */
async function startCamera() {
  startGps();
  if (state.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) { $('camFallback').hidden = false; return; }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 2560 }, height: { ideal: 1920 } }
    });
    $('video').srcObject = state.stream;
    $('camFallback').hidden = true;
    await $('video').play().catch(() => {});
  } catch (e) {
    console.warn('camera', e);
    $('camFallback').hidden = false;
  }
}
function stopCamera() {
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  stopGps();
}

/* ---------------- GPS (funciona sem internet) ---------------- */
function startGps() {
  if (!navigator.geolocation || state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(
    (p) => { state.fix = p; renderLive(); },
    (e) => { console.warn('gps', e); renderLive(e); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
  );
}
function stopGps() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}
function freshFix() {
  return new Promise((res) => {
    const f = state.fix;
    if (f && Date.now() - f.timestamp < 30000) return res(f);
    if (!navigator.geolocation) return res(f || null);
    navigator.geolocation.getCurrentPosition(
      (p) => { state.fix = p; res(p); },
      () => res(f || null),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 8000 }
    );
  });
}
function renderLive(err) {
  const d = new Date();
  $('liveClock').textContent = `${fmtDate(d)}  ${fmtTime(d)}`;
  const f = state.fix;
  $('liveGps').textContent = f
    ? `📍 ${fmtCoords(f.coords.latitude, f.coords.longitude)}  (±${Math.round(f.coords.accuracy)} m)`
    : err && err.code === 1 ? '📍 Permita o acesso à localização nas configurações'
    : '📍 Buscando localização…';
}

/* endereço aproximado: só quando há internet, com tempo-limite curto */
const geoCache = new Map();
async function reverseGeocode(lat, lon) {
  if (!navigator.onLine) return null;
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=pt-BR&lat=${lat}&lon=${lon}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json(), a = j.address || {};
    const parts = [
      [a.road, a.house_number].filter(Boolean).join(', '),
      a.suburb || a.neighbourhood,
      a.city || a.town || a.village || a.municipality,
      a.state
    ].filter(Boolean);
    const s = parts.join(' - ') || j.display_name || null;
    geoCache.set(key, s);
    return s;
  } catch { return null; }
}

/* ---------------- captura e carimbo ---------------- */
async function capture(source) {
  const btn = $('btnShutter'); btn.disabled = true;
  try {
    const flash = $('flash'); flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
    const when = new Date();
    let w, h;
    if (source instanceof HTMLVideoElement) {
      w = source.videoWidth; h = source.videoHeight;
      if (!w) throw new Error('Câmera ainda não está pronta');
    } else { w = source.naturalWidth; h = source.naturalHeight; }
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, c.width, c.height);

    const fix = await freshFix();
    const lat = fix?.coords.latitude, lon = fix?.coords.longitude, acc = fix?.coords.accuracy;
    const address = fix ? await reverseGeocode(lat, lon) : null;

    drawStamp(ctx, c.width, c.height, when, fix, address);
    const blob = await toBlob(c, 0.88);

    const tk = THUMB_SIDE / Math.max(c.width, c.height);
    const t = document.createElement('canvas');
    t.width = Math.round(c.width * tk); t.height = Math.round(c.height * tk);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    const thumb = await toBlob(t, 0.75);

    const item = {
      id: uuid(), blob, thumb,
      meta: {
        taken_at: when.toISOString(),
        latitude: lat ?? null, longitude: lon ?? null,
        accuracy_m: acc != null ? Math.round(acc) : null,
        address: address || null,
        created_offline: !navigator.onLine
      }
    };
    await idb.put(item);
    setLastThumb(thumb);
    refreshBadge();
    sync();
  } catch (e) {
    alert('Não foi possível salvar a foto: ' + e.message);
  } finally { btn.disabled = false; }
}

function drawStamp(ctx, W, H, when, fix, address) {
  const fs = Math.max(16, Math.round(Math.min(W, H) * 0.038));
  const lines = [`${fmtDate(when)}  ${fmtTime(when)}  (${fmtTz(when)})`];
  if (fix) lines.push(`Lat/Long: ${fmtCoords(fix.coords.latitude, fix.coords.longitude)}  ±${Math.round(fix.coords.accuracy)} m`);
  else lines.push('Localização indisponível');
  if (address) lines.push(address);
  const pad = Math.round(fs * 0.6), lh = Math.round(fs * 1.3);
  const bandH = pad * 2 + lh * lines.length;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, H - bandH, W, bandH);
  ctx.textBaseline = 'top';
  lines.forEach((ln, i) => {
    ctx.font = `${i === 0 ? 700 : 500} ${i === 0 ? fs : Math.round(fs * 0.82)}px -apple-system, Roboto, "Segoe UI", sans-serif`;
    ctx.fillStyle = i === 0 ? '#ffcc33' : '#ffffff';
    let text = ln;
    while (ctx.measureText(text).width > W - pad * 2 && text.length > 4) text = text.slice(0, -2);
    if (text !== ln) text = text.slice(0, -1) + '…';
    ctx.fillText(text, pad, H - bandH + pad + i * lh);
  });
}

function setLastThumb(blob) {
  const img = $('lastThumb');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob); img.hidden = false;
}

async function refreshBadge() {
  const n = (await idb.all()).length;
  const b = $('pendingBadge'); b.textContent = n; b.hidden = n === 0;
  return n;
}

/* ---------------- sincronização ---------------- */
async function sync() {
  if (state.syncing || !navigator.onLine || !state.user) return;
  state.syncing = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { setSyncInfo('Entre novamente para enviar as fotos.'); return; }
    const uid = session.user.id;
    const items = await idb.all();
    for (const it of items) {
      const base = `${uid}/${it.id}`;
      const up1 = await sb.storage.from(BUCKET).upload(`${base}.jpg`, it.blob, { contentType: 'image/jpeg', upsert: true });
      if (up1.error) throw up1.error;
      const up2 = await sb.storage.from(BUCKET).upload(`${base}_t.jpg`, it.thumb, { contentType: 'image/jpeg', upsert: true });
      if (up2.error) throw up2.error;
      const { error } = await sb.from('photos').upsert({ id: it.id, user_id: uid, storage_path: `${base}.jpg`, ...it.meta });
      if (error) throw error;
      await idb.del(it.id);
      refreshBadge();
    }
    setSyncInfo(items.length ? `${items.length} foto(s) enviada(s) para a nuvem.` : '');
  } catch (e) {
    console.warn('sync', e);
    setSyncInfo('Falha ao enviar, tentaremos de novo: ' + (e.message || e));
  } finally {
    state.syncing = false;
    if (!$('gallery').hidden) renderGallery();
  }
}
function setSyncInfo(t) { $('syncInfo').textContent = t; }

/* ---------------- galeria ---------------- */
async function renderGallery() {
  const grid = $('grid');
  const pending = (await idb.all()).sort((a, b) => b.meta.taken_at.localeCompare(a.meta.taken_at));
  let cloud = state.cloud;
  if (navigator.onLine) {
    const { data, error } = await sb.from('photos').select('*').order('taken_at', { ascending: false }).limit(1000);
    if (!error && data) {
      const paths = data.flatMap((p) => [p.storage_path, p.storage_path.replace(/\.jpg$/, '_t.jpg')]);
      const urls = {};
      for (let i = 0; i < paths.length; i += 200) {
        const r = await sb.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 200), 3600);
        (r.data || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
      }
      cloud = data.map((p) => ({ ...p, url: urls[p.storage_path], thumbUrl: urls[p.storage_path.replace(/\.jpg$/, '_t.jpg')] || urls[p.storage_path] }));
      state.cloud = cloud;
    }
  }
  const all = [
    ...pending.map((p) => ({ ...p.meta, id: p.id, pending: true, blob: p.blob, thumbBlob: p.thumb })),
    ...cloud
  ];
  grid.textContent = '';
  let lastDay = '';
  for (const p of all) {
    const d = new Date(p.taken_at), day = fmtDate(d);
    if (day !== lastDay) {
      const h = document.createElement('div'); h.className = 'day'; h.textContent = day; grid.append(h); lastDay = day;
    }
    const b = document.createElement('button'); b.className = 'tile';
    const img = document.createElement('img'); img.loading = 'lazy'; img.alt = `Foto de ${day} ${fmtTime(d)}`;
    img.src = p.pending ? URL.createObjectURL(p.thumbBlob) : (p.thumbUrl || '');
    const tag = document.createElement('span');
    tag.className = 'tag' + (p.pending ? ' wait' : '');
    tag.textContent = p.pending ? 'aguardando envio' : fmtTime(d).slice(0, 5);
    b.append(img, tag);
    b.onclick = () => openViewer(p);
    grid.append(b);
  }
  $('emptyMsg').hidden = all.length > 0;
  if (!navigator.onLine) setSyncInfo('Sem internet: mostrando só as fotos guardadas neste celular.');
}

function openViewer(p) {
  state.current = p;
  const img = $('viewerImg');
  img.src = p.pending ? URL.createObjectURL(p.blob) : p.url;
  const d = new Date(p.taken_at);
  const meta = $('viewerMeta'); meta.textContent = '';
  const rows = [
    ['Data', fmtDate(d)], ['Hora', `${fmtTime(d)} (${fmtTz(d)})`],
    ['Local', p.latitude != null ? `${fmtCoords(p.latitude, p.longitude)} ±${p.accuracy_m} m` : 'indisponível'],
    ...(p.address ? [['Endereço', p.address]] : []),
    ['Situação', p.pending ? 'guardada no celular, aguardando internet' : 'salva na nuvem']
  ];
  for (const [k, v] of rows) {
    const div = document.createElement('div'); const b = document.createElement('b');
    b.textContent = k + ': '; div.append(b, v); meta.append(div);
  }
  const map = $('btnMap');
  map.hidden = p.latitude == null;
  if (p.latitude != null) map.href = `https://www.google.com/maps?q=${p.latitude},${p.longitude}`;
  show('viewer');
}

async function downloadCurrent() {
  const p = state.current; if (!p) return;
  const btn = $('btnDownload'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Preparando…';
  try {
    const blob = p.pending ? p.blob : await (await fetch(p.url)).blob();
    const name = fileName(p.taken_at);
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (isIOS && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name }).catch(() => {});
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) { alert('Não foi possível baixar: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = label; }
}

async function deleteCurrent() {
  const p = state.current; if (!p) return;
  if (!confirm('Apagar esta foto definitivamente?')) return;
  try {
    if (p.pending) await idb.del(p.id);
    else {
      if (!navigator.onLine) { alert('Conecte-se à internet para apagar fotos da nuvem.'); return; }
      const { error } = await sb.from('photos').delete().eq('id', p.id);
      if (error) throw error;
      await sb.storage.from(BUCKET).remove([p.storage_path, p.storage_path.replace(/\.jpg$/, '_t.jpg')]);
    }
    refreshBadge(); show('gallery'); renderGallery();
  } catch (e) { alert('Não foi possível apagar: ' + e.message); }
}

/* ---------------- eventos ---------------- */
$('loginForm').addEventListener('submit', (e) => { e.preventDefault(); doAuth(false); });
$('btnSignup').addEventListener('click', () => { if ($('loginForm').reportValidity()) doAuth(true); });
$('btnShutter').addEventListener('click', () => {
  if (state.stream) capture($('video'));
  else $('fileInput').click();
});
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => { capture(img).finally(() => URL.revokeObjectURL(img.src)); };
  img.src = URL.createObjectURL(f);
  e.target.value = '';
});
$('btnFlip').addEventListener('click', () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  localStorage.setItem('cr_facing', state.facing);
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  startCamera();
});
$('btnGallery').addEventListener('click', () => { show('gallery'); renderGallery(); });
$('btnBack').addEventListener('click', () => show('camera'));
$('btnSync').addEventListener('click', async () => { setSyncInfo(navigator.onLine ? 'Sincronizando…' : 'Sem internet no momento.'); await sync(); renderGallery(); });
$('btnCloseViewer').addEventListener('click', () => show('gallery'));
$('btnDownload').addEventListener('click', downloadCurrent);
$('btnDelete').addEventListener('click', deleteCurrent);
$('btnLogout').addEventListener('click', async () => {
  const n = await refreshBadge();
  if (n && !confirm(`Há ${n} foto(s) ainda não enviada(s). Elas continuam guardadas neste celular. Sair mesmo assim?`)) return;
  await sb.auth.signOut().catch(() => {});
  setUser(null);
});
window.addEventListener('online', () => { updateNet(); sync(); });
window.addEventListener('offline', updateNet);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else { if (!$('camera').hidden) startCamera(); sync(); }
});
setInterval(() => { if (!$('camera').hidden) renderLive(); }, 1000);
setInterval(sync, 60000);

sb.auth.onAuthStateChange((ev, session) => {
  if (ev === 'SIGNED_IN' && session && !state.user) setUser(session.user);
});

/* ---------------- instalar (baixar o app) ---------------- */
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function showInstall() { $('btnInstall').hidden = standalone() || !($('camera').hidden === false || $('login').hidden === false); }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; showInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; $('btnInstall').hidden = true; });
$('btnInstall').addEventListener('click', async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; return; }
  $('installText').innerHTML = isIOS
    ? 'No iPhone, abra este link no <b>Safari</b>, toque no botão <b>Compartilhar</b> (quadrado com seta para cima) e escolha <b>Adicionar à Tela de Início</b>.'
    : 'No Android, abra este link no <b>Chrome</b>, toque no menu <b>⋮</b> e escolha <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.';
  $('installHelp').hidden = false;
});
$('installOk').addEventListener('click', () => { $('installHelp').hidden = true; });

/* ---------------- início ---------------- */
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  updateNet();
  $('userEmail').textContent = state.user?.email || '';
  if (state.user) { show('camera'); refreshBadge(); sync(); }
  else show('login');
  renderLive();
  showInstall();
})();
