import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';

/* ───────────────────────── Configuration ───────────────────────── */

const configured = !SUPABASE_URL.includes('TON-PROJET') && !SUPABASE_ANON_KEY.includes('COLLE');
const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

const BUCKET = 'photos';
const MAX_BATCH = 30; // nombre max de photos par enregistrement groupé
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const GRADIENTS = ['love', 'dream', 'ocean', 'sun'];
const EMOJIS = ['❤️', '🔥', '🌴', '🏡', '📸', '✨', '🎉', '🐶', '🍕', '💍'];

/* ───────────────────────── Utilitaires ───────────────────────── */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, extra = '') => `<svg ${extra}><use href="#i-${name}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, words) => `${n} ${n > 1 ? words.split(' ').map((w) => w + 's').join(' ') : words}`;

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('lp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lp.' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d < 7 ? `il y a ${d} j` : new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
const fullDate = (iso) => new Date(iso).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const stamp = (iso) => new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(m)) return "Confirme d'abord ton e-mail (regarde ta boîte de réception).";
  if (/already registered/i.test(m)) return 'Un compte existe déjà avec cet e-mail.';
  if (/Code invalide/i.test(m)) return "Ce code d'invitation n'existe pas.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Pas de connexion internet. Réessaie.';
  return m;
}

/* ───────────────────────── État ───────────────────────── */

const state = {
  user: null,
  profile: null,
  spaces: [],
  photos: [],
  names: new Map(),
  urls: new Map(),
  files: new Map(),
  select: null, // Set d'ids quand le mode sélection est actif
  photosFilter: 'received',
  send: { files: [], spaceId: null, busy: false },
  channel: null,
  autoSheetShown: false,
  events: [],
  cal: { month: null, selected: null },
  push: 'off',
};

const saved = new Set(prefs.get('saved', []));
function markSaved(ids) {
  ids.forEach((id) => saved.add(id));
  prefs.set('saved', [...saved].slice(-3000));
}

function autoSave() {
  return prefs.get('autosave', null);
}
function setAutoSave(on) {
  prefs.set('autosave', { on, since: new Date().toISOString() });
}

const me = () => state.user?.id;
const nameOf = (id) => (id === me() ? 'Toi' : state.names.get(id) || 'Quelqu’un');
const spaceOf = (id) => state.spaces.find((s) => s.id === id);
const received = () => state.photos.filter((p) => p.sender_id !== me());
const sentPhotos = () => state.photos.filter((p) => p.sender_id === me());

function pendingPhotos() {
  const a = autoSave();
  if (!a || !a.on) return [];
  return received().filter((p) => p.created_at >= a.since && !saved.has(p.id));
}

/* ───────────────────────── Thème ───────────────────────── */

function applyTheme() {
  document.documentElement.dataset.theme = prefs.get('theme', 'auto');
}

/* ───────────────────────── Données (Supabase) ───────────────────────── */

async function loadProfile() {
  const { data, error } = await sb.from('profiles').select('id, username, created_at, notif_photos, notif_members, notif_events, notif_reminders').eq('id', me()).single();
  if (error) throw error;
  state.profile = data;
}

async function loadData() {
  const [sp, ph] = await Promise.all([
    sb.from('spaces')
      .select('id, name, emoji, gradient, invite_code, owner_id, created_at, space_members(user_id, profiles(username))')
      .order('created_at'),
    sb.from('photos').select('id, space_id, sender_id, path, created_at').order('created_at', { ascending: false }).limit(500),
    sb.from('events').select('*').order('starts_at'),
  ]).then(([a, b, c]) => { if (c.error) throw c.error; state.events = c.data; return [a, b]; });
  if (sp.error) throw sp.error;
  if (ph.error) throw ph.error;
  state.spaces = sp.data;
  state.photos = ph.data;
  state.names.clear();
  for (const s of sp.data) for (const m of s.space_members) if (m.profiles) state.names.set(m.user_id, m.profiles.username);
}

async function ensureUrls(list) {
  const missing = [...new Set(list.map((p) => p.path).filter((path) => !state.urls.has(path)))];
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(missing.slice(i, i + 100), 60 * 60 * 6);
    if (error) throw error;
    for (const d of data) if (d.signedUrl) state.urls.set(d.path, d.signedUrl);
  }
}

async function hydrateImages(root = document) {
  const imgs = $$('img[data-path]:not([src])', root);
  if (!imgs.length) return;
  const list = imgs.map((img) => ({ path: img.dataset.path }));
  try { await ensureUrls(list); } catch { return; }
  for (const img of imgs) {
    const url = state.urls.get(img.dataset.path);
    if (!url) continue;
    img.onload = () => img.classList.add('loaded');
    img.src = url;
  }
}

function subscribeRealtime() {
  if (state.channel) sb.removeChannel(state.channel);
  let batchTimer;
  state.channel = sb
    .channel('lonapics-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'photos' }, ({ new: p }) => {
      if (state.photos.some((x) => x.id === p.id)) return;
      state.photos.unshift(p);
      if (p.sender_id !== me()) {
        const s = spaceOf(p.space_id);
        toast(`📸 ${nameOf(p.sender_id)} vient d'envoyer une photo${s ? ' dans ' + s.name : ''}`);
        clearTimeout(batchTimer);
        batchTimer = setTimeout(() => {
          const pend = pendingPhotos();
          if (pend.length && document.visibilityState === 'visible' && !document.querySelector('.sheet, .viewer')) openSaveSheet(pend);
        }, 1500);
      }
      softRender();
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'photos' }, ({ old }) => {
      state.photos = state.photos.filter((x) => x.id !== old.id);
      softRender();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, async () => {
      const { data } = await sb.from('events').select('*').order('starts_at');
      if (data) { state.events = data; softRender(); }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'space_members' }, async ({ new: m }) => {
      if (m.user_id === me()) return;
      await loadData().catch(() => {});
      const s = spaceOf(m.space_id);
      toast(`🎉 ${nameOf(m.user_id)} a rejoint ${s ? s.name : 'ton espace'}`);
      softRender();
    })
    .subscribe();
}

/* ───────────────────────── Enregistrement dans la galerie ───────────────────────── */

async function prepareFiles(list, onProgress) {
  await ensureUrls(list);
  let done = 0;
  return Promise.all(
    list.map(async (p) => {
      if (!state.files.has(p.id)) {
        const res = await fetch(state.urls.get(p.path));
        if (!res.ok) throw new Error('Téléchargement impossible');
        const blob = await res.blob();
        const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
        const ext = type.split('/')[1].replace('jpeg', 'jpg');
        state.files.set(p.id, new File([blob], `LonaPics_${stamp(p.created_at)}_${p.id.slice(0, 4)}.${ext}`, { type }));
      }
      onProgress?.(++done, list.length);
      return state.files.get(p.id);
    }),
  );
}

// iPhone : feuille de partage → « Enregistrer X images » (va directement dans Photos).
// Android : téléchargement → la photo apparaît dans la galerie (dossier Download).
async function deliverFiles(list, files) {
  const canShare = navigator.canShare && navigator.canShare({ files });
  if (isIOS && canShare) {
    try {
      await navigator.share({ files });
      markSaved(list.map((p) => p.id));
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancel';
      if (e.name === 'NotAllowedError') return 'retry';
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    await sleep(300);
  }
  markSaved(list.map((p) => p.id));
  return 'downloaded';
}

function openSaveSheet(all) {
  const list = all.slice(0, MAX_BATCH);
  const senders = [...new Set(list.map((p) => nameOf(p.sender_id)))].join(', ');
  let files = null;
  const el = openSheet(`
    <div class="row" style="margin-bottom:6px">${icon('download', 'style="color:var(--pink)"')}<h2 class="h2">${plural(list.length, 'nouvelle photo')}</h2></div>
    <p class="muted" style="margin:0 0 14px">De ${esc(senders)}</p>
    <div class="grid" style="margin-bottom:18px">${list.slice(0, 9).map((p) => tile(p, { meta: false })).join('')}</div>
    <button class="btn block" id="save-go" disabled>Préparation…</button>
    <p class="small muted" style="text-align:center;margin:12px 0 0">${
      isIOS ? 'Dans le menu qui s’ouvre, choisis « Enregistrer les images ».' : 'Les photos vont dans ta galerie (album « Download »).'
    }${all.length > MAX_BATCH ? `<br>Les ${all.length - MAX_BATCH} suivantes seront proposées juste après.` : ''}</p>
    <button class="btn ghost block" id="save-later" style="margin-top:12px">Plus tard</button>
  `);
  hydrateImages(el);
  const go = $('#save-go', el);
  prepareFiles(list, (d, n) => { go.textContent = `Préparation… ${d}/${n}`; })
    .then((f) => { files = f; go.disabled = false; go.innerHTML = `${icon('download')} Enregistrer dans ma galerie`; })
    .catch((e) => { go.textContent = errMsg(e); });

  go.onclick = async () => {
    if (!files) return;
    const r = await deliverFiles(list, files);
    if (r === 'retry') { toast('Appuie encore une fois pour enregistrer'); return; }
    if (r === 'cancel') return;
    closeSheet();
    toast(`✨ ${plural(list.length, 'photo')} enregistrée${list.length > 1 ? 's' : ''}`);
    softRender();
    const rest = all.filter((p) => !saved.has(p.id));
    if (rest.length) setTimeout(() => openSaveSheet(rest), 600);
  };
  $('#save-later', el).onclick = closeSheet;
}

/* ───────────────────────── Envoi ───────────────────────── */

async function prepareImage(file) {
  const q = prefs.get('quality', 'high');
  if (q === 'original') return file;
  const max = q === 'high' ? 3000 : 1600;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && q === 'high' && file.type === 'image/jpeg') { bmp.close?.(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q === 'high' ? 0.92 : 0.82));
    return blob || file;
  } catch {
    return file; // format non lisible par le navigateur : on envoie l'original
  }
}

async function uploadOne(file, spaceId) {
  const blob = await prepareImage(file);
  const type = blob.type || 'image/jpeg';
  const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' }[type] || 'jpg';
  const path = `${spaceId}/${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false });
  if (up.error) throw up.error;
  const { data, error } = await sb.from('photos').insert({ space_id: spaceId, path }).select('id, space_id, sender_id, path, created_at').single();
  if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
  if (!state.photos.some((x) => x.id === data.id)) state.photos.unshift(data);
  return data;
}

/* ───────────────────────── Feuilles et visionneuse ───────────────────────── */

function openSheet(html) {
  closeSheet();
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  $('.backdrop', root).onclick = closeSheet;
  return $('.sheet', root);
}
function closeSheet() {
  $('#sheet-root').innerHTML = '';
}

function openViewer(photo, list) {
  let i = Math.max(0, list.findIndex((p) => p.id === photo.id));
  const root = document.createElement('div');
  root.className = 'viewer';
  document.body.appendChild(root);
  const close = () => { root.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') show(i + 1); if (e.key === 'ArrowLeft') show(i - 1); };
  document.addEventListener('keydown', onKey);

  async function show(n) {
    if (n < 0 || n >= list.length) return;
    i = n;
    const p = list[i];
    const s = spaceOf(p.space_id);
    root.innerHTML = `
      <div class="top">
        <button class="icon-btn" data-a="close" aria-label="Fermer">${icon('x')}</button>
        <div style="flex:1;text-align:center"><b>${esc(nameOf(p.sender_id))}</b><div class="small" style="opacity:.75">${esc(fullDate(p.created_at))}${s ? ' · ' + esc(s.emoji + ' ' + s.name) : ''}</div></div>
        ${p.sender_id === me() ? `<button class="icon-btn" data-a="delete" aria-label="Supprimer">${icon('trash')}</button>` : '<span style="width:44px"></span>'}
      </div>
      <div class="img-wrap"><img data-path="${esc(p.path)}" alt="Photo de ${esc(nameOf(p.sender_id))}"></div>
      <div class="bottom">
        <span class="small" style="opacity:.75">${i + 1} / ${list.length}</span>
        <button class="btn" data-a="save">${icon(saved.has(p.id) ? 'check' : 'download')} ${saved.has(p.id) ? 'Enregistrée' : 'Enregistrer'}</button>
      </div>`;
    await hydrateImages(root);
    $('img', root).classList.add('loaded');
    prepareFiles([p]).catch(() => {}); // préchargement pour un enregistrement immédiat
  }

  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const p = list[i];
    if (a === 'close') close();
    if (a === 'save') {
      try {
        const files = await prepareFiles([p]);
        const r = await deliverFiles([p], files);
        if (r === 'retry') toast('Appuie encore une fois pour enregistrer');
        else if (r !== 'cancel') { toast('✨ Photo enregistrée'); show(i); softRender(); }
      } catch (err) { toast(errMsg(err)); }
    }
    if (a === 'delete' && confirm('Supprimer cette photo pour tout le monde ?')) {
      try {
        await sb.storage.from(BUCKET).remove([p.path]);
        const { error } = await sb.from('photos').delete().eq('id', p.id);
        if (error) throw error;
        state.photos = state.photos.filter((x) => x.id !== p.id);
        list.splice(i, 1);
        toast('Photo supprimée');
        softRender();
        if (!list.length) close(); else show(Math.min(i, list.length - 1));
      } catch (err) { toast(errMsg(err)); }
    }
  });

  let x0 = null;
  root.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) show(dx < 0 ? i + 1 : i - 1);
    x0 = null;
  });
  show(i);
}

/* ───────────────────────── Composants ───────────────────────── */

const logo = () => `<div class="logo"><img src="icons/icon-192.png" alt=""><span><span class="a">Lona</span><span class="b">Pics</span></span></div>`;

function spaceCard(s) {
  const n = s.space_members.length;
  const count = state.photos.filter((p) => p.space_id === s.id).length;
  return `<a class="grad ${esc(s.gradient)} space-card" href="#/space/${s.id}">
    <span class="emoji">${esc(s.emoji)}</span>
    <span><b>${esc(s.name)}</b><span class="small">${plural(n, 'membre')}</span><span class="small">${plural(count, 'photo')}</span></span>
  </a>`;
}

function tile(p, { meta = true } = {}) {
  const sel = state.select?.has(p.id);
  return `<button class="tile${sel ? ' selected' : ''}" data-photo="${p.id}" aria-label="Photo de ${esc(nameOf(p.sender_id))}">
    <img data-path="${esc(p.path)}" alt="" loading="lazy">
    ${saved.has(p.id) && p.sender_id !== me() ? `<span class="saved">${icon('check')}</span>` : ''}
    ${state.select ? `<span class="check">${icon('check')}</span>` : ''}
    ${meta ? `<span class="meta">${esc(nameOf(p.sender_id))} · ${esc(timeAgo(p.created_at))}</span>` : ''}
  </button>`;
}

function photoGrid(list, empty) {
  if (!list.length) return `<div class="empty">${empty}</div>`;
  return `<div class="grid">${list.map((p) => tile(p)).join('')}</div>`;
}

function selectionBar(list) {
  if (!state.select) {
    return list.length ? `<button class="chip" data-act="select-on">Sélectionner</button>` : '';
  }
  return `<div class="row"><button class="chip" data-act="select-all">Tout</button><button class="chip" data-act="select-off">Annuler</button></div>`;
}

function selectionAction() {
  if (!state.select) return '';
  const n = state.select.size;
  return `<div style="position:sticky;bottom:calc(var(--safe-bottom) + 92px);margin-top:16px;z-index:5">
    <button class="btn block" data-act="save-selection" ${n ? '' : 'disabled'}>${icon('download')} Enregistrer ${n ? plural(n, 'photo') : ''}</button></div>`;
}

/* ───────────────────────── Vues ───────────────────────── */

function viewAuth(mode = 'login') {
  return `<div class="view">
    <div class="hero"><img src="icons/icon-512.png" alt="Logo LonaPics"><h1 class="title">Lona<span style="color:var(--pink)">Pics</span></h1>
    <p class="muted" style="margin:6px 0 0">Tous vos souvenirs, au même endroit. ❤️</p></div>
    ${configured ? '' : `<div class="tip" style="margin-bottom:16px">⚙️ L'appli n'est pas encore reliée à Supabase. Ouvre <b>config.js</b> et colle l'adresse et la clé de ton projet (voir le guide).</div>`}
    <div class="tabs2" style="margin-bottom:18px">
      <button data-mode="login" class="${mode === 'login' ? 'on' : ''}">Connexion</button>
      <button data-mode="signup" class="${mode === 'signup' ? 'on' : ''}">Inscription</button>
    </div>
    <form id="auth-form" class="stack" novalidate>
      ${mode === 'signup' ? `<label class="field"><span>Pseudo</span><input class="input" name="username" maxlength="30" placeholder="Lorenzo" autocomplete="nickname" required></label>` : ''}
      <label class="field"><span>E-mail</span><input class="input" name="email" type="email" placeholder="toi@exemple.com" autocomplete="email" required></label>
      <label class="field"><span>Mot de passe</span><input class="input" name="password" type="password" minlength="6" placeholder="6 caractères minimum" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></label>
      <div id="auth-error" class="error" role="alert"></div>
      <button class="btn block" type="submit">${mode === 'signup' ? 'Créer mon compte' : 'Me connecter'}</button>
      ${mode === 'login' ? `<button type="button" class="btn ghost block" id="forgot">Mot de passe oublié ?</button>` : ''}
    </form>
  </div>`;
}

function bindAuth(mode) {
  $$('.tabs2 button').forEach((b) => (b.onclick = () => { app.innerHTML = viewAuth(b.dataset.mode); bindAuth(b.dataset.mode); }));
  const form = $('#auth-form');
  const err = $('#auth-error');
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!sb) { err.textContent = 'Configure d’abord Supabase dans config.js.'; return; }
    const f = Object.fromEntries(new FormData(form));
    err.textContent = '';
    if (mode === 'signup' && !f.username?.trim()) { err.textContent = 'Choisis un pseudo.'; return; }
    if (!/^\S+@\S+\.\S+$/.test(f.email || '')) { err.textContent = 'Entre une adresse e-mail valide.'; return; }
    if ((f.password || '').length < 6) { err.textContent = 'Le mot de passe doit faire au moins 6 caractères.'; return; }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email: f.email.trim(), password: f.password,
          options: { data: { username: f.username.trim() }, emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) {
          app.innerHTML = `<div class="view"><div class="hero"><img src="icons/icon-512.png" alt=""><h1 class="title">Vérifie tes e-mails 💌</h1>
            <p class="muted">On t'a envoyé un lien de confirmation à <b>${esc(f.email)}</b>. Ouvre-le, puis reviens te connecter.</p></div>
            <button class="btn block" onclick="location.reload()">J'ai confirmé</button></div>`;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
        if (error) throw error;
      }
    } catch (ex) {
      err.textContent = errMsg(ex);
    } finally {
      btn.disabled = false;
    }
  };
  const forgot = $('#forgot');
  if (forgot) forgot.onclick = async () => {
    const email = $('input[name=email]', form).value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Entre d’abord ton e-mail ci-dessus.'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    err.textContent = '';
    toast(error ? errMsg(error) : '📧 E-mail de réinitialisation envoyé');
  };
}

function viewHome() {
  const recv = received();
  const sent = sentPhotos();
  const pend = pendingPhotos();
  const first = (state.profile?.username || '').split(' ')[0];
  const senders = [...new Set(pend.map((p) => nameOf(p.sender_id)))].join(', ');
  return `<div class="view">
    <div class="row between">${logo()}
      <button class="icon-btn" data-act="pending" aria-label="Nouvelles photos">${icon('bell')}${pend.length ? '<span class="dot"></span>' : ''}</button>
    </div>
    <div style="margin:22px 0 18px"><div class="muted">Salut ${esc(first)} 👋</div><h1 class="title">${pend.length ? 'Des souvenirs t’attendent' : 'Partage un souvenir'}</h1></div>
    ${pend.length ? `<div class="grad sun banner" data-act="pending">
      <span class="bubble">${icon('sparkle')}</span>
      <span style="flex:1"><b>${plural(pend.length, 'nouvelle photo')} de ${esc(senders)}</b><span class="small" style="display:block">Touche pour les enregistrer dans ta galerie</span></span>
      ${icon('download')}</div>` : ''}
    <div class="section"><h2 class="h2">Tes espaces</h2><a href="#/spaces" class="small muted">Tout voir</a></div>
    ${state.spaces.length
      ? `<div class="spaces-scroll">${state.spaces.map(spaceCard).join('')}</div>`
      : `<div class="empty">Crée ton premier espace pour partager avec ta copine, tes potes ou ta famille.<br><br><button class="btn" data-act="create">${icon('plus')} Créer un espace</button></div>`}
    ${homeUpcoming()}
    <div class="section"><h2 class="h2">Reçues récemment</h2><a href="#/photos" class="small muted">Toutes les photos</a></div>
    ${photoGrid(recv.slice(0, 9), 'Les photos qu’on t’envoie apparaîtront ici.')}
    <div class="section"><h2 class="h2">Envoyées récemment</h2></div>
    ${photoGrid(sent.slice(0, 6), 'Touche le bouton photo pour envoyer ton premier souvenir.')}
  </div>`;
}

function viewSpaces() {
  return `<div class="view">
    <h1 class="title">Tes espaces</h1>
    <p class="muted" style="margin:4px 0 18px">Des bulles privées, rien que pour vous.</p>
    <div class="row" style="margin-bottom:18px">
      <button class="btn block" data-act="create">${icon('plus')} Créer</button>
      <button class="btn violet block" data-act="join">${icon('key')} Rejoindre</button>
    </div>
    ${state.spaces.length ? `<div class="space-grid">${state.spaces.map(spaceCard).join('')}</div>` : '<div class="empty">Aucun espace pour l’instant. Crée-en un ou rejoins celui de quelqu’un avec son code.</div>'}
  </div>`;
}

function viewSpace(id) {
  const s = spaceOf(id);
  if (!s) return `<div class="view"><a href="#/spaces" class="icon-btn">${icon('back')}</a><div class="empty" style="margin-top:20px">Cet espace n'existe plus ou tu n'en fais plus partie.</div></div>`;
  const list = state.photos.filter((p) => p.space_id === id);
  const members = s.space_members.map((m) => (m.user_id === me() ? 'Toi' : m.profiles?.username || '…')).join(', ');
  const owner = s.owner_id === me();
  return `<div class="view">
    <div class="row between" style="margin-bottom:14px">
      <a href="#/spaces" class="icon-btn" aria-label="Retour">${icon('back')}</a>
      <button class="icon-btn" data-act="invite" aria-label="Inviter">${icon('share')}</button>
    </div>
    <div class="grad ${esc(s.gradient)}" style="padding:22px">
      <div style="font-size:40px">${esc(s.emoji)}</div>
      <h1 class="title" style="color:inherit;margin-top:6px">${esc(s.name)}</h1>
      <div class="small" style="margin-top:4px">${esc(members)}</div>
      <div class="row" style="margin-top:16px">
        <a class="btn ghost" href="#/send/${s.id}" style="flex:1">${icon('camera')} Envoyer</a>
        <button class="btn ghost" data-act="invite" style="flex:1">${icon('plus')} Inviter</button>
      </div>
    </div>
    <div class="section"><h2 class="h2">${plural(list.length, 'photo')}</h2>${selectionBar(list)}</div>
    ${photoGrid(list, 'Aucune photo ici pour l’instant. Envoie la première !')}
    ${selectionAction()}
    <button class="btn danger block" style="margin-top:28px" data-act="${owner ? 'delete-space' : 'leave-space'}">${owner ? 'Supprimer cet espace' : 'Quitter cet espace'}</button>
  </div>`;
}

function viewPhotos() {
  const list = state.photosFilter === 'received' ? received() : sentPhotos();
  return `<div class="view">
    <h1 class="title">Photos</h1>
    <div class="section" style="margin-top:14px;flex-wrap:wrap;gap:10px">
      <div class="chips" style="flex-wrap:nowrap">
        <button class="chip ${state.photosFilter === 'received' ? 'on' : ''}" data-filter="received">Reçues · ${received().length}</button>
        <button class="chip ${state.photosFilter === 'sent' ? 'on' : ''}" data-filter="sent">Envoyées · ${sentPhotos().length}</button>
      </div>
      ${selectionBar(list)}
    </div>
    ${photoGrid(list, state.photosFilter === 'received' ? 'Rien reçu pour l’instant.' : 'Rien envoyé pour l’instant.')}
    ${selectionAction()}
  </div>`;
}

function viewSend(presetSpace) {
  const st = state.send;
  if (presetSpace && spaceOf(presetSpace)) st.spaceId = presetSpace;
  if (!st.spaceId || !spaceOf(st.spaceId)) st.spaceId = prefs.get('lastSpace', null);
  if (!spaceOf(st.spaceId)) st.spaceId = state.spaces[0]?.id || null;

  if (!state.spaces.length) {
    return `<div class="view"><h1 class="title">Partager un souvenir</h1>
      <div class="empty" style="margin-top:20px">Il te faut d'abord un espace (par exemple « Lorenzo et Tina ❤️ »).<br><br><button class="btn" data-act="create">${icon('plus')} Créer un espace</button></div></div>`;
  }
  return `<div class="view">
    <h1 class="title">Partager un souvenir</h1>
    <p class="muted" style="margin:4px 0 18px">Choisis tes photos, puis l'espace où les envoyer.</p>
    <div class="stack">
      <label class="grad dream row" style="padding:18px;gap:14px;cursor:pointer">
        <span class="bubble emoji" style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.25);display:grid;place-items:center">${icon('gallery')}</span>
        <span><b style="font-size:17px">Depuis ma galerie</b><span class="small" style="display:block">Une ou plusieurs photos</span></span>
        <input type="file" accept="image/*" multiple hidden data-pick>
      </label>
      <label class="grad love row" style="padding:18px;gap:14px;cursor:pointer">
        <span style="width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.25);display:grid;place-items:center">${icon('camera')}</span>
        <span><b style="font-size:17px">Prendre une photo</b><span class="small" style="display:block">Directement avec l'appareil</span></span>
        <input type="file" accept="image/*" capture="environment" hidden data-pick>
      </label>
    </div>
    ${st.files.length ? `
      <div class="section"><h2 class="h2">${plural(st.files.length, 'photo')} prête${st.files.length > 1 ? 's' : ''}</h2><button class="chip" data-act="clear-send">Vider</button></div>
      <div class="grid">${st.files.map((f, i) => `<div class="tile"><img class="loaded" src="${f.preview}" alt=""><button class="check" style="background:rgba(0,0,0,.45);cursor:pointer" data-remove="${i}" aria-label="Retirer">${icon('x', 'style="opacity:1"')}</button></div>`).join('')}</div>
      <div class="section"><h2 class="h2">Envoyer dans</h2></div>
      <div class="chips">${state.spaces.map((s) => `<button class="chip ${s.id === st.spaceId ? 'on' : ''}" data-space="${s.id}">${esc(s.emoji)} ${esc(s.name)}</button>`).join('')}</div>
      <div id="send-progress" class="progress" style="margin-top:20px" hidden><div></div></div>
      <button class="btn block" style="margin-top:18px" data-act="send" ${st.busy ? 'disabled' : ''}>${icon('share')} Envoyer ${plural(st.files.length, 'photo')}</button>
    ` : ''}
  </div>`;
}

function viewProfile() {
  const a = autoSave() || { on: false };
  const q = prefs.get('quality', 'high');
  const theme = prefs.get('theme', 'auto');
  const name = state.profile?.username || '';
  return `<div class="view">
    <div class="grad rainbow" style="text-align:center;padding:26px 16px">
      <div class="avatar">${esc((name[0] || '?').toUpperCase())}</div>
      <h2 class="h2" style="margin-top:12px">${esc(name)}</h2>
      <div class="small">${esc(state.user.email)}</div>
      <div class="stats"><div><b>${sentPhotos().length}</b><span class="small">envoyées</span></div><div><b>${received().length}</b><span class="small">reçues</span></div></div>
    </div>

    <div class="section"><h2 class="h2">Réglages</h2></div>
    <div class="card" style="padding:4px 16px">
      <div class="setting">
        <div><b>Enregistrement automatique dans ma galerie</b>
        <div class="small muted">Dès qu'une photo arrive, LonaPics te la propose en un seul geste pour ta galerie.</div></div>
        <label class="switch"><input type="checkbox" id="autosave" ${a.on ? 'checked' : ''}><i></i></label>
      </div>
      <div class="setting">
        <div><b>Qualité des photos envoyées</b><div class="small muted">Originale = aucune perte, mais plus lourd.</div></div>
        <select class="input" id="quality" style="width:auto;padding:10px 12px">
          <option value="original" ${q === 'original' ? 'selected' : ''}>Originale</option>
          <option value="high" ${q === 'high' ? 'selected' : ''}>Haute</option>
          <option value="eco" ${q === 'eco' ? 'selected' : ''}>Économie</option>
        </select>
      </div>
      <div class="setting" style="flex-direction:column;align-items:flex-start">
        <b>Apparence</b>
        <div class="chips">${[['light', 'Clair'], ['dark', 'Sombre'], ['auto', 'Auto']].map(([v, l]) => `<button class="chip ${theme === v ? 'on' : ''}" data-theme-choice="${v}">${l}</button>`).join('')}</div>
      </div>
    </div>
    ${notifSection()}

    <div class="section"><h2 class="h2">Compte</h2></div>
    <div class="stack">
      <button class="btn ghost block" data-act="rename">Modifier mon pseudo</button>
      ${isStandalone ? '' : '<button class="btn ghost block" data-act="install">Ajouter LonaPics à mon écran d’accueil</button>'}
      <button class="btn ghost block" data-act="privacy">Confidentialité</button>
      <button class="btn ghost block" data-act="logout">Se déconnecter</button>
      <button class="btn danger block" data-act="delete-account">Supprimer mon compte</button>
    </div>
    <p class="small muted" style="text-align:center;margin-top:20px">LonaPics · Tous vos souvenirs, au même endroit ❤️</p>
  </div>`;
}

/* ───────────────────────── Actions ───────────────────────── */

function openCreateSheet() {
  let emoji = EMOJIS[0];
  let gradient = GRADIENTS[0];
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:16px">Nouvel espace</h2>
    <form id="create-form" class="stack" novalidate>
      <label class="field"><span>Nom</span><input class="input" name="name" maxlength="40" placeholder="Lorenzo et Tina" required></label>
      <div><span class="small muted" style="font-weight:600">Icône</span><div class="chips" style="margin-top:8px">${EMOJIS.map((e, i) => `<button type="button" class="emoji-pick ${i === 0 ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}</div></div>
      <div><span class="small muted" style="font-weight:600">Couleur</span><div class="row" style="margin-top:8px">${GRADIENTS.map((g, i) => `<button type="button" class="swatch grad ${g} ${i === 0 ? 'on' : ''}" data-grad="${g}" aria-label="${g}"></button>`).join('')}</div></div>
      <div class="error" id="create-error"></div>
      <button class="btn block" type="submit">Créer l'espace</button>
    </form>`);
  el.addEventListener('click', (e) => {
    const em = e.target.closest('[data-emoji]');
    const gr = e.target.closest('[data-grad]');
    if (em) { emoji = em.dataset.emoji; $$('[data-emoji]', el).forEach((b) => b.classList.toggle('on', b === em)); }
    if (gr) { gradient = gr.dataset.grad; $$('[data-grad]', el).forEach((b) => b.classList.toggle('on', b === gr)); }
  });
  $('#create-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name').trim();
    if (!name) { $('#create-error', el).textContent = 'Donne un nom à ton espace.'; return; }
    try {
      const { data, error } = await sb.from('spaces').insert({ name, emoji, gradient, owner_id: me() }).select('id').single();
      if (error) throw error;
      await loadData();
      closeSheet();
      location.hash = `#/space/${data.id}`;
      setTimeout(openInviteSheet, 400);
    } catch (ex) { $('#create-error', el).textContent = errMsg(ex); }
  };
}

function openJoinSheet(prefill = '') {
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:6px">Rejoindre un espace</h2>
    <p class="muted" style="margin:0 0 16px">Entre le code qu'on t'a envoyé.</p>
    <form id="join-form" class="stack" novalidate>
      <input class="input code" name="code" maxlength="8" placeholder="AB12CD34" autocapitalize="characters" autocomplete="off" value="${esc(prefill)}" required>
      <div class="error" id="join-error"></div>
      <button class="btn violet block" type="submit">Rejoindre</button>
    </form>`);
  $('#join-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').trim().toUpperCase();
    if (code.length < 4) { $('#join-error', el).textContent = 'Entre le code complet.'; return; }
    try { await joinWithCode(code); closeSheet(); } catch (ex) { $('#join-error', el).textContent = errMsg(ex); }
  };
}

async function joinWithCode(code) {
  const { data, error } = await sb.rpc('join_space', { code });
  if (error) throw error;
  await loadData();
  const s = spaceOf(data);
  notify({ type: 'join', space_id: data });
  toast(`🎉 Bienvenue dans ${s ? s.name : 'l’espace'} !`);
  location.hash = `#/space/${data}`;
}

function openInviteSheet() {
  const id = location.hash.split('/')[2];
  const s = spaceOf(id);
  if (!s) return;
  const link = `${location.origin}${location.pathname}?join=${s.invite_code}`;
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:6px">Inviter dans ${esc(s.emoji)} ${esc(s.name)}</h2>
    <p class="muted" style="margin:0 0 16px">Envoie ce lien, ou donne le code. Seules les personnes invitées peuvent entrer.</p>
    <div class="code">${esc(s.invite_code)}</div>
    <button class="btn block" style="margin-top:16px" data-a="share">${icon('share')} Envoyer le lien</button>
    <button class="btn ghost block" style="margin-top:10px" data-a="copy">Copier le lien</button>`);
  el.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'share') {
      if (navigator.share) {
        try { await navigator.share({ title: 'LonaPics', text: `Rejoins « ${s.name} » sur LonaPics 📸`, url: link }); } catch { /* annulé */ }
      } else copy();
    }
    if (a === 'copy') copy();
  };
  async function copy() {
    try { await navigator.clipboard.writeText(link); toast('Lien copié'); } catch { prompt('Copie ce lien :', link); }
  }
}

function openInstallSheet() {
  openSheet(`
    <h2 class="h2" style="margin-bottom:12px">Installer LonaPics</h2>
    ${isIOS ? `<ol style="padding-left:20px;margin:0" class="stack">
        <li>Ouvre cette page dans <b>Safari</b>.</li>
        <li>Touche le bouton <b>Partager</b> (le carré avec une flèche).</li>
        <li>Choisis <b>« Sur l'écran d'accueil »</b>, puis <b>Ajouter</b>.</li></ol>`
      : `<ol style="padding-left:20px;margin:0" class="stack">
        <li>Ouvre cette page dans <b>Chrome</b>.</li>
        <li>Touche le menu <b>⋮</b> en haut à droite.</li>
        <li>Choisis <b>« Ajouter à l'écran d'accueil »</b> ou <b>« Installer l'application »</b>.</li></ol>`}
    <p class="tip" style="margin-top:16px">LonaPics s'ouvrira alors en plein écran, comme une vraie appli.</p>`);
}

function openPrivacySheet() {
  openSheet(`
    <h2 class="h2" style="margin-bottom:12px">Confidentialité</h2>
    <div class="stack small">
      <p>Tes photos sont stockées dans un espace privé. Seuls les membres d'un espace peuvent les voir, grâce à des règles de sécurité appliquées par la base de données elle-même.</p>
      <p>Les liens vers les photos sont temporaires et expirent après quelques heures.</p>
      <p>Tu peux supprimer à tout moment une photo que tu as envoyée. Elle disparaît pour tout le monde.</p>
      <p>En supprimant ton compte, ton profil, tes photos envoyées et les espaces que tu as créés sont effacés définitivement.</p>
      <p>Aucune publicité, aucune revente de données.</p>
    </div>`);
}

function openRenameSheet() {
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:16px">Ton pseudo</h2>
    <form class="stack" novalidate>
      <input class="input" name="username" maxlength="30" value="${esc(state.profile?.username)}" required>
      <div class="error"></div>
      <button class="btn block" type="submit">Enregistrer</button>
    </form>`);
  $('form', el).onsubmit = async (e) => {
    e.preventDefault();
    const username = new FormData(e.target).get('username').trim();
    if (!username) { $('.error', el).textContent = 'Le pseudo ne peut pas être vide.'; return; }
    const { error } = await sb.from('profiles').update({ username }).eq('id', me());
    if (error) { $('.error', el).textContent = errMsg(error); return; }
    state.profile.username = username;
    state.names.set(me(), username);
    closeSheet();
    toast('Pseudo mis à jour');
    render();
  };
}

function openNewPasswordSheet() {
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:16px">Nouveau mot de passe</h2>
    <form class="stack" novalidate>
      <input class="input" type="password" name="password" minlength="6" placeholder="6 caractères minimum" autocomplete="new-password" required>
      <div class="error"></div>
      <button class="btn block" type="submit">Enregistrer</button>
    </form>`);
  $('form', el).onsubmit = async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get('password');
    if (password.length < 6) { $('.error', el).textContent = '6 caractères minimum.'; return; }
    const { error } = await sb.auth.updateUser({ password });
    if (error) { $('.error', el).textContent = errMsg(error); return; }
    closeSheet();
    toast('Mot de passe modifié');
  };
}

async function removeStorage(paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}

async function allPhotoPaths(filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(sb.from('photos').select('path')).range(from, from + 999);
    if (error) throw error;
    out.push(...data.map((d) => d.path));
    if (data.length < 1000) return out;
  }
}

function openDeleteAccountSheet() {
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:8px;color:#E5484D">Supprimer mon compte</h2>
    <p class="muted" style="margin:0 0 14px">Ton profil, toutes les photos que tu as envoyées et les espaces que tu as créés seront effacés définitivement. C'est irréversible.</p>
    <form class="stack" novalidate>
      <label class="field"><span>Tape SUPPRIMER pour confirmer</span><input class="input" name="confirm" autocomplete="off" autocapitalize="characters"></label>
      <div class="error"></div>
      <button class="btn danger block" type="submit">Supprimer définitivement</button>
    </form>`);
  $('form', el).onsubmit = async (e) => {
    e.preventDefault();
    if (new FormData(e.target).get('confirm').trim().toUpperCase() !== 'SUPPRIMER') { $('.error', el).textContent = 'Tape SUPPRIMER pour confirmer.'; return; }
    const btn = $('button[type=submit]', el);
    btn.disabled = true;
    btn.textContent = 'Suppression…';
    try {
      const owned = state.spaces.filter((s) => s.owner_id === me()).map((s) => s.id);
      const paths = new Set(await allPhotoPaths((q) => q.eq('sender_id', me())));
      if (owned.length) (await allPhotoPaths((q) => q.in('space_id', owned))).forEach((p) => paths.add(p));
      await removeStorage([...paths]);
      const { error } = await sb.rpc('delete_account');
      if (error) throw error;
      await sb.auth.signOut();
      localStorage.clear();
      closeSheet();
      location.hash = '';
      location.reload();
    } catch (ex) {
      $('.error', el).textContent = errMsg(ex);
      btn.disabled = false;
      btn.textContent = 'Supprimer définitivement';
    }
  };
}

async function deleteSpace(id) {
  const s = spaceOf(id);
  if (!s || !confirm(`Supprimer « ${s.name} » et toutes ses photos pour tout le monde ?`)) return;
  try {
    await removeStorage(await allPhotoPaths((q) => q.eq('space_id', id)));
    const { error } = await sb.from('spaces').delete().eq('id', id);
    if (error) throw error;
    await loadData();
    toast('Espace supprimé');
    location.hash = '#/spaces';
  } catch (ex) { toast(errMsg(ex)); }
}

async function leaveSpace(id) {
  const s = spaceOf(id);
  if (!s || !confirm(`Quitter « ${s.name} » ? Il te faudra une nouvelle invitation pour revenir.`)) return;
  const { error } = await sb.from('space_members').delete().eq('space_id', id).eq('user_id', me());
  if (error) { toast(errMsg(error)); return; }
  await loadData();
  toast('Tu as quitté l’espace');
  location.hash = '#/spaces';
}

async function sendPhotos() {
  const st = state.send;
  if (!st.files.length || !st.spaceId || st.busy) return;
  st.busy = true;
  const btn = $('[data-act=send]');
  const bar = $('#send-progress');
  btn.disabled = true;
  bar.hidden = false;
  const total = st.files.length;
  let done = 0;
  const failed = [];
  const queue = [...st.files];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      try { await uploadOne(f.file, st.spaceId); } catch (e) { failed.push(f); console.error(e); }
      done++;
      $('div', bar).style.width = `${Math.round((done / total) * 100)}%`;
      btn.textContent = `Envoi… ${done}/${total}`;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  st.busy = false;
  prefs.set('lastSpace', st.spaceId);
  st.files.filter((f) => !failed.includes(f)).forEach((f) => URL.revokeObjectURL(f.preview));
  st.files = failed;
  const s = spaceOf(st.spaceId);
  const ok = total - failed.length;
  if (ok) {
    toast(`🚀 ${plural(ok, 'photo')} envoyée${ok > 1 ? 's' : ''} dans ${s.name}`);
    notify({ type: 'photos', space_id: st.spaceId, count: ok });
  }
  if (failed.length) { toast(`${plural(failed.length, 'photo')} n'a pas pu partir. Réessaie.`, 4000); render(); }
  else location.hash = `#/space/${st.spaceId}`;
}

/* ───────────────────────── Notifications push ───────────────────────── */

async function notify(body) {
  if (!sb) return null;
  try {
    const { data } = await sb.functions.invoke('notify', { body });
    return data;
  } catch {
    return null; // les notifications ne doivent jamais bloquer l'appli
  }
}

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const swReady = () => Promise.race([navigator.serviceWorker.ready, sleep(4000).then(() => null)]);

async function saveSubscription(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: me() });
  if (error) throw error;
}

async function checkPush() {
  if (!VAPID_PUBLIC_KEY) return 'unconfigured';
  if (isIOS && !isStandalone) return 'need-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await swReady();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && Notification.permission === 'granted') { saveSubscription(sub).catch(() => {}); return 'on'; }
  } catch { /* ignoré */ }
  return 'off';
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission(); // doit être le tout premier appel après le toucher (iPhone)
    if (perm !== 'granted') { state.push = perm === 'denied' ? 'denied' : 'off'; softRender(); return; }
    const reg = await swReady();
    if (!reg) throw new Error('Service worker indisponible. Recharge la page.');
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(VAPID_PUBLIC_KEY) }));
    await saveSubscription(sub);
    state.push = 'on';
    softRender();
    toast('🔔 Notifications activées');
    notify({ type: 'test' });
  } catch (e) {
    toast(errMsg(e), 4000);
  }
}

async function forgetThisDevice() {
  try {
    const reg = await swReady();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
  } catch { /* ignoré */ }
}

async function disablePush() {
  await forgetThisDevice();
  state.push = 'off';
  softRender();
  toast('Notifications coupées sur ce téléphone');
}

function notifSection() {
  const p = state.profile || {};
  const status = {
    on: ['Activées sur ce téléphone ✅', `<button class="chip" data-act="push-test">Tester</button><button class="chip" data-act="push-off">Couper</button>`],
    off: ['Pour être prévenu même quand l’appli est fermée.', `<button class="btn" style="padding:10px 18px" data-act="push-on">Activer</button>`],
    denied: ['Bloquées. Réactive-les dans les réglages du téléphone (Notifications › LonaPics), puis reviens ici.', ''],
    'need-install': ['Sur iPhone, ajoute d’abord LonaPics à l’écran d’accueil, puis ouvre-la depuis son icône.', `<button class="chip" data-act="install">Comment ?</button>`],
    unsupported: ['Ce navigateur ne gère pas les notifications. Sur Android, utilise Chrome.', ''],
    unconfigured: ['Clé de notification manquante dans config.js.', ''],
  }[state.push] || ['', ''];
  const toggle = (col, label) => `<div class="setting"><b style="font-weight:600">${label}</b>
    <label class="switch"><input type="checkbox" data-pref="${col}" ${p[col] !== false ? 'checked' : ''}><i></i></label></div>`;
  return `
    <div class="section"><h2 class="h2">Notifications</h2></div>
    <div class="card" style="padding:4px 16px">
      <div class="setting" style="flex-wrap:wrap"><div style="flex:1;min-width:180px"><b>Sur ce téléphone</b><div class="small muted">${status[0]}</div></div><div class="row">${status[1]}</div></div>
      ${toggle('notif_photos', '📸 Nouvelle photo reçue')}
      ${toggle('notif_members', '🎉 Quelqu’un rejoint un espace')}
      ${toggle('notif_events', '📅 Nouveau rendez-vous ajouté')}
      ${toggle('notif_reminders', '⏰ Rappels du calendrier')}
    </div>`;
}

/* ───────────────────────── Calendrier ───────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const REPEATS = [['none', 'Jamais'], ['weekly', 'Chaque semaine'], ['monthly', 'Chaque mois'], ['yearly', 'Chaque année']];
const remindOptions = (allDay) => allDay
  ? [['', 'Pas de rappel'], ['0', 'Le jour même (9 h)'], ['1440', 'La veille (9 h)'], ['2880', '2 jours avant'], ['10080', '1 semaine avant']]
  : [['', 'Pas de rappel'], ['0', 'À l’heure'], ['10', '10 min avant'], ['30', '30 min avant'], ['60', '1 h avant'], ['120', '2 h avant'], ['1440', '1 jour avant'], ['10080', '1 semaine avant']];

// Même logique que la fonction serveur : répétitions en heure locale, fin de mois respectée.
function occurrence(base, repeat, k) {
  const d = new Date(base);
  if (!k || repeat === 'none') return d;
  if (repeat === 'weekly') { d.setDate(d.getDate() + 7 * k); return d; }
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + (repeat === 'monthly' ? k : 12 * k));
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}

function occurrencesBetween(ev, from, to) {
  const base = new Date(ev.starts_at);
  if (ev.repeat === 'none') return base >= from && base < to ? [base] : [];
  const out = [];
  for (let k = 0; k < 6000; k++) {
    const o = occurrence(base, ev.repeat, k);
    if (o >= to) break;
    if (o >= from) out.push(o);
  }
  return out;
}

const remindFor = (occ, ev) => new Date(occ.getTime() + (ev.all_day ? 9 * 3600000 : 0) - (ev.remind_offset ?? 0) * 60000);

function nextRemind(ev, after = new Date()) {
  if (ev.remind_offset == null) return null;
  const base = new Date(ev.starts_at);
  if (ev.repeat === 'none') { const r = remindFor(base, ev); return r > after ? r : null; }
  for (let k = 0; k < 6000; k++) { const r = remindFor(occurrence(base, ev.repeat, k), ev); if (r > after) return r; }
  return null;
}

function eventsBetween(from, to) {
  const out = [];
  for (const ev of state.events) for (const o of occurrencesBetween(ev, from, to)) out.push({ ev, o });
  return out.sort((a, b) => {
    const ka = dayKey(a.o), kb = dayKey(b.o);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.ev.all_day !== b.ev.all_day) return a.ev.all_day ? -1 : 1;
    return a.o - b.o;
  });
}

function upcoming(days = 60, limit = 5) {
  const t = new Date();
  const startToday = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return eventsBetween(startToday, new Date(startToday.getTime() + days * 86400000))
    .filter(({ ev, o }) => ev.all_day || o >= new Date(t.getTime() - 30 * 60000))
    .slice(0, limit);
}

function relDay(d) {
  const t = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Demain';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('fr-FR', { weekday: 'long' }).replace(/^./, (c) => c.toUpperCase());
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

function eventItem({ ev, o }, showDay = false) {
  const s = ev.space_id ? spaceOf(ev.space_id) : null;
  const when = `${showDay ? relDay(o) + ' · ' : ''}${ev.all_day ? 'Toute la journée' : hhmm(o)}`;
  const where = s ? `${s.emoji} ${s.name}` : '🔒 Perso';
  return `<button class="event" data-event="${ev.id}">
    <span class="ev-bar grad ${esc(s?.gradient || 'dream')}"></span>
    <span class="ev-main"><b>${esc(ev.title)}</b><span class="small muted">${esc(when)} · ${esc(where)}${ev.repeat !== 'none' ? ' · 🔁' : ''}${ev.remind_offset != null ? ' · 🔔' : ''}</span></span>
  </button>`;
}

function homeUpcoming() {
  const list = upcoming(7, 3);
  if (!list.length) return '';
  return `<div class="section"><h2 class="h2">Bientôt</h2><a href="#/calendar" class="small muted">Calendrier</a></div>
    <div class="events">${list.map((x) => eventItem(x, true)).join('')}</div>`;
}

function viewCalendar() {
  const today = new Date();
  if (!state.cal.month) state.cal = { month: new Date(today.getFullYear(), today.getMonth(), 1), selected: dayKey(today) };
  const m = state.cal.month;
  const gridStart = new Date(m.getFullYear(), m.getMonth(), 1 - ((m.getDay() + 6) % 7));
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
  const byDay = new Map();
  for (const x of eventsBetween(gridStart, gridEnd)) {
    const k = dayKey(x.o);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(x);
  }
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const k = dayKey(d);
    const evs = byDay.get(k) || [];
    const dots = evs.slice(0, 3).map(({ ev }) => `<i class="grad ${esc(spaceOf(ev.space_id)?.gradient || 'dream')}"></i>`).join('');
    cells.push(`<button class="cal-day${d.getMonth() !== m.getMonth() ? ' out' : ''}${k === dayKey(today) ? ' today' : ''}${k === state.cal.selected ? ' sel' : ''}" data-day="${k}" aria-label="${d.getDate()} ${MONTHS[d.getMonth()]}${evs.length ? `, ${evs.length} rendez-vous` : ''}">
      <span>${d.getDate()}</span><span class="dots">${dots}</span></button>`);
  }
  const sel = parseKey(state.cal.selected);
  const dayList = byDay.get(state.cal.selected) || [];
  const next = upcoming(60, 6);
  return `<div class="view">
    <div class="row between"><h1 class="title">Calendrier</h1><button class="btn" style="padding:10px 16px" data-act="add-event">${icon('plus')} Ajouter</button></div>
    <p class="muted" style="margin:4px 0 16px">Rendez-vous, anniversaires et rappels, à deux ou en groupe.</p>
    <div class="card" style="padding:14px 12px">
      <div class="row between" style="margin-bottom:10px">
        <button class="icon-btn" data-cal="-1" aria-label="Mois précédent">${icon('back')}</button>
        <button class="h2" data-act="cal-today" style="background:none;border:0;cursor:pointer;text-transform:capitalize">${MONTHS[m.getMonth()]} ${m.getFullYear()}</button>
        <button class="icon-btn" data-cal="1" aria-label="Mois suivant">${icon('back', 'style="transform:rotate(180deg)"')}</button>
      </div>
      <div class="cal-grid">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span class="cal-wd">${d}</span>`).join('')}${cells.join('')}</div>
    </div>
    <div class="section"><h2 class="h2" style="text-transform:none">${esc(relDay(sel) === "Aujourd'hui" ? "Aujourd'hui" : sel.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (c) => c.toUpperCase()))}</h2></div>
    ${dayList.length ? `<div class="events">${dayList.map((x) => eventItem(x)).join('')}</div>` : `<div class="empty" style="padding:18px">Rien de prévu.<br><button class="chip" style="margin-top:10px" data-act="add-event">${icon('plus', 'style="width:16px;height:16px;vertical-align:-3px"')} Ajouter ce jour-là</button></div>`}
    <div class="section"><h2 class="h2">À venir</h2></div>
    ${next.length ? `<div class="events">${next.map((x) => eventItem(x, true)).join('')}</div>` : '<div class="empty" style="padding:18px">Aucun rendez-vous dans les 2 prochains mois.</div>'}
  </div>`;
}

function openEventSheet(ev, dateKey) {
  const editing = Boolean(ev);
  const start = ev ? new Date(ev.starts_at) : null;
  const v = {
    title: ev?.title || '',
    date: start ? dayKey(start) : dateKey || dayKey(new Date()),
    time: start && !ev.all_day ? hhmm(start) : '20:00',
    allDay: ev?.all_day || false,
    space: ev ? ev.space_id || '' : prefs.get('lastSpace', state.spaces[0]?.id || ''),
    remind: ev ? (ev.remind_offset ?? '') + '' : '60',
    repeat: ev?.repeat || 'none',
    note: ev?.note || '',
  };
  if (!editing && v.space && !spaceOf(v.space)) v.space = state.spaces[0]?.id || '';
  const opts = (list, cur) => list.map(([val, l]) => `<option value="${val}" ${String(cur) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const el = openSheet(`
    <h2 class="h2" style="margin-bottom:16px">${editing ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous'}</h2>
    <form class="stack" novalidate>
      <label class="field"><span>Quoi ?</span><input class="input" name="title" maxlength="80" placeholder="Resto pour nos 1 an ❤️" value="${esc(v.title)}" required></label>
      <div class="row" style="align-items:flex-end">
        <label class="field" style="flex:1"><span>Date</span><input class="input" type="date" name="date" value="${v.date}" required></label>
        <label class="field" style="width:130px" data-time ${v.allDay ? 'hidden' : ''}><span>Heure</span><input class="input" type="time" name="time" value="${v.time}"></label>
      </div>
      <div class="setting" style="padding:4px 4px"><b style="font-weight:600">Toute la journée</b><label class="switch"><input type="checkbox" name="allDay" ${v.allDay ? 'checked' : ''}><i></i></label></div>
      <label class="field"><span>Pour qui ?</span><select class="input" name="space">
        ${opts([...state.spaces.map((s) => [s.id, `${s.emoji} ${s.name}`]), ['', '🔒 Juste moi']], v.space)}</select></label>
      <div class="row">
        <label class="field" style="flex:1"><span>Rappel</span><select class="input" name="remind">${opts(remindOptions(v.allDay), v.remind)}</select></label>
        <label class="field" style="flex:1"><span>Répéter</span><select class="input" name="repeat">${opts(REPEATS, v.repeat)}</select></label>
      </div>
      <label class="field"><span>Note (facultatif)</span><textarea class="input" name="note" rows="2" maxlength="500" placeholder="Réservé au nom de Lorenzo">${esc(v.note)}</textarea></label>
      <div class="error"></div>
      <button class="btn block" type="submit">${editing ? 'Enregistrer' : 'Ajouter au calendrier'}</button>
      ${editing ? '<button class="btn danger block" type="button" data-del>Supprimer</button>' : ''}
    </form>`);
  const form = $('form', el);
  form.allDay.onchange = () => {
    $('[data-time]', el).hidden = form.allDay.checked;
    const cur = form.remind.value;
    form.remind.innerHTML = opts(remindOptions(form.allDay.checked), cur);
    if (![...form.remind.options].some((o) => o.value === cur)) form.remind.value = form.allDay.checked ? '1440' : '60';
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.error', el);
    const title = form.title.value.trim();
    if (!title) { err.textContent = 'Donne un nom au rendez-vous.'; return; }
    if (!form.date.value) { err.textContent = 'Choisis une date.'; return; }
    if (!form.allDay.checked && !form.time.value) { err.textContent = 'Choisis une heure.'; return; }
    const starts = new Date(`${form.date.value}T${form.allDay.checked ? '00:00' : form.time.value}`);
    if (Number.isNaN(starts.getTime())) { err.textContent = 'Date invalide.'; return; }
    const row = {
      title,
      note: form.note.value.trim() || null,
      starts_at: starts.toISOString(),
      all_day: form.allDay.checked,
      repeat: form.repeat.value,
      remind_offset: form.remind.value === '' ? null : Number(form.remind.value),
      space_id: form.space.value || null,
    };
    row.remind_at = nextRemind(row)?.toISOString() ?? null;
    const btn = $('button[type=submit]', el);
    btn.disabled = true;
    try {
      if (editing) {
        const { error } = await sb.from('events').update(row).eq('id', ev.id);
        if (error) throw error;
      } else {
        const { data, error } = await sb.from('events').insert({ ...row, created_by: me() }).select('id').single();
        if (error) throw error;
        if (row.space_id) notify({ type: 'event', event_id: data.id });
      }
      const { data } = await sb.from('events').select('*').order('starts_at');
      if (data) state.events = data;
      state.cal.selected = dayKey(starts);
      state.cal.month = new Date(starts.getFullYear(), starts.getMonth(), 1);
      closeSheet();
      toast(row.remind_at ? '📅 Ajouté, rappel programmé 🔔' : '📅 Ajouté au calendrier');
      if (location.hash !== '#/calendar') location.hash = '#/calendar'; else render();
      if (row.remind_at && state.push !== 'on') setTimeout(() => toast('Active les notifications dans ton profil pour recevoir le rappel', 4500), 2800);
    } catch (ex) {
      err.textContent = errMsg(ex);
      btn.disabled = false;
    }
  };
  const del = $('[data-del]', el);
  if (del) del.onclick = async () => {
    if (!confirm(`Supprimer « ${ev.title} »${ev.repeat !== 'none' ? ' (et toutes ses répétitions)' : ''} ?`)) return;
    const { error } = await sb.from('events').delete().eq('id', ev.id);
    if (error) { toast(errMsg(error)); return; }
    state.events = state.events.filter((x) => x.id !== ev.id);
    closeSheet();
    toast('Rendez-vous supprimé');
    render();
  };
}

/* ───────────────────────── Rendu et navigation ───────────────────────── */

const app = $('#app');
const tabbar = $('#tabbar');

function currentRoute() {
  const [, view = 'home', arg] = (location.hash || '#/home').split('/');
  return { view, arg };
}

function render() {
  if (!state.user) {
    tabbar.hidden = true;
    app.innerHTML = viewAuth('login');
    bindAuth('login');
    return;
  }
  const { view, arg } = currentRoute();
  const html = { home: viewHome, spaces: viewSpaces, space: () => viewSpace(arg), send: () => viewSend(arg), photos: viewPhotos, profile: viewProfile, calendar: viewCalendar }[view];
  app.innerHTML = (html || viewHome)();
  tabbar.hidden = false;
  const tab = view === 'space' ? 'spaces' : view === 'photos' ? 'home' : view;
  $$('a', tabbar).forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  hydrateImages(app);
}

// Rafraîchit l'écran sans casser ce que l'utilisateur est en train de faire.
function softRender() {
  const { view } = currentRoute();
  if (['home', 'space', 'photos', 'profile', 'spaces', 'calendar'].includes(view) && !document.activeElement?.matches('input, select')) {
    const y = scrollY;
    render();
    scrollTo(0, y);
  }
}

function visibleList() {
  const { view, arg } = currentRoute();
  if (view === 'space') return state.photos.filter((p) => p.space_id === arg);
  if (view === 'photos') return state.photosFilter === 'received' ? received() : sentPhotos();
  if (view === 'home') return state.photos;
  return [];
}

app.addEventListener('click', async (e) => {
  const t = e.target;
  const photoEl = t.closest('[data-photo]');
  if (photoEl && !t.closest('[data-remove]')) {
    const list = visibleList();
    const p = list.find((x) => x.id === photoEl.dataset.photo) || state.photos.find((x) => x.id === photoEl.dataset.photo);
    if (!p) return;
    if (state.select) {
      state.select.has(p.id) ? state.select.delete(p.id) : state.select.add(p.id);
      softRender();
    } else if (photoEl.closest('.sheet') === null) {
      const { view } = currentRoute();
      openViewer(p, view === 'home' ? (p.sender_id === me() ? sentPhotos() : received()) : list);
    }
    return;
  }
  const act = t.closest('[data-act]')?.dataset.act;
  const { arg } = currentRoute();
  switch (act) {
    case 'pending': { const pend = pendingPhotos(); if (pend.length) openSaveSheet(pend); else toast(autoSave()?.on ? 'Tout est à jour ✨' : 'Active l’enregistrement automatique dans ton profil'); break; }
    case 'create': openCreateSheet(); break;
    case 'join': openJoinSheet(); break;
    case 'invite': openInviteSheet(); break;
    case 'delete-space': deleteSpace(arg); break;
    case 'leave-space': leaveSpace(arg); break;
    case 'select-on': state.select = new Set(); softRender(); break;
    case 'select-off': state.select = null; softRender(); break;
    case 'select-all': visibleList().forEach((p) => state.select.add(p.id)); softRender(); break;
    case 'save-selection': {
      const list = visibleList().filter((p) => state.select.has(p.id));
      state.select = null;
      softRender();
      if (list.length) openSaveSheet(list);
      break;
    }
    case 'clear-send': state.send.files.forEach((f) => URL.revokeObjectURL(f.preview)); state.send.files = []; render(); break;
    case 'send': sendPhotos(); break;
    case 'rename': openRenameSheet(); break;
    case 'install': openInstallSheet(); break;
    case 'privacy': openPrivacySheet(); break;
    case 'logout': if (confirm('Se déconnecter ?')) { await forgetThisDevice(); await sb.auth.signOut(); } break;
    case 'push-on': enablePush(); break;
    case 'push-off': disablePush(); break;
    case 'push-test': notify({ type: 'test' }).then((r) => toast(r?.sent ? '🔔 Notification envoyée' : 'Rien reçu ? Vérifie le guide (fonction notify).')); break;
    case 'add-event': openEventSheet(null, state.cal.selected); break;
    case 'cal-today': { const t = new Date(); state.cal = { month: new Date(t.getFullYear(), t.getMonth(), 1), selected: dayKey(t) }; render(); break; }
    case 'delete-account': openDeleteAccountSheet(); break;
  }
  const rm = t.closest('[data-remove]');
  if (rm) { const [f] = state.send.files.splice(+rm.dataset.remove, 1); URL.revokeObjectURL(f.preview); render(); }
  const sp = t.closest('[data-space]');
  if (sp) { state.send.spaceId = sp.dataset.space; $$('[data-space]').forEach((b) => b.classList.toggle('on', b === sp)); }
  const fl = t.closest('[data-filter]');
  if (fl) { state.photosFilter = fl.dataset.filter; state.select = null; render(); }
  const cm = t.closest('[data-cal]');
  if (cm) { const m = state.cal.month; state.cal.month = new Date(m.getFullYear(), m.getMonth() + Number(cm.dataset.cal), 1); render(); }
  const dd = t.closest('[data-day]');
  if (dd) { state.cal.selected = dd.dataset.day; const d = parseKey(dd.dataset.day); if (d.getMonth() !== state.cal.month.getMonth()) state.cal.month = new Date(d.getFullYear(), d.getMonth(), 1); render(); }
  const evb = t.closest('[data-event]');
  if (evb) { const ev = state.events.find((x) => x.id === evb.dataset.event); if (ev) openEventSheet(ev); }
  const th = t.closest('[data-theme-choice]');
  if (th) { prefs.set('theme', th.dataset.themeChoice); applyTheme(); render(); }
});

app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-pick]')) {
    for (const file of t.files) state.send.files.push({ file, preview: URL.createObjectURL(file) });
    t.value = '';
    render();
  }
  if (t.id === 'autosave') {
    setAutoSave(t.checked);
    toast(t.checked ? '✅ Les nouvelles photos te seront proposées dès leur arrivée' : 'Enregistrement automatique désactivé');
  }
  if (t.id === 'quality') prefs.set('quality', t.value);
  if (t.dataset.pref) {
    const col = t.dataset.pref;
    sb.from('profiles').update({ [col]: t.checked }).eq('id', me()).then(({ error }) => {
      if (error) { toast(errMsg(error)); t.checked = !t.checked; } else state.profile[col] = t.checked;
    });
  }
});

window.addEventListener('hashchange', () => {
  state.select = null;
  closeSheet();
  render();
  scrollTo(0, 0);
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.user) return;
  try { await loadData(); } catch { return; }
  softRender();
  const pend = pendingPhotos();
  if (pend.length && !document.querySelector('.sheet, .viewer')) openSaveSheet(pend);
});

/* ───────────────────────── Démarrage ───────────────────────── */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) { const h = new URL(e.data.url).hash; if (h) location.hash = h; }
  });
}

function captureJoinCode() {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (code) {
    sessionStorage.setItem('lp.join', code.toUpperCase());
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

async function onSession(session) {
  if (!session) {
    state.user = null;
    state.profile = null;
    state.spaces = [];
    state.photos = [];
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    render();
    return;
  }
  state.user = session.user;
  try {
    await Promise.all([loadProfile(), loadData()]);
  } catch (e) {
    app.innerHTML = `<div class="view"><div class="empty">${esc(errMsg(e))}<br><br><button class="btn" onclick="location.reload()">Réessayer</button></div></div>`;
    return;
  }
  if (!autoSave()) setAutoSave(true); // activé par défaut, pour les photos reçues à partir de maintenant
  subscribeRealtime();
  state.push = await checkPush();
  render();
  const code = sessionStorage.getItem('lp.join');
  if (code) {
    sessionStorage.removeItem('lp.join');
    try { await joinWithCode(code); } catch (e) { toast(errMsg(e), 4000); }
  }
  const pend = pendingPhotos();
  if (pend.length && !state.autoSheetShown) { state.autoSheetShown = true; setTimeout(() => openSaveSheet(pend), 500); }
}

async function init() {
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  captureJoinCode();
  if (!sb) { render(); return; }
  sb.auth.onAuthStateChange((event, session) => {
    // On sort du callback avant d'appeler Supabase (recommandation de supabase-js).
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') openNewPasswordSheet();
      else if (event === 'SIGNED_IN' && session && session.user.id !== state.user?.id) onSession(session);
      else if (event === 'SIGNED_OUT') onSession(null);
    }, 0);
  });
  const { data } = await sb.auth.getSession();
  if (data.session?.user.id !== state.user?.id || !data.session) await onSession(data.session);
}

init();
