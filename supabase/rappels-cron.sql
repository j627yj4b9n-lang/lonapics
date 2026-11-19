-- ═══════════════════════════════════════════════════════════════
--  LonaPics — envoi automatique des rappels du calendrier
--  À lancer APRÈS avoir créé la fonction « notify ».
--  Remplace les DEUX valeurs en MAJUSCULES ci-dessous avant de cliquer sur Run.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'lonapics-rappels';

-- Chaque minute : s'il y a un rappel à envoyer, on réveille la fonction « notify ».
select cron.schedule(
  'lonapics-rappels',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://mgfxuvlsmmmsdxsqbqqn.supabase.co/functions/v1/hyper-processor',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'TON-CRON-SECRET'),
      body := '{}'::jsonb
    )
    where exists (select 1 from public.events where remind_at <= now());
  $job$
);
