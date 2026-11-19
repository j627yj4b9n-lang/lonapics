-- ═══════════════════════════════════════════════════════════════
--  LonaPics — base de données Supabase
--  À coller en entier dans Supabase > SQL Editor > New query > Run
-- ═══════════════════════════════════════════════════════════════

-- ── Tables ─────────────────────────────────────────────────────

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 1 and 30),
  created_at timestamptz not null default now()
);

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  emoji text not null default '❤️' check (char_length(emoji) <= 16),
  gradient text not null default 'love' check (gradient in ('love', 'dream', 'ocean', 'sun')),
  invite_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.space_members (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  sender_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  path text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists photos_space_created_idx on public.photos (space_id, created_at desc);
create index if not exists photos_sender_idx on public.photos (sender_id);
create index if not exists space_members_user_idx on public.space_members (user_id);

-- ── Fonctions utilitaires ──────────────────────────────────────

create or replace function public.is_member(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from space_members where space_id = s and user_id = auth.uid());
$$;

create or replace function public.is_space_owner(s uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from spaces where id = s and owner_id = auth.uid());
$$;

create or replace function public.shares_space_with(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from space_members a join space_members b on a.space_id = b.space_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- Profil créé automatiquement à l'inscription
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), split_part(new.email, '@', 1), 'Moi'), 30)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Le créateur d'un espace en devient membre automatiquement
create or replace function public.add_owner_as_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into space_members (space_id, user_id) values (new.id, new.owner_id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_space_created on public.spaces;
create trigger on_space_created after insert on public.spaces
  for each row execute function public.add_owner_as_member();

-- Rejoindre un espace : uniquement avec le bon code d'invitation
create or replace function public.join_space(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s uuid;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  select id into s from spaces where invite_code = upper(trim(code));
  if s is null then raise exception 'Code invalide'; end if;
  insert into space_members (space_id, user_id) values (s, auth.uid()) on conflict do nothing;
  return s;
end;
$$;

-- Suppression définitive du compte (les photos du stockage sont effacées par l'appli juste avant)
create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.join_space(text), public.delete_account() from public, anon;
grant execute on function public.join_space(text), public.delete_account() to authenticated;

-- ── Sécurité : chacun ne voit que ses espaces ──────────────────

alter table public.profiles enable row level security;
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.photos enable row level security;

drop policy if exists "profil visible par soi et ses proches" on public.profiles;
create policy "profil visible par soi et ses proches" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_space_with(id));
drop policy if exists "modifier son profil" on public.profiles;
create policy "modifier son profil" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "voir ses espaces" on public.spaces;
create policy "voir ses espaces" on public.spaces for select to authenticated
  using (public.is_member(id) or owner_id = auth.uid());
drop policy if exists "créer un espace" on public.spaces;
create policy "créer un espace" on public.spaces for insert to authenticated
  with check (owner_id = auth.uid());
drop policy if exists "modifier son espace" on public.spaces;
create policy "modifier son espace" on public.spaces for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "supprimer son espace" on public.spaces;
create policy "supprimer son espace" on public.spaces for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists "voir les membres" on public.space_members;
create policy "voir les membres" on public.space_members for select to authenticated
  using (public.is_member(space_id));
drop policy if exists "quitter ou retirer" on public.space_members;
create policy "quitter ou retirer" on public.space_members for delete to authenticated
  using (user_id = auth.uid() or public.is_space_owner(space_id));
-- Pas de règle d'insertion : on n'entre que par join_space() ou en créant l'espace.

drop policy if exists "voir les photos de ses espaces" on public.photos;
create policy "voir les photos de ses espaces" on public.photos for select to authenticated
  using (public.is_member(space_id));
drop policy if exists "envoyer dans ses espaces" on public.photos;
create policy "envoyer dans ses espaces" on public.photos for insert to authenticated
  with check (sender_id = auth.uid() and public.is_member(space_id));
drop policy if exists "supprimer ses photos" on public.photos;
create policy "supprimer ses photos" on public.photos for delete to authenticated
  using (sender_id = auth.uid() or public.is_space_owner(space_id));

-- ── Stockage des photos (privé) ────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 52428800, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'])
on conflict (id) do nothing;

-- Les fichiers sont rangés ainsi : photos/<id de l'espace>/<id>.jpg
drop policy if exists "lonapics lire" on storage.objects;
create policy "lonapics lire" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "lonapics envoyer" on storage.objects;
create policy "lonapics envoyer" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "lonapics supprimer" on storage.objects;
create policy "lonapics supprimer" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (owner_id = auth.uid()::text or public.is_space_owner(((storage.foldername(name))[1])::uuid)));

-- ── Calendrier et rappels ──────────────────────────────────────

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  space_id uuid references public.spaces(id) on delete cascade,          -- vide = rappel perso
  created_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  note text check (char_length(note) <= 500),
  starts_at timestamptz not null,
  all_day boolean not null default false,
  repeat text not null default 'none' check (repeat in ('none', 'weekly', 'monthly', 'yearly')),
  remind_offset integer check (remind_offset between 0 and 43200),       -- minutes avant ; vide = pas de rappel
  remind_at timestamptz,                                                  -- prochain rappel à envoyer
  created_at timestamptz not null default now()
);
create index if not exists events_remind_idx on public.events (remind_at) where remind_at is not null;
create index if not exists events_space_idx on public.events (space_id);

alter table public.events enable row level security;

create or replace function public.can_see_event(s uuid, creator uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case when s is null then creator = auth.uid() else public.is_member(s) end;
$$;

drop policy if exists "voir les rendez-vous" on public.events;
create policy "voir les rendez-vous" on public.events for select to authenticated
  using (public.can_see_event(space_id, created_by));
drop policy if exists "ajouter un rendez-vous" on public.events;
create policy "ajouter un rendez-vous" on public.events for insert to authenticated
  with check (created_by = auth.uid() and public.can_see_event(space_id, created_by));
drop policy if exists "modifier un rendez-vous" on public.events;
create policy "modifier un rendez-vous" on public.events for update to authenticated
  using (public.can_see_event(space_id, created_by))
  with check (public.can_see_event(space_id, created_by));
drop policy if exists "supprimer un rendez-vous" on public.events;
create policy "supprimer un rendez-vous" on public.events for delete to authenticated
  using (public.can_see_event(space_id, created_by));

-- ── Notifications push ─────────────────────────────────────────

alter table public.profiles add column if not exists notif_photos boolean not null default true;
alter table public.profiles add column if not exists notif_members boolean not null default true;
alter table public.profiles add column if not exists notif_events boolean not null default true;
alter table public.profiles add column if not exists notif_reminders boolean not null default true;

-- Un abonnement par téléphone (le serveur d'envoi les lit avec la clé secrète)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "ses abonnements" on public.push_subscriptions;
create policy "ses abonnements" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ── Temps réel (photos, membres, calendrier) ───────────────────

do $$
begin
  begin alter publication supabase_realtime add table public.photos; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.space_members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.events; exception when duplicate_object then null; end;
end $$;
