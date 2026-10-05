# Video renderer

`worker.mjs` je jediný aktivní video worker pro `agent_videos` frontu. Pracuje na
libovolném stroji s Node.js 20+ a FFmpeg; GPU ani Oracle VM nejsou potřeba.

## Nároky

- Node.js 20 nebo novější,
- FFmpeg a FFprobe s `libx264` a AAC,
- zapisovatelný `WORK_DIR` a v něm volné místo (default minimum 2 GiB, `MIN_FREE_BYTES`),
- Supabase URL a service-role key pouze v root-only environment souboru.

## Větve

| větev | co potřebuje | stav |
|---|---|---|
| `static_cover` | pouze ffmpeg | **dostupná** |
| `video_loop` | pouze ffmpeg + `source_video_path` | **dostupná** |
| `source_loop` | pouze ffmpeg (`loop-engine.mjs`) | **dostupná**, náhrada dashboard větví |
| `image_animation` | ai-video-generator dashboard | fail-closed, není nasazený |
| `full_scenes` | ai-video-generator dashboard | fail-closed, není nasazený |

`image_animation` a `full_scenes` jedou přes ai-video-generator dashboard na
`127.0.0.1:8080`. Dashboard na tomto stroji neběží a nebyl nikdy nasazený, takže
obě větve jsou **odmítnuty hned** (`assertDashboardReady()`): kontrola běží před
stahováním audia a obalu, takže job nečeká na mrtvý port ani nepohlcuje stovky MB
před `ECONNREFUSED`. Použij `source_loop`, která dělá totéž čistým ffmpegem.

## Preflight

Worker při startu ověří ffmpeg, ffprobe, encodery `libx264`/`aac`, zapisovatelnost
`WORK_DIR` a volné místo. Při chybějící závislosti odejde s kódem `1` a vypíše,
co chybí, místo aby selhal až uprostřed renderu. Dřív to končilo na
`spawn ffmpeg ENOENT` u jednoho jobu, který pak zůstal viset ve stavu `rendering`.

Ověření bez spuštění fronty:

```sh
PREFLIGHT_ONLY=1 node worker.mjs   # exit 0 = všechno v pořádku, exit 1 = chybí závislost
```

## Nasazení

`workers/video-renderer/songcraft-renderer.service.example` je systemd unit.
Bez hostitele fronta nikam nesměřuje a `video-renderer-dispatch` fail-closed
odmítá s `503 renderer není nasazený`. Po rozchození hostitele nastav na edge
funkci `VIDEO_RENDERER_URL` na jeho adresu; dispatch pak volá `POST <url>/render`
s `{ "videoId": "..." }`.

## Chování fronty

- používá se pouze finální audio verze; preferuje se tagged copy,
- `job.audio_storage_path` má přednost, když job přináší vlastní výřez,
- výstup je soukromý Supabase Storage objekt s prefixem vlastníka,
- lease expirovaný job se vrací do fronty, dlouhý render lease prodlužuje,
- po `max_attempts` se job označí `failed` a pracovní adresář se uklidí,
- starý `sc_video_jobs`/GitHub release pipeline se pro nové joby nepoužívá.
