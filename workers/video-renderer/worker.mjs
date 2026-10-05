#!/usr/bin/env node
/**
 * Temney v3.0 ffmpeg video-renderer worker (Oracle Cloud Always Free VM, ubuntu, ffmpeg).
 *
 * Každou smyčku vezme PRVNÍ job z agent_videos (render_status=queued), zamkne ho
 * (queued→rendering) a podle job.type zpracuje právě jednu ze tří větví; výsledek je
 * vždy 16:9, nahraje se do Supabase Storage (bucket songcraft) a PATCH ready.
 *
 *   static_cover     → lokální ffmpeg (loop artwork + audio → stillimage MP4)   [výchozí]
 *   image_animation  → lokální ai-video-generator dashboard http://127.0.0.1:8080
 *                      POST /api/generate (audio + artwork + prompt + mode=image_animation)
 *                      → poll GET /api/runs → stáhne hotové mp4 z /api/runs/{id}/download
 *   full_scenes      → dashboard POST /api/generate mode=full_scenes (audio + artwork
 *                      jako referenční postava + prompt) → poll → stáhne mp4 → Storage → ready
 *   video_loop       → lokální ffmpeg (source_video_path → crossfade smyčka na délku audia)
 *   source_loop      → loop engine (workers/video-renderer/loop-engine.mjs): tři techniky
 *                      (palindrom / rozmlužení / střih v klidu) s náhodně dlouhými
 *                      průchody a náhodnými přechody. Bere video skladby, jinak obal.
 *                      16:9 nebo 9:16. Nahrazuje image_animation a full_scenes, které
 *                      potřebovaly dashboard a nebyly na VM dostupné.
 *
 * Dashboard (FastAPI, Basic auth z env DASHBOARD_USER/DASHBOARD_PASSWORD) běží NA STEJNÉM
 * Oracle VM jako tento worker ⇒ volá se lokálně 127.0.0.1:8080, bez otevírání portů ven.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DASHBOARD_USER, DASHBOARD_PASSWORD.
 * Optional: DASHBOARD_URL (default http://127.0.0.1:8080), WORKER_INTERVAL_MS (30000),
 *           WORK_DIR, RUN_ONCE=1.
 */
import { mkdir, writeFile, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { buildLoopVideo } from "./loop-engine.mjs";

const exec = promisify(execFile);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dashboardUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:8080";
const dashboardUser = process.env.DASHBOARD_USER || "";
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const bucket = "songcraft";
const workRoot = process.env.WORK_DIR || "/tmp";
const interval = Number(process.env.WORKER_INTERVAL_MS || 30000);
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 45 * 1024 * 1024);
const maxDownloadBytes = Number(process.env.MAX_DOWNLOAD_BYTES || 64 * 1024 * 1024);
const minFreeBytes = Number(process.env.MIN_FREE_BYTES || 2 * 1024 * 1024 * 1024);
const preflightOnly = process.env.PREFLIGHT_ONLY === "1";
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
function api(table, query = "") { return `${url}/rest/v1/${table}${query}`; }
async function request(endpoint, options = {}) {
  const response = await fetch(endpoint, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function signed(pathname) {
  // Storage API vyžaduje lomítka v cestě DOSLOVA; encodeURIComponent by je změnilo na %2F → 400.
  const encoded = pathname.split("/").map(encodeURIComponent).join("/");
  const result = await request(`${url}/storage/v1/object/sign/${bucket}/${encoded}`, { method: "POST", body: JSON.stringify({ expiresIn: 900 }) });
  return `${url}/storage/v1${result.signedURL}`;
}
function ownedPath(userId, pathname) {
  if (typeof pathname !== "string" || !pathname || pathname.length > 1024 || pathname.includes("\\") || pathname.includes("..") || pathname.startsWith("/") || !pathname.startsWith(`${userId}/`)) {
    throw new Error("Storage path does not belong to the job owner");
  }
  return pathname;
}
async function download(file, target, extraHeaders = {}) {
  const response = await fetch(file, { headers: extraHeaders, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxDownloadBytes) throw new Error(`Download exceeds the configured limit (${declaredLength} bytes)`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength <= 0 || bytes.byteLength > maxDownloadBytes) throw new Error("Downloaded file has an invalid size");
  await writeFile(target, bytes);
}

/**
 * Wrapper s časovým limitem. Preflight nesmí viset: na neobvyklém filesystému
 * (např. mkdir -p do /proc) může systémový syscall blokovat neomezeně a kontrola
 * závislostí by pak měla stejný defect jako samotný render.
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} vypršel po ${ms} ms`)), ms); }),
  ]);
}

/**
 * Startup preflight: ověří všechny věci, bez kterých worker nemůže renderovat,
 * a při chybějící závislosti odejde s nenulovým kódem místo toho, aby selhal potom
 * uprostřed dvouhodinového renderu. Dřív to končilo až na `spawn ffmpeg ENOENT`
 * u jednoho jobu, který pak zůstal viset ve stavu rendering.
 */
async function preflight() {
  const problems = [];

  for (const bin of ["ffmpeg", "ffprobe"]) {
    try {
      await exec(bin, ["-version"], { maxBuffer: 1024 * 1024 });
    } catch (error) {
      problems.push(`${bin} není v PATH nebo není spustitelný (${error.code || error.message})`);
    }
  }
  if (problems.length === 0) {
    // Bez libx264 a aac by ffmpeg vyrobil jen prázdný/nečitelný MP4; kontrola
    // encoderu je levná a odliší "ffmpeg existuje" od "ffmpeg umí MP4".
    try {
      const { stdout } = await exec("ffmpeg", ["-hide_banner", "-encoders"], { maxBuffer: 4 * 1024 * 1024 });
      for (const encoder of ["libx264", "aac"]) {
        if (!new RegExp(`\\s${encoder}\\s`, "i").test(stdout)) {
          problems.push(`ffmpeg je nainstalovaný, ale nemá encoder ${encoder}`);
        }
      }
    } catch (error) {
      problems.push(`ffmpeg -encoders selhal (${error.code || error.message})`);
    }
  }

  // mkdir i statfs se obalí limitem, aby kontrola sama nevěsela (viz withTimeout).
  const workDirOk = await withTimeout(
    (async () => {
      await mkdir(workRoot, { recursive: true });
      const probe = path.join(workRoot, `.preflight-${process.pid}`);
      await writeFile(probe, "ok");
      await rm(probe, { force: true });
      const space = await statfs(workRoot);
      return Number(space.bavail) * Number(space.bsize);
    })(),
    Number(process.env.PREFLIGHT_TIMEOUT_MS || 15_000),
    `kontrola WORK_DIR ${workRoot}`
  ).then(
    (free) => ({ free }),
    (error) => ({ error })
  );

  if (workDirOk.error) {
    problems.push(
      `WORK_DIR ${workRoot} není použitelný (${workDirOk.error.code || workDirOk.error.message}). Nastav WORK_DIR na zapisovatelný adresář.`
    );
  } else if (workDirOk.free < minFreeBytes) {
    problems.push(
      `na ${workRoot} je ${(workDirOk.free / 1024 ** 3).toFixed(2)} GiB volných, minimum je ${(minFreeBytes / 1024 ** 3).toFixed(2)} GiB (MIN_FREE_BYTES)`
    );
  } else {
    console.log(`[preflight] volné místo na ${workRoot}: ${(workDirOk.free / 1024 ** 3).toFixed(1)} GiB`);
  }

  if (problems.length > 0) {
    console.error("[preflight] video renderer nelze spustit, chybí závislosti:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("[preflight] ffmpeg, ffprobe, encodery, WORK_DIR a volné místo jsou v pořádku");
}

/**
 * Větve `image_animation` a `full_scenes` jedou přes ai-video-generator dashboard.
 * Dashboard na headless VM nebeží a `fetch` na mrtvý port hází ECONNREFUSED až
 * v okamžiku generování, takže job vypadal jako chyba sítě. Proto se dostupnost
 * ověří PŘED stahováním audia: bez dashboardu se job odmítne hned, bez stažení
 * stovek MB a bez čekání na retry.
 */
async function assertDashboardReady() {
  if (!dashboardUser || !dashboardPassword) {
    throw new Error(
      "Větev vyžaduje ai-video-generator dashboard, ale DASHBOARD_USER/DASHBOARD_PASSWORD nejsou nastavené. Použij source_loop nebo static_cover, obě jsou čistý ffmpeg. / This branch needs the ffmpeg-web dashboard, which is not configured."
    );
  }
  let response;
  try {
    response = await fetch(`${dashboardUrl}/api/runs`, {
      headers: { Authorization: dashAuth() },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(
      `Dashboard na ${dashboardUrl} neodpovídá (${error.cause?.code || error.code || error.message}). Větev není na tomto stroji dostupná, použij source_loop nebo static_cover. / Dashboard unreachable; use a pure ffmpeg branch.`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Dashboard na ${dashboardUrl} vrátil ${response.status}: ${(await response.text()).slice(0, 200)}. Použij source_loop nebo static_cover.`
    );
  }
}

/** Supabase upload limit je 50 MiB; před uploadem bezpečně zmenší př oversized MP4. */
async function prepareUpload(file) {
  if ((await stat(file)).size <= maxUploadBytes) return file;
  const target = `${file}.upload.mp4`;
  await exec("ffmpeg", [
    "-y", "-i", file,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", target,
  ], { maxBuffer: 10 * 1024 * 1024 });
  const size = (await stat(target)).size;
  if (size > maxUploadBytes) throw new Error(`Compressed video is still too large: ${size} bytes`);
  return target;
}

/** Délka souboru v sekundách z ffprobe (fail-closed: bez čísla nelze sestavit smyčku). */
async function probeDuration(file) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ], { maxBuffer: 1024 * 1024 });
  const seconds = Number(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe returned no usable duration for ${path.basename(file)}`);
  }
  return seconds;
}

/**
 * Plynulá smyčka: crossfade spojí konec klipu se začátkem, takže opakování
 * jednotky nemá viditelný střih. Průchod 1 složí jednotku, průchod 2 ji opakuje
 * na délku audia. Rozměry cílového rámu se řeší až v průchodu 2, aby se
 * nedeformovalo xfade počítání.
 */
async function renderSeamlessVideoLoop(source, audio, output, aspect) {
  const dims = aspect === "9:16" ? { w: 1080, h: 1920 } : { w: 1280, h: 720 };
  const audioDuration = await probeDuration(audio);
  const sourceDuration = await probeDuration(source);
  // Fade nesmí přesáhnout třetinu klipu, jinak by zbylo málo pohybu.
  const fade = Math.min(1, Math.max(0.25, sourceDuration / 3));
  const main = sourceDuration - fade;
  const unitDuration = main + fade - fade;
  if (unitDuration <= 0.4) throw new Error("Nahrané video je příliš krátké pro smyčku");
  const offset = main - fade;
  const unit = `${output}.unit.mp4`;

  await exec("ffmpeg", [
    "-y", "-i", source,
    "-filter_complex",
    `[0:v]split=2[va][vb];[va]trim=0:${main.toFixed(6)},setpts=PTS-STARTPTS[a];` +
      `[vb]trim=${main.toFixed(6)}:${sourceDuration.toFixed(6)},setpts=PTS-STARTPTS[b];` +
      `[a][b]xfade=transition=fade:duration=${fade.toFixed(6)}:offset=${Math.max(0, offset).toFixed(6)},format=yuv420p[v]`,
    "-map", "[v]", "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    unit,
  ], { maxBuffer: 10 * 1024 * 1024 });

  const loops = Math.ceil(audioDuration / unitDuration) + 1;
  const { w, h } = dims;
  await exec("ffmpeg", [
    "-y", "-stream_loop", String(loops), "-i", unit, "-i", audio,
    "-filter_complex",
    `[0:v]split=2[fg][bg];` +
      `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=24,eq=brightness=-0.12:saturation=0.6[bgb];` +
      `[fg]scale=${w}:-2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black[fgp];` +
      `[bgb][fgp]overlay=0:0,format=yuv420p[v]`,
    "-map", "[v]", "-map", "1:a",
    "-t", audioDuration.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ], { maxBuffer: 10 * 1024 * 1024 });

  await rm(unit, { force: true });
}

/**
 * Dashboard (I2V i scény) vrací 16:9. Když job hlásí 9:16, převedeme výstup na
 * 1080x1920 s rozmazaným pozadím, aby šel záznam v agent_videos.aspect odrážel
 * skutečný výstup. Bez toho by short v DB tvrdil svislé a soubor byl vodorovný.
 */
async function fitToAspect(file, aspect) {
  if (aspect !== "9:16") return file;
  const target = `${file}.vertical.mp4`;
  await exec("ffmpeg", [
    "-y", "-i", file,
    "-filter_complex",
    `[0:v]split=2[fg][bg];` +
      `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=24,eq=brightness=-0.12:saturation=0.6[bgb];` +
      `[fg]scale=1080:-2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black[fgp];` +
      `[bgb][fgp]overlay=0:0,format=yuv420p[v]`,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart", target,
  ], { maxBuffer: 10 * 1024 * 1024 });
  return target;
}

/** Basic auth hlavička dashboard API. */
function dashAuth() {
  if (!dashboardUser || !dashboardPassword) throw new Error("DASHBOARD_USER and DASHBOARD_PASSWORD are required for image_animation/full_scenes");
  return "Basic " + Buffer.from(`${dashboardUser}:${dashboardPassword}`).toString("base64");
}

/**
 * POST /api/generate → vytvoří job na dashboardu. Vrací {run_id,...}.
 * mode: image_animation | full_scenes
 */
/** Podle magic bytů určí příponu obrázku (fail-closed: neznámý formát → png). */
function sniffImageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return "png";
}

async function dashGenerate(mode, audio, image, title, prompt) {
  const form = new FormData();
  form.append("audio", new Blob([await readFile(audio)], { type: "audio/mpeg" }), "audio.mp3");
  if (image) {
    const ext = sniffImageExtension(await readFile(image));
    form.append("image", new Blob([await readFile(image)], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), `artwork.${ext}`);
  }
  form.append("prompt", prompt || "");
  form.append("title", title || "Temney");
  form.append("mode", mode);
  const response = await fetch(`${dashboardUrl}/api/generate`, { method: "POST", headers: { Authorization: dashAuth() }, body: form });
  if (!response.ok) throw new Error(`dashboard generate ${response.status}: ${await response.text()}`);
  const record = await response.json();
  if (!record?.run_id) throw new Error("dashboard generate: missing run_id");
  return record;
}

/** Poll GET /api/runs dokud job neskončí → vrací run (s download URL když hotovo). */
async function dashPoll(runId, timeoutMs = 90 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${dashboardUrl}/api/runs`, { headers: { Authorization: dashAuth() } });
    if (!response.ok) throw new Error(`dashboard runs ${response.status}: ${await response.text()}`);
    const runs = await response.json();
    const item = (Array.isArray(runs) ? runs : []).find((r) => String(r?.run_id) === String(runId));
    if (!item) {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      continue;
    }
    // Selhání běhu musí přijít PRVNÍ: dashboard nechává u neúspěšných běhů
    // pole `output`, které míří na neexistující soubor — bez této kontroly
    // by worker skončil na "Download failed 404" a ztratil důvod (např. vyčerpanou
    // GPU kvótu), takže by to vypadalo jako chyba sítě.
    const status = String(item?.status ?? "").toLowerCase();
    if (["failed", "error", "crashed"].includes(status)) {
      const reason = String(item?.error || item?.message || item?.reason || status).slice(0, 400);
      throw new Error(`Oracle dashboard selhal render: ${reason}`);
    }
    if (item?.download) return item;
    if (item?.output && status === "finished") return item;
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error("dashboard render timed out");
}

/** Po stažení ověří, že je soubor použitelný video (ne 0 B, ne HTML chyba). */
async function assertPlayableVideo(file) {
  const { size } = await stat(file);
  if (size < 20_000) throw new Error(`Výstup videa je příliš malý (${size} B) — render selhal`);
  const probe = await new Promise((resolve) => {
    exec("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name:format=duration",
      // nk=1 by vyhodil názvy polí a výstup by byl jen h264/1280/720/378.32,
      // takže kontrola width= by nikdy neselhala
      "-of", "default=nw=1",
      file,
    ], { maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => resolve(String(stdout)))
      .catch((error) => resolve(`ERR ${error.message}`));
  });
  if (probe.startsWith("ERR") || !/width=\d+/i.test(probe)) {
    throw new Error(`Výstup není čitelné video (ffprobe): ${probe.slice(0, 160)}`);
  }
  return probe.replace(/\n/g, " ");
}

/**
 * Lease na dlouhý render.
 *
 * Původních 15 minut nestačilo: 6:18 song kóduje hodiny a lease mezitím vypršel.
 * Prodlužuje se při každém hlášení průběhu, nejvýš jednou za dvě minuty, aby
 * se do DB netlačilo při každém průchodu.
 */
const LEASE_MS = 6 * 60 * 60 * 1000;
const lastLease = new Map();
function refreshLease(id, userId) {
  const now = Date.now();
  if (now - (lastLease.get(id) || 0) < 120_000) return;
  lastLease.set(id, now);
  return request(api("agent_videos", `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`), {
    method: "PATCH",
    body: JSON.stringify({ lease_expires_at: new Date(now + LEASE_MS).toISOString() }),
  }).catch(() => {});
}

/** Uklidí pracovní adresáře starší než maxAgeMs, aby VM nedošlo místo. */
async function pruneOldWork(maxAgeMs) {
  try {
    for (const entry of await readdir(work, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(work, entry.name);
      const info = await stat(dir).catch(() => null);
      if (info && Date.now() - info.mtimeMs > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        console.log(`[prune] ${entry.name}`);
      }
    }
  } catch {
    // pracovní adresář ještě nemusí existovat
  }
}

async function processJob(job) {
  const work = path.join(workRoot, `temney-${job.id}`);
  await mkdir(work, { recursive: true });
  try {
    const songs = await request(api("sc_songs", `?select=id,title,cover_path,album_id,source_video_path&id=eq.${encodeURIComponent(job.song_id)}&user_id=eq.${encodeURIComponent(job.user_id)}`));
    const song = songs?.[0]; if (!song) throw new Error("Song not found");
    const versions = await request(api("sc_audio_versions", `?select=id,storage_path,original_storage_path,tagged_storage_path,is_final,is_primary,rating&song_id=eq.${encodeURIComponent(job.song_id)}&user_id=eq.${encodeURIComponent(job.user_id)}&is_final=eq.true&order=is_primary.desc,rating.desc&limit=1`));
    const version = versions?.[0]; if (!version) throw new Error("No final audio version");
    // Job si může přinést vlastní zvuk, třeba 30 s výřez pro short. Bez toho se
    // vždy brala finální verze skladby a short vyšel dlouhý jako celá píseň.
    const jobAudio = typeof job.audio_storage_path === "string" && job.audio_storage_path
      ? ownedPath(job.user_id, job.audio_storage_path) : null;
    const audioStoragePath = jobAudio || ownedPath(job.user_id, version.tagged_storage_path || version.original_storage_path || version.storage_path);
    let coverStoragePath = ownedPath(job.user_id, song.cover_path);
    if (!coverStoragePath && song.album_id) {
      const albums = await request(api("sc_albums", `?select=cover_path&id=eq.${encodeURIComponent(song.album_id)}&user_id=eq.${encodeURIComponent(job.user_id)}`));
      coverStoragePath = ownedPath(job.user_id, albums?.[0]?.cover_path);
    }
    const audio = path.join(work, "audio.mp3");
    const output = path.join(work, "render.mp4");
    const type = job.mode || job.type || "static_cover";
    // Dashboard se ověřuje PŘED stahováním zdrojů. Bez této kontroly se na mrtvém
    // portu 8080 nejprve stáhne celé audio a obal, teprve pak to spadne na
    // ECONNREFUSED a job vypadá jako chyba sítě místo chybějící závislosti.
    if (type === "image_animation" || type === "full_scenes") await assertDashboardReady();
    // source_loop si bere video, nebo obal když video není, a obal nepotřebuje
    // stahovat dopředu.
    const needsArtwork = type !== "source_loop";
    let artwork = null;
    await download(await signed(audioStoragePath), audio);
    if (needsArtwork) {
      const artworkRaw = path.join(work, "artwork.raw");
      await download(await signed(coverStoragePath), artworkRaw);
      // Skutečný typ obrázku určíme z magic bytů: ffmpeg i dashboard dostávají
      // správnou příponu a MIME, jinak se JPEG failuje jako PNG.
      artwork = path.join(work, `artwork.${sniffImageExtension(await readFile(artworkRaw))}`);
      if (artwork !== artworkRaw) await writeFile(artwork, await readFile(artworkRaw));
      await rm(artworkRaw, { force: true });
    }

    if (type === "source_loop") {
      // === větev D2: loop engine (náhrada image_animation a full_scenes) ===
      // Všechno běží lokálním ffmpegem, žádný dashboard, žádné drahé GPU.
      let sourceVideo;
      if (typeof job.source_video_path === "string" && job.source_video_path) {
        sourceVideo = path.join(work, "source.mp4");
        await download(await signed(ownedPath(job.user_id, job.source_video_path)), sourceVideo);
      }
      let sourceImage = null;
      if (!sourceVideo) {
        const raw = path.join(work, "loopcover.raw");
        await download(await signed(coverStoragePath), raw);
        sourceImage = path.join(work, `loopcover.${sniffImageExtension(await readFile(raw))}`);
        if (sourceImage !== raw) await writeFile(sourceImage, await readFile(raw));
        await rm(raw, { force: true });
      }
      const result = await buildLoopVideo({
        sourceVideo,
        sourceImage,
        audio,
        out: output,
        workDir: path.join(work, "loop"),
        seed: String(job.id),
        aspect: job.aspect === "9:16" ? "9:16" : "16:9",
        onProgress: (line) => {
          console.log(`[${job.id}] ${line}`);
          void refreshLease(job.id, job.user_id);
        },
      });
      await assertPlayableVideo(output);
      console.log(`[ready] ${job.id} (source_loop, ${result.passes.length} průchodů, ${result.aspect}, ${result.duration.toFixed(2)} s)`);
    } else if (type === "static_cover") {
      // === větev A: statický cover (lokální ffmpeg) ===
      // Pozor na filtry: `format` je samostatný filtr, musí být oddělený čárkou
      // (jinak ffmpeg hlásí "Option not found" na crop) a před ním musí být
      // scale, aby cover nebyl oříznutý (16:9 z plného obrázku).
      await exec("ffmpeg", [
        "-y", "-loop", "1", "-i", artwork, "-i", audio,
        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p",
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-shortest", output,
      ]);
      await assertPlayableVideo(output);
    } else if (type === "image_animation" || type === "full_scenes") {
      // === větve B/C: dashboard pipeline (Oracle localhost, Wan 2.2 I2V / scény) ===
      // Dostupnost dashboardu už ověřil assertDashboardReady() před stahováním.
      const mode = type === "image_animation" ? "image_animation" : "full_scenes";
      const record = await dashGenerate(mode, audio, artwork, song.title, job.prompt_used || "");
      await dashPoll(record.run_id);
      await download(`${dashboardUrl}/api/runs/${record.run_id}/download`, output, { Authorization: dashAuth() });
      const fitted = await fitToAspect(output, job.aspect);
      if (fitted !== output) {
        await writeFile(output, await readFile(fitted));
        await rm(fitted, { force: true });
      }
      await assertPlayableVideo(output);
    } else if (type === "video_loop") {
      // === větev D: plynulá smyčka z nahráného videa přes celou skladbu ===
      const sourceVideo = ownedPath(job.user_id, job.source_video_path);
      const source = path.join(work, "source.mp4");
      await download(await signed(sourceVideo), source);
      await renderSeamlessVideoLoop(source, audio, output, job.aspect);
      await assertPlayableVideo(output);
    } else {
      throw new Error(`Unknown video type: ${type}`);
    }

    const uploadFile = await prepareUpload(output);
    const bytes = new Uint8Array(await readFile(uploadFile));
    const outputPath = `${job.user_id}/videos/${job.id}.mp4`;
    const uploadPath = outputPath.split("/").map(encodeURIComponent).join("/");
    const upload = await fetch(`${url}/storage/v1/object/${bucket}/${uploadPath}`, { method: "POST", headers: { ...headers, "Content-Type": "video/mp4", "x-upsert": "true" }, body: bytes });
    if (!upload.ok) throw new Error(`Upload failed ${upload.status}: ${await upload.text()}`);
    await request(api("agent_videos", `?id=eq.${job.id}&user_id=eq.${job.user_id}`), { method: "PATCH", body: JSON.stringify({ render_status: "ready", storage_path: outputPath, output_path: outputPath, error_message: null, lease_expires_at: null }) });
    console.log(`[ready] ${job.id} (${type})`);
    await rm(work, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempt = Number(job.attempt_count || 0);
    const maxAttempts = Number(job.max_attempts || 3);
    const retry = attempt < maxAttempts;
    await request(api("agent_videos", `?id=eq.${job.id}&user_id=eq.${job.user_id}`), { method: "PATCH", body: JSON.stringify({ render_status: retry ? "queued" : "failed", lease_expires_at: null, error_message: message.slice(0, 1000) }) }).catch(() => {});
    console.error(`[${retry ? "retry" : "failed"}] ${job.id} (${attempt}/${maxAttempts}): ${message}`);
    if (!retry) {
      // Hotové průchody se nechávají do posledního pokusu, protože engine z nich
      // při dalším běhu vychází. Staré adresáře se uklidí, jinak by VM došlo
      // místo na disku.
      await rm(work, { recursive: true, force: true }).catch(() => {});
      await pruneOldWork(24 * 60 * 60 * 1000);
    } else {
      // Při retry se adresář NEOZMĚNÍ: engine si z něj vezme už vykódované
      // průchody. Dřív se tu mazalo všechno, takže OAM vždy rozběhl render od
      // prvního průchodu a 6:18 song se nikdy nedokončil.
      console.error(`[retry] ${job.id}: pracovní adresář ${work} se ponechává, engine naváže na hotové průchody`);
    }
  }
}

async function tick() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  await request(api("agent_videos", `?render_status=eq.rendering&or=(lease_expires_at.is.null,lease_expires_at.lt.${encodeURIComponent(staleBefore)})`), { method: "PATCH", body: JSON.stringify({ render_status: "queued", lease_expires_at: null, error_message: "Worker lease expired; job was requeued." }) }).catch(() => {});

  const jobs = await request(api("agent_videos", "?select=id,user_id,song_id,type,mode,backend,prompt_used,attempt_count,max_attempts,lease_expires_at,audio_storage_path,aspect&render_status=eq.queued&order=created_at.asc&limit=1"));
  const job = jobs?.[0]; if (!job) return;
  const attempt = Number(job.attempt_count || 0) + 1;
  const maxAttempts = Number(job.max_attempts || 3);
  if (attempt > maxAttempts) {
    await request(api("agent_videos", `?id=eq.${encodeURIComponent(job.id)}&user_id=eq.${encodeURIComponent(job.user_id)}`), { method: "PATCH", body: JSON.stringify({ render_status: "failed", error_message: "Maximum render attempts exceeded.", lease_expires_at: null }) });
    return;
  }
  const claimed = await request(api("agent_videos", `?id=eq.${encodeURIComponent(job.id)}&user_id=eq.${encodeURIComponent(job.user_id)}&render_status=eq.queued`), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ render_status: "rendering", attempt_count: attempt, lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(), error_message: null }) });
  const ok = Array.isArray(claimed) && claimed.length > 0;
  if (ok) await processJob({ ...job, attempt_count: attempt, max_attempts: maxAttempts, mode: claimed[0].mode || job.mode, backend: claimed[0].backend || job.backend, prompt_used: claimed[0].prompt_used || job.prompt_used });
}

await preflight();
if (preflightOnly) process.exit(0);
console.log(`Temney renderer ready; interval ${interval}ms; dashboard ${dashboardUrl} (pouze pro image_animation/full_scenes)`);
do {
  await tick().catch((error) => console.error(error));
  if (process.env.RUN_ONCE === "1") break;
  await new Promise((resolve) => setTimeout(resolve, interval));
} while (true);
