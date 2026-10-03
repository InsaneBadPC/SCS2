# SongCraft Studio

SongCraft Studio je soukromý hudební workspace pro texty, artworky, finální MP3, AImanažera a soukromé video na Oracle VM.

## Bezpečný datový tok

```text
Expo app / Web
  → Supabase Auth (RLS + user-prefixed storage)
  → Edge Functions (ověřený JWT + server-only tools)
  → agent_videos queue
  → Oracle video worker
  → private Supabase Storage
  → explicitní confirmation handshake
  → YouTube OAuth / publish
```

Veřejný GitHub release renderer není součástí aktivního video flow. Staré `sc_video_jobs`/GitHub release skripty jsou fail-closed a slouží pouze jako historická reference.

## Vývoj

```bash
cp .env.example .env.local   # šablona je v repu, jen ji vyplň
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm security:check
pnpm smoke:structure
```

`.env.example` obsahuje **jména všech proměnných s českým komentářem, odkud hodnota pochází** — žádné skutečné hodnoty. Zdroj pravdy pro seznam jmen je `SCS2/.env.scs2.example`. `.env.local` musí zůstat necommitnutý; `SUPABASE_SERVICE_ROLE_KEY` a ostatní SECRET nikdy nepatří do klientského kódu.

Live testy s účty a providery jsou oddělené přes `pnpm test:live` a vyžadují explicitně nakonfigurované testovací secrets. Do běžného repozitáře se nikdy neukládají service-role keys ani OAuth tokeny.

## Nasazení

Postup, secret contract, Oracle systemd konfigurace, rollback a E2E acceptance gate jsou v:

- `docs/TODO_PRODUCTION_AI_AGENT.md`
- `docs/DEPLOYMENT_RUNBOOK.md`
- `docs/UI_MODERNIZATION_PLAN.md`

Migrace jsou v `supabase/migrations/` a nesmí se aplikovat přes ad-hoc JSON snapshoty. JSON soubory `supabase_songcraft_*.json` jsou pouze synchronizované legacy deploy vstupy; pro nové změny je zdrojem pravdy `supabase/functions/` a `supabase/migrations/`.
