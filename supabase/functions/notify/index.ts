// LonaPics — fonction d'envoi des notifications push
// À créer dans Supabase > Edge Functions > « notify » (voir le guide).
// Réglage important : désactiver « Verify JWT » (la fonction vérifie elle-même qui l'appelle).
// Aucune bibliothèque d'envoi : le chiffrement Web Push est fait avec WebCrypto (intégré à Deno).

import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
// Les clés sont nettoyées : un copier-coller depuis un téléphone ajoute parfois guillemets,
// espaces spéciaux ou retours à la ligne invisibles.
const cleanKey = (v: string) => v.replace(/^[^=]*=\s*/, (m) => (/^[A-Z_]+\s*=/.test(m) ? '' : m)).replace(/[^A-Za-z0-9\-_+/]/g, '');
const VAPID_PUBLIC_KEY = cleanKey(env('VAPID_PUBLIC_KEY'));
const VAPID_PRIVATE_KEY = cleanKey(env('VAPID_PRIVATE_KEY'));
const VAPID_SUBJECT = env('VAPID_SUBJECT') || 'mailto:lonapics@example.com';
const CRON_SECRET = env('CRON_SECRET');
const TIMEZONE = env('APP_TIMEZONE') || 'Europe/Paris';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

type Pref = 'notif_photos' | 'notif_members' | 'notif_events' | 'notif_reminders';
type Payload = { title: string; body: string; url?: string; tag?: string };

/* ── Web Push (RFC 8291 + VAPID RFC 8292), sans bibliothèque externe ── */
// @webpush-start
const enc = new TextEncoder();
const b64uDecode = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b64uEncode = (buf: ArrayBuffer | Uint8Array) => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

function ecJwk(publicRaw: Uint8Array, privateB64u?: string) {
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: b64uEncode(publicRaw.slice(1, 33)), y: b64uEncode(publicRaw.slice(33, 65)), ext: true };
  if (privateB64u) jwk.d = privateB64u;
  return jwk;
}

// Chiffre le message pour un abonné (aes128gcm). `fixed` ne sert qu'aux tests.
async function encryptPayload(
  plaintext: Uint8Array, p256dh: string, authSecret: string,
  fixed?: { salt: Uint8Array; senderPublic: Uint8Array; senderPrivate: string },
) {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  let senderPrivateKey: CryptoKey;
  let senderPublic: Uint8Array;
  if (fixed) {
    senderPublic = fixed.senderPublic;
    senderPrivateKey = await crypto.subtle.importKey('jwk', ecJwk(senderPublic, fixed.senderPrivate), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    senderPrivateKey = pair.privateKey;
    senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, senderPrivateKey, 256));
  const ikm = await hkdf(auth, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, senderPublic), 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = senderPublic.length;
  return concat(header, senderPublic, cipher);
}

async function vapidAuthorization(endpoint: string) {
  const check = (name: string, value: string, bytes: number) => {
    let n = -1;
    try { n = b64uDecode(value).length; } catch { /* illisible */ }
    if (n !== bytes) throw new Error(`Secret ${name} invalide : ${value.length} caractères lus, attendu ${bytes === 65 ? 87 : 43}. Recopie-le.`);
  };
  check('VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY, 65);
  check('VAPID_PRIVATE_KEY', VAPID_PRIVATE_KEY, 32);
  const pub = b64uDecode(VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey('jwk', ecJwk(pub, VAPID_PRIVATE_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${VAPID_PUBLIC_KEY}`;
}
// @webpush-end

async function pushOne(sub: { endpoint: string; p256dh: string; auth: string }, payload: Payload) {
  const authHeader = await vapidAuthorization(sub.endpoint);
  let body: Uint8Array;
  try {
    body = await encryptPayload(enc.encode(JSON.stringify(payload)), cleanKey(sub.p256dh), cleanKey(sub.auth));
  } catch (e) {
    return { status: 0, text: `abonnement illisible (${(e as Error).message}) : appuie sur Couper puis Activer` };
  }
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(60 * 60 * 24),
      Urgency: 'high',
    },
    body,
  });
  return { status: res.status, text: res.ok ? '' : await res.text().catch(() => '') };
}

/* ── Envoi ─────────────────────────────────────────────────── */

async function sendTo(userIds: string[], pref: Pref | null, payload: Payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('Secrets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants');
  const unique = [...new Set(userIds)];
  if (!unique.length) return 0;
  let ids = unique;
  if (pref) {
    const { data } = await admin.from('profiles').select('id').in('id', unique).eq(pref, true);
    ids = (data ?? []).map((p) => p.id);
  }
  if (!ids.length) return 0;
  const { data: subs } = await admin.from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', ids);
  let sent = 0;
  const errors: string[] = [];
  await Promise.all(
    (subs ?? []).map(async (s) => {
      const r = await pushOne(s, payload);
      if (r.status >= 200 && r.status < 300) sent++;
      // Abonnement expiré (appli supprimée, notifs coupées) : on le retire.
      else if (r.status === 404 || r.status === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      else errors.push(`${r.status || ''} ${r.text}`.trim().slice(0, 200));
    }),
  );
  if (!sent && errors.length) throw new Error(`Refus du service de notifications : ${errors[0]}`);
  return sent;
}

async function spaceInfo(spaceId: string) {
  const { data } = await admin.from('spaces').select('name, emoji, space_members(user_id)').eq('id', spaceId).single();
  return data as { name: string; emoji: string; space_members: { user_id: string }[] } | null;
}

async function usernameOf(id: string) {
  const { data } = await admin.from('profiles').select('username').eq('id', id).single();
  return data?.username ?? 'Quelqu’un';
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/* ── Dates (même logique que l'appli) ─────────────────────── */

type EventRow = {
  id: string; space_id: string | null; created_by: string; title: string; starts_at: string;
  all_day: boolean; repeat: 'none' | 'weekly' | 'monthly' | 'yearly'; remind_offset: number | null; remind_at: string | null;
};

// Les répétitions se calculent en heure locale (Europe/Paris), comme dans l'appli,
// pour que « tous les 1er du mois à 20 h » reste à 20 h, heure d'été comme d'hiver.
const wallFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});
function wall(t: number) {
  const p = Object.fromEntries(wallFmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month - 1, d: p.day, h: p.hour, min: p.minute };
}
function fromWall(y: number, m: number, d: number, h: number, min: number) {
  const guess = Date.UTC(y, m, d, h, min);
  const offsetAt = (t: number) => { const w = wall(t); return Date.UTC(w.y, w.m, w.d, w.h, w.min) - t; };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

function occurrence(base: Date, repeat: EventRow['repeat'], k: number) {
  if (repeat === 'none' || k === 0) return new Date(base);
  const w = wall(base.getTime());
  if (repeat === 'weekly') return fromWall(w.y, w.m, w.d + 7 * k, w.h, w.min);
  const months = w.m + (repeat === 'monthly' ? k : 12 * k);
  const last = new Date(Date.UTC(w.y, months + 1, 0)).getUTCDate();
  return fromWall(w.y, months, Math.min(w.d, last), w.h, w.min);
}

// Les rendez-vous « toute la journée » sont rappelés par rapport à 9 h le jour même.
const remindFor = (occ: Date, ev: EventRow) =>
  new Date(occ.getTime() + (ev.all_day ? 9 * 3600_000 : 0) - (ev.remind_offset ?? 0) * 60_000);

function nextRemind(ev: EventRow, after: Date) {
  if (ev.remind_offset == null) return null;
  const base = new Date(ev.starts_at);
  if (ev.repeat === 'none') {
    const r = remindFor(base, ev);
    return r > after ? r : null;
  }
  for (let k = 0; k < 2000; k++) {
    const r = remindFor(occurrence(base, ev.repeat, k), ev);
    if (r > after) return r;
  }
  return null;
}

const fmtTime = (d: Date) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
const fmtDay = (d: Date) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TIMEZONE });

function whenText(offset: number, allDay: boolean, occ: Date) {
  const time = allDay ? '' : ` à ${fmtTime(occ)}`;
  if (offset === 0) return allDay ? "C'est aujourd'hui" : `Maintenant${time}`;
  if (offset < 60) return `Dans ${offset} min${time}`;
  if (offset < 1440) return `Dans ${Math.round(offset / 60)} h${time}`;
  if (offset === 1440) return `Demain${time}`;
  return `${fmtDay(occ).replace(/^./, (c) => c.toUpperCase())}${time}`;
}

/* ── Rappels programmés (appelé chaque minute par pg_cron) ─── */

async function handleReminders() {
  const now = new Date();
  const { data: due, error } = await admin
    .from('events')
    .select('id, space_id, created_by, title, starts_at, all_day, repeat, remind_offset, remind_at')
    .not('remind_at', 'is', null)
    .lte('remind_at', now.toISOString())
    .limit(100);
  if (error) throw error;

  let sent = 0;
  for (const ev of (due ?? []) as EventRow[]) {
    // On « réserve » le rappel avant d'envoyer, pour ne jamais l'envoyer deux fois.
    const next = nextRemind(ev, now);
    const { data: claimed } = await admin
      .from('events')
      .update({ remind_at: next ? next.toISOString() : null })
      .eq('id', ev.id)
      .eq('remind_at', ev.remind_at!)
      .select('id');
    if (!claimed?.length) continue;

    // Rappel en retard de plus de 12 h (projet en pause…) : on ne spamme pas.
    if (now.getTime() - new Date(ev.remind_at!).getTime() > 12 * 3600_000) continue;

    const occ = new Date(new Date(ev.remind_at!).getTime() + (ev.remind_offset ?? 0) * 60_000 - (ev.all_day ? 9 * 3600_000 : 0));
    let recipients = [ev.created_by];
    let where = 'Rappel perso';
    if (ev.space_id) {
      const s = await spaceInfo(ev.space_id);
      if (!s) continue;
      recipients = s.space_members.map((m) => m.user_id);
      where = `${s.emoji} ${s.name}`;
    }
    sent += await sendTo(recipients, 'notif_reminders', {
      title: `⏰ ${ev.title}`,
      body: `${whenText(ev.remind_offset ?? 0, ev.all_day, occ)} · ${where}`,
      url: '#/calendar',
      tag: `rappel-${ev.id}`,
    });
  }
  return sent;
}

/* ── Point d'entrée ───────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (CRON_SECRET && req.headers.get('x-cron-secret') === CRON_SECRET) {
      return json({ ok: true, sent: await handleReminders() });
    }

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth } = await admin.auth.getUser(token);
    const user = auth?.user;
    if (!user) return json({ error: 'non connecté' }, 401);

    const body = await req.json().catch(() => ({}));
    const me = await usernameOf(user.id);

    if (body.type === 'test') {
      const sent = await sendTo([user.id], null, { title: '🔔 LonaPics', body: 'Les notifications marchent sur ce téléphone !', url: '#/profile' });
      return json({ ok: true, sent });
    }

    const spaceId = String(body.space_id ?? '');
    if (body.type === 'photos' || body.type === 'join') {
      const s = await spaceInfo(spaceId);
      if (!s || !s.space_members.some((m) => m.user_id === user.id)) return json({ error: 'espace introuvable' }, 403);
      const others = s.space_members.map((m) => m.user_id).filter((id) => id !== user.id);

      if (body.type === 'photos') {
        // Anti-abus : il faut avoir vraiment envoyé des photos à l'instant.
        const { count } = await admin.from('photos').select('id', { count: 'exact', head: true })
          .eq('space_id', spaceId).eq('sender_id', user.id).gte('created_at', minutesAgo(10));
        if (!count) return json({ ok: true, sent: 0 });
        const n = Math.min(count, Number(body.count) || 1);
        const sent = await sendTo(others, 'notif_photos', {
          title: `📸 ${me}`,
          body: `${n > 1 ? `${n} nouvelles photos` : 'Nouvelle photo'} dans ${s.emoji} ${s.name}`,
          url: `#/space/${spaceId}`,
          tag: `photos-${spaceId}`,
        });
        return json({ ok: true, sent });
      }

      const { data: m } = await admin.from('space_members').select('joined_at')
        .eq('space_id', spaceId).eq('user_id', user.id).gte('joined_at', minutesAgo(10)).maybeSingle();
      if (!m) return json({ ok: true, sent: 0 });
      const sent = await sendTo(others, 'notif_members', {
        title: '🎉 Nouveau membre',
        body: `${me} a rejoint ${s.emoji} ${s.name}`,
        url: `#/space/${spaceId}`,
      });
      return json({ ok: true, sent });
    }

    if (body.type === 'event') {
      const { data: ev } = await admin.from('events')
        .select('id, space_id, created_by, title, starts_at, all_day, created_at')
        .eq('id', String(body.event_id ?? '')).single();
      if (!ev || ev.created_by !== user.id || !ev.space_id || ev.created_at < minutesAgo(10)) return json({ ok: true, sent: 0 });
      const s = await spaceInfo(ev.space_id);
      if (!s) return json({ ok: true, sent: 0 });
      const start = new Date(ev.starts_at);
      const sent = await sendTo(
        s.space_members.map((m) => m.user_id).filter((id) => id !== user.id),
        'notif_events',
        {
          title: `📅 ${me} a ajouté un rendez-vous`,
          body: `${ev.title} · ${fmtDay(start)}${ev.all_day ? '' : ' à ' + fmtTime(start)}`,
          url: '#/calendar',
        },
      );
      return json({ ok: true, sent });
    }

    return json({ error: 'type inconnu' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
