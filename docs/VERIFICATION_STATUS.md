# Ověření implementace — 25. 9. 2026 (večer, po nasazení)

Tento záznam obsahuje výsledky hermetic kontrol, živých E2E testů a stav rollbacku. Neobsahuje credentials ani hodnoty secretů.

## Nasazení na produkci (projekt `hfykngbhcxmnpxvjagoj`)

- 11 produkčních migrací aplikováno v pořadí a zapsáno do `supabase_migrations.schema_migrations` (potvrzeno v CI logu: `applying … ok` ×11)
- 23 Edge Function secretů na projektu; všech 15 povinných názvů ověřeno přes Management API (`scripts/verify-edge-secrets.mjs`)
- 16 Edge Functions nasazeno (`supabase functions deploy --use-api`)
- Deploy workflow: `Deploy agent orchestrator` — **success** (opakovaně, idempotentní)
- `SongCraft CI` — **success** (16/16 `deno check`, testy, security scan, web export)

## Živé E2E (15/15)

- auth pro všechny tři účty (`temney`, `dj-palacinka`, `verca`)
- `agent_confirmations`, `youtube_oauth_states` existují; `agent_videos` má `attempt_count`/`lease_expires_at`
- `agent-orchestrator`: anonymně 401, přihlášeně 200, žádný stack trace v odpovědi
- `youtube-sync-stats` a `youtube-publish-scheduler`: anonymně 401 (fail-closed)
- `youtube-oauth-start` vrací platnou Google authorization URL (PKCE stav uložen)
- izolace účtů: žádný překryv songů mezi účty, cizí song nepřístupný
- 24 songů / 20 audio verzí / 10 jobů ve frontě dostupných pro render testy

## Video pipeline (skutečné rendery, vše tři režimy)

- `static_cover` × 6, `image_animation` × 1, `full_scenes` × 1 — vše `ready`
- postup: job vytvořen přes `songcraft-youtube` jako přihlášený uživatel → nový worker si ho zamkl lease → `queued → rendering → ready`
- výstupy: 10–18 MB MP4, platné `ftyp`, 16:9, v soukromém bucketu `songcraft` s owner-prefix cestou
- anonymní čtení objektu: HTTP 400 (soukromé); vlastník přes signed URL: HTTP 200
- opravené chyby zjištěné živým během: chybějící čárka před `format=yuv420p` v filter chainu a detekce typu artworku z magic bytů
- legacy `songcraft-video-renderer` (GitHub release pipeline) zastaven a vypnut; aktivní je už jen `songcraft-renderer`

## Android APK a automatické aktualizace

- `.github/workflows/build-apk.yml` po každém pushi do klientského kódu vystaví APK, zveřejní ho jako release `app-vX.Y.Z` a doplní verzi, versionCode, velikost, sha256 a commit
- verze se propíše i do `package.json` před `expo prebuild`, takže tag release, Android `versionName` a `Constants.expoConfig.version` (Nastavení) sedí — jinak by si updater nabízel verzi, kterou už aplikace má
- `versionCode` se počítá jako maximum posledního vydání + 1 (Android nižší verci nepřijme)
- podepisování: `scripts/configure-android-signing.mjs` po prebuildu vloží `release` do existujícího `signingConfigs` bloku a přepojí `release` buildType z debug klíče runnera (debug klíč se mezi buildy mění → aktualizace nebyly proveditelné)
- klíč pouze v GitHub Secrets (`CI_KEYSTORE`, `CI_KEYSTORE_PASS`, `CI_KEY_ALIAS`), lokální záloha mimo repozitář
- ověřeno: `app-v2.9.3` (versionCode 20903, 49 MB) podepsán certifikátem `CN=SongCraft Studio, OU=Release` se SHA-256 `97:95:BA:…:9D` (shoduje s lokálním keystore)
- updater v aplikaci: banner při startu (s přeskočením verze) + ruční kontrola v Nastavení, throttle 30 min s cache (GitHub API bez tokenu má 60 req/h na IP)
- **jednorázový krok pro uživatele:** staré APK je podepsané jiným klíčem, takže je nutné starou aplikaci odinstalovat a 2.9.3 nainstalovat ručně; další aktualizace už jdou přes aplikaci

## Odstranění veřejných videí

- release `songcraft-videos` měl 2 veřejná MP4 (35,7 MB + 48,5 MB) z 21. 9. 2026
- oba dotčené songy dostaly soukromé náhradní rendery (`58ecdf30` pro `0c6d3151`, `b6780201` pro `e1c8326f`)
- assety, release i tag smazány; oba veřejné URL vracejí 404
- zbývají pouze APK release (distribuce aplikace)

## Živé testy produkční brány (`pnpm test:live`)

- 8/8 prošlo: 3 soukromé účty, assistant (401 bez JWT + odpověď přes Gemini), cover 16:9, Google AI Studio key, service role read-only
- oprava: `vitest.config.ts` tyto testy vylučoval, takže `pnpm test:live` končil „No test files found"; přidán `vitest.live.config.ts`


## Oracle VM

- Node.js 22.23.3, `songcraft-renderer.service` active, work dir `/var/lib/songcraft-studio/work`
- dashboard `127.0.0.1:8080` s basic auth (401 bez přihlášení), veřejně přes Caddy + Cloudflare tunel
- starý worker vypnut, privátní fronta nahrazuje veřejné GitHub release

## Odstraněné bugy (nálezy z živého běhu)

1. `pg_policy` sloupec `polname` (ne `policyname`) — shodil by hardening i core migraci
2. ledger insert v runneru — špatné escapování `$` v `array[$$…$$]`
3. preflight mlčel při chybě dotazu — teď fail-closed a kontroluje existující sloupce
4. `songcraft-imports` 32 MB bundle → HTTP 413; řešeno server-side bundlingem (`--use-api`)
5. `supabase secrets list --output json` jiný tvar než očekával grep → verifikace přes Management API
6. NativeWind `forceWriteFileSystem` v CI → „Failed to get the SHA-1 for web.css"
7. ffmpeg filter chain v workeru + detekce typu artworku

## Zbývá za release gate (vyžaduje výslovné potvrzení uživatele)

- reálný YouTube publish po confirmation nonce (veřejný zásah — neprovádím bez souhlasu)
- `pnpm test:live` běžel a prošel; `image_animation`/`full_scenes` ověřeny na CPU-only VM
- Android APK build přes CI workflow
- rotace starých tokenů a API klíčů (odloženo podle zadání na release gate — nasazení a E2E hotovo, teď je poslední krok)
- ukončení starého `video-agent` dispatcheru na VM, pokud už nová fronta pokrývá i AI režimy

