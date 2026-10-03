# SongCraft Studio — produkční deployment runbook

Tento runbook neobsahuje žádné hesla, tokeny ani API klíče. Secrets se nastavují výhradně v Supabase Dashboard / GitHub Environment / Oracle Secret Manager.

## 1. Před nasazením

- Potvrdit commit a větev `dev/ai-manager-studio`.
- Zkontrolovat `pnpm-lock.yaml`, změny schématu a všechny `supabase/migrations/*`.
- Ověřit, že `songcraft` a video bucket jsou private.
- Ověřit, že veřejné release assety neobsahují uživatelská videa.
- Vytvořit DB backup a storage manifest.
- Nastavit auth allowlist na serverové straně; ne pouze v klientském UI.
- Zkontrolovat, že starý `songcraft-studio-assistant` není používán jako produkční orchestrátor.

## 2. Supabase

### Legacy path preflight

Před `20260925010000_agent_security_hardening.sql` spusť na staging pouze read-only kontroly cest v `agent_videos`, `agent_image_assets` a `agent_media_uploads`. Migrace je fail-closed: pokud najde legacy cestu mimo `${user_id}/`, celý soubor se odroluje a je nutné nejdříve soubor přesunout nebo explicitně opravit. Nezakazuj migraci obejítím kontroly.

### Lokální reprodukovatelnost

Před prvním `db push` ověřte `supabase/config.toml` hodnotu `major_version` proti remote projektu; nesmí se měnit naslepo.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
supabase db lint
supabase functions serve --env-file .env.local
# Type-check Edge Functions independently from the Expo tsconfig:
deno check --config supabase/functions/deno.json --node-modules-dir=auto supabase/functions/agent-orchestrator/index.ts
```

Soubory `.env*` jsou lokální a nesmějí být commitnuty. Do `.env.local` patří pouze testovací hodnoty.

### Migrace

```bash
supabase db push
supabase db diff --schema public
```

Ledger musí zahrnout minimálně `20260925000000`, `20260925010000`, `20260925110000`, `20260925120000`, `20260925130000`, `20260925140000`, `20260925150000`, `20260925160000` a `20260925170000` v uvedeném pořadí.

Migrace musí být idempotentní nebo jednoznačně verzované. Po každém pushu zkontrolovat v Supabase migration ledgeru, zda nebyly přeskočeny starší migrace.

### Nasazení bez hesla do databáze (Management API)

`supabase link`/`supabase db push` vyžadují heslo do Postgres. Pokud heslo není dostupné (např. Termux bez Dockeru), použij `scripts/apply-migrations.mjs`, který aplikuje migrace přes Management API `database/query` a zapisuje stejný ledger (`supabase_migrations.schema_migrations`) jako CLI. Horní transakční příkazy (`BEGIN`/`COMMIT`) se odstraní pouze mimo dollar-quoted těla, takže `DO $$ … $$` bloky zůstávají nedotčené.

```bash
export SUPABASE_ACCESS_TOKEN=...        # personal access token, mimo repozitář
node scripts/apply-migrations.mjs --dry-run     # pouze plán
node scripts/apply-migrations.mjs --preflight   # read-only kontrola legacy cest
APPLY_MIGRATIONS=1 scripts/deploy-production.sh --migrations
```

`scripts/deploy-production.sh --secrets --functions` pak nastaví Edge Function secrets z lokálního
`.env` souboru (`--secrets-file`, nikdy necommitovat) a nasadí funkce přes `--use-api` (bez Dockeru).
Skript je fail-closed: pokud v secrets souboru chybí některý z povinných názvů, nasazení se zastaví.

### Edge Functions

Workflow `youtube-publish-scheduler.yml` pouze převádí due `scheduled` záznamy na `draft` a vytváří recommendation; **nikdy** nepublikuje bez confirmation nonce. `sync-youtube-stats.yml` používá pouze `SYNC_STATS_CRON_SECRET`.

Nasadit pouze zdroje z `supabase/functions/`:

```bash
supabase functions deploy agent-orchestrator
supabase functions deploy video-renderer-dispatch
supabase functions deploy youtube-publish
supabase functions deploy youtube-sync-stats
```

`agent-orchestrator` musí ověřit uživatelský JWT. `youtube-sync-stats` je scheduler funkce a smí přijímat pouze interní scheduler/service credential, ne libovolný bearer token z klienta.

### Povinné secret názvy

Názvy jsou pouze kontrakt; hodnoty se nikdy neukládají do repozitáře:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_AI_STUDIO_KEY` nebo `GEMINI_API_KEY`
- `OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY` (volitelné fallbacky)
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`
- `VIDEO_VM_ENDPOINT`
- `VIDEO_VM_BASIC_AUTH`
- `SONGCRAFT_ALLOWED_USER_IDS` (server-side allowlist, immutable UUIDs)
- `SONGCRAFT_ALLOWED_EMAILS` (server-side allowlist fallback)
- `SONGCRAFT_APP_REDIRECT_URL`
- `EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL` (client build variable, stejný deep link)
- `SYNC_STATS_CRON_SECRET`
- `PUBLISH_SCHEDULER_SECRET`

## 3. Oracle video worker

Na VM patří pouze `workers/video-renderer/worker.mjs`, Node 20+, FFmpeg a bezpečnostní pravidla pro práci s audiem a obrázky.

Požadované proměnné jsou uložené v root-only environment souboru nebo systemd credential store:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VIDEO_RENDERER_ENDPOINT` (pokud worker volá dashboard přes proxy)
- případný provider/API key pouze pro konkrétní backend

Service musí mít:

- `Restart=on-failure`,
- `User=songcraft-renderer` nebo ekvivalentní neprivilegovaný účet,
- `WorkingDirectory` oddělený od webové aplikace,
- health check a logy bez access tokenů.

Před nasazením workeru ověřit, že načítá pouze finální audio, nikoli source/original MP3, a že výstup zapisuje do privátního Supabase Storage pod vlastníkem účtu.

## 4. Oracle testovací scénář

1. Vytvořit krátký interní testovací audio soubor.
2. Nahrát finální MP3 a privátní cover.
3. Spustit `static_cover`.
4. Ověřit `queued → rendering → ready` a soukromý download.
5. Totéž pro `image_animation` a `full_scenes`.
6. Ověřit, že cizí účet nevidí video ID ani storage path.
7. Ověřit retry po dočasném selhání a reaper po přerušeném worku.

## 5. Release gate

Release nevydávat, pokud neprochází:

- auth a cross-user RLS test,
- private storage a žádný public asset,
- upload MIME/size/magic-byte test,
- všechny tři render mode testy,
- confirmation handshake pro YouTube,
- per-video statistics test,
- Android build a web export,
- rollback nebo obnovení z backupu.

## 6. Rollback

- Funkce vrátit na předchozí commit přes CI/CD nebo Supabase deploy log.
- Databázové změny nevracet destruktivním SQL; použít předem otestovanou dopřednou opravu nebo obnovu backupu podle Runbooku.
- Starý worker zastavit, drainovat frontu a teprve potom nasadit předchozí worker.
- Ověřit, že rollback nevrátil veřejné GitHub release ani staré credential.
- Po ověření nové cesty odstranit/znepřístupnit existující `songcraft-videos` GitHub release assety a zrušit jejich download tokeny.
