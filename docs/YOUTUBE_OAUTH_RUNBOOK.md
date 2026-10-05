# YouTube OAuth — manuální kroky, které udělá jen majitel

SCS2 má všechno připravené. **Jediné, co chybí, je Google Cloud OAuth klient** —
ten se nedá vytvořit přes API a musí ho založit člověk v konzoli. Tenhle dokument
popisuje jen ty ruční kroky, nic jiného.

Když je hotovo, `youtube-oauth-start` přestane vracet 503 a aplikace v
**Nastavení → YouTube kanál → Připojit YouTube OAuth** (nebo přímo na
obrazovce **YouTube export**) otevře přihlášení Google a po návratu připojí kanál.

Všechny hodnoty níže jsou z kódu, ne odhad. Když něco nesouhlasí, je chyba tady.

---

## 1. Co kód skutečně žádá

| Věc | Hodnota | Kde je v kódu |
|---|---|---|
| Typ klienta | **Web application** (Webová aplikace) | vyžaduje to `YOUTUBE_REDIRECT_URI` s `https://` |
| Authorization endpoint | `https://accounts.google.com/o/oauth2/v2/auth` | `supabase/functions/youtube-oauth-start/index.ts:58-69` |
| Token endpoint | `https://oauth2.googleapis.com/token` | `supabase/functions/youtube-oauth-callback/index.ts:65` |
| PKCE | `S256`, verifier 48 B, challenge = base64url(SHA-256(verifier)) | `youtube-oauth-start/index.ts:50-53` |
| `state` | 32 B náhodných, v DB jen SHA-256, `expires_at` +10 min, `consumed_at` proti replayi | `youtube-oauth-start/index.ts:50-55`, `youtube-oauth-callback/index.ts:55-62` |
| `access_type` / `prompt` | `offline` / `consent` — kvůli refresh tokenu | `youtube-oauth-start/index.ts:62-63` |

### Scopes — přesně ty tři, nic víc

```
https://www.googleapis.com/auth/youtube.upload
https://www.googleapis.com/auth/youtube.force-ssl
https://www.googleapis.com/auth/yt-analytics.readonly
```

- `youtube.upload` — `videos.insert` při publikaci (`youtube-publish`)
- `youtube.force-ssl` — čtení kanálu a metadat; `channels?mine=true` v callbacku
  (`youtube-oauth-callback/index.ts:74`) i titul kanálu v UI (`youtube-status`)
- `yt-analytics.readonly` — statistics v `youtube-sync-stats/index.ts:105`

> Kdybys chtěl scope změnit, musí se změnit **jedno místo**: `scope` na řádku 64
> `youtube-oauth-start/index.ts`. Appka scope neposílá — server ho posílá za ni.

---

## 2. Google Cloud — co zaklikat

1. <https://console.cloud.google.com/apis/credentials> → vyber nebo založ **projekt**.
   (Projekt může být nový; nemusí to být ten, ke kterému patří starý klient.)
2. **APIs & Services → Library** → zapni **YouTube Data API v3**.
   Bez ní spadne `channels?mine=true` a aplikace skončí na `channel_lookup_failed`.
3. **OAuth consent screen** — nastav název aplikace, kontaktní e-mail, e-mail
   vývojáře. Dokud obrazovka není v režimu *Production*, musíš ten Google účet,
   který vlastní kanál, přidat jako **Test user**.
4. **Credentials → Create Credentials → OAuth client ID → Application type:
   Web application.**

> **Ne** „Desktop app“. Desktop klient přijímá jen loopback redirect
> (`http://localhost`), ne `https://…supabase.co/…`. Špatný typ = `redirect_uri_mismatch`
> a nikdo to kódem neopraví.

### Redirect URI — zkopíruj ZNAK PO ZNAKU

Do pole **Authorized redirect URIs** patří přesně jedna adresa:

```
https://gpgbgjxeybfncrexrpbr.supabase.co/functions/v1/youtube-oauth-callback
```

Trefit ji nemusíš — je to `SUPABASE_URL` z `lib/supabase.ts` plus pevná cesta.
Aplikace si ji ukazuje i v Nastavení, když je kanál nepřipojený
(`app/(tabs)/settings.tsx`), takže si ji můžeš zkontrolovat přímo v aplikaci.

Google porovnává `redirect_uri` **znak po znaku** (a včetně koncového `/`).
Proto:

- **žádný koncový lomítko navíc**,
- **žádný `localhost`**, pokud jsi použil desktop klienta,
- stejná hodnota musí být i v Supabase secretu `YOUTUBE_REDIRECT_URI` (krok 3).

---

## 3. Tři hodnoty do Supabase

Supabase Dashboard → **Project Settings → Edge Functions → Secrets** →
**Add new secret**. Totéž umí příkaz. Hodnoty si připrav v prostředí — klíč
nikdy nepiš do repa a nechci ho v shell history:

```bash
export YOUTUBE_CLIENT_ID='…'       # Credentials → tvůj klient (…apps.googleusercontent.com)
export YOUTUBE_CLIENT_SECRET='…'   # Credentials → tvůj klient

supabase secrets set --project-ref gpgbgjxeybfncrexrpbr \
  YOUTUBE_CLIENT_ID=$YOUTUBE_CLIENT_ID \
  YOUTUBE_CLIENT_SECRET=$YOUTUBE_CLIENT_SECRET \
  YOUTUBE_REDIRECT_URI=https://gpgbgjxeybfncrexrpbr.supabase.co/functions/v1/youtube-oauth-callback
```

Klíč, který by utekl do historie shellu, v Google Cloud smaz a založ nový.
Výsledek ověř krokem níže — `supabase secrets list` hodnoty nevypisuje.

| Secret | Co je to |
|---|---|
| `YOUTUBE_CLIENT_ID` | `…apps.googleusercontent.com` z Credentials |
| `YOUTUBE_CLIENT_SECRET` | z kliknutí na klienta, **tajemství** — nikdy do repa, nikdy do APK |
| `YOUTUBE_REDIRECT_URI` | přesně ta adresa výše |

Tyhle tři názvy patří i jako GitHub repo Secrets. `.github/workflows/deploy-agent-orchestrator.yml`
je u každého obalený `if [ -n … ]`, takže prázdný GitHub secret hodnotu na Supabase
neruší — jen vypíše „profil youtube zůstává odložen“. Kdybys je tam nenastavil,
`youtube-oauth-start` by po deployi dál vracel 503 a nebylo by to poznat z kódu.
Kontrola bez vypisování hodnot:

```bash
node scripts/verify-edge-secrets.mjs --profile youtube
```

`SONGCRAFT_APP_REDIRECT_URL` nastavovat nemusíš. Bez něj funguje výchozí
`songcraftstudio://settings`, což je existující routa v `app/(tabs)/settings.tsx`.
Nastavuj ho jen pokud chceš jiný cíl — a pak **stejnou hodnotu** i jako
`EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL` v buildu APK (`lib/youtube-oauth.ts`),
jinak `openAuthSessionAsync` návrat neshoduje.

---

## 4. Kam se aplikace vrátí

```
Google → youtube-oauth-callback (GET, verify_jwt = false)
       → 302 na songcraftstudio://settings?youtube=connected
         nebo songcraftstudio://settings?youtube=error&reason=<důvod>
```

`youtube` parametr čte `readYouTubeOauthReturn()` v `lib/youtube-oauth.ts` a
překládá `reason` na češtinu. `reason`, která můžou nastat, a co znamenají:

| `reason` | Význam |
|---|---|
| `denied` | v konzoli jsi klikl na „Zrušit“ |
| `google_error` | Google vrátil `error=` jiný než `access_denied` |
| `invalid_request` | Google poslal neúplnou odpověď |
| `not_configured` | chybí `YOUTUBE_CLIENT_ID` nebo `YOUTUBE_CLIENT_SECRET` na serveru |
| `invalid_state` | stav vypršel (10 min) nebo se neshodoval |
| `state_already_used` | replay — stav už jednou spotřebován |
| `account_not_allowed` | účet není v `SONGCRAFT_ALLOWED_EMAILS` / `_USER_IDS` |
| `token_exchange_failed` | Google odmítl kód vyměnit → typicky `redirect_uri_mismatch` |
| `channel_lookup_failed` | token platí, ale kanál se nepodařilo načíst |
| `credential_save_failed` | token se vyměnil, ale neuložil |
| `oauth_failed` | přerušeno uprostřed |

### Jak poznat, že to fungovalo

```bash
# stav připojení (jen přihlášený uživatel; bez JWT vrátí 401)
curl -s -X POST \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  https://gpgbgjxeybfncrexrpbr.supabase.co/functions/v1/youtube-status
```

Úspěch = `{"connected":true, "channelId":"…","channelTitle":"…"}`.

A v Nastavení v aplikaci má být místo červeného „Připojit YouTube OAuth“
zelený pruh s názvem kanálu.

---

## 5. Když to nepůjde

| Symptom | Příčina |
|---|---|
| `redirect_uri_mismatch` u Google | jiný typ klienta (Desktop místo Web) nebo jinak opsaná adresa |
| 503 „Chybí na Supabase: YOUTUBE_CLIENT_ID“ | secrety nejsou nastavené, nebo je deploy přepsal prázdnými |
| `channel_lookup_failed` | YouTube Data API v3 není zapnuté na projektu |
| Token po ~týdnu `invalid_grant` | consent screen je v režimu *Testing* — refresh token má 7 dní. Přepnout na *Production*. |
| `account_not_allowed` | účet chybí v `SONGCRAFT_ALLOWED_EMAILS` |

**7 dní refresh tokenu v Testing režimu není bug kódu** — je to Google. Po přepnutí
na *Production* token vydrží.

---

## 6. Co kód dělat nebude

- **Nikdy nepublikuje bez tvého potvrzení.** `youtube-publish` vyžaduje nonce z
  `agent_confirmations`, a ten vznikne jen když v Asistentovi potvrdíš, co ti AI
  navrhla.
- **Tokeny neopouštějí server.** `youtube_credentials` má nulovou RLS policy pro
  klienta, takže se z aplikace nedají přečíst. Klient dostane jen
  `{connected, channelId, channelTitle}` z `youtube-status`.
- **Starý klient se nepoužívá.** Klient `77741409309-…` v projektu
  `opencode-506810` patří starému SCS1 projektu. SCS2 běží na Supabase projektu
  `gpgbgjxeybfncrexrpbr` a jeho redirect je jiný — starý klient nech plodit a
  nepoužívej ho.