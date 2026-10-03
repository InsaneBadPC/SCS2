# Inventář bezplatných kapacit a automatizovatelných schopností

Stav k 26. 9. 2026. Každý řádek je ověřený rešerší nebo živým testem. Značky:
`MÁME` = účet existuje a máme k němu přístup · `TESTOVÁNO` = ověřeno spuštěním ·
`BLOKUJE` = technicky nedosažitelné · `REGRESE` = chybí registrace (uživatel).

---

## 1. Shrnutí — co je reálně zdarma a automatizovatelné

| # | Zdroj | Co dostaneme | Automatizace | Stav |
|---|---|---|---|---|
| 1 | **Google Colab CLI** | T4 16 GB / L4 24 GB / G4, GPU i TPU, **oficiální CLI od 5. 6. 2026** | plná, headless, bez prohlížeče | **MÁME CLI, chybí 1 přihlášení** |
| 2 | **Kaggle Notebooks** | 30 h/týden T4/P100 (někdy 2×T4) | plná přes REST API | **MÁME, render potvrzen, doprava rozbitá** |
| 3 | **HF ZeroGPU** | 2 účty = 2 kvóty, ~2 min GPU/den/účet | plná přes API | **MÁME, dnes vyčerpáno** |
| 4 | Oracle Cloud `Insane420` | 4 OCPU/24 GB ARM **bez GPU** | — | **BLOKUJE** (ověřeno 26. 9.) |
| 5 | ModelScope API | 2000 volání/den, Wan 2.1/2.2 I2V | plná přes REST | REGRESE |
| 6 | Tensor.Art API | 300 kreditů + 100/den, Wan video i free | oficiální TAMS API | REGRESE |
| 7 | SeaArt | 50–100 kreditů/den, I2V, free ComfyUI | API (placené plány) | REGRESE |
| 8 | fal.ai / Replicate | $10 / $5 startovní kredit | plná | REGRESE |
| 9 | Modal | **$30/měsíc** trvale | plná | REGRESE |
| 10 | RunPod / Vast.ai | $5–10 startovních kreditů | plná | REGRESE |
| 11 | Lightning AI | ~80 free GPU hodin | plná | REGRESE |
| 12 | Web studia (Kling, Vidu, Hailuo, PixVerse, Seedance, Pika, Luma, Firefly, Flow/Veo) | denní/měsíční kredity | **jen ručně v prohlížeči** | ruční |

---

## 2. Kategorie A — skutečné GPU, plně automatizovatelné

### 2.1 Google Colab CLI — NEJLEPŠÍ NALEZ
Google 5. 6. 2026 vydal oficiální `google-colab-cli` (Apache 2.0), který dává free tier Colabu
headless rozhraní pro agenty. Nainstalováno na Oracle VM (`/home/ubuntu/.local/bin/colab`).

```bash
colab new --gpu T4              # vytvoří session
colab exec -f render.py         # pošle skript na GPU
colab download /out/clip.mp4    # stáhne výstup
colab install -r requirements   # balíčky přes uv
colab log                       # historie
```
Dostupné akcelerátory: `T4, L4, G4, H100, A100` + TPU `v5e1, v6e1`.
Dodatečně (březen 2026) existuje **Colab MCP Server** pro přímé řízení notebooků agentem.
Balíček obsahuje i `COLAB_SKILL.md` — hotová instrukce pro agenty.

- **Free tier:** T4 (16 GB), občas L4 (24 GB). A100/H100 = Colab Pro.
- **Jediný manuální krok:** jednorázové přihlášení Google účtem (OAuth InstalledAppFlow).
  CLI vygeneruje URL → otevřít v prohlížeči na telefonu → vložit auth kód.
- **Omezení:** session umí být odpojená; plánujeme proto dlouhé dávky (batch) uvnitř jedné session,
  ne „jeden klip = jedna session“.

### 2.2 Kaggle Notebooks — 30 h/týden
- Účet `petrinsane`, kernel `petrinsane/sc-chunk`, SVD na GPU běží (potvrzeno logem).
- **Problém:** doprava klipu ven z běhu. `kaggle kernels output` vrací jen log; REST varianta s
  `?fileName=` 404; `/kaggle/working` v k3 běhu neověřeno.
- **Vyřešení:** krátkodobá podepsaná upload URL do soukromého bucketu `songcraft` (viz 4.1).
  Autentizace přes `Authorization: Bearer <token>` funguje; blokuje už jen povolený MIME typ.

### 2.3 Hugging Face ZeroGPU — 2 účty
- `InsaneBadIT` + `Insanebad` = 2 nezávislé kvóty (~2 min GPU/den každá).
- Dnes vyčerpáno do ~23:00 (`exceeded your free ZeroGPU quota (180s requested vs 76s left)`).
- Správně selhává s `QuotaExhausted` — fail-closed, tichý fallback neexistuje.

### 2.4 Oracle Cloud — ověřeno, GPU není
Dotaz přes OCI SDK 2.187.0 na VM (26. 9. 2026, tenancy `Insane420`, region eu-frankfurt-1):
```
AUTENTIZACE OK
shapy: BM.Standard.A1.160, VM.Standard.A1.Flex, VM.Standard.A2.Flex, VM.Standard.E2.1.Micro
GPU shapy: ZADNE
instance: smartcam-server (E2.1.Micro, STOPPED), youtube-agent-vm (E2.1.Micro, RUNNING)
```
**Free tier = 4 ARM OCPU + 24 GB RAM, žádný GPU.** Nelze použít pro video modely.
Zůstává využitelný na CPU práci (ffmpeg, upscale, audio, Whisper) — to je i teď hlavní role VM.

---

## 3. Kategorie B — free API kredity (registrace, ~2 minuty, bez karty)

| Služba | Co zdarma | Kvalita I2V | Automatizace | Poznámka |
|---|---|---|---|---|
| **ModelScope** | **2000 API volání/den**, reset 00:00 UTC+8, bez karty | Wan 2.1/2.2 I2V, 3–5 s | REST API, `429` po vyčerpání | Nejlepší poměr free/automatizace vůbec |
| **Tensor.Art** | 300 kreditů při registraci + 100/den, bez karty | Wan 2.1/2.2 video i na free tieru | oficiální **TAMS API** (`tams.tensor.art`), workflow jobs, API „Create Video from First and Last Frame“ | kredity nenabíhají, fronta ve špičce 30+ min |
| **SeaArt** | 50–100 kreditů/den, free ComfyUI na jejich GPU | I2V | API | anime-focused, restrikce obsahu |
| **fal.ai** | $10 startovních kreditů | Kling 2.1, Wan 2.6, Veo Lite | plná REST | před platbou chce platební metodu |
| **Replicate** | $5 startovních kreditů | různé | plná REST | |
| **SiliconFlow** | ~$1 startovní kredit | **Wan2.2-I2V-A14B $0,29/klip** (celý klip, ne sekunda) | plná REST | i po vyčerpání kreditu: $1 ≈ 3 klipy |
| **Modal** | **$30/měsíc** trvale | cokoliv si zapíšeš | plná, per-second | T4 ~$0,59/h |
| **RunPod** | $5–10 startovních kreditů | RTX 4090 $0,34/h | plná | ~30 GPU hodin z $10 |
| **Lightning AI** | ~80 free GPU hodin | cokoliv | plná | 1 free Studio |
| **SambaNova / Cerebras** | free inference tier | jen text, **ne video** | — | nevyužitelné pro I2V |

---

## 4. Kategorie C — denní kredity, ale JEN ručně v prohlížeči

Nejde je automatizovat, ale dávají bezplatné klipy pro výběr scén a náhledy.

| Nástroj | Free tier | Délka/rozlišení | Vodoznak | Komerční užití |
|---|---|---|---|---|
| Kling | **66 kreditů/den** (reset denně, nerozpadá) | ~5 s, 720p | ano | free tier ne |
| Vidu | 66 kreditů/den | až 10 s, 720p | ano | free tier ne |
| PixVerse | 60 kreditů/den | 5–8 s, 540–720p | ano | jen placené plány |
| Hailuo (MiniMax) | 3–5 generací/den | ~6 s | ano | dle podmínek |
| Seedance (Dreamina/CapCut) | 10 generací/den | až 10 s, 1080p | ne | ano |
| Google Veo ve Flow / AI Studiu | malý denní fond | ~8 s, 720p | ano | dle podmínek |
| Pika | 80 kreditů/měsíc | 5 s, 480p | ano | ano |
| Luma Dream Machine | 30 kreditů/měsíc | 5 s, 720p | — | — |
| Runway | 125 jednorázových | ~5 s | — | omezené |
| Adobe Firefly | denní generace zdarma | 5 s | ano | jen placené |
| InVideo AI | 10 min/týden | — | ano | — |
| **LMArena** | video frontier modelů **zdarma výběrem v „blind battles“** | různé | — | — |
| ZSky AI (nové) | tvrdí „unlimited free forever“, 1080p video se zvukem | 1080p | ano (wordmark) | tvrdí ano; důvěřovat opatrně |

**Minimax API klíč (který máme) nefunguje:** `status_code 1004 login fail: Please carry the API secret
key in the 'Authorization' field` na všech 4 kombinacích host/endpoint. Klíč má 43 znaků a začíná
`MINI` — není to platný API secret pro open platform. Nutná ruční kontrola v konzoli Minimax.

---

## 5. Kategorie D — co free NENÍ (abychom to už nehledali znovu)

- **Google Veo 3.1 API — žádný free tier.** Gemini text je free, ale video se fakturuje od první
  sekundy. To je důvod, proč `GOOGLE_AI_STUDIO_KEY` nepomůže.
- **Sora API se vypíná 24. 9. 2026** — neplánovat.
- fal/Replicate/Runway mají jen startovní jednorázové kredity.
- HuggingFace Inference Providers: free jen na textových modelech.

---

## 6. Kvalitní žebřík a co se vejde na jednotlivé GPU

| Model | VRAM | Kvalita I2V | Vejde se na |
|---|---|---|---|
| SVD-XT | 10–16 GB | slabá, 25 snímků, bez promptu | T4, Kaggle T4 |
| CogVideoX-2B | 16 GB | slabá až střední | T4 |
| **Wan2.2 TI2V-5B (GGUF Q4)** | **8 GB** + offload | dobrá na 4–8 s | T4 (pomalu), L4 (plynule) |
| **Wan2.2 TI2V-5B BF16** | 24 GB | dobrá, 720p | **L4**, A100 |
| Wan2.2 A14B MoE | 48 GB (480p) / 80 GB (720p) | výrazně lepší pohyb, stabilní postava | A100/H100 (komerční) |
| HunyuanVideo 1.5 | 24 GB FP8+offload / 80 GB | nejlepší koherence | L4 s offload, A100 |
| LTX-2.3 distilled | 32 GB (FP8) | 4K, nativní zvuk | A100 |

**Důsledek pro nás:** veškerý free GPU (T4 = 16 GB) zvládne **jen 5B model kvantizovaný** nebo SVD.
Proto je na free tierch kritická **dávkovost** (batch v jedné session) a **post-processing**:
upscale (Real-ESRGAN na CPU VM), prolnutí snímků, křížové přechody, grading.
Placeny A100 (~1,1–1,4 $/h) by byl až 2–4 $ na celé video, ale už je to mimo rozpočet.

---

## 7. Co z toho plyne pro architekturu

Aby agent uměl realizovat cokoliv, potřebuje **jednu bránu**, ne N pevných cest:

```
uživatel → agent-orchestrator (Edge Function)
              ↓ nástroj dispatch_capability(intent, spec)
          capability broker (validace, kvóty, odhad)
              ↓
          provider router na VM (výběr backendu podle kvóty/rychlosti/kvality)
              ├── local ffmpeg / Python (CPU, vždy zdarma)   ← Oracle VM
              ├── colab_cli    (T4/L4)  → nově
              ├── kaggle       (T4/P100) → po opravě dopravy
              ├── hf_zerogpu ×2 (2 min/den/účet)
              ├── modelscope / tensorart / siliconflow / modal  → po registraci
              └── ruční fronta (Kling/Vidu/…) — agent připraví prompt a vstupy pro člověka
```
Agent navíc dostane `sandbox_python` a `sandbox_ffmpeg` — deklarativní recipe (JSON/YAML),
který běží v omezeném sandboxu na VM. Tím „jakýmkoliv způsobem“ platí i pro operace,
na které nemáme předepsaný backend.

**Fail-closed zůstává:** žádný tichý fallback na slideshow/placeholder. Když žádný free backend
nesplní `MIN_MOTION` a QC, render skončí chybou a agent to řekne uživateli.

---

## 8. Akční plán

| Kdo | Akce | Odblokuje |
|---|---|---|
| **Uživatel** | Otevřít v telefonu OAuth URL z `colab new --gpu T4` a vložit auth kód | T4/L4 GPU, ~30 h/týden, plná automatizace |
| Já | Opravit transport z Kaggle (MIME + podepsaná URL), potom batch N klipů v jednom běhu | 30 h/týden GPU navíc |
| Já | Provider router + capability broker + recipe runner | agent umí cokoliv |
| Uživatel (2 min) | Registrace ModelScope + Tensor.Art | 2000 volání/den a 100 kreditů/den přes API |
| Uživatel | Rozhodnout o Colab Pro / Modal ($30) | A100 kvalita |
