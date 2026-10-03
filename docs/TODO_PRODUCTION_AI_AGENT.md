# SongCraft Studio — produkční TODO: AI hudební manažer a Oracle video pipeline

**Stav dokumentu:** živý roadmap  
**Cílová větev:** `dev/ai-manager-studio`  
**Zdrojový snapshot:** 25. 9. 2026  
**Rotace tokenů/API klíčů:** podle zadání provést až po dokončení a ověření ostatních bodů. Během vývoje nepřidávat nové secrets do repozitáře.

## První implementační slice — stav k 25. 9. 2026

Následující změny jsou již v pracovním stromu, ale **nejsou ještě potvrzené na produkčním Supase/Oracle prostředí**:

- [~] user-scoped React Query cache, logout cleanup a user-scoped drafty;
- [~] SecureStore Supabase session adapter s jednorázovou migrací starého AsyncStorage záznamu;
- [~] client-side storage signature/size/path guard a soukromý user-prefix bucket policy;
- [~] RLS hardening, append-only audit, server-only render sloupce a scheduler auth;
- [~] konverzace `agent_conversations`/`agent_messages` a klientský `agent-api` boundary;
- [~] tři render mode, private Oracle queue, lease/retry a final/tagged audio preference;
- [~] PKCE OAuth start/callback, explicitní confirmation nonce a `agent-confirm` boundary;
- [x] aktivní video/cover GitHub release pipeline nahrazen fail-closed private/Oracle cestou;
- [~] modernizovaný Přehled, skrytý album tab, OAuth settings karta a video job panel;
- [~] hermetic CI, security boundary scanner a produkční runbook.

**Blokující před nasazením:** aplikovat migrace v pořadí z `supabase/migrations`, nastavit `SONGCRAFT_ALLOWED_*` a scheduler/OAuth secrets, nasadit Oracle systemd worker, potom spustit E2E a teprve potom rotovat tokeny.

## Stav k 25. 9. 2026 večer (po offline verifikaci v Termuxu)

Detailní checklisty níže zůstávají v původním znění; tento oddíl je současný souhrn.

| Sekce | Stav | Kde je to implementováno / důkaz |
| --- | --- | --- |
| 1. Zdroj pravdy | hotovo kromě git rozhodnutí | `supabase/config.toml`, `supabase/migrations/`, `README.md`, verze z `package.json` |
| 2. Tajemství | částečně | odstraněny hardcoded klíče z deploy skriptů, security scanner v CI; rotace odložena na release gate |
| 3. Auth a izolace | implementováno, chybí E2E | SecureStore adapter, user-scoped query keys, logout cleanup, server allowlist ve funkcích |
| 4. DB integrita | implementováno, migrace neaplikovány | `20260925010000` a `20260925110000`–`20260925170000` |
| 5. Storage | implementováno | `lib/storage-paths.ts`, `lib/supabase-storage.ts`, `songcraft-media`, origin/tagged audio invariant |
| 6. Orchestrator | implementováno | `lib/agent-api.ts`, `supabase/functions/agent-orchestrator` |
| 7. Potvrzení a YouTube | implementováno | `agent-confirm`, `youtube-oauth-start/callback`, `youtube-publish`, `youtube-publish-scheduler` |
| 8. Oracle pipeline | implementováno, VM ve stavu staging | `workers/video-renderer/worker.mjs`; dashboard na VM vrací 401 bez basic auth |
| 9. Statistiky | implementováno | `youtube-sync-stats` (per-video, `dimensions=video,day`) |
| 10. UI/UX | implementováno | nový Přehled, skrytý album tab, OAuth karta, video job panel, tři render režimy |
| 11. Testy a CI | hotovo | 66 passed / 1 skipped, 16/16 `deno check`, hermetic CI, scanner, smoke check |
| 12. Nasazení | blokováno | chybí platný Supabase management access token pro `hfykngbhcxmnpxvjagoj` |

Aktuální stav živých ověření a blockerů: `docs/VERIFICATION_STATUS.md`.
Postup bez hesla do Postgres (Management API): `docs/DEPLOYMENT_RUNBOOK.md`, `scripts/apply-migrations.mjs`,
`scripts/deploy-production.sh`.

> Tento soubor je jediný kanonický seznam zbývající práce. Starší `todo.md`, `todo-dee7naux.md`, `VALIDATION.md` a `PROJECT_TODO_AI_MANAGER.md` jsou historické podklady, nikoli authoritative stav.

---

## 0. Definice hotového produktu

Produkt je nasazený až tehdy, když přihlášený uživatel může bezpečně:

1. přihlásit se soukromým Supabase účtem;
2. vidět pouze svá alba, texty, skladby, soubory a recommendation data;
3. v chatu s AI manažerem získat kontext vlastního katalogu;
4. vytvořit song artwork i album artwork;
5. vytvořit video ve třech režimech:
   - `static_cover`,
   - `image_animation`,
   - `full_scenes`;
6. zobrazit stav fronty a stáhnout hotový MP4;
7. vytvořit metadata a draft YouTube publikace;
8. publikovat až po skutečném uživatelském potvrzení;
9. synchronizovat per-video statistiky;
10. bezpečně exportovat a zálohovat katalog.

Veřejný stav nesmí být dosažen jen tím, že kód existuje v repository. Každý prvek musí mít test, nasazení, rollback a ověření na cílové Supabase/Oracle infrastruktuře.

---

## 1. Zdroj pravdy a verze

- [x] Rozdělit `main` a `dev/ai-manager-studio`.
- [x] Zjistit, že lokální checkout byl starý snapshot `main` (`1.0.0`).
- [x] Synchronizovat pracovní snapshot s `dev/ai-manager-studio` (`2.9.1`).
- [ ] Rozhodnout, zda se AI manager mergeuje do `main`, nebo zůstane na dlouhodobé větvi.
- [ ] Změnit package/build verzi z jediného zdroje (`package.json`).
- [ ] Zkontrolovat, že `origin/main` a `origin/dev/ai-manager-studio` mají před nasazením stejný zamýšlený commit.
- [ ] Přidat kořenové `README.md` s přesnou architekturou a runbookem.
- [ ] Odstranit nebo přesunout legacy Manus runbook a `template.json` mimo aktivní repo.

**Gate:** žádný soubor nesmí být zdrojem pravdy pouze v `supabase_songcraft_*.json`; zdroj musí být v běžném `supabase/functions/` nebo `supabase/migrations/` adresáři.

---

## 2. Incident response a tajemství

- [ ] Inventarizovat všechny plaintext credentials v `/storage/emulated/0/InsaneCode/Secret`, CSV/TXT/PDF/archive souborech a Android úložišti.
- [ ] Odstranit hardcoded nasazovací tokeny z:
  - `scripts/upload-supabase-web.mjs`,
  - `scripts/upload-external-web-entry.mjs`,
  - `supabase_songcraft_web_deployer_open_function.json`.
- [ ] Odstranit starý renderer API klíč z `scripts/create-youtube-export-function.mjs`.
- [ ] Zkontrolovat Git historii a případně odstranit secrets z historie.
- [ ] **Teprve těsně před produkčním nasazením** rotovat:
  - Supabase service-role key,
  - hesla soukromých účtů,
  - Google/Gemini key,
  - GitHub token/automation token,
  - YouTube OAuth client secret a OAuth tokens,
  - Oracle/VM a externí renderer credentials.
- [ ] Ověřit, že staré credentials nejsou aktivní ani v GitHub Actions, Supabase ani Oracle VM.
- [ ] Přesunout veškeré credentials do Supabase/GitHub secret storage nebo Secret Manager.
- [ ] Přidat secret scan do CI a blokaci při novém hardcoded credentialu.
- [ ] Nastavit `chmod`/šifrování lokálních secret záloh a ověřit záložní kopii mimo sdílené Android úložiště.

**Gate:** po rotaci nesmí žádný starý credential fungovat; nový release APK ani web nesmí obsahovat service-role key.

---

## 3. Supabase auth a izolace účtů

- [ ] Ověřit v Supabase Auth, že public signup je vypnutý.
- [ ] Enforce allowlist tří účtů na serveru, ne pouze v `app/auth.tsx`.
- [ ] Preferovat immutable user ID místo porovnávání emailu/display name.
- [ ] Přidat route-level auth guard pro všechny detail/editor/export routy.
- [ ] Přidat `user_id` do React Query key:
  - `["songcraft", "supabase", "snapshot", userId]`.
- [ ] Při logout/account switch:
  - odstranit všechny private queries,
  - zrušit pending mutations,
  - vymazat staré signed URLs z cache,
  - případně provést `queryClient.clear()`.
- [ ] User-scopovat local draft key pomocí user ID.
- [ ] Opravit obnovování draftů v textovém i song editoru.
- [ ] Otestit přechod Temney → DJ Palačinka → Verča na stejném zařízení.
- [ ] Nahradit AsyncStorage pro nativní Supabase session SecureStore adaptorem.
- [ ] Definovat retention/deletion pro assistant history, rhyme history a drafts.
- [ ] Při logout nabídnout nebo automaticky provést lokální cleanup soukromých dat.

**Gate:** test prokáže, že účet B nikdy neuvidí snapshot, draft, assistant history, cover, audio ani recommendation účtu A.

---

## 4. Databázová integrita a tenant boundaries

- [ ] Vytvořit conventional `supabase/config.toml` a `supabase/migrations/`.
- [ ] Doplnit chybějící core tabulky a sloupce:
  - `sc_style_prompts`,
  - `sc_cover_jobs`,
  - `sc_video_jobs`,
  - `sc_songs.style_prompts`,
  - YouTube metadata a publication sloupce.
- [ ] Přidat RLS pro všechny tabulky, včetně job a style prompt tabulek.
- [ ] Rozdělit `FOR ALL` policies na konkrétní operation policies.
- [ ] `youtube_credentials`:
  - žádný client SELECT/UPDATE,
  - přístup pouze přes serverovou OAuth funkci,
  - ideálně Supabase Vault nebo aplikační šifrování.
- [ ] `agent_action_log` změnit na server-only append-only audit.
- [ ] `agent_videos.storage_path`, `render_status` a `output_path` měnit pouze workerem/Edge Function.
- [ ] Přidat composite tenant integrity:
  - lyric/album,
  - song/album,
  - song/source lyric,
  - audio version/song,
  - agent video/song,
  - publication/video,
  - stats/publication.
- [ ] Přidat unique constraint na `sc_songs.source_lyric_id`.
- [ ] Přidat validní `privacy_status`, `mode`, `backend` a audio/image/video whitelisty.
- [ ] Opravit idempotentní a atomické RPC pro:
  - dokončení lyric dokumentu,
  - primary/final verze,
  - publish queue.
- [ ] Změnit bucket `songcraft` na private a nastavit storage metadata limity.
- [ ] Ověřit, že `songcraft-web` nemá anonymní INSERT/UPDATE policy.
- [ ] Zavést lifecycle/garbage collection pro orphaned Storage objektů.

**Gate:** adversarial RLS testy pro dva účty, cizí ID, cizí storage path a přímé zápisy do audit/credential tabulek procházejí pouze v izolovaném scénáři.

---

## 5. Storage a soubory

- [ ] Přidat server-side validaci uploadu:
  - MIME allowlist,
  - magic-byte kontrola,
  - skutečná velikost,
  - rozměry obrázku,
  - MP3 délka/duration limit.
- [ ] Nejprve zablokovat bypass přímého uploadu obcházející UI.
- [ ] Změnit ID3 model na:
  - `original_storage_path` immutable,
  - `tagged_storage_path` generated,
  - `original_file_name` immutable.
- [ ] Při exportu nikdy nepřepisovat source pointer.
- [ ] Zachovat uživatelem upravená ID3 metadata při tagování.
- [ ] Přidat korektní `songcraft-media/index.ts` zdroj.
- [ ] Odstranit/nebezpečně zastaralé deployment JSON snapshoty.
- [ ] Omezit import:
  - maximální base64 request,
  - PDF pages,
  - DOCX archive entries,
  - remote response size,
  - timeout.
- [ ] Omezit ZIP export:
  - 300 MB hard limit,
  - bounded/streaming generation,
  - žádné načítání celé knihovny bez limitu.
- [ ] Přidat orphan cleanup a retention policy.
- [ ] Omezit počet souborů, verzí a generovaných jobů na uživatele.

**Gate:** upload, import, ID3 export a ZIP export mají jednotkové i integrační testy hraničních hodnot.

---

## 6. AI orchestrator

- [ ] Zavést canonical `lib/agent-api.ts`.
- [ ] Přepojit `lib/assistant-chat.ts` a UI na `agent-orchestrator`.
- [ ] Přidat persistentní:
  - `agent_conversations`,
  - `agent_messages`,
  - conversation ID do requestu.
- [ ] Oddělit instruction context od uživatelských dat; lyrics jsou data, ne instructions.
- [ ] Přidat provider budget/rate limit a timeout/retry/backoff.
- [ ] Omezit počet iterací, nástrojů a externích providerů na request.
- [ ] Implementovat nástroje podle plánu:
  - catalog reads,
  - lyric analysis,
  - song/album artwork,
  - metadata,
  - 3 render modes,
  - recommendations,
  - publication draft,
  - publish/update/comment/thumbnail s potvrzením,
  - per-video stats.
- [ ] Neodesílat celé texty do URL externích providerů bez informovaného souhlasu.
- [ ] Implementovat 1:1 album artwork a 16:9 song artwork.
- [ ] Implementovat A/B thumbnail návrhy.
- [ ] Implementovat `audit_channel_health`, trend a release planning nástroje až po bezpečném core.
- [ ] Logovat každý tool call včetně chyby a pending confirmation.
- [ ] Nevracet stack trace/provider internals klientovi.

**Gate:** stejný uživatel dostane kontextovou odpověď; cizí účet nemůže přes LLM získat cizí data; každý write tool má ownership check a audit.

---

## 7. Potvrzení a YouTube publishing

- [ ] Přidat serverový confirmation nonce vázaný na:
  - publication ID,
  - title/description/tags,
  - video ID/hash,
  - privacy status,
  - playlisty.
- [ ] Přidat `pending → publishing → published/failed` state.
- [ ] Použít atomický claim a idempotency key.
- [ ] Implementovat OAuth connect/callback přes PKCE a scope/channel binding.
- [ ] Implementovat `agent-confirm` Edge Function.
- [ ] Implementovat confirm UI v chatu a v detailu publikace.
- [ ] Implementovat skutečný scheduler pro `scheduled_at`.
- [ ] `auto_publish` číst pouze serverově.
- [ ] Přidat retry/backoff pro YouTube rate limit a transient errors.
- [ ] Po uploadu atomicky propojit `agent_videos.video_id` s publication draftem.
- [ ] Nastavit thumbnail a metadata podle potvrzeného payloadu.
- [ ] Implementovat update, comment reply, playlist a removal s potvrzením.
- [ ] Před každým veřejným zásahem zobrazit přesný cíl, název, soukromí a playlist.

**Gate:** žádný veřejný YouTube zásah se neprovede pouhým LLM tool callem; vždy vyžaduje platné uživatelské potvrzení.

---

## 8. Oracle video pipeline

### Rozhodnutí architektury

- [ ] Vybrat jedinou canonical frontu: `agent_videos` nebo `sc_video_jobs`.
- [ ] Druhou frontu odstranit nebo vytvořit explicitní migration bridge.
- [ ] Zachovat soukromý Supabase Storage jako výchozí výstup.
- [ ] Veřejný GitHub release nepoužívat pro soukromá videa.

### Worker

- [ ] Nasadit Node 20+ worker na Oracle VM přes systemd.
- [ ] Používat pouze `SUPABASE_SERVICE_ROLE_KEY` na VM.
- [ ] Worker musí použít pouze finální audio.
- [ ] Preferovat `tagged_storage_path`, pokud existuje.
- [ ] Načítat a persistovat `prompt_used`.
- [ ] Používat `mode` a `backend` z jobu.
- [ ] Přidat lease/heartbeat/reaper pro `rendering`.
- [ ] Přidat retry/backoff a dead-letter stav.
- [ ] Přidat limity délky audia, velikosti a současných jobů.
- [ ] Vytvořit oddělený work directory s bezpečnými právy.
- [ ] Přidat health endpoint a systemd restart policy.
- [ ] Ověřit volání dashboardu pouze přes loopback nebo HTTPS.
- [ ] Ověřit oba AI režimy na krátké testovací písni.

### Režimy

- [ ] `static_cover`: cover + finální MP3, bez ořezu coveru.
- [ ] `image_animation`: cover + finální MP3 přes Oracle dashboard.
- [ ] `full_scenes`: storyboard/referenční postava + finální MP3 přes Oracle.
- [ ] Každý job má `queued/rendering/ready/failed`, chybu a download URL.
- [ ] Hotový MP4 se uloží soukromě a zobrazí pouze oprávněnému uživateli.

**Gate:** na Oracle běží service, health check je zelený, testovací píseň projde všemi třemi režimy a výstup je vrácen pouze vlastníkovi.

---

## 9. Statistiky YouTube

- [ ] Používat `dimensions=video,day`, ne kanálový souhrn pro každé video.
- [ ] Filtrovat podle konkrétního `youtube_video_id`.
- [ ] Doplňit refresh expirovaného access tokenu.
- [ ] Ukládat `agent_channel_stats` pro kanálové agregáty.
- [ ] Vyplnit CTR a traffic source, pokud je YouTube API poskytuje.
- [ ] Přidat retry a logging selhání API/upsertu.
- [ ] Omezit scheduler na interní credential, ne na veřejný service-role bearer.
- [ ] Nestahovat credentialy ani výsledky do klienta.

**Gate:** dva testovací videa mají rozdílné a konzistentné statistiky; kanálový agregát odpovídá součtu videí.

---

## 10. UI/UX modernizace

Cíl: méně „dashboardového chaosu“, více rychlého hudebního workspace.

### Navigace

- [ ] Nahradit šest těžkých tabů maximálně pěti:
  - **Přehled**,
  - **Knihovna**,
  - **Vytvořit**,
  - **AI**,
  - **Nastavení**.
- [ ] Texty a Alba přesunout do sekce Knihovna/ Vyvořit jako sekce nebo filtry.
- [ ] Zachovat nejvýraznější primární akci v thumb zone.
- [ ] Přidat jasné stavy ` synchronizace / offline / chyba / aktualizace`.

### Přehled

- [ ] Hero panel pouze s jednou hlavní akcí: `Pokračovat`, `Nová skladba` nebo `Nový text`.
- [ ] Zobrazit 3–5 relevantních položek, ne dlouhý seznam.
- [ ] Oddělit:
  - rozpracované,
  - připravené k MP3,
  - finální,
  - chybějící cover/metadata.
- [ ] Přidat sticky sync status a poslední změnu.
- [ ] Opravit položky bez `isError` fallbacku.

### Knihovna

- [ ] Jednotné karty songu:
  - cover,
  - název,
  - album,
  - počet verzí,
  - stav,
  - primární akce.
- [ ] Filtr jako segmented control místo příliš velkého množství chipů.
- [ ] V detailu skladby použít sticky bottom action: `Přehrát`, `Upravit`, `Export`.
- [ ] Album jako sekce/side sheet, ne mřížka bez jasného navigation flow.

### Vytvořit

- [ ] Jeden wizard:
  - text → prompt → cover → album → dokončit,
  - nebo přímá skladba s AI assistencí.
- [ ] Autosave stav viditelný uživateli.
- [ ] Draft recovery musí být deterministický.
- [ ] Rýmy a AI asistent vkládat přímo do aktivního textu bez desynchronizace undo historie.

### AI manažer

- [ ] Chat s kartami akcí místo dlouhého volného textu.
- [ ] Zobrazit pending render, doporučení, confirmace a download MP4.
- [ ] Každý nástroj zobrazit jako:
  - co udělá,
  - kde použije data,
  - zda potřebuje potvrzení.
- [ ] Conversation persistence v databázi, ne jen AsyncStorage.
- [ ] Error states a retry.

### Vizuální systém

- [ ] Zachovat temavý background, ale omezit počet gradientů.
- [ ] Použít jeden copper/amber accent pro primární akce a jeden success green.
- - [ ] Zvýšit kontrast textu a použít méně translucent vrstev.
- [ ] Standardizovat radius, spacing, typography scale.
- [ ] Všechny důležité akce minimálně 44×44 px.
- [ ] Přidat loading/skeleton/error/empty states bez falešného „prázdného katalogu“.
- [ ] Zachovat Android keyboard resize a testovat portrait mode.

**UI gate:** nový návrh musí projít manuálním scénářem na telefonu i webu: přihlášení → text → cover → MP3 → finalizace → AI render → confirm/download.

---

## 11. Testy a CI

- [ ] Oddělit unit testy od live integračních testů.
- [ ] Přidat mocked Edge Function testy.
- [ ] Přidat Deno typecheck/lint pro všechny Edge Functions.
- [ ] Přidat testy:
  - auth/allowlist,
  - logout cache,
  - draft recovery,
  - cross-user RLS,
  - storage path validation,
  - import limits,
  - ID3 original/tagged separation,
  - ZIP limit,
  - job quota/idempotency,
  - confirmation nonce,
  - OAuth refresh,
  - per-video analytics,
  - all three render modes.
- [ ] CI musí spouštět:
  - `pnpm install --frozen-lockfile`,
  - `pnpm check`,
  - `pnpm lint`,
  - unit testy,
  - Deno checks,
  - secret scan,
  - dependency audit,
  - web export,
  - Android build.
- [ ] Živý test s produkčním Gemini/Supabase musí být opt-in a mít oddělený credential.

---

## 12. Nasazení a rollback

### Před nasazením

- [ ] Zvolený commit je na `dev/ai-manager-studio` i `main` podle rozhodnutí.
- [ ] Všechny migrace jsou v repository a v Supabase migration ledgeru.
- [ ] Všechny Edge Functions jsou nasazeny z `supabase/functions/`.
- [ ] Service keys jsou v Supabase/GitHub secrets.
- [ ] `songcraft` i video bucket jsou private.
- [ ] Staré deploy funkce jsou zavřené a credentialy odvolané.
- [ ] Oracle VM má aktualizovaný worker a systemd service.
- [ ] Je připraven backup DB a storage manifestu.

### Po nasazení

- [ ] Auth smoke test pro všechny tři účty.
- [ ] RLS smoke test pro dva účty.
- [ ] Upload/cover smoke test.
- [ ] `static_cover` render na krátké písni.
- [ ] `image_animation` render na krátké písni.
- [ ] `full_scenes` render na krátké písni.
- [ ] Confirmovaný YouTube publish na private/unlisted draft.
- [ ] Statistiky jednoho videa.
- [ ] Android APK install/update test.
- [ ] Web GitHub Pages direct-route test.
- [ ] Rollback testu výkonu předchozího commitu.

---

## 13. Akceptační kritéria

Projekt lze označit jako hotový pouze když:

- [ ] všechny tři účty jsou izolované;
- [ ] žádný plaintext credential není v repo, klientovi ani veřejném release;
- [ ] čistý checkout lze reprodukovatelně nasadit na nový Supabase projekt;
- [ ] AI manažer odpovídá pouze na data přihlášeného uživatele;
- [ ] konverzace a akce jsou auditované;
- [ ] všechny tři video režimy fungují na Oracle;
- [ ] video jsou soukromá a download je řízený;
- [ ] YouTube publikace vyžaduje platné potvrzení;
- [ ] statistiky jsou per-video a ověřené proti testovacímu videu;
- [ ] upload/import/export mají limity a testy;
- [ ] drafty a cache jsou bezpečně oddělené mezi účty;
- [ ] `pnpm check`, lint, testy, Deno checks, Android build a web export procházejí;
- [ ] UI scénář funguje na Androidu i webu;
- [ ] existuje rollback postup a ověřená záloha.

---

## 14. První implementační pořadí

1. TODO a volba canonical větve.
2. User-scoped cache, logout cleanup, draft scope a UI error states.
3. Oprava draft/rhyme/album/session regressions.
4. Centralizace Supabase migrací a RLS.
5. Storage/media validation a original/tagged MP3 model.
6. Auth/allowlist a service-role boundary hardening.
7. Orchestrator API, persistent conversations a confirmation handshake.
8. Jedna Oracle video fronta a worker recovery.
9. YouTube OAuth/publish/scheduler/statistics.
10. UI/UX redesign a Android/web E2E.
11. Kompletní CI a security audit.
12. Teprve potom rotace tokenů a produkční release.
