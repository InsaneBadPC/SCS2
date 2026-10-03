# SongCraft Studio — Project TODO: AI Manažer

> **Kanónický produkční roadmap:** `docs/TODO_PRODUCTION_AI_AGENT.md`  
> Tento historický plán ponechávám pro traceability; aktuální stav a gate patří do kanónického souboru.

**Větev:** `dev/ai-manager-studio`
**Návaznost:** velký plán v `docs/SACRED_WORK_PLAN.md` (jednotlivé fáze a detaily).

Legenda: `[ ]`=todo, `[~]`=v běhu, `[x]`=done.

---

## Fáze 0 — Integrace základů (větev, schéma, prototyp)

- [ ] V hlavním repu na větvi `dev/ai-manager-studio` (hotovo — vetev existuje).
- [ ] Převézt migraci `20260922000000_temney_agent_v3.sql` do `supabase/migrations/` hlavního repa.
- [ ] Rozšířit `agent_videos`: sloupce `mode`, `backend`, `audio_storage_path`, `prompt_used`, `output_path`.
- [ ] Rozšířit `agent_image_assets`: `for_album boolean`, `render_url text`, `variant_label text`.
- [ ] Nová tabulka `agent_media_uploads` (kind, storage_path, mime, byte_size, conversation_id, song_id).
- [ ] Nová tabulka `agent_channel_stats` (denní agregát kanálu: views, watch_time, subs, CTR, avg_view_duration, traffic_source).
- [ ] Rozšířit `agent_recommendations`: `expected_impact`, `metric` (ctr|retention|long_watch_time|subs|engagement), `deadline_at`, `linked_publication_id`, `outcome`.
- [ ] Nová tabulka `agent_content_calendar` (planned_date, format long|short|community|release, song_id, publication_id, status).
- [ ] Přidat secrets: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, YOUTUBE_CLIENT_ID/SECRET, VIDEO_VM_ENDPOINT, VIDEO_VM_BASIC_AUTH, R2_* (server-side).
- [ ] Nakopírovat prototyp: orchestrator, video-renderer-dispatch, youtube-publish, youtube-sync-stats, `workers/video-renderer/worker.mjs`, `lib/temney-agent.ts`, workflow `sync-youtube-stats`.
- [ ] `supabase db push` bez chyb; funkce deploynuté.

## Fáze 1 — Orchest rátor v2 (plnohodnotný agent)

- [ ] Rozšířit tool inventory (podle sekce 5 plánu): list_songs, list_lyric_drafts, get_album_detail, list_audio_versions, get_lyrics, extract_lyric_themes, generate_song_artwork (16:9), make_album_artwork (1:1), render_video, render_video_animation, render_video_scenes, generate_metadata, schedule_publication, publish_publication, update_publication, set_thumbnail, list_recent_publications, get_stats, comment_reply, create_recommendation, analyze_trends, refine_recommendation, upload_chat_file, link_file_to_song.
- [ ] Persistence konverzací: agent_conversations + agent_messages (user/model/function).
- [ ] Tool `upload_chat_file` + validace typu.
- [ ] Dispatche render_video_animation/full_scenes na VM.
- [ ] Audit do agent_action_log pro každý nástroj.
- [ ] Vložit MUSIC_MANAGER_GUIDE do system promptu (sekce 6 plánu).
- [ ] CONFIRM_REQUIRED pro publish/update/comment/thumbnail neprovádí veřejné změny.

## Fáze 2 — Client (chat, upload, potvrzení, stav rendroku)

- [ ] `lib/agent-api.ts` (askAgent(message, history, conversationId)).
- [ ] `app/(tabs)/assistant.tsx`: konverzace z DB (fallback AsyncStorage).
- [ ] Attachment button (image/audio/video) → picker → upload → orchestrator.
- [ ] Potvrzovací UI (publish/update/comment/thumbnail) → agent-confirm edge funkce.
- [ ] Komponenta stav rendroku agent_videos (queued/rendering/ready/failed) + Otevřít MP4 (signed URL).
- [ ] Náhled + Accept/Reject doporučení (agent_recommendations).
- [ ] Styl dle design.md, a11y, haptiky, reanimated.

## Fáze 3 — 3 režimy video renderu

- [ ] Režim 1 (ffmpeg): worker + cover+audio → 1280×720 → ready.
- [ ] Režim 2 (image_animation): VM /api/generate mode=image_animation → MP4 → agent_videos ready.
- [ ] Režim 3 (full_scenes): VM /api/generate mode=full_scenes → MP4 → ready.
- [ ] VM: bezpečný autohead (token), endpoint v secrets.
- [ ] render_status + error_message ve všech režimech.

## Fáze 4 — YouTube / distribuce

- [ ] Ověřit youtube_credentials Temney (channel UCVBrh8BozfEz5SDltgsvGWw).
- [ ] update_publication + set_thumbnail + comment_reply (CONFIRM_REQUIRED).
- [ ] youtube-sync-stats denní cron.
- [ ] Konektory Spotify/TikTok: placeholdery + credentials tabulky (prototyp).

## Fáze 5 — Manažerská vrstva (diagnostika + strategie + learning loop)

- [ ] Vložit MUSIC_MANAGER_GUIDE do system promptu orchest rátoru (sekce 6 plánu: persona, algoritmus 2026, operating model).
- [ ] Tooly diagnostiky: `get_channel_stats`, `get_video_performance`, `audit_channel_health`, `analyze_trends`.
- [ ] Tooly strategie: `plan_release` (8týdenní kampaň), `create_content_calendar` (long 1×/2–4 týdny + Shorts 2–3×/týden), `set_strategy_prefs`.
- [ ] Tooly loopu: `track_outcome`, `weekly_report`.
- [ ] `generate_thumbnail_concepts` → 2–3 A/B varianty + návrh testu (Test & Compare).
- [ ] Kadence respektuje preferred_publish_hour (peak 30 min před aktivitou publika) a agent_content_calendar.
- [ ] Learning loop: track_outcome porovnává metriky před/po; weekly_report vstupuje do agent_recommendations.

## Fáze 6 — Nasazení, testy, docs

- [ ] Workflow: deploy edge funkcí, sync-youtube-stats.
- [ ] Testy: orchestrator unit, upload, youtube mock, helper tests.
- [ ] Aktualizace SYSTEM_GUIDE.md / HOW_TO_USE.md (sekce AI manažer).
- [ ] E2E na VM: režim 1+2+3, publish confirmed, stats.
- [ ] Aktualizovat plán + TODO.
- [ ] `pnpm test` green.

---

## Definice hotovo (celý SongCraft)

- [ ] Orchestr čte reálná data, česky, DB konverzace.
- [ ] Upload obrázek/MP3/MP4 v chatu → propojení se skladbou.
- [ ] Artwork 1:1 alb + 16:9 písní → cover_path.
- [ ] Video 3 režimy → ready → MP4 v chatu.
- [ ] Publikace draft→confirmed→published na reálné kanálu TEMNEY.
- [ ] Manažerská vrstva: audit_channel_health, plan_release, create_content_calendar, track_outcome funkční; doporučení s měřitelným KPI → accept/reject.
- [ ] Playbook MUSIC_MANAGER_GUIDE vložen a dodržuje se (nikdy netvrdí úspěch bez success; konfirmace pro veřejné akce).
- [ ] Testy green, nasazení funkční, docs aktuální.