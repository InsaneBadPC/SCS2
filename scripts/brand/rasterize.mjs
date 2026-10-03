#!/usr/bin/env node
/**
 * ============================================================================
 * SCS2 — rasterizace značky do PNG (čistý Node, nulové závislosti)
 * ============================================================================
 *
 * CO TO JE
 * --------
 * Generuje všechny bitmapy, které Expo build skutečně spotřebuje:
 * aplikační ikonu, favicon, splash ikonu a trojici adaptivních
 * ikon pro Android. Každý obrázek pochází z jediného zdroje
 * pravdy — `scripts/brand/geometry.mjs`. Žádný rastr se
 * nekreslí ručně a žádná externí knihovna se nepoužívá.
 *
 * JAK TO FUNGUJE
 * --------------
 * 1. Každý výstup se kreslí v rozlišení SS× výstupu (supersampling)
 *    a pak se zmenší box downsamplem SS×SS — tím vznikne antialiasing.
 * 2. Pás (ribbon) se plní SWEEP EM SCANLINE: pro každý řádek se
 *    spočítají průsečíky hran, seřadí se podle x a mezi spárovanými
 *    průsečíky se vyplní rozsah (sudě-liché pravidlo; pás je jeden
 *    jednoduchý uzavřený prstenec). Vrcholový atribut `t` se přenáší
 *    po hraně a interpoluje lineárně přes rozsah — pásmo tak dostane
 *    hladký gradient cyan → #5FF3FF → oranž podél své délky.
 *    Složitost je O(řádků × průsečíků na řádku), nikoli O(pixelů
 *    × vrcholů) — to je důvod, proč tohle běží, kde per-pixel
 *    distance-test proti 1502 vrcholům visí.
 * 3. Kruhy se kreslí spanem na řádek (dx = sqrt(r² − dy²)).
 *    Zaoblený obdélník má na řádku jeden rozsah s rohem "vepsaným"
 *    do hranice. Lem štítku vzniká odchylkou: zaoblený obdélník se
 *    vyplní do masky a 1px zasunutá kopie se z ní vymaže.
 * 4. Vrstvy se skládají v pořadí: štítek (šikmý gradient) →
 *    cyanové světlo → oranžové světlo → lem → pás → koule s
 *    prstencem → jiskry. Každá vrstva se alpha-blenduje
 *    (neprůhledné vrstvy píší rovnou, průsvitné blendují).
 * 5. PNG kóduje tento skript sám: 8B signatura, IHDR (8 bit,
 *    typ 6 = RGBA), jeden IDAT (řádky s filtrem 0) a IEND.
 *    Jediná závislost je vestavěné `node:zlib` (deflateSync)
 *    a ruční CRC32.
 *
 * PAMĚŤ
 * -----
 * Maska 3072² je 9,4 MB. Skript proto drží PEVNÝ POOL dvou masek
 * a přepočítává je, nikdy neakumuluje masku na vrstvu.
 *
 * POUŽITÍ
 * -------
 *   node scripts/brand/rasterize.mjs
 *
 * Výstup je deterministní: stejné vstupy dají bajtově identické PNG.
 * ============================================================================
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  BADGE,
  BADGE_RIM,
  CANVAS,
  NODE,
  SPARKS,
  gradientAt,
  hexToRgb,
  markTransform,
  ribbonPolygon,
} from "./geometry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "assets", "images");

const WHITE = { r: 255, g: 255, b: 255 };

/* --- PNG encoder (signatura, IHDR, IDAT, IEND, ruční CRC32) ---------- */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA (8 bit, typ 6) → PNG. Jeden IDAT, řádky s filtrem 0. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // hloubka: 8 bitů na kanál
  ihdr[9] = 6; // typ barvy: 6 = RGBA
  ihdr[10] = 0; // komprese: deflate
  ihdr[11] = 0; // filtr: adaptivní (řádkové bajty nesou typ 0)
  ihdr[12] = 0; // prokládání: žádné

  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // typ filtru: None
    offset += 1;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), offset);
    offset += stride;
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --- Pixelové jádro --------------------------------------------------- */

/** Src-over blending jednoho pixelu. `sa` je konečné zdrojové alfa 0..1. */
function blendOne(pixels, p, r, g, b, sa) {
  if (sa <= 0) return;
  const da = pixels[p + 3] / 255;
  const out = sa + da * (1 - sa);
  if (out <= 0) return;
  const inv = 1 / out;
  pixels[p] = Math.round((r * sa + pixels[p] * da * (1 - sa)) * inv);
  pixels[p + 1] = Math.round((g * sa + pixels[p + 1] * da * (1 - sa)) * inv);
  pixels[p + 2] = Math.round((b * sa + pixels[p + 2] * da * (1 - sa)) * inv);
  pixels[p + 3] = Math.round(out * 255);
}

/**
 * Plátno v rozlišení SS× výstupu. `pixels` je RGBA (straight alpha),
 * `masks` je pevný pool dvou krycích masek, který se přepočítává.
 */
function createCanvas(size, ss) {
  const sw = size * ss;
  const sh = size * ss;
  const pixels = Buffer.alloc(sw * sh * 4);
  const masks = [new Uint8Array(sw * sh), new Uint8Array(sw * sh)];
  let cursor = 0;
  return {
    sw,
    sh,
    pixels,
    nextMask() {
      const mask = masks[cursor];
      cursor = (cursor + 1) % masks.length;
      mask.fill(0);
      return mask;
    },
  };
}

/** Vodorovný rozsah zaobleného obdélníku na řádku `row`, nebo null. */
function roundedRectSpan(row, x0, y0, w, h, radius) {
  const y = row + 0.5 - y0;
  if (y < 0 || y > h) return null;
  let inset = 0;
  if (y < radius) {
    const d = radius - y;
    inset = radius - Math.sqrt(Math.max(0, radius * radius - d * d));
  } else if (y > h - radius) {
    const d = y - (h - radius);
    inset = radius - Math.sqrt(Math.max(0, radius * radius - d * d));
  }
  return [x0 + inset, x0 + w - inset];
}

/** Rozsah rohům: pixely se středem uvnitř [xa, xb], oříznuto na plátno. */
function spanPixels(xa, xb, sw) {
  return [Math.max(0, Math.ceil(xa - 0.5)), Math.min(sw - 1, Math.floor(xb - 0.5))];
}

/* --- Vrstvy ------------------------------------------------------------ */

/** Štítek: zaoblený obdélník přes celé plátno, šikmý gradient A → B. */
function writeBadgeTile(pixels, sw, sh) {
  const radius = BADGE.radius * sw;
  const a = hexToRgb(BADGE.fillA);
  const b = hexToRgb(BADGE.fillB);
  for (let row = 0; row < sh; row += 1) {
    const span = roundedRectSpan(row, 0, 0, sw, sh, radius);
    if (!span) continue;
    const [x0, x1] = spanPixels(span[0], span[1], sw);
    const base = row * sw;
    for (let x = x0; x <= x1; x += 1) {
      // Parametr šikmého gradientu (x1=y1=0 → x2=y2=1 v bbox): projekce na diagonálu.
      const f = (x + 0.5 + (row + 0.5)) / (2 * sw);
      const p = (base + x) * 4;
      pixels[p] = Math.round(a[0] + (b[0] - a[0]) * f);
      pixels[p + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
      pixels[p + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
      pixels[p + 3] = 255;
    }
  }
}

/** Zářivé světlo štítku: konstantní barva, alfa klesá po zastaveních 0 / 0.55 / 1.
 *  Světla jsou uříznutá štítkem — `clip` je krycí maska zaobleného obdélníku. */
function blendGlow(pixels, sw, sh, glow, clip) {
  const cx = glow.center[0] * sw;
  const cy = glow.center[1] * sh;
  const r = glow.radius * sw;
  const [cr, cg, cb] = hexToRgb(glow.color);
  const x0 = Math.max(0, Math.ceil(cx - r - 0.5));
  const x1 = Math.min(sw - 1, Math.floor(cx + r - 0.5));
  const y0 = Math.max(0, Math.ceil(cy - r - 0.5));
  const y1 = Math.min(sh - 1, Math.floor(cy + r - 0.5));
  for (let row = y0; row <= y1; row += 1) {
    const dy = row + 0.5 - cy;
    const base = row * sw;
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d >= 1) continue;
      const i = base + x;
      const clipped = clip[i];
      if (clipped === 0) continue;
      const fall = d <= 0.55 ? 1 - 0.5 * (d / 0.55) : 0.5 * (1 - (d - 0.55) / 0.45);
      blendOne(pixels, i * 4, cr, cg, cb, glow.alpha * fall * (clipped / 255));
    }
  }
}

/** Vyplní (příbo vymaže) zaoblený obdélník v masce. */
function fillRoundedRectMask(mask, sw, sh, x0, y0, w, h, radius, value) {
  for (let row = 0; row < sh; row += 1) {
    const span = roundedRectSpan(row, x0, y0, w, h, radius);
    if (!span) continue;
    const [x0px, x1px] = spanPixels(span[0], span[1], sw);
    const base = row * sw;
    for (let x = x0px; x <= x1px; x += 1) mask[base + x] = value;
  }
}

/**
 * Světla a vnitřní lem štítku sdílejí jednu masku: nejprve se
 * vyplní zaoblený obdélník (to je zároveň řez světel), pak se
 * z masky vymaže 1px zasunutá kopie — zbylý pruh je lem.
 */
function drawGlowsAndRim(canvas) {
  const { sw, sh, pixels } = canvas;
  const ss = sw / CANVAS;
  const mask = canvas.nextMask();
  const radius = BADGE.radius * sw;
  fillRoundedRectMask(mask, sw, sh, 0, 0, sw, sh, radius, 255);
  blendGlow(pixels, sw, sh, BADGE.glows[0], mask);
  blendGlow(pixels, sw, sh, BADGE.glows[1], mask);
  const inset = BADGE_RIM.width * ss;
  fillRoundedRectMask(mask, sw, sh, inset, inset, sw - 2 * inset, sh - 2 * inset, radius - inset, 0);
  const [rr, rg, rb] = hexToRgb(BADGE_RIM.color);
  const total = sw * sh;
  for (let i = 0; i < total; i += 1) {
    if (mask[i] === 0) continue;
    blendOne(pixels, i * 4, rr, rg, rb, BADGE_RIM.alpha);
  }
}

/**
 * Pás: scanline sweep uzavřeného mnohoúhelníku. Průsečíky hran s
 * řádkem se seřadí, rozsahy se vyplní mezi spárovanými průsečíky
 * (sudě-liché). Atribut `t` se interpoluje přes rozsah, takže
 * gradient běží podél délky pásu, ne jen po jeho ose.
 */
function writeRibbon(pixels, sw, sh, pts, mono) {
  const n = pts.length;
  const crossX = new Float64Array(n);
  const crossT = new Float64Array(n);
  for (let row = 0; row < sh; row += 1) {
    const y = row + 0.5;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const ay = a.y;
      const by = b.y;
      if (ay === by) continue;
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const f = (y - ay) / (by - ay);
        crossX[count] = a.x + (b.x - a.x) * f;
        crossT[count] = a.t + (b.t - a.t) * f;
        count += 1;
      }
    }
    if (count < 2) continue;
    // Průsečíků na řádku je vždy málo → insertion sort.
    for (let i = 1; i < count; i += 1) {
      const xk = crossX[i];
      const tk = crossT[i];
      let j = i - 1;
      while (j >= 0 && crossX[j] > xk) {
        crossX[j + 1] = crossX[j];
        crossT[j + 1] = crossT[j];
        j -= 1;
      }
      crossX[j + 1] = xk;
      crossT[j + 1] = tk;
    }
    for (let i = 0; i + 1 < count; i += 2) {
      const xa = crossX[i];
      const xb = crossX[i + 1];
      const ta = crossT[i];
      const tb = crossT[i + 1];
      const [x0, x1] = spanPixels(xa, xb, sw);
      const span = xb - xa;
      const base = row * sw;
      for (let x = x0; x <= x1; x += 1) {
        const f = span > 0 ? (x + 0.5 - xa) / span : 0;
        const t = ta + (tb - ta) * f;
        const c = mono ? WHITE : gradientAt(t);
        const p = (base + x) * 4;
        pixels[p] = c.r;
        pixels[p + 1] = c.g;
        pixels[p + 2] = c.b;
        pixels[p + 3] = 255;
      }
    }
  }
}

/** Kruh: scanline span fill, dx = sqrt(r² − dy²). */
function blendCircle(pixels, sw, sh, cx, cy, r, color, alpha) {
  const y0 = Math.max(0, Math.ceil(cy - r - 0.5));
  const y1 = Math.min(sh - 1, Math.floor(cy + r - 0.5));
  for (let row = y0; row <= y1; row += 1) {
    const dy = row + 0.5 - cy;
    const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    const [x0, x1] = spanPixels(cx - dx, cx + dx, sw);
    const base = row * sw;
    for (let x = x0; x <= x1; x += 1) {
      blendOne(pixels, (base + x) * 4, color.r, color.g, color.b, alpha);
    }
  }
}

/* --- Zmenšení SS× → výstupní rozlišení -------------------------------- */

/**
 * Box downsample SS×SS s korektním alpha: scitáme premultiplied
 * kanály, pak depremultiplikujeme — barvy na antialiasovaných
 * hranách neztmavnou.
 */
function downsample(pixels, sw, sh, size, ss) {
  const out = Buffer.alloc(size * size * 4);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < size; y += 1) {
    const rowBase = y * ss;
    for (let x = 0; x < size; x += 1) {
      const colBase = x * ss;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < ss; dy += 1) {
        let p = ((rowBase + dy) * sw + colBase) * 4;
        for (let dxc = 0; dxc < ss; dxc += 1, p += 4) {
          const alpha = pixels[p + 3];
          r += pixels[p] * alpha;
          g += pixels[p + 1] * alpha;
          b += pixels[p + 2] * alpha;
          a += alpha;
        }
      }
      if (a > 0) {
        const o = (y * size + x) * 4;
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a * inv);
      }
    }
  }
  return out;
}

/* --- Kompozice --------------------------------------------------------- */

/**
 * Režimy:
 *  - "badge"  celý štítek: podklad, světla, lem, značka v měřítku BADGE_SCALE
 *  - "mark"   jen značka, průhledné pozadí, bezpečná zóna adaptivní ikony
 *  - "tile"   jen tmavý šikmý podklad adaptivní ikony (žádná značka)
 *
 * `mono` vynutí bílou barvu všech značkových vrstev (Android si
 * monochromní ikonu odbarvuje sám), alfa zůstává beze změny.
 */
function renderImage(spec) {
  const { size, ss, mode, mono = false } = spec;
  const canvas = createCanvas(size, ss);
  const { sw, sh, pixels } = canvas;
  const k = sw / CANVAS;

  // Značka je v štítku zmenšená na BADGE_SCALE, v adaptivní ikoně
  // na safeScale() — obojí z geometry, aby PNG a vektor seděly na sobě.
  const transform = markTransform(mode === "mark" ? "foreground" : "badge");
  const toPx = (x, y) => [
    (x * transform.scale + transform.translate[0]) * k,
    (y * transform.scale + transform.translate[1]) * k,
  ];
  const toLen = (d) => d * transform.scale * k;
  const paint = (hex) => (mono ? WHITE : { r: hexToRgb(hex)[0], g: hexToRgb(hex)[1], b: hexToRgb(hex)[2] });

  if (mode !== "mark") writeBadgeTile(pixels, sw, sh);
  if (mode === "badge") drawGlowsAndRim(canvas);

  // Režim "tile" kreslí jen podklad — značka není.
  if (mode !== "tile") {
    const ribbon = ribbonPolygon();
    const pts = ribbon.points.map((p) => {
      const [x, y] = toPx(p.x, p.y);
      return { x, y, t: p.t };
    });
    writeRibbon(pixels, sw, sh, pts, mono);

    // Nahrávací kapsle: plná koule, pak oranžový prstenec.
    const [nx, ny] = toPx(NODE.center[0] * CANVAS, NODE.center[1] * CANVAS);
    const nodeR = toLen((NODE.diameter * CANVAS) / 2);
    blendCircle(pixels, sw, sh, nx, ny, nodeR, paint(NODE.fill), 1);
    blendCircle(pixels, sw, sh, nx, ny, nodeR * NODE.ringScale, paint(NODE.ring), mono ? 1 : NODE.ringAlpha);

    // Jiskry: signál, který už putuje do stroje.
    for (const spark of SPARKS) {
      const [sx, sy] = toPx(spark.center[0] * CANVAS, spark.center[1] * CANVAS);
      blendCircle(pixels, sw, sh, sx, sy, toLen(spark.radius * CANVAS), paint(spark.fill), mono ? 1 : spark.alpha);
    }
  }

  return downsample(pixels, sw, sh, size, ss);
}

/* --- Výstupy ---------------------------------------------------------- */

const OUTPUTS = [
  { file: "icon.png", size: 1024, ss: 3, mode: "badge" },
  { file: "favicon.png", size: 512, ss: 3, mode: "badge" },
  { file: "splash-icon.png", size: 512, ss: 3, mode: "mark" },
  { file: "android-icon-foreground.png", size: 1024, ss: 3, mode: "mark" },
  { file: "android-icon-background.png", size: 1024, ss: 3, mode: "tile" },
  { file: "android-icon-monochrome.png", size: 432, ss: 4, mode: "mark", mono: true },
];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ribbon = ribbonPolygon();
  console.log(`pás: ${ribbon.count} vrcholů, měřítka: badge ${markTransform("badge").scale}, foreground ${markTransform("foreground").scale}`);
  for (const spec of OUTPUTS) {
    const rgba = renderImage(spec);
    const png = encodePng(spec.size, spec.size, rgba);
    writeFileSync(join(OUT_DIR, spec.file), png);
    console.log(`OK  ${spec.file.padEnd(28)} ${String(png.length).padStart(7)} B  ${spec.size}×${spec.size}  SS=${spec.ss}  ${spec.mode}${spec.mono ? "+mono" : ""}`);
  }
}

main();
