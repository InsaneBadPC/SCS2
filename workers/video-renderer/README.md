# Oracle video renderer

`worker.mjs` je jediný aktivní video worker pro novou `agent_videos` frontu.

## Nároky

- Node.js 20 nebo novější,
- FFmpeg s `libx264` a AAC,
- pro `image_animation`/`full_scenes` dashboard na loopbacku,
- Supabase URL a service-role key pouze v root-only environment souboru.

## Bezpečné spuštění

1. zkopírovat `songcraft-renderer.service.example` do `/etc/systemd/system/`,
2. vytvořit neprivilegovaného uživatele `songcraft-renderer`,
3. uložit secrets do `/etc/songcraft-studio/renderer.env` s právy `600`,
4. nastavit `WORK_DIR` na adresář, který service smí číst a zapisovat,
5. spustit `systemctl daemon-reload && systemctl enable --now songcraft-renderer`.

Nikdy neotevírat dashboard port veřejně. Worker používá pouze `http://127.0.0.1:8080` a
Basic auth z environmentu.

## Chování fronty

- `static_cover` používá lokální FFmpeg,
- `image_animation` a `full_scenes` volají Oracle dashboard přes loopback,
- používá se pouze finální audio verze; preferuje se tagged copy,
- výstup je soukromý Supabase Storage objekt s prefixem vlastníka,
- lease expirovaný job se vrací do fronty,
- po `max_attempts` se job označí `failed`,
- starý `sc_video_jobs`/GitHub release pipeline se pro nové joby nepoužívá.
