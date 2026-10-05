# SongCraft Studio — skills pro práci s projektem

Vzniklo z reálného průzkumu repozitáře a **běžícího ověření** na Termuxu. Každý skill obsahuje
pouze to, co bylo skutečně ověřeno spuštěním, nebo přes `deno check` / CI log / dotaz do DB.
Když něco nešlo ověřit, je to v textu označené jako **NE OVĚŘENO**.

---

## 0. Fakta o prostředí (ověřeno)

| Položka | Hodnota |
|---|---|
| Pracovní kopie | `/data/data/com.termux/files/home/work/songcraft-studio` |
| Git branch (aktuální) | `main` |
| Verze, po které poznat správné repo | **`3.x`** – když vypišeš `2.9.1`, jsi ve špatné kopii |
| Druhá kopie na sdcard | `/storage/emulated/0/InsaneCode/songcraft-studio` (2.9.1, mrtvá) — viz 11g |
| `node_modules` | bind mount z vnitřního úložiště, viz 11g |
| Zálohy | `/storage/emulated/0/InsaneCode/songcraft-backup-20260925.zip`, `songcraft-secrets-encrypted-20260925.zip` (+ `.sha256`) |
| Secrety (mimo repo) | `~/InsaneCode/secrets/edge-functions.env` (16 klíčů), `songcraft-release.jks`, `songcraft-release.pass` |
| Další secrety | `/storage/emulated/0/InsaneCode/Secret/` (Oracle, YouTube client_secret, `PRISTUPOVE-ÚDAJE.md`) |
| Supabase projekt | `hfykngbhcxmnpxvjagoj` |
| GitHub | `InsaneBadPC/SCS2` (public) |
| Stack | Expo SDK 54, RN 0.81.5, React 19.1, expo-router 6, TS strict, NativeWind 4, TanStack Query 5, Supabase, Vitest 2 |
| Verze v `package.json` | `2.9.1` (APK release má `2.9.4` – verzi propíše workflow před prebuildem) |
| Nástroje v Termuxu | `ffmpeg 8.1.3`, `deno`, `supabase`, `gh 2.101.0` (bez auth), `node 22`, `python 3.14` |
| Staré sessions opencode | `~/.local/share/opencode/opencode.db` → tabulky `session_v2`, `session_message` (2431 zpráv) |

### Účty (izolace dat)

| E-mail | `user_id` |
|---|---|
| `temney@songcraft.test` | `99dacb87-b331-4069-9b15-61c06bd76bdd` |
| `verca@songcraft.test` | `f28d7833-3c74-483d-8620-2316f79f296c` |
| `dj.palacinka@songcraft.test` | `daa9c6dc-eb23-48c2-b422-2a6e145c80f8` (zatím bez skladeb) |

Alba: `Myšlenkovej Boom` = `c3398ce7-c442-4e59-8621-67f25ead6d80`,
`Kid of Street` = `6264b402…`, `Síla ve mě` = `621e4acc…`, `Pro Maminku` = `56a63de6…`,
`Zrůda mě porodila` = `083d5b2c…`

---

## 1. SKILL: Orientace v projektu

**Kdy použít:** poprvé v repu, nebo když nevíš kam sáhnout.

```bash
cd /data/data/com.termux/files/home/work/songcraft-studio
git log --oneline -10
find app lib components supabase/functions supabase/migrations -type f -not -path '*/node_modules/*' | sort
```

Kde co žije:

- `app/` – expo-router routy. `app/(tabs)/` = 6 tabů (Přehled, Texty, Knihovna, Asistent, Nastavení + skryté Alba), `app/song/[id].tsx` = detail skladby + verze MP3, `app/export/youtube.tsx` = export MP4, `app/auth.tsx` = soukromé přihlášení.
- `lib/external-studio.ts` – **jediná skutečná datová vrstva**. Každý read/write má `.eq("user_id", user.id)`.
- `lib/agent-api.ts` – jediná hranice klient → AI agent.
- `supabase/functions/` – 14 aktivních Edge Function + `_shared/`.
- `supabase/migrations/` – 13 migrací, zdroj pravdy pro DB.
- `workers/video-renderer/worker.mjs` – ffmpeg worker na Oracle VM.
- `docs/` – plány a stav. `docs/VERIFICATION_STATUS.md` = poslední ověřený stav nasazení.
- `supabase_songcraft_*.json` v rootu – **legacy snapshoty, ne zdroj pravdy**. Pro nové změny je zdrojem pravdy `supabase/functions/` + `supabase/migrations/`.

**Dead code, nehledat ho:** `server/**` a `lib/_core/**` jsou pozůstatky Manus backendu
(`lib/_core/api.ts`, `lib/_core/manus-runtime.ts` atd. nejsou nikde importované).
Také `lib/temney-agent.ts` a `songcraft-studio-assistant` funkce jsou nepoužívané.

---

## 2. SKILL: Ověřovací brány (POŘADÍ JE DŮLEŽITÉ)

Ověřeno na Termuxu 28. 9. 2026, všechny **PASS** na `398871cf`:

```bash
cd /data/data/com.termux/files/home/work/songcraft-studio
export PATH="/data/data/com.termux/files/usr/bin:$PATH"

node scripts/security-boundary-check.mjs     # 1 s   → "security-boundary-check: OK"
node scripts/production-smoke-check.mjs     # 1 s   → "OK (9 migrations, 12 required files)"
npx tsc --noEmit                            # 2 m 50 s → 0 chyb
npx vitest run                              # 10 s testů (2 m s npx bootem) → 66 passed, 1 skipped
deno check --config supabase/functions/deno.json \
  --node-modules-dir=auto --no-lock \
  supabase/functions/agent-orchestrator/index.ts    # 4 min (poprvé stahuje z jsr.io)
```

Pravidla:

1. **`tsc --noEmit` NECHYTÍ Edge Function.** `tsconfig.json` má v `exclude`
   `supabase/functions/**/*`. Jediná brána pro Deno kód je `deno check`.
2. `pnpm test:live` je oddělený config (`vitest.live.config.ts`) a potřebuje živé
   testovací secrets. Není součástí běžné brány.
3. **GitHub `SongCraft CI` má 2 joby:** `hermetic` (security, smoke, tsc, lint,
   vitest, web export) a `deno-functions` (`deno check` všech `functions/*/index.ts`).
   Padne-li `deno-functions`, padá i `Deploy agent orchestrator` → **funkce se nenasadí**.
4. `Build Android APK` běží paralelně a může být **success**, i když CI je červené.
   To znamená: existuje APK, ale serverová logika je stará. Netvrď, že „vše funguje“.

Ověřit stav CI na commitu:

```bash
curl -s "https://api.github.com/repos/InsaneBadPC/SCS2/actions/runs?per_page=10" \
| python3 -c "import json,sys;[print(f\"{r['name'][:30]:30} {r['conclusion']:8} {r['head_sha'][:8]} {r['created_at']}\") for r in json.load(sys.stdin)['workflow_runs']]"
```

---

## 3. SKILL: Dotaz do produkční DB přes REST

`service_role` obchází RLS. **Používat výhradně na jejich projektu, nikdy na cizím.**

```bash
cd ~/InsaneCode/secrets && set -a && . ./edge-functions.env && set +a
H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

# seznam písní
curl -s -G "$SUPABASE_URL/rest/v1/sc_songs" \
  --data-urlencode "select=id,title,album_id,user_id,is_published" \
  --data-urlencode "order=updated_at.desc" --data-urlencode "limit=50" "${H[@]}"

# konkrétní píseň (POZOR na diakritiku v URL)
curl -s -G "$SUPABASE_URL/rest/v1/sc_songs" --data-urlencode "title=eq.Proč" "${H[@]}"
```

Pasti, které jsem reálně narazil:

- `?select=*` na `sc_albums` **spadne** – tabulka nemá sloupec `title`, má `name`.
- `title=ilike.*%C5%99%C4%8D*` (ručně escapované) vrací prázdno. Použij
  `--data-urlencode`, ne sestavení URL ručně.
- Po `set -a; . ./edge-functions.env` **vypni `set -a` před každým dalším curl**,
  jinak se vzdálené cesty zmrští (curl: "option --H is unknown").
- Auth účty: `curl -s -G "$SUPABASE_URL/auth/v1/admin/users" -H "apikey: ..." -H "Authorization: Bearer ..."`

---

## 4. SKILL: Nahrání MP3 jako verze skladby

**Nesplnil jsem automaticky** – použiješ až když to schválíš. Postup je ověřený,
protože jsem ho 28. 9. použil na „Proč“.

```bash
# 1) upload do soukromého bucketu `songcraft` na owner-prefixovanou cestu
UID9="99dacb87-b331-4069-9b15-61c06bd76bdd"           # vlastník
TS=$(date +%s000)
P="$UID9/audio/${TS}-nazev.mp3"
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$P")

curl -s -X POST "$SUPABASE_URL/storage/v1/object/songcraft/$ENC" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: audio/mpeg" -H "x-upsert: false" \
  --data-binary "@/cesta/k/souboru.mp3"
# → {"Key":"songcraft/<P>","Id":"..."}

# 2) řádek verze
curl -s -X POST "$SUPABASE_URL/rest/v1/sc_audio_versions" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"user_id":"...","song_id":"...","label":"Proč (production)",
       "original_file_name":"Proč (production).mp3","storage_path":"<P>",
       "mime_type":"audio/mpeg","byte_size":8524488,"rating":5,
       "is_primary":false,"is_final":false,
       "id3_title":"Proč","id3_artist":"Temney","id3_album":"Myšlenkovej Boom"}'
```

Hranice, které tě hodí (jinak to spadne 42501/415):

- `storage_path` **musí** začínat `<user_id>/` a nesmí obsahovat `\`, NUL, `..`,
  `/` na začátku ani `//` (`lib/storage-paths.ts:25`).
- `audio/mpeg`, `audio/mp3`, `audio/aac`, `audio/mp4`, `video/mp4`, `image/jpeg|png|webp`
  jsou v allowlistu bucketu. **HEIC/HEIF odmítá** i validátor na klientovi.
- `original_storage_path` **nepiš ručně** – trigger `sc_audio_versions_guard_paths()`
  ho dopočítá a pak je immutable.
- `byte_size` je povinný (`not null`).
- `is_published`, `published_at`, `published_video_id` na `sc_songs` **nejde měnit**
  jinak než service rolí – trigger `sc_songs_publication_guard()`.

---

## 5. SKILL: Loop engine – tři techniky a náhodné spoje

`workers/video-renderer/loop-engine.mjs`, bez závislostí, běží na telefonu i na VM.
Nahrazuje `image_animation` a `full_scenes` (dashboard nebyl na VM dostupný a vždy
vracel 16:9, i když záznam říkal 9:16).

```bash
# 16:9 celé video ze skladby
node workers/video-renderer/loop-engine.mjs video.mp3_skladby.mp3 out.mp4 seed
# 9:16 short
LOOP_ASPECT=9:16 node workers/video-renderer/loop-engine.mjs video aaaa.mp3 out.mp4 seed
```

`seed` = ID práce. Plán je z něj reprodukovatelný, ale pro každou píseň jiný.
Vstup může být libovolné video **i statický obraz** (obraz → 5 s klip s driftem).

### Tři techniky průchodů

| | princip | proč neukáže střih |
|---|---|---|
| **A palindrom** | půl cyklu tam, totéž zpět, push-in + sinusový drift | konec je totožný se začátkem (obsah i měřítko); zpáteční průchod udělá pull-out, kamera nezastaví |
| **B rozmluzení** | lineární průchod, do videa vstupuje xfade s náhodným přechodem, hlava může být rozpuštěná | přechod kryje skok, obsah se plynule přelévá |
| **C střih v klidu** | lineární průchod od nejklidnějšího snímku zdroje | `blend=difference,signalstats` měří pohyb; návrat na tentýž snímek je neviditelný |

Rychlost se mění tím, **kolik snímků zdroje průchod spotřebuje** (3–15 s), ne
setpts. Žádná technika ani délka třikrát po sobě.

### Náhodnost

technika, délka, offset, zoom, drift, rychlost, přechod, tlumení – vše ze semene.
Přechody pro spoj: `hblur, fade, fadeblack, fadewhite, fadegrays, dissolve,
smoothleft/right/up/down, circleopen/close, vertopen/close, horzopen/close,
radial, distance, pixelize, wipetl/tr/bl/br`.

### Pět chyb, které stojí za každou

1. **Průchody se neřadí samy.** Perfektní smyčka končí *vlastním* startovním snímkem, takže
   dva s různými offsety se spojí tvrdým střihem (naměřeno 9–45× medianu). Proto plán
   řeší typ spoje napřed: `blend` = xfade, `cut` = dokonale souvislé pokračování
   (`startFrame = konec předchozího`).
2. **`trim` bez `end_frame`.** Větev A přehrála celý zdroj, reverse vrátil 2× víc a
   `-frames:v` odřízl konec – poslední snímek nebyl prvním. Skok 45× medianu.
3. **Drift musí být v t=0 nulový** (`sin(2*PI*t/5)`, ne `+fáze`). Jinak se první a
   poslední snímek palindromu liší.
4. **`xfade offset=0` a správné oříznutí obou stran.** Offset `D-1/fps` přetéká za
   konec prvního vstupu a spoj vyjde prázdný. Každý přechod spotřebuje T snímků
   překryvu, takže plán musí vyrobit o ΣT snímků navíc – generuje se iterativně do
   konvergence. B a C jedou bez zoomu/driftu, aby jejich první snímek seděl na flat snímek.
5. **Zdroj není smyčka.** Lineární průchod delší než zbytek zdroje se zasekne o skok
   přes konec klipu (naměřeno po 121 snímcích, což je délka zdroje). Proto se jednou
   vyrobí **crossfade smyčka** (trojnásobně zopakovaná, aby bylo místo pro offsety) a
   všechny průchody jedou přes ni.

A navíc: `gblur` i `boxblur` **neprijímají `t` ve výrazu** („Undefined constant“).
Časově proměnné rozostření je nedostupné; použij `xfade` s přechodem `hblur`.
Streamcopy (`-c:v copy`) se nesmí kombinovat s `-filter_complex`.

### Ověření, že spoj neukáže

Nestačí porovnat poslední a první snímek. Správně: **profil pohybu přes celé video** a
spoj musí mít stejnou hodnotu jako běžné sousední snímky.

```bash
ffmpeg -i out.mp4 -vf scale=120:68 -pix_fmt gray -f rawvideo x.raw -y
# python: mean(|frame[i-1]-frame[i]|) na každý snímek, porovnat s medianem
```

Výsledky: short 30 s → **všechny spoj 0,7–1,5× medianu**. Celé video 378 s (9079 snímků)
→ 47 spojů v normě a 8 snímků kolem 25× medianu, což jsou **wipe přechody**
(dissolve s tvrdou hranou), potvrzené vizuálně: postava se vpravuje zleva postupně,
žádný skok.

## 6. SKILL: AI agent (agent-orchestrator)

### Dva nástroje na oba druhy videa (28. 9. 2026)

`make_long_video` (16:9) a `make_short_video` (9:16) – oba zapisují `agent_videos` řádek
s `type=source_loop`, `mode=source_loop`, `backend=ffmpeg`, `aspect` podle nástroje a
`source_video_path`, pokud píseň má nahráté video (jinak engine použije obal).
Oba jdou přes **jeden handler**, aby se logika nerozdvojila. Agent **nepíše
motionPrompt** a nic nevymýšlí – engine si vybere průchody i přechody sám, a proto
dává pokaždé jiný výsledek, takže jde volat opakovaně.

Staré `make_music_video` / `make_short` zůstávají pro případ, kdy uživatel výslovně
řekne, co se má rozpohybovat.

- Klient volá **jen** `lib/agent-api.ts` → `askSongCraftAgent()` → POST `agent-orchestrator`.
- Auth: `Authorization: Bearer <user JWT>`. Chybí hlavička → 401, špatný JWT → 401,
  účet mimo allowlist → 403, chybí konfigurace → 503, tělo > 64 KB → 413, prázdné → 400.
- Tělo: `{ message, messages?, conversationId? }`. Max 1000 znaků zprávy, posledních 10.
- `pending` vrací akce k potvrzení. `publish_to_youtube` nese `confirmationId`
  a `confirmationToken` (32–256 znaků, jinak to klient odmítne).
- **Zveřejnění nikdy neobcházej.** Vyžaduje nonce v `agent_confirmations`
  (`nonce_hash` unique, service-role only) a druhý krok `agent-confirm` → proxy na
  `youtube-publish`. `youtube-publish` navíc kontroluje konstantní čas, metadata drift
  a `is_final` verzi.

### Známé zlomy (stav k 28. 9. 2026)

| ID | Závažnost | Co | Kde |
|---|---|---|---|
| **B1** | kritické | `hasSourceVideo` není nikde definované – `make_music_video` a `make_short` spadnou na `ReferenceError`. **Celá funkce „nahraj MP4 → loop“ je mrtvá.** | `supabase/functions/agent-orchestrator/index.ts:1055` |
| **B2** | kritické | `agent_videos.type` má CHECK jen `static_cover\|image_animation\|full_scenes`, ale orchestrator vkládá `"short"` a `"lyric_video"` | constraint `20260925000000_…sql:36-38` vs `index.ts:1081,1174` |
| **B3** | vysoká | Worker umí jen `static_cover`, `image_animation`, `full_scenes`. Agent módy `vm_living` / `vm_loop` nemá renderer → `Unknown video type` | `workers/video-renderer/worker.mjs:201-223` |
| **B4** | vysoká | System prompt volá `check_video_status`, ale ten tool není deklarovaný – model si ho vymyslí | `index.ts:1361` vs `toolDefs` `index.ts:82-236` |
| **B5** | střední | Hardcoded deploy token v `scripts/upload-supabase-web.mjs:6` a v `supabase_songcraft_web_deployer_open_function.json` | tam |
| **B6** | střední | `upload-supabase-web.mjs:50` reference nedefinovanou `bucket` | tam |
| **B7** | nízké | `app/song/[id].tsx:118-119` – `onAction` handlery jsou `() => {}` | tam |
| **B8** | nízké | `console.log` v `lib/theme-provider.tsx:63` v produkci | tam |

**Reprodukce B1 (shoduje s červeným CI):**

```
TS2304 [ERROR]: Cannot find name 'hasSourceVideo'.
    if (hasSourceVideo) {
        at .../agent-orchestrator/index.ts:1055:9
```

**Důsledek pro uživatele:** MP4→loop cesta v aplikaci nefunguje a **není ani
nasazená** – job `Deploy agent orchestrator` na `398871cf` skončil `failure`.
V produkci běží orchestrator z posledního úspěšného buildu (`b4730cd2`, 27. 9.).
Proto jsem short vyrobil lokálně přes ffmpeg, ne přes `make_short`.

### Jak B1+B2+B3 opravit (pořadí, kdyby se to mělo dělat)

1. B1: zavést `const hasSourceVideo = Boolean(song.source_video_path)` před použitím.
2. B2: rozšířit CHECK v `agent_videos` o `short` a `lyric_video` – **novou migrací**,
   ne úpravou staré (`docs/TODO_PRODUCTION_AI_AGENT.md:82` zakazuje JSON snapshoty jako zdroj pravdy).
3. B3: doplnit rendery do `worker.mjs` pro `vm_living` a `vm_loop`.
4. B4: buď deklarovat `check_video_status` v `toolDefs`, nebo odstranit z promptu.
5. Pokaždé `pnpm check && node scripts/security-boundary-check.mjs && deno check` na všech funkcích.

---

## 7. SKILL: Video render fronta

1. Klient zavolá `songcraft-youtube` (`create`) se `songId`, `versionId`, `mode`.
   Musí existovat `is_final` verze (jinak 400) a vlastní audio + cover (jinak 409).
2. Funkce vloží řádek do `agent_videos` s `render_status='queued'`.
3. Worker na Oracle VM si řádek zamkl lease (`lease_expires_at`, `attempt_count`, `max_attempts=3`).
4. ffmpeg vyrenderuje, výstup jde do **soukromého** bucketu `songcraft` na cestu s prefixem vlastníka.
5. Klient čte `render_status` (v `app/export/youtube.tsx` 72× po 5 s = 6 min; v editoru obalů 36× po 10 s).
6. Stahování: `lib/video-jobs.ts:getVideoDownloadUrl()` vyžaduje `ready` +
   `assertOwnedStoragePath` + `createSignedUrl(3600)`. Anonymní čtení = HTTP 400.

Režimy: `static_cover`, `image_animation`, `full_scenes`.
Starý `songcraft-video-renderer` (GitHub release pipeline) je **zastavený a fail-closed** (410).

---

## 8. SKILL: GitHub release, main větev a auto-update v aplikaci

### Jak auto-update reálně funguje

`lib/app-update.ts` **nečte `main`**. Poluje na
`https://api.github.com/repos/InsaneBadPC/SCS2/releases`,
přijímá jen tagy `^app-v\d+\.\d+\.\d+$` a bere první `.apk`.
=> **Aby aplikace dostupávala aktualizace, stačí mít na repu release.**
`main` je zdroj pravdy pro CI, ne pro updater.

Další fakta:

- 30min cache (GitHub bez tokenu má 60 req/h na IP), banner při startu + ruční
  kontrola v Nastavení, přeskočení verze.
- `versionCode` = max předchozího vydání + 1. **Staré APK je podepsané jiným klíčem**,
  proto je nutné před 2.9.3 starou app odinstalovat a nainstalovat ručně.
- Podepisování: `scripts/configure-android-signing.mjs` po prebuildu přepojí `release`
  buildType z debug klíče runnera na `CI_KEYSTORE` / `CI_KEYSTORE_B64` (jinak se debug
  klíč mezi buildu mění a update nejsou proveditelné). Klíč jen v GitHub Secrets.

### Stav repozitáře k 28. 9. 2026 (ověřeno přes API)

| Větev | SHA | Poznámka |
|---|---|---|
| `dev/ai-manager-studio` | `398871cf` | **HEAD, nejnovější kód** |
| `main` | `8ca9787f` | **29 commitů pozadu** (`status: ahead`, `behind: 0`) |
| `experiment/cover-image-mp3-fix` | `8e1b51a3` | experiment |
| `experiment/google-ai-studio` | `e8ac4a2f` | experiment |

Release `app-v2.9.4` byl sestaven **z `398871cf`** (tělo release: „Automatické sestavení
po změně `398871cf`“, 2.9.4, versionCode 20904, sha256 `13533f0b…`), ale jeho
`target_commitish` ukazuje na `main`. **Ano – release je z nejnovějšího kódu.**

Nedalo se to udělat, protože **na tomhle zařízení není přihlazený GitHub** –
`gh auth status` hlásí „not logged in“, `GH_TOKEN` chybí. Bez tokenu nelze pushnout.

Co by se muselo udělat po doplnění auth (a po mém potvrzení – je to nevratné):

```bash
git fetch origin
git push origin dev/ai-manager-studio:main --force-with-lease   # NE force, viz níže
```

Doporučení, ne postup: **nepoužívej force.** Bezpečnější je fast-forward nebo merge:

```bash
git checkout main && git pull --ff-only
git merge --no-ff origin/dev/ai-manager-studio -m "sync: dev/ai-manager-studio -> main"
git push origin main
```

A pozor na `main` jako zdroj pravdy pro `build-apk.yml`: release tagy míří na `main`,
takže po přesunu `main` dopředu začnou tagy ukazovat na novější kód – to je žádoucí
chování, ale zároveň to znamená, že **každý push na `main` spustí nový APK release**.
A nedělej to dřív, než je zelené CI na `398871cf` (viz B1), jinak se rozbije build
i pro uživatele, kteří si 2.9.4 nainstalovali.

---

## 9. SKILL: YouTube publish (pravidla, ne postup)

1. **Nikdy nepublikovat bez výslovného schválení uživatele na konkrétní video.**
2. Cesta: `youtube-oauth-start` (PKCE, `state` hash v `youtube_oauth_states`,
   `consumed_at` pro replay) → Google → `youtube-oauth-callback` (GET, `verify_jwt=false`,
   atomický claim stavu) → `youtube-publish` (nonce z `agent_confirmations`).
3. OAuth tokeny patří do `youtube_credentials`, která má **zero policies + `revoke all`**
   z `anon` i `authenticated` – jen service role.
4. `youtube-publish-scheduler` **nikdy nepublikuje** – jen převádí `scheduled` na `draft`
   a zapisuje `agent_recommendations`.
5. Před zveřejněním se zkontroluje: metadata drift proti `payload` (jinak 409),
   `is_final` verze (jinak 400), stav rendru (jinak 409), `isPublished` na skladbě.
6. `sc_songs.is_published` jde změnit **jen** service rolí (trigger).
7. Jedenkrát publish = `0c6d3151` a `e1c8326f` měly veřejná MP4 v releasu, které musely
   být smazány a nahrazeny soukromými rendery. **Před každým zveřejněním zkontroluj,
   že výstup jde do soukromého bucketu, ne do veřejného releasu.**

---

## 10. SKILL: Bezpečnostní hranice, které se nesmí porušit

- **Fail-closed.** Chybí konfigurace → 503, ne fallback. Chybí JWT → 401.
  Anonymní volání `agent-orchestrator`, `youtube-sync-stats`,
  `youtube-publish-scheduler` musí vracet 401 – to je testované.
- **Allowlist účtů** v `supabase/functions/_shared/access.ts`. Prázdný allowlist = nikdo.
  `scheduler-auth.ts` používá konstantní časové porovnání.
- **Owner-prefix na storage**, všude. Cesty mimo `<user_id>/` odmítnout.
- **MIME podle bajtů, ne podle tvrzení klienta** (`sniffImageMimeType`,
  `sniffVideoMimeType`); HEIC/HEIC odmítnout.
- **`agent_action_log` je append-only** – trigger blokuje UPDATE/DELETE/TRUNCATE.
  Existuje útěk `SET LOCAL songcraft.allow_audit_mutation='on'`, používat výhradně
  v migracích.
- **`agent_videos` serverové sloupce** jsou triggerem vynucené, klient je nemění.
- **Starý GitHub release renderer je mrtvý.** Nepoužívat `sc_video_jobs` render cestu.
- `node scripts/security-boundary-check.mjs` musí být **OK** před každým pushem.

---

## 10b. SKILL: Operace agenta na VM (agent_ops + ops-runner)

Agent umí dělat na VM: shell, git push, nasazení workeru, čtení souborů z repa a
skills. **Každá taková operace musí projít potvrzením uživatele.** Bez nového
veřejného portu – fronta žije v Supabase, VM si ji čte samo.

```
agent-orchestrator → INSERT agent_ops (status = pending_confirmation)
                      ↓ uživatel řekne ano
agent-confirm     → UPDATE status = approved     (jen pro vlastníka řádku)
                      ↓
ops-runner na VM  → bere VYHRADNĚ approved → running → done|failed + výstup
agent_action_log  → append-only audit
```

Nástroje v agentovi: `run_vm_command`, `check_op_status`, `push_git_branch`,
`deploy_worker`, `read_repo_file`, `read_skills`.

Nasazení runneru na VM (ručně, jednou):

```bash
sudo install -m 644 -o songcraft-renderer -g songcraft-renderer \
  ops-runner.mjs /opt/songcraft-studio/workers/ops-runner/ops-runner.mjs
sudo install -m 600 -o songcraft-renderer -g songcraft-renderer \
  ops-runner.env /opt/songcraft-studio/workers/ops-runner/ops-runner.env
sudo systemctl enable --now songcraft-ops
```

`ops-runner.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`,
`OPS_TIMEOUT_MS` (300000), `OPS_MAX_OUTPUT` (20000), `OPS_REPO_DIR`,
`OPS_SKILLS_DIR`, `OPS_HOME`.

Bezpečnost: bez `sudo`, neprivilegovaný účet `songcraft-renderer`, tvrdý timeout,
oříznutý výstup, `NoNewPrivileges`, `ProtectSystem=strict`, zakázané destruktivní
příkazy už v agentovi, potvrzení expikuje po 30 minutách.

**Supabase Postgres vrací JSON POLE, ne obálku `{ data: ... }`.** Při čtení přes
surový `fetch` je `const { data } = await fetch(...)` vždy `undefined`. A u `PATCH`
je default `Prefer: return=minimal`, tedy **204 bez těla** – bez
`return=representation` se update provede, ale klient nevidí výsledek a řádek
zůstane viset ve stavu `running`. Obě chyby se projeví jako „fronta je prázdná“.

---

## 11. SKILL: Pasti z reálné práce

| Past | Důsledek | Obejití |
|---|---|---|
| Změna v `supabase/functions/` | `tsc` ji nechytí, `deno check` ano | spusť `deno check` ručně |
| Ruční psaní URL s diakritikou v PostgREST | tichý prázdný výsledek | `--data-urlencode` |
| `?select=*` na `sc_albums` | 42703, sloupec je `name` | výběr sloupců explicitně |
| `set -a` ponechané přes další příkaz | rozbije cesty v argumentech | `set +a` hned po načtení |
| `is_primary`/`is_final` při nové verzi | přepíše existující primární/final verzi | `false`, flagy měnit záměrně |
| Velký soubor base64 přes `Input.insertText`/JSON | OOM na Androidu | `assetToArrayBuffer` (viz `lib/file-base64.ts`) |
| Loop z 5s klipu bez crossfade | viditelný střih každých 5 s | crossfade loop (skill 5) |
| Center-crop 9:16 na širokém obalu | roztrhaný název skladby | rozmazané pozadí |
| Věřit, že „APK release existuje“ = „funkcionuje“ | `Build Android APK` běží paralelně k CI | zkontrolovat `SongCraft CI` i `Deploy agent orchestrator` |
| Tlačit `main` s červeným CI | rozbije build uživatelům s 2.9.4 | nejdřív opravit B1–B4 |
| `ffprobe -of default=nw=1:nk=1` | zahodí názvy polí, validace `width=` padne vždy | `default=nw=1` |
| Filtr `reverse` na dlouhém úseku | bufferuje celý úsek, OOM na 954 MB VM | půlcyklus A max 1.5 s |
| Počet průchodů úměrný délce skladby | 6:18 song = 47 průchodů, hodiny kódování | 6–16 průchodů, delší úseky |
| Mazat pracovní adresář při retry | OOM restart od prvního průchodu | adresář ponechat, `plan.sha` |
| `agent_ops` vložen bez `command` | CHECK `agent_ops_command_present` to odmítne | `command` pro `shell` |
| Hledat GitHub token jen v `~/` | je v `Secret/PRISTUPOVE-ÚDAJE.md` | `grep -rE "ghp_[A-Za-z0-9]{30,}"` |
| Přepsat celý `_layout.tsx` z jiného repa | `href: null` schoval tab Alba, uživatel přišel o sekci | diffovat routovací soubor, ne jen obrazovku |
| `supabase.functions.invoke()` | posílá POST, funkce s `if (method !== "GET")` vrátí 405 | povolit GET+POST nebo poslat `{ method: "GET" }` |
| Číst `error.message` z `functions.invoke` | vždy `non-2xx status code`, příčina skrytá | číst `error.context` jako `Response`, jen jednou |
| Chybějící účet v `SONGCRAFT_ALLOWED_USER_IDS` | všechny Edge Function vracejí 403, UI vypadá jako „vadná funkce" | allowlist je fail-closed, ale musí se promítnout do UI |
| Nová Edge Function jen v repu | workflow má ruční seznam, funkce se nenasadí (404) | doplnit `supabase functions deploy` + test |
| Důvěřit `ffprobe -of default=nw=1:nk=1` | zahazuje názvy polí, validace `width=` selhá vždy | `default=nw=1` |
| Dát dva APK vedle sebe a „jsou podobně velké" | rozdílný podpisový klíč = Android odmítne instalovat | porovnat podpisové bloky, ne velikost |
| Předpokládat, že `error` ve volání selhal | Supabase vrací 204 s prázdným tělem | `json.loads("")` vyhodí výjimku, je-li t t prázdné |
| **Editovat soubor migrace po aplikaci** | oprava se nikdy nespustí, v živé DB zůstane stará verze | vždy nový migrační soubor |
| Věřit, že repo ukazuje pravdu o DB | `sc_*` tabulky a `storage.objects` policy v repu ≠ produkce | živý test: testovací účet + skutečný JWT |
| `flask`/`android mount` na `/storage/emulated` občas vrací "No such file" | grep tokenu selže, 401 z GitHubu | přečíst token jednou do `/tmp` a používat odtud |

### Jak ověřit, že nahrávání fakticky funguje

Kód v repu může být správný a přesto nahrávání nefunguje, protože chyba je v databázi.
Postup, který to odhalil 29. 9. 2026:

```bash
# 1) založit testovací účet a vzít skutečný JWT (service role)
POST {SUPABASE_URL}/auth/v1/admin/users            {"email":…,"password":…,"email_confirm":true}
POST {SUPABASE_URL}/auth/v1/token?grant_type=password

# 2) poslat minimální JPEG přes uživatelský token, ne přes service role
POST {SUPABASE_URL}/storage/v1/object/songcraft/{uid}/covers/test.jpg   (JWT v Authorization)

# 3) uklidit: smazat objekty s prefixem, pak smazat účet (kaskáda smaže i data)
```

`service_role` tuto chybu neodhalí – trigger `songcraft_storage_object_guard` má pro
`service_role` early return a bypassuje se. Test musí jít přes JWT uživatele.

---

## 11b. SKILL: Jedno repo, updater a podepisování APK

Repo je **jedno**, větev je `main` a updater hledá tagy `app-vX.Y.Z`:

| Repo | Větev | Tagy release | K čemu |
|---|---|---|---|
| `InsaneBadPC/SCS2` | `main` | `app-vX.Y.Z` | zdroj pravdy, CI, nasazování funkcí a migrací, a zároveň **repo, ze kterého updater v aplikaci tahá release** |

`lib/app-update.ts` má `const REPO = "..."` zadrátovaný. Aplikace si pak hledá
`app-v*` na tomhle repu. Pushnutí do `songcraft-studio` tedy samotný nestačí,
úživatel aktualizaci neuvidí.

**Postup pro opravu, kterou má dostat i uživatel:**
1. změna v `songcraft-studio` (main), commit i push
2. zkontrolovat CI a `Deploy agent orchestrator`
3. zkopírovat soubory do `songcraft-studio-temney-agent`, vrátit tam
   `REPO` na temney-agent a verzi zvednout o 1 (3.0.6 → 3.0.7)
4. pushnout a `gh workflow run build-apk.yml -f force_version=X.Y.Z`

### POZOR 1. 10. 2026: main TAKY dělá releasy, a to je past

`build-apk.yml` v `main` má trigger na `push` do `main` a opravdu publishuje
release. **Uživatel ho ale neuvidí**, protože jeho APK je postavené z
temney-agent a ptá se tam. 1. 10. takto vznikly na main tagy `app-v3.0.8`,
`app-v3.0.9` a `app-v3.0.10`, o kterých uživatel **neví a nikdy je nedostane**.
Jeho aplikace hlásí „žádná novější verze", protože temney-agent skončil na 3.0.7.

**Poučení:** push do `main` sám o sobě aktualizaci uživateli neudělá. Vždy se
kontroluje, **kam se aplikace ptá** – to je `REPO` v `lib/app-update.ts` repu,
ze kterého byla APK sestavena, ne to, kde zrovna visí nejvyšší tag.
Pushnutí do main bez kroku 3 výše je v podstatě zbytečná práce.

### Ověření podpisu

APK je podepsané schématem **v2/v3**, takže **nemá** `META-INF/*.RSA` –
`unzip -p app-release.apk META-INF/*.RSA` vrátí prázdné a `keytool -printcert`
taky ne. `apksigner` z Android SDK zde není, ale **nejde o překážku**: podpisový
blok jde rozebrat ručně a jeho struktura je jednoznačná.

Blok leží těsně před centrálním adresářem ZIPu a vypadá takto
(`--` = 8 bajtů `size_of_block`):

```
[S][ID-value páry …][S]["APK Sig Block 42"]   ← 16 B magika, končí na cd_offset-1
```

`cd_offset` je z EOCD, takže **offset bloku se neukládá, ale odvodí**:

```python
magic_at = cd_offset - 16            # musí být b"APK Sig Block 42"
size     = u64le(magic_at - 8)       # druhé pole [S] — 16376 u app-v3.0.8
start    = cd_offset - size - 8      # pozice prvního [S]
```

Páry se čtou od `start + 8`: `u64` délka, `u32` ID, hodnota. Schéma v2 je
`0x7109871a`, v3 `0xf05368c0`. Hodnota v2 bloku je posloupnost signerů
(délkově předepsané), z nichž 3. člen je posloupnost **certifikátů** — každý
`u32` délka + DER. Ten DER ulož do `.der` a spusť `keytool -printcert -file cert.der`.

Pak porovnávej **SHA-256 DER certifikátu**, ne délku bloku:

```
app-v3.0.8  SHA256(DER) = fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
                        CN=Android Debug, OU=Android, O=Unknown, …  (debug klíč runnera)
```

Stejný klíč ⇒ **stejný SHA-256**. To je jediná spolehlivá kontrola; odhad
„dlouhý/krátký úsek" dole je jen vodítka.

### Podepisování
- `build-apk.yml` **musí** volat `scripts/configure-android-signing.mjs` a
  workflow musí mít `CI_KEYSTORE_PASS` a `CI_KEY_ALIAS` (= `songcraft`, **ne**
  `CI_KEYSTORE_ALIAS` — tohle jméno nikdo nečte).
  Base64 klíče jde pod **`CI_KEYSTORE` i `CI_KEYSTORE_B64`**: workflow má
  `secrets.CI_KEYSTORE_B64 || secrets.CI_KEYSTORE`, takže v UI GitHubu je
  správný oba. **Patrně nastav jen jeden z nich** — když jsou oba a hodnoty se
  po normalizaci bílých znaků liší, skript fail-closed spadne a release build
  nevyjde vůbec.
  Bez toho jde ven APK podepsané debug klíčem runnera, který se mezi buildu mění
  a **aktualizaci nelze nainstalovat**.
- Starší buildy v temney-agent podepisovací krok neměly. Jejich klíč neexistuje,
  takže přechod 3.0.1 → 3.0.2 vyžaduje **odinstalovat** a instalovat ručně.
  Totéž platí pro `app-v3.0.8` (5. 10. 2026 potvrzeno: je podepsané `CN=Android Debug`).
  Nový release klíč byl vygenerován 5. 10. 2026 a uložen mimo repozitář;
  **první APK s ním je jediný, který musí uživatel nainstalovat ručně.**
- `versionCode` = `major*10000 + minor*100 + patch`. 3.0.1 = 30001, 3.0.7 = 30007.
  Android odmítne aktualizaci, pokud je versionCode menší nebo stejný.
- Ověření, že dva APK mají stejný klíč: porovnat podpisové bloky. V APK je
  „APK Sig Block 42“ před centrálním adresářem; shodný certifikát dá dlouhý
  shodný úsek (u našho klíče 1460 bajtů). Různý klíč dá jen ~520 bajtů.

---

## 11c. SKILL: OAuth na YouTube, jak ho rozchodit bez konzole

Google klíč `77741409309-…` v projektu `opencode-506810` je typu **Desktop app**
a má zaregistrované **jen `http://localhost`**. Adresa
`https://…supabase.co/functions/v1/youtube-oauth-callback` u Google evidovaná
není, takže jakýkoli odkaz s ní skončí `redirect_uri_mismatch` — a to
**neopraví kódem**.

Dvě cesty:

**A) Zprovoznit tlačítko v aplikaci** – v Google Cloud Console u klíče přidat tu
Supabase adresu do *Authorized redirect URIs*, nebo vytvořit klíč typu
**Web application**. Bez zásahu do konzole to nejde.

**B) Připojit kanál bez konzole** (použito 29. 9. 2026, fungovalo):
`http://localhost` je registrovaný, takže stačí na telefonu poslouchat port 80,
Google přesměruje na něj a kód se vymění za tokeny s PKCE verifierem uloženým
v `youtube_oauth_states`. Termux umí port 80 (běží jako root v kontejneru) a
`termux-open-url` otevře Google ve formuláři na telefonu.

**OAuth consent screen v režimu Testing zabíjí refresh token po 7 dnech.**
Google vrací `invalid_grant / Token has been expired or revoked`. Není to chyba
našeho kódu. Řešení: přepnout na Production, nebo (prakticky) prostřednictvím
kroku B připojit znovu, když token umře.

---

## 11d. SKILL: Supabase Edge Function v aplikaci — tři pasti

1. **`supabase.functions.invoke()` posílá POST**, i když funkce nic nepřijímá.
   Funkce, která povoluje jen GET, odpoví `405 Použijte GET`. Aplikace to vyloží
   jako „nepodařilo se ověřit“. Buď povolit obě metody, nebo poslat
   `{ method: "GET" }`.
2. **`error.message` je vždy `Edge Function returned a non-2xx status code`.**
   Skutečný stav a tělo jsou v `error.context` jako `Response` a jdou přečíst
   **jen jednou**. Bez toho se hádí.
3. **`SONGCRAFT_ALLOWED_USER_IDS` / `_EMAILS` gate-ují VŠECHNY funkce.**
   Když v nich chybí uživatel, všechny Edge Function odmítají s 403 a aplikace
   vypadá, že daná funkce neexistuje. Fail-closed je správně, ale musí se
   vysvětlit v UI jinak — jinak se to projeví jako „nic se nezmenilo“.

Navíc: **seznam nasazovaných funkcí je ručně v `.github/workflows/
deploy-agent-orchestrator.yml`.** Nová funkce, která tam není, se nenasadí vůbec
(`agent` ji nemůže volat, funkce vrátí 404). Po přidání funkce vždy doplnit
řádek `supabase functions deploy` a mít na to test.

---

## 11e. SKILL: Loop engine na VM s 954 MB RAM

6:18 song padal na OOM po 2,5 hodinách. Příčiny byly tři a všechny se projevily
jediným hlášením „render běží“:

1. **`reverse` v palindromu bufferuje celý půlcyklus.** Pro 15 s úsek je to
   360 snímků 720p ≈ 500 MB. Půlcyklus A je omezený na `A_MAX_HALF` (1,5 s).
2. **Počet průchodů rostl lineárně s délkou skladby** (47 průchodů). Počítá se
   z délky: 6–16 průchodů, delší úseky místo množství.
3. **Worker při retry mazal celý pracovní adresář** a engine ho navíc čistil na
   startu, takže každý OOM začínal od prvního průchodu. Teď se adresář ponechává
   a engine si z něj bere vykódované průchody, pokud sedí otisk plánu v `plan.sha`.

Když se něco opravuje v enginu, je nutné **nechat ho doběhnout na dlouhé skladbě**,
ne jen na krátkém testu — kontrola výstupu (`ffprobe`) byla celou dobu vadná
(`-of default=nw=1:nk=1` zahazuje názvy polí, takže hledání `width=` selhalo vždy)
a nikdo to neviděl, protože se render nikdy nedostal za to místo.

---

## 11f. SKILL: Kopírování kódu mezi repa

Při přenosu souborů mezi repa (sloučení, backport) **zkontrolovat i routovací
soubory, ne jen obrazovky**. Přepsání `app/(tabs)/_layout.tsx` celého souboru
přineslo `href: null`, které **schovalo tab Alba** — uživatel přišel o celou
sekci, přitom `albums.tsx` byl bitově stejný a v Repu se nemažlo nic.

Proto:
- `git diff <starý-sha> HEAD -- app/` a projít, ne jen soubory, na které je
  kód přímo
- hledat `href: null`, skryté routes a přejmenované položky v layoutu
- `lib/app-update.ts` a `app.config.ts` jsou dvě věci, které se při přenosu
  záměrně **nechávají** z cílového repa

---

## 11g. SKILL: `node_modules` na SD kartě (Termux) + dvě kopie repa

### Proč bind mount

SD karta (`/mnt/sdcard`, FAT/exFAT) **neumí symlinky**. `pnpm` je potřebuje
pro `node_modules/.bin`, takže běžné `pnpm install` končí:

```
EACCES: permission denied, symlink '../semver/bin/semver.js' -> '.../node_modules/.bin/semver'
```

Řešení: `node_modules` je **adresář na vnitřním úložišti** a do repa se
namapuje. `.npmrc` už obsahuje `node-linker=hoisted`, to samo nestačí.

```bash
REPO=/mnt/sdcard/InsaneCode/songcraft-studio   # nebo ~/work/songcraft-studio
mkdir -p "$REPO/node_modules" /data/data/com.termux/files/home/snm
mount --bind /data/data/com.termux/files/home/snm "$REPO/node_modules"
cd "$REPO" && pnpm install --frozen-lockfile
```

**Po restartu Termuxu mount zmizí a `node_modules` bude vypadat prázdná.**
`pnpm check` / `pnpm test` pak selžou „command not found“. Řešení je bind mount
zopakovat – nic jiného se reinstalovat nemusí.

Kontrola, že mount sedí:
```bash
mount | grep -c songcraft        # ma vypsat 1
ls "$REPO/node_modules/.bin" | wc -l   # desítky, ne 0
```

`du -sh node_modules` přes bind mount vrací nesmyslné číslo – měřit
`du -sh /data/data/com.termux/files/home/snm`.

### Web export potřebuje `CI=true`

`CI=true npx expo export --platform web`

Bez `CI=true` se NativeWind CSS zapisuje na disk a Metro pro ten soubor neumí
spočítat SHA-1 → `Failed to get the SHA-1 for .../web.css`. V `metro.config.js`
je to už ošetřené (`forceWriteFileSystem: !isCI`), takže řešení je prostě
proměnnou prostředí. GitHub Actions ji nastavuje sám.

### POZOR: dvě kopie repa s různou historií

| Kopie | Stav |
|---|---|
| `~/work/songcraft-studio` | **pracovní kopie** – má opravu importu, právní stránky, vrácený tab Alba |
| `/mnt/sdcard/InsaneCode/songcraft-studio` | jiná linie historie, ne potomek té první |

Obě míří na stejný GitHub remote, ale **nemají společného předka** – `git log`
jedné nezná commity druhé a `git apply -3` nemá co porovnat. Kopie na SD kartě
dlouho držela jen necommitnuté změny a působila jako ta správná.

**Než začneš psát kód, ověř, kde ses:**

```bash
git -C ~/work/songcraft-studio log --oneline -3
git -C /mnt/sdcard/InsaneCode/songcraft-studio log --oneline -3
git -C <jedna> status --short | wc -l
```

Práce na SD kartě pak musí do pracovní kopie přejít ručně po souborach. A tady
platí **11f**: při tomhle přenosu hledat `href: null` a další záměrně vrácené
věci, protože kopie na SD kartě schovaný tab Alba pořád má.

---

## 12. Kde jsou staré sessions a co z nich plyne

`~/.local/share/opencode/opencode.db` (39 MB, SQLite). Tabulky `session_v2` (8 sessions)
a `session_message` (2431 zpráv). Hlavní session: **„Nastudování projektu Songcraft Studio“**
(`ses_f27964f5fffe8g4E2j7Rge7ic7`) + 6 subagentů. Použitelné dotazy:

```sql
select id, title, agent, time_updated from session_v2 order by time_updated desc;
select data from session_message where session_id='<id>' and type='user';
```

Otevřené body, které z nich vyplynuly a které v `todo-dee7naux.md` ještě nejsou hotové:

- [ ] ověřit web export a sestavit APK z izolované větve
- [ ] předat odkaz na APK
- nahrát obrázek 16:9 + MP4→loop (viz B1–B3)
- animace obrazu podle promptu – **u každé fotky něco jiného, žádné blesky, žádný dým,
  žádné ruské kolo** (doslovné zadání v session `seq 15258`)

---

## 13. Ověřovací checklist pro „hotovo“

```bash
cd /data/data/com.termux/files/home/work/songcraft-studio
node scripts/security-boundary-check.mjs          # OK
node scripts/production-smoke-check.mjs          # OK
npx tsc --noEmit                                 # 0 chyb
npx vitest run                                   # 66 passed
find supabase/functions -mindepth 2 -maxdepth 2 -name index.ts -print0 \
  | xargs -0 -n1 deno check --config supabase/functions/deno.json \
      --node-modules-dir=auto --no-lock          # bez chyb
```

A navíc, ručně, protože to neautomatizuje nic:

- [ ] na GitHubu `SongCraft CI` = success **na tom commitu, který pushuješ**
- [ ] `Deploy agent orchestrator` = success (jinak funkce běží stará)
- [ ] `main` není 30 commitů pozadu
- [ ] release tag míří na commit, z kterého je opravdu sestavené APK
- [ ] nic veřejného neuniklo (release assets, bucket policy)
- [ ] YouTube zveřejnění má **výslovné schválení uživatele**
