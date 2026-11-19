// LonaPics — fonction d'envoi des notifications push
// À créer dans Supabase > Edge Functions > « notify » (voir le guide).
// Réglage important : désactiver « Verify JWT » (la fonction vérifie elle-même qui l'appelle).

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:lonapics@example.com';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const TIMEZONE = Deno.env.get('APP_TIMEZONE') ?? 'Europe/Paris';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
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

/* ── Envoi ─────────────────────────────────────────────────── */

async function sendTo(userIds: string[], pref: Pref | null, payload: Payload) {
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
  await Promise.all(
    (subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 24, urgency: 'high' },
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // Abonnement expiré (appli supprimée, notifs coupées) : on le retire.
        if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        else console.error('push', code, (e as Error).message);
      }
    }),
  );
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
