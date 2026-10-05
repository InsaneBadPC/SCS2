# Ověření stavu SCS2 — 5. 10. 2026

Ověřeno přímo proti **SCS2** projektu a proti souborům v repu. Bez credentials
a bez hodnot secretů.

> **Pozor na původ tohoto souboru.** Do 5. 10. 2026 neslo tentýž název v SCS1
> a psalo o projektu `hfykngbhcxmnpxvjagoj`. Ty výsledky se do SCS2 **nepřevedly** —
> je to jiný Supabase projekt, jiné účty a jiný Google klíč. Sekce označené
> níže jako *SCS1 – jen historie* nepopisují SCS2 a nikdo je neměl brát jako
> současný stav.

## Projekt

| Položka | Hodnota | Jak ověřeno |
|---|---|---|
| Supabase projekt | **SCS2**, ref `gpgbgjxeybfncrexrpbr` | Management API `GET /projects/{ref}` |
| Region | **`eu-west-2`** (Londýn) | Management API + `.env.local` `SUPABASE_REGION` |
| GitHub | `InsaneBadPC/SCS2`, public, `main` | `GET /repos/InsaneBadPC/SCS2` |

## Migrace

- **19** souborů v `supabase/migrations/`
- **18 aplikovaných** (Management API `GET /database/migrations`)
- **1 NEaplikovaná:** `20261004000000_agent_ops_rls_policies.sql`

Starší údaj „11 produkčních migrací“ patřil SCS1 a je zastaralý. Pozor:
`scripts/production-smoke-check.mjs` kontroluje jen **11 vyjmenovaných
povinných** souborů, ne celý počet — to není rozpor.

## Edge Functions

- **18** funkcí v repu (`ls -1 supabase/functions/*/index.ts | wc -l`; `_shared/`
  funkce není) a **18 nasazených** — seznamy sedí 1:1.
- `youtube-oauth-callback`, `youtube-sync-stats` a `youtube-publish-scheduler`
  mají v `supabase/config.toml` `verify_jwt = false` (cron/JWT-free).
- CORS hlásiče (`Access-Control-Allow-Origin: *`) má **17 z 18**. Jediný bez je
  `legal`, a to je záměrné — jde o veřejnou stránku pro Googlebot, která se
  nesmí dotáhnout na `Authorization` hlavičku.

## Secrets

- **11** uživatelských secretů nastavených (z 15 celkem; 4 z nich
  `SUPABASE_DB_URL`/`JWKS`/`PUBLISHABLE_KEYS`/`SECRET_KEYS` zřizuje Supabase sám).
- Chybí: **`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`**,
  `SYNC_STATS_CRON_SECRET`, `PUBLISH_SCHEDULER_SECRET`.
- Nalisteno (těch 11): `GEMINI_API_KEY`, `GOOGLE_AI_STUDIO_KEY`,
  `SONGCRAFT_ALLOWED_EMAILS`, `SONGCRAFT_ALLOWED_USER_IDS`,
  `SONGCRAFT_APP_REDIRECT_URL`, `SONGCRAFT_SERVICE_ROLE_KEY`,
  `SONGCRAFT_SUPABASE_ANON_KEY`, `SONGCRAFT_SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.
- Dvě další jména (`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`) se čtou dynamicky
  přes `keyEnvs` v `agent-orchestrator`, takže je grep `Deno.env.get("…")` najde
  vůbec. Bez nich skončí fallback řetězec na `openrouter:no-key`.
- Starý údaj „23 secretů / 15 povinných názvů“ patřil SCS1. `REQUIRED` v dnešním
  `scripts/verify-edge-secrets.mjs` je **8 jmen** v profilu `base`, další jsou
  profilové (`youtube`, `ai`, `cron`).

## Data — 278 řádků ve 12 tabulkách (ověřeno živým dotazem, `Prefer: count=exact`)

| Tabulka | Řádků |
|---|---|
| `sc_lyrics` | 74 |
| `agent_action_log` | 60 |
| `sc_songs` | 31 |
| `agent_videos` | 27 |
| `sc_video_jobs` | 23 |
| `sc_audio_versions` | 23 |
| `agent_messages` | 16 |
| `sc_albums` | 6 |
| `youtube_publications` | 5 |
| `sc_cover_jobs` | 5 |
| `agent_conversations` | 5 |
| `agent_image_assets` | 3 |
| **součet** | **278** |

Přes PostgREST je vystaveno **27 tabulek** (`sc_rhyme_words`, `sc_style_prompts`,
`agent_ops`, `motion_recipes`, `youtube_stats`, … jsou prázdné).

**Záměrně vyloučeno při importu (a proto prázdné, ne chybějící):**
`youtube_credentials` = 0 řádků (tokeny starého projektu),
`youtube_oauth_states` = 0 řádků (PKCE verifier + redirect URI starého hostu).
`youtube_publications` má 5 řádků z importu — jde o metadata, ne o tokeny.

## YouTube — co reálně umí a co ne

- `youtube-oauth-start` vrací **503** s výčtem chybějících hodnot. Neprodává
  authorize URL, dokud nejsou secrets (viz `docs/YOUTUBE_OAUTH_RUNBOOK.md`).
- `youtube-publish` vrací **412 „Nejdříve připoj YouTube OAuth účet.“**
  `youtube_credentials` je prázdná a 412 je vědecký, ne chyba.
- `youtube-status` vrací `{connected:false}`.
- Publikace tedy **nejde**. Ruční kroky pro Google klienta jsou v
  [`docs/YOUTUBE_OAUTH_RUNBOOK.md`](YOUTUBE_OAUTH_RUNBOOK.md).
- Starý klíč `77741409309-…` v projektu `opencode-506810` patří SCS1. V SCS2
  nefunguje — jiná redirect URI, jiný Supabase projekt. Nepoužívat.

## Obaly — deklarace UI vs. reality

Dnes **žádný kód v repu nekreslí text do obrazu** a **široký 16:9 obal se
neskládá**. `songcraft-cover-ai` žádá AI Horde na **512 × 512**, větev
`youtube_16_9` jen nahraje soubor do `covers/raw/`, `cover_path` nepřepíše a
klient ho zahazuje. `scripts/render/compose-cover.mjs` je záměrný stub
(`process.exit(1)`). Grep po `drawtext` / `fillText` / `canvas` / `ImageMagick` /
`sharp` v repu vrací 0.

5. 10. 2026 opraveno **v UI** (texty už nelhát), ne v backendu — ten potřebuje
renderer, který v repu není. Viz `docs/SONGCRAFT_SKILLS.md` § 14.

## Brány — stav k 5. 10. 2026

```
node scripts/security-boundary-check.mjs    → security-boundary-check: OK
node scripts/production-smoke-check.mjs    → production smoke structure: OK (11 migrations, 13 required files)
node node_modules/typescript/bin/tsc --noEmit → 0 chyb
node node_modules/vitest/vitest.mjs run    → 125 passed / 1 skipped (18 souborů + 1 přeskočený)
```

## Releases

| Release | Datum |
|---|---|
| `app-v3.0.8` | 3. 10. 2026 |
| `app-v3.0.9` | 5. 10. 2026 |
| `app-v3.0.10` | 5. 10. 2026 |

**Git tagy: 0** — releases jsou GitHub Releases, ne tagy. Staré tvrzení
„repo má jediné release `app-v3.0.8`“ už neplatí.

## Podepisování APK

Platí závěr z opravy 5. 10. 2026 beze změny: **nikdy nebylo ověřeno**, že se
aplikace aktualizuje sama. `app-v3.0.8` je podepsané **debug klíčem** runnera
(`CN=Android Debug`), takže přechod na nové APK vyžaduje jednorázovou ruční
instalaci. Nový release klíč byl vygenerován mimo repozitář
(`SCS2-secrets/songcraft-release.jks`, heslo v `SCS2-secrets/Keystore.txt` a
v GitHub Secrets `CI_KEYSTORE`/`CI_KEYSTORE_PASS`/`CI_KEY_ALIAS`).

## Co zbývá — a co nejde udělat kódem

1. **Google Cloud OAuth klient.** Ruční konzole. → `docs/YOUTUBE_OAUTH_RUNBOOK.md`
2. **Aplikovat `20261004000000_agent_ops_rls_policies.sql`** na SCS2.
3. **`OPENROUTER_API_KEY` / `DEEPSEEK_API_KEY`** do Supabase secrets, jinak
   fallback řetězec v `agent-orchestrator` skončí na `openrouter:no-key`.
4. **`SYNC_STATS_CRON_SECRET` / `PUBLISH_SCHEDULER_SECRET`** — bez nich
   `youtube-sync-stats` a `youtube-publish-scheduler` (obě `verify_jwt = false`)
   odmítají plánovač.
5. **Široký 16:9 obal** — chybí renderer obrazu. Viz výše.
6. **Skutečný publish na YouTube** — veřejný zásah, nikdy bez výslovného
   schválení majitele.

---

## SCS1 – jen historie

Následující nálezy byly ověřeny 25.–26. 9. 2026 na projektu
`hfykngbhcxmnpxvjagoj` a **o SCS2 nic nevypovídají**. Nezakládat na nich nic.

- Živé E2E 15/15, 24 songů / 20 audio verzí / 10 jobů ve frontě.
- Video pipeline: `static_cover` × 6, `image_animation` × 1, `full_scenes` × 1,
  `ready`; 10–18 MB MP4; chybějící čárka před `format=yuv420p` v filter chainu.
- Odstranění veřejných videí z release `songcraft-videos` (35,7 MB + 48,5 MB).
- Oracle VM: Node.js 22.23.3, `songcraft-renderer.service` active, dashboard
  `127.0.0.1:8080` za basic auth.
- Sedm odstraněných bugů z živého běhu (`pg_policy.polname`, ledger escaping `$`,
  mlčící preflight, 32 MB bundle → HTTP 413, tvar `supabase secrets list`,
  NativeWind `forceWriteFileSystem`, ffmpeg filter chain).