/**
 * SongCraft loop engine – dlouhé video ze zdrojového klipu nebo statického obrazu.
 *
 * Proč existuje: dashboard větve image_animation a full_scenes jsou drahé, na
 * Oracle VM nebyly dostupné a jejich výstup (16:9) navíc vždy odporoval 9:16
 * záznamu v DB. Engine je nahrazuje jedním lokálním ffmpeg postupem, který
 * potřebuje jen zdroj a zvuk, a funguje na libovolném videu i obrazu.
 *
 * Tři druhy průchodů:
 *
 *   A) PALINDROM  – půl cyklu tam, totéž zpět. Konec je totožný se začátkem
 *                   (obsah i měřítko), takže průchod je nulový sám o sobě.
 *                   Pomalý push-in a sinusový drift se na zpětném průchodu
 *                   přehrají do pull-outu, takže kamera nikdy nezastaví.
 *
 *   B) ROZMLŽENÍ  – lineární průchod, který do videa vstupuje přes náhodně
 *                   vybraný přechod (hblur, dissolve, radial, pixelize…) a
 *                   hlavu má částečně rozmazanou. Rychlost písně se v každém
 *                   průchodu mění, takže 5s scenka někdy zabere 5 s a
 *                   někdy 12 s.
 *
 *   C) STŘIH V KLIDU – lineární průchod, který začíná v nejklidnějším snímku
 *                   zdroje (pohyb se měří tblend=difference,signalstats) a
 *                   navazuje tvrdým střihem. Návrat na tentýž snímek je
 *                   neviditelný, zůstává jen skok rychlosti a v klidu je
 *                   nejméně pozorovatelný.
 *
 * Spoje mezi průchody jsou řešené explicitně. Průchod, který je perfektní
 * smyčka, končí svým vlastním startovým snímkem, takže dva průchody s různými
 * offsety by se spojily tvrdým střihem (naměřeno 9-43x median pohybu). Proto:
 *
 *   - 'blend' → mezi koncem předchozího a začátkem tohoto je xfade s náhodným
 *     přechodem. Offsety mohou být libovolné.
 *   - 'cut'   → tvrdý střih, ale oba průchody mají stejný offset, takže snímek
 *     na spoji je doslova stejný. Proto se offsety zacyklí na některém z
 *     nejklidnějších snímků zdroje.
 *
 * Plán pracuje ve snímcích, ne v sekundách: průchod je "N snímků zdroje od
 * offsetu" a délka plyne z rychlosti. Náhodnost (technika, délka, offset, zoom,
 * drift, fáze, rychlost, přechod, tlumení) se váže na ID práce, takže plán je
 * reprodukovatelný, ale pro každou píseň jiný.
 *
 * Bez závislostí, jen ffmpeg/ffprobe.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const exec = promisify(execFile);
const FPS = 24;
const W = 1280;
const H = 720;
const MAX_BUFFER = 24 * 1024 * 1024;

const TECHNIQUES = ["A", "B", "C"];
/** Počet snímků zdroje na průchod → délka 2.5 s až 15 s. */
const BURSTS = [72, 96, 120, 144, 168, 192, 216, 240, 288, 336, 360];
/**
 * Dvě věci, které na Oracle VM (954 MB RAM, 2 jádra) shodily dlouhé video:
 *
 * 1) PALINDROM BUFFERUJE. Filtr `reverse` drží celý půlcyklus v paměti.
 *    Pro 15 s průchodu je to 360 snímků 1280x720, tedy asi 500 MB, a ffmpeg
 *    padá na OOM. Proto je půlcyklus A omezený a dlouhé úseky berou B nebo C,
 *    které streamují bez bufferu.
 *
 * 2) POČET PRŮCHODŮ RŮSTL S DÉLKOU SKLADBY. 6:18 song = 47 průchodů = hodiny
 *    kódování a po každém OOM restart od nuly. Počet průchodů se proto počítá
 *    z délky a průchody se prodlužují, ne množí.
 */
const A_MAX_HALF = Math.round(FPS * 1.5);
/** 6 a víc průchodů už není potřeba, 16 a méně už není rozmanité. */
const MIN_PASSES = 6;
const MAX_PASSES = 16;
/** ffmpeg s -threads 6 na 2 jádra držel v bufferu stovky MB. */
const THREADS = "2";
const OFFSETS = [0, 3, 6, 9, 12, 20, 30, 40, 57, 70, 83, 95, 100, 103, 105, 106, 108, 109, 115];
/** Náhodné přechody pro spoj typu blend. hblur je pravý rozostřovací přechod. */
const XFADES = [
  "hblur", "fade", "fadeblack", "fadewhite", "fadegrays", "dissolve",
  "smoothleft", "smoothright", "smoothup", "smoothdown",
  "circleopen", "circleclose", "vertopen", "vertclose", "horzopen", "horzclose",
  "radial", "distance", "pixelize", "wipetl", "wipetr", "wipebl", "wipebr",
];

async function ffmpeg(args) {
  return exec("ffmpeg", ["-hide_banner", "-v", "error", "-nostdin", ...args], { maxBuffer: MAX_BUFFER });
}
async function ffprobe(args) {
  return exec("ffprobe", ["-v", "error", ...args], { maxBuffer: MAX_BUFFER });
}

export async function probeDuration(file) {
  const { stdout } = await ffprobe(["-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const seconds = Number(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe nevrátil použitelnou délku pro ${path.basename(file)}`);
  }
  return seconds;
}

export async function probeFrameCount(file) {
  try {
    const { stdout } = await ffprobe([
      "-select_streams", "v:0", "-count_frames",
      "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file,
    ]);
    const n = Number(String(stdout).trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* délka jako záloha */ }
  return Math.max(1, Math.round((await probeDuration(file)) * FPS));
}

/**
 * Snímky s nejmenším pohybem. tblend=difference dá rozdíl proti předchozímu
 * snímku a signalstats z něj YAVG, tedy přímo průměrnou velikost změny.
 */
export async function calmFrames(video, wanted = 10) {
  const scored = [];
  try {
    const { stdout } = await ffprobe([
      "-f", "lavfi",
      "-i", `movie=${video.replace(/[\\:,'"[\]]/g, "\\$&")},tblend=all_mode=difference,signalstats`,
      "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG",
      "-of", "csv=p=0",
    ]);
    for (const line of String(stdout).split("\n")) {
      const [t, v] = line.split(",");
      if (!t || !v) continue;
      const value = Number(v);
      if (Number.isFinite(value)) scored.push({ t: Number(t), value });
    }
  } catch {
    return [0];
  }
  if (!scored.length) return [0];
  scored.sort((a, b) => a.value - b.value);
  const picked = [];
  for (const row of scored) {
    const index = Math.round(row.t * FPS);
    if (index >= 0 && index < 10_000) picked.push(index);
    if (picked.length >= wanted) break;
  }
  return [...new Set(picked)].sort((a, b) => a - b);
}

function randomFor(seed, state0) {
  let state = state0 ?? 0;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) state = (Math.imul(state, 31) + text.charCodeAt(i)) | 0;
  if (state === 0) state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13; state |= 0;
    state ^= state >>> 17;
    state ^= state << 5; state |= 0;
    return ((state >>> 0) % 1e6) / 1e6;
  };
  next.state = () => state;
  return next;
}
/**
 * Seamless zdroj.
 *
 * Zdrojové video nemusí jít do smyčky (u Luma klipu se poslední a první snímek
 * liší) a lineární průchod delší než zbytek zdroje se na něm zasekne o tvrdý
 * skok. Proto si jednou vyrobíme crossfade smyčku a použijeme ji jako pracovní
 * zdroj: je plynulá na svém začátku i konci, takže se na ni dá bezpečně
 * navazovat i vracet. Třikrát zopakovaná smyčka dává i víc místa pro náhodné
 * starty průchodů.
 */
async function buildSeamlessBase(video, out, frameCount) {
  const fade = Math.max(6, Math.min(Math.round(FPS), Math.floor(frameCount / 3)));
  const main = Math.max(12, frameCount - fade);
  const loopUnit = path.join(path.dirname(out), ".loopunit.mp4");
  try {
    await ffmpeg(["-threads", THREADS, "-filter_threads", "1", "-i", video, "-filter_complex",
      `[0:v]trim=start_frame=0:end_frame=${main},setpts=PTS-STARTPTS[a];`
      + `[0:v]trim=start_frame=${main}:end_frame=${frameCount},setpts=PTS-STARTPTS[b];`
      + `[a][b]xfade=transition=fade:duration=${(fade / FPS).toFixed(4)}`
      + `:offset=${((main - fade) / FPS).toFixed(4)},format=yuv420p[v]`,
      "-map", "[v]", "-frames:v", String(main), ...ENCODE, "-y", loopUnit]);
    await ffmpeg(["-threads", THREADS, "-stream_loop", "3", "-i", loopUnit,
      "-map", "0:v", "-frames:v", String(main * 3), ...ENCODE, "-y", out]);
  } finally {
    await rm(loopUnit, { force: true });
  }
  return main * 3;
}

/**
 * Zpomalení pohybu zdroje.
 *
 * setpts=2*PTS zdvojnásobí dobu každého snímku, takže 5 s scéna zabere 10 s a
 * pohyb je poloviční. Důsledek pro opakování: za stejnou délku skladby se
 * projde jen polovina původního obsahu, takže scena "recykluje" v 6:18 videu
 * ~38× místo ~75×. Zvuk neřešíme, zdroj je beze zvuku.
 */
async function slowSource(source, out, factor) {
  await ffmpeg(["-threads", THREADS, "-i", source, "-vf", `setpts=${factor.toFixed(4)}*PTS,format=yuv420p`,
    "-r", String(FPS), ...ENCODE, "-y", out]);
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];

/**
 * Odložený výstup už existuje?
 *
 * Každý průchod je samostatný ffmpeg a na tomhle VM trvá minuty. Když ffmpeg
 * zabije OOM, worker zkusí práci zopakovat a bez tohoto by začal od průchodu
 * nula. Hotový soubor se proto pouze znovu použije.
 */
async function alreadyDone(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 1024;
  } catch {
    return false;
  }
}

/**
 * Plán v SNÍMKÁCH. Vrací průchody s `frames` (snímky zdroje) a plán spojů.
 * Délka průchodu v sekundách je frames / FPS (u A je frames/2 na půl cyklu).
 */
export function planLoop({ duration, frameCount, calm, seed }) {
  const rand = randomFor(seed);
  const totalFrames = Math.round(duration * FPS);
  // Počet průchodů roste s délkou pomalu, ne lineárně: krátká scéna si drží
  // současné rozmanité členění, dlouhý song dostane méně a delších průchodů.
  const targetPasses = Math.max(
    MIN_PASSES,
    Math.min(MAX_PASSES, Math.round(totalFrames / (FPS * 25))),
  );
  // Cílová délka průchodu v snímcích. Pro krátká videa (cíl do 360 snímků)
  // se drží původní BURSTS, tam je rozmanitost vyzkoušená. Dlouhé skladby
  // dostanou délku kolem cíle, jinak by jich bylo 30 místo 16.
  const targetBurst = totalFrames / targetPasses;
  const useTargetBurst = targetBurst > BURSTS[BURSTS.length - 1];
  // Každý přechod spotřebuje T snímků překryvu (xfade zkrátí spoj o T), takže
  // plán musí vyprodukovat o ΣT snímků navíc. Nejde to odhadnout předem, proto
  // se plán generuje několikrát, dokud součet nesedne na délku skladby.
  let budget = totalFrames;
  let passes = [];
  for (let attempt = 0; attempt < 14; attempt += 1) {
    passes = generatePasses({ budget, rand: randomFor(seed), frameCount, calm, useTargetBurst, targetBurst });
    const content = passes.reduce((sum, x) => sum + x.outFrames, 0)
      - passes.filter((x) => x.join === "blend").reduce((sum, x) => sum + x.joinFrames, 0);
    const deficit = totalFrames - content;
    if (Math.abs(deficit) <= 1) break;
    budget += deficit;
  }
  return passes;
}

function generatePasses({ budget, rand, frameCount, calm, useTargetBurst = false, targetBurst = 0 }) {
  const totalFrames = budget;
  const maxA = Math.max(2, Math.min(6, Math.round(totalFrames / (FPS * 25) / 3)));
  const maxOffset = Math.max(0, Math.min(frameCount - 8, 119));
  const calmSet = calm.filter((c) => c <= maxOffset);
  const calmUsable = calmSet.length ? calmSet : [0];
  const passes = [];
  let used = 0;
  let lastTech = null;
  let sameRun = 0;
  // Palindrom je nejlepší technika, ale jen když se do paměti vejde. Na dlouhé
  // skladbě se jí proto používá jen párkrát a vždy v krátkém provedení.
  let aCount = 0;

  while (totalFrames - used > FPS * 2) {
    // Délka průchodu: u krátkých vide z BURSTS, u dlouhých kolem cíle, aby jich
    // nebylo 30. Náhodnost zůstává na stable ID práce.
    const burst = useTargetBurst
      ? Math.max(FPS * 3, Math.round(targetBurst * (0.6 + rand() * 0.8)))
      : pick(rand, BURSTS);
    const room = totalFrames - used;
    const pool = sameRun >= 2 ? TECHNIQUES.filter((x) => x !== lastTech) : TECHNIQUES;
    let tech = pick(rand, pool);
    // A je palindrom: 'frames' je délka půlcyklu a ven jde dvojnásobek, aby
    // délka průchodu zůstala ve stejném rozmezí jako u B a C
    let frames = tech === "A" ? Math.max(FPS, Math.round(burst / 2)) : burst;
    if (tech === "A" && aCount >= maxA) {
      // Už padlo dost palindromů, dál půjde streamovací B nebo C.
      tech = lastTech === "B" ? "C" : "B";
      frames = burst;
    } else if (tech === "A" && frames > A_MAX_HALF) {
      // reverse drží půlcyklus v paměti, dlouhý by shodil ffmpeg přes OOM.
      // Palindrom tedy zůstane, ale jen v krátkém provedení.
      frames = A_MAX_HALF;
    }
    if (tech === "A") aCount += 1;
    const outFrames = tech === "A" ? frames * 2 : frames;
    if (room <= outFrames) {
      const shrunk = tech === "A" ? Math.max(8, Math.floor(room / 2)) : room;
      if (shrunk < FPS) break;
      if (tech === "A" && shrunk > A_MAX_HALF) shrunk = A_MAX_HALF;
      const outFrames = tech === "A" ? shrunk * 2 : shrunk;
      passes.push({
        tech, frames: shrunk, outFrames, startFrame: 0,
        zoom: 0.03, drift: 12, phase: 0,
        join: passes.length === 0 ? "start" : "cut", joinFrames: 0, fade: "fade", headBlur: 0,
      });
      used += outFrames;
      break;
    }
    passes.push({
      tech,
      frames,
      startFrame: 0,
      outFrames,
      zoom: Number((0.018 + rand() * 0.04).toFixed(4)),
      drift: pick(rand, [0, 6, 12, 18, 26]),
      phase: Number((rand() * 6.283).toFixed(3)),
      join: passes.length === 0 ? "start" : (rand() > 0.3 ? "blend" : "cut"),
      joinFrames: 0,
      fade: pick(rand, XFADES),
      headBlur: tech === "B" && rand() > 0.5 ? pick(rand, [4, 7, 11]) : 0,
    });
    sameRun = tech === lastTech ? sameRun + 1 : 1;
    lastTech = tech;
    used += passes[passes.length - 1].outFrames;
  }
  const rest = totalFrames - used;
  if (rest > FPS / 2) {
    passes.push({
      tech: "A", frames: Math.max(8, Math.round(rest / 2)), outFrames: rest, startFrame: 0,
      zoom: 0.03, drift: 12, phase: 0, join: "cut", joinFrames: 0, fade: "fade", headBlur: 0,
    });
  }

  // Offsety.
  //
  // 'cut'   → průchod prostě POKRAČUJE tam, kde předchozí skončil. Snímek na
  //            spoji je totožný, takže je to dokonale souvislé video a jediná
  //            změna je v tom, jak se s daným úsekem pracuje (počet snímků
  //            = rychlost, push-in, tlumení). Palindrom končí na svém prvním
  //            snímku, lineární průchod na posledním.
  // 'blend' → offset libovolný, protože spoj kryje xfade.
  const usable = Math.max(8, Math.min(frameCount - 8, 512));
  const endFrame = (pass) => (pass.tech === "A" ? pass.startFrame : pass.startFrame + pass.frames);
  passes[0].startFrame = 0;
  for (let i = 1; i < passes.length; i += 1) {
    passes[i].startFrame = passes[i].join === "cut"
      ? endFrame(passes[i - 1]) % usable
      : Math.max(0, Math.min(usable - 1, pick(rand, OFFSETS)));
  }
  for (let i = 1; i < passes.length - 1; i += 1) {
    if (passes[i + 1].join !== "cut") continue;
    if (passes[i + 1].tech !== "C") continue;
    if (passes[i].tech !== "A") continue;
    // Klidný bod se dá použít jen u C, který navazuje na PALINDROM. Palindrom
    // končí přesně na svém prvním snímku, takže stejný offset je opravdu
    // neviditelný spoj. U lineárního průchodu by to byl skok zpět na začátek,
    // takže tam musí zůstat souvislé pokračování.
    const calmFrame = pick(rand, calmUsable);
    passes[i].startFrame = calmFrame;
    passes[i + 1].startFrame = calmFrame;
  }
  // délka spojení nesmí přesáhnout ani jeden ze sousedních průchodů
  for (let i = 1; i < passes.length; i += 1) {
    const join = passes[i];
    if (join.join !== "blend") continue;
    const maxJoin = Math.min(join.outFrames, passes[i - 1].outFrames);
    const want = Math.round((0.8 + rand() * 1.3) * FPS);
    join.joinFrames = Math.max(12, Math.min(want, Math.floor(maxJoin * 0.4)));
  }
  return passes;
}

/**
 * Pomalý push-in a sinusový drift pro palindrom.
 *
 * Drift MUSÍ být v t=0 nulový. Kdyby začínal fází, první snímek by byl
 * posunutý a poslední snímek palindromu (který je zase první snímek) by byl
 * posunutý jinak, takže by na spoji byl tvrdý střih (naměřeno 45x median).
 */
function pushIn(segment) {
  return `scale=w='trunc(iw*(1+${segment.zoom}*t)/2)*2':h='trunc(ih*(1+${segment.zoom}*t)/2)*2':eval=frame,`
    + `setsar=1,crop=${W}:${H}:`
    + `x='(iw-ow)/2+${segment.drift}*sin(2*PI*t/5)':y='(ih-oh)/2'`;
}

const flat = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p`;

const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-r", String(FPS), "-profile:v", "high", "-level", "4.1",
  "-g", String(FPS * 2), "-keyint_min", String(FPS), "-sc_threshold", "0", "-an",
];

function loopsFor(needed, frameCount) {
  return Math.max(1, Math.ceil(needed / Math.max(1, frameCount)) + 1);
}

/**
 * Jeden průchod jako samostatný soubor (bez spojů).
 *
 * `extraOut` je rezerva snímků, kterou spoj před sebou sní (xfade spotřebuje
 * překryv z obou stran, jinak by výstup o to zkrátilo). Výstup je vždy přesně
 * `outFrames + extraOut` snímků, jinak házíme chybu místo tichého posunu.
 */
async function renderPass(segment, source, out, frameCount, extraOut = 0) {
  const target = segment.outFrames + extraOut;
  const blur = segment.headBlur ? `,gblur=sigma=${segment.headBlur}` : "";
  if (segment.tech === "A") {
    const half = Math.max(4, Math.round(target / 2));
    const need = segment.startFrame + half + 16;
    // end_frame je povinné: bez něj by větev A přehrála celý zdroj, reverse
    // by vrátil 2x víc snímků a -frames:v by odřízl konec palindromu. Pak by
    // poslední snímek nebyl prvním a spoj měl skok 45x medianu.
    const graph = `[0:v]trim=start_frame=${segment.startFrame}:end_frame=${segment.startFrame + half},`
      + `setpts=PTS-STARTPTS,${pushIn(segment)}[h];[h]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]`;
    await ffmpeg(["-threads", THREADS, "-stream_loop", String(loopsFor(need, frameCount)), "-i", source,
      "-filter_complex", graph, "-map", "[v]", "-frames:v", String(target), ...ENCODE, "-y", out]);
    return target;
  }
  const need = segment.startFrame + target + 16;
  // B a C jedou bez zoomu a driftu: jejich první snímek musí být přesně flat
  // snímek zdroje, aby navázal na libovolný předchozí průchod bez střihu.
  const graph = `[0:v]trim=start_frame=${segment.startFrame},setpts=PTS-STARTPTS,${flat}${blur}[v]`;
  await ffmpeg(["-threads", THREADS, "-stream_loop", String(loopsFor(need, frameCount)), "-i", source,
    "-filter_complex", graph, "-map", "[v]", "-frames:v", String(target), ...ENCODE, "-y", out]);
  return target;
}

/** Přechod mezi koncem předchozího průchodu a začátkem tohoto. */
async function renderJoin(previous, passFile, joinFile, join, previousFile) {
  const T = join.joinFrames;
  const tail = path.join(joinFile, "..", `.tail.${path.basename(joinFile)}`);
  const head = path.join(joinFile, "..", `.head.${path.basename(joinFile)}`);
  try {
    await ffmpeg(["-threads", THREADS, "-ss", ((previous.outFrames - T) / FPS).toFixed(4),
      "-i", previousFile, "-frames:v", String(T), ...ENCODE, "-y", tail]);
    await ffmpeg(["-threads", THREADS, "-i", passFile, "-frames:v", String(T), ...ENCODE, "-y", head]);
    await ffmpeg(["-threads", THREADS, "-i", tail, "-i", head,
      // offset=0: přechod začíná hned na prvním snímku ocádku (který navazuje
      // na useknutou část předchozího průchodu) a končí na posledním snímku
      // hlavy. Offset posunutý o D-1/fps by přetékal za konec prvního vstupu a
      // spoj by vyšel prázdný.
      "-filter_complex", `[0:v][1:v]xfade=transition=${join.fade}:duration=${(T / FPS).toFixed(4)}`
        + `:offset=0,format=yuv420p[v]`,
      "-map", "[v]", "-frames:v", String(T),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-r", String(FPS), "-profile:v", "high", "-level", "4.1",
      "-g", String(FPS * 2), "-keyint_min", String(FPS), "-sc_threshold", "0", "-an", "-y", joinFile]);
  } finally {
    await rm(tail, { force: true });
    await rm(head, { force: true });
  }
  return T;
}

/**
 * Sestaví celé video.
 * @param {{sourceVideo?: string, sourceImage?: string, audio: string, out: string,
 *          workDir: string, seed?: string|number, onProgress?: (l: string) => void}} options
 */
export async function buildLoopVideo(options) {
  const {
    sourceVideo, sourceImage, audio, out, workDir,
    seed = "songcraft", aspect = "16:9", onProgress = () => {},
  } = options;
  if (!sourceVideo && !sourceImage) throw new Error("loop engine potřebuje sourceVideo nebo sourceImage");
  if (!audio) throw new Error("loop engine potřebuje audio pro určení délky videa");
  if (aspect !== "16:9" && aspect !== "9:16") throw new Error(`neznámý poměr stran: ${aspect}`);
  await mkdir(workDir, { recursive: true });

  const duration = await probeDuration(audio);
  let source = sourceVideo;
  if (!source) {
    source = path.join(workDir, "base.mp4");
    await ffmpeg([
      "-threads", THREADS, "-loop", "1", "-framerate", String(FPS), "-i", sourceImage,
      "-vf", `${flat},zoompan=z='min(zoom+0.0018,1.10)':d=1:`
        + `x='iw/2-(iw/zoom/2)+16*sin(2*PI*on/120)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`,
      "-frames:v", String(FPS * 5), ...ENCODE, "-y", source,
    ]);
  }
  // Zpomalení jde PŘED seamless základem, aby se celý engine pracoval s
  // pomalejším pohybem a počet průchodů přirozeně klesl.
  const slowdown = Math.max(1, Math.min(4, Number(options.slowdown ?? 2)));
  if (slowdown > 1) {
    const slowed = path.join(workDir, "slow.mp4");
    await slowSource(source, slowed, slowdown);
    source = slowed;
    onProgress(`pohyb zpomalen ${slowdown}x`);
  }
  const rawFrameCount = await probeFrameCount(source);
  // Průchody jedou přes seamless zdroj, jinak se lineární průchod delší než
  // zbytek zdroje zasekne o tvrdý skok přes konec klipu.
  const smooth = path.join(workDir, "smooth.mp4");
  const frameCount = await buildSeamlessBase(source, smooth, rawFrameCount);
  source = smooth;
  const calm = (await calmFrames(source, 10)).filter((c) => c < frameCount);
  onProgress(`seamless zdroj: ${rawFrameCount} -> ${frameCount} snímků (crossfade smyčka x3)`);
  const passes = planLoop({ duration, frameCount, calm, seed });
  const counts = passes.reduce((a, p) => ({ ...a, [p.tech]: (a[p.tech] || 0) + 1 }), {});
  const blends = passes.filter((p) => p.join === "blend").length;
  onProgress(`plán: ${passes.length} průchodů na ${duration.toFixed(2)} s `
    + `(A=${counts.A || 0} B=${counts.B || 0} C=${counts.C || 0}) · spojů: ${blends} blend, `
    + `${passes.filter((p) => p.join === "cut").length} tvrdý · zdroj ${frameCount} snímků`);

  // Žádná rezerva: přechod zpracovává T posledních snímků průchodu i a T
  // prvních snímků průchodu i+1 a vyprodukuje z nich T snímků. Zbytek průchodu
  // i+1 se proto orezává až za hlavou, ne od začátku.
  // Uložené průchody patří konkrétnímu plánu. Když se plán shoduje, použijí se
  // znovu a render po OOM naváže; když se změnil, staré soubory by byly jiné
  // a musí pryč. Dřív se tu mazalo všechno vždy, takže checkpoint nikdy neplatil.
  const fingerprint = createHash("sha256").update(JSON.stringify(passes)).digest("hex").slice(0, 16);
  const marker = path.join(workDir, "plan.sha");
  const previous = String(await readFile(marker, "utf8").catch(() => "")).trim();
  if (previous === fingerprint) {
    const kept = (await readdir(workDir)).filter((f) => /^pass\d+\.mp4$/.test(f)).length;
    if (kept) onProgress(`pokračuji, plán beze změny, ${kept} průchodů už na disku`);
  } else {
    if (previous) onProgress("plán se změnil, čistím staré průchody");
    for (const file of await readdir(workDir)) {
      if (/^(pass|part)\w*\d+\.mp4$/.test(file)) await rm(path.join(workDir, file), { force: true });
    }
    await writeFile(marker, fingerprint);
  }

  const passesFiles = [];
  const startedAt = Date.now();
  const deadlineMs = duration * 4 * 60_000 + 10 * 60_000;
  for (let i = 0; i < passes.length; i += 1) {
    const pass = passes[i];
    const file = path.join(workDir, `pass${String(i).padStart(3, "0")}.mp4`);
    if (await alreadyDone(file)) {
      passesFiles.push(file);
      onProgress(`  [${i + 1}/${passes.length}] ${pass.tech} použito z disku`);
      continue;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > deadlineMs) {
      throw new Error(`překročen časový limit ${(deadlineMs / 60_000).toFixed(0)} min `
        + `na průchodu ${i + 1}/${passes.length}`);
    }
    const produced = await renderPass(pass, source, file, frameCount);
    if (produced !== pass.outFrames) {
      throw new Error(`průchod ${i} (${pass.tech}) vyrobil ${produced} snímků, plán počítal ${pass.outFrames}`);
    }
    passesFiles.push(file);
    onProgress(`  [${i + 1}/${passes.length}] ${pass.tech} start=${pass.startFrame} `
      + `snímků=${pass.frames} (${(pass.outFrames / FPS).toFixed(2)} s) spoj=${pass.join}`
      + (pass.join === "blend" ? ` ${pass.fade} ${(pass.joinFrames / FPS).toFixed(2)} s` : ""));
  }

  // xfade NAHRAZUJE posledních T snímků prvního vstupu a prvních T druhého.
  // Kdyby se to neořízlo, na začátku přechodu je skok o T-1 snímků pohybu
  // (naměřeno 13-45x median). Proto u obou sousedů odřízneme překryv.
  const parts = [];
  for (let i = 0; i < passes.length; i += 1) {
    const pass = passes[i];
    const incoming = i > 0 && pass.join === "blend" ? pass.joinFrames : 0;
    const outgoing = i < passes.length - 1 && passes[i + 1].join === "blend" ? passes[i + 1].joinFrames : 0;
    const keep = pass.outFrames - incoming - outgoing;
    if (keep <= 0) throw new Error(`průchod ${i} má po oříznutí spojů ${keep} snímků`);
    if (keep === pass.outFrames) {
      parts.push(passesFiles[i]);
    } else {
      const middle = path.join(workDir, `part${String(i).padStart(3, "0")}mid.mp4`);
      await ffmpeg(["-threads", THREADS, "-i", passesFiles[i],
        "-vf", `trim=start_frame=${incoming}:end_frame=${incoming + keep},setpts=PTS-STARTPTS`,
        "-frames:v", String(keep), ...ENCODE, "-y", middle]);
      parts.push(middle);
    }
    if (outgoing) {
      const joinFile = path.join(workDir, `part${String(i).padStart(3, "0")}join.mp4`);
      await renderJoin(passes[i], passesFiles[i + 1], joinFile, passes[i + 1], passesFiles[i]);
      parts.push(joinFile);
    }
  }

  const list = path.join(workDir, "segments.txt");
  await writeFile(list, parts.map((f) => `file '${f}'\n`).join(""));
  const joined = path.join(workDir, "joined.mp4");
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  // Průchody se vždy skládají na 16:9 pracovní ploše, aby obě varianty měly
  // stejný vstup. Cílový poměr stran se řeší až tady, jedním průchodem.
  const vertical = aspect === "9:16";
  const dims = vertical ? { w: 1080, h: 1920 } : { w: W, h: H };
  // celý graf včetně vstupních labelů, jinak se vstup vloží dvakrát
  const fit = vertical
    ? `[0:v]split=2[fg][bg];`
      + `[bg]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=increase,crop=${dims.w}:${dims.h},`
      + `gblur=sigma=24,eq=brightness=-0.14:saturation=0.55[bgb];`
      + `[fg]scale=${dims.w}:-2,pad=${dims.w}:${dims.h}:(ow-iw)/2:(oh-ih)/2:color=black[fgp];`
      + `[bgb][fgp]overlay=0:0,format=yuv420p[v]`
    : `[0:v]null[v]`; // 16:9 graf nepoužíváme, streamcopy s ním nesmí
  // Pro 16:9 se žádný filtr nepoužije: streamcopy a filtergraph se nesmí
  // kombinovat ("Streamcopy requested for output stream fed from a complex
  // filtergraph"). Pro 9:16 jde přes graf a video se překóduje.
  await ffmpeg(["-y", "-i", joined, "-i", audio,
    ...(vertical
      ? ["-filter_complex", fit, "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-r", String(FPS)]
      : ["-map", "0:v", "-map", "1:a", "-c:v", "copy"]),
    "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  if (process.env.LOOP_KEEP_SEGMENTS !== "1") {
    for (const file of parts) await rm(file, { force: true });
  }
  return { out, duration, passes, aspect, slowdown };
}

if (process.argv[1] && process.argv[1].endsWith("loop-engine.mjs")) {
  const [, , input, audio, out, seed] = process.argv;
  if (!input || !audio || !out) {
    console.error("použití: node loop-engine.mjs <video|obraz> <audio> <výstup.mp4> [seed]");
    process.exit(2);
  }
  const isVideo = /\.(mp4|mov|m4v|webm|mkv)$/i.test(input);
  const aspect = process.env.LOOP_ASPECT === "9:16" ? "9:16" : "16:9";
  const slowdown = Number(process.env.LOOP_SLOWDOWN || 2);
  const result = await buildLoopVideo({
    sourceVideo: isVideo ? input : undefined,
    sourceImage: isVideo ? undefined : input,
    audio, out, aspect, slowdown,
    workDir: path.join(path.dirname(out), ".loop-work"),
    seed: seed || "cli",
    onProgress: (line) => console.log(line),
  });
  console.log(`hotovo: ${result.out} (${result.duration.toFixed(2)} s, ${result.passes.length} průchodů, `
    + `${result.aspect}, zpomalení ${result.slowdown}x)`);
}
