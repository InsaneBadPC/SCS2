#!/usr/bin/env node

/**
 * Generuje `assets/brand/scs2-mark.svg` a `assets/brand/scs2-mark-only.svg`
 * z `scripts/brand/geometry.mjs`.
 *
 * Spustit po JAKÉKOLI změně geometrie:
 *
 *     node scripts/brand/write-svg.mjs
 *
 * Tady se nikdy nekreslí ani neenkódují pixely - jen se z geometrie složí
 * značky SVG a na konci se oba výstupy ověří vlastní kontrolou struktury XML.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BADGE,
  BADGE_RECT,
  BADGE_RIM,
  CANVAS,
  GRADIENT_AXIS,
  GRADIENT_STOPS,
  MONOCHROME,
  NODE,
  PALETTE,
  SPARKS,
  markTransform,
  ribbonPolygon,
} from "./geometry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "assets", "brand");

/** Číslo bez plovoucího odrazu - v SVG je zbytečná hmotnost. */
function num(value) {
  return Number(value.toFixed(2));
}

/* --- Značky --------------------------------------------------------------- */

const TITLE = "SCS2 — znak SongCraft Studio";
const DESC_BADGE =
  "Zaoblený tmavý štítek se dvěma barevnými světly. Uprostřed kosý pás tvořený písmenem S, " +
  "který se zároveň čte jako zvuková vlna: začíná cyanově nahoře vpravo, v nejširším místě " +
  "přechází přes světlou modrou a končí oranžově. Na jeho spodním konci sedí plná žlutá koule " +
  "v oranžovém prstenci — nahrávací kapsle mikrofonu. Za ní odlétají tři zmenšující se jiskry, " +
  "signál, který už putuje do stroje.";
const DESC_MARK =
  "Samotný znak bez štítku, průhledné pozadí. Kosý pás tvořený písmenem S, který se zároveň čte " +
  "jako zvuková vlna: cyan na začátku, světlá modrá v pasu, oranž na konci. Spodní konec zakončuje " +
  "plná žlutá koule v oranžovém prstenci — nahrávací kapsle mikrofonu — a za ní tři " +
  "zmenšující se jiskry, signál, který už putuje do stroje.";

/** Všechny kruhy, co něco kreslíme: koule a jiskry v pixelech. */
function circles() {
  const nodeX = num(NODE.center[0] * CANVAS);
  const nodeY = num(NODE.center[1] * CANVAS);
  const nodeR = num((NODE.diameter * CANVAS) / 2);
  const ringR = num(nodeR * NODE.ringScale);

  const node =
    `    <circle cx="${nodeX}" cy="${nodeY}" r="${nodeR}" fill="${NODE.fill}"/>\n` +
    `    <circle cx="${nodeX}" cy="${nodeY}" r="${ringR}" fill="${NODE.ring}" fill-opacity="${NODE.ringAlpha}"/>`;

  const sparks = SPARKS.map((s) => {
    const cx = num(s.center[0] * CANVAS);
    const cy = num(s.center[1] * CANVAS);
    const r = num(s.radius * CANVAS);
    return `    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.fill}" fill-opacity="${s.alpha}"/>`;
  }).join("\n");

  return `${node}\n${sparks}`;
}

/** Pás jako jediný uzavřený `<path>`. */
function ribbonPath(monochrome) {
  const ribbon = ribbonPolygon();
  const fill = monochrome ? MONOCHROME : "url(#scs2-ribbon)";
  const attrs = monochrome ? ' fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linejoin="round"' : ` fill="${fill}"`;
  // `d` je zalomený na řádky - bílé znaky v něm jsou v XML nepodstatné.
  const d = ribbon.d.replace(/\n/g, "\n      ");
  return `    <path\n      d="${d}"${attrs}/>`;
}

/* --- Oba výstupy --------------------------------------------------------- */

function buildBadgeSvg() {
  const ribbon = ribbonPath(false);
  const rim = BADGE_RIM;
  const inset = rim.width / 2;
  const transform = markTransform("badge").svg;
  const glows = BADGE.glows
    .map((g, i) => {
      const cx = num(g.center[0] * CANVAS);
      const cy = num(g.center[1] * CANVAS);
      const r = num(g.radius * CANVAS);
      return (
        `    <radialGradient id="scs2-glow-${i + 1}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">\n` +
        `      <stop offset="0" stop-color="${g.color}" stop-opacity="${g.alpha}"/>\n` +
        `      <stop offset="0.55" stop-color="${g.color}" stop-opacity="${num(g.alpha / 2)}"/>\n` +
        `      <stop offset="1" stop-color="${g.color}" stop-opacity="0"/>\n` +
        `    </radialGradient>`
      );
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" role="img" aria-labelledby="scs2-mark-title scs2-mark-desc">
  <title id="scs2-mark-title">${TITLE}</title>
  <desc id="scs2-mark-desc">${DESC_BADGE}</desc>
  <defs>
    <linearGradient id="scs2-badge-fill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BADGE.fillA}"/>
      <stop offset="1" stop-color="${BADGE.fillB}"/>
    </linearGradient>
${glows}
    <linearGradient id="scs2-ribbon" gradientUnits="userSpaceOnUse" x1="${num(GRADIENT_AXIS.x1)}" y1="${num(GRADIENT_AXIS.y1)}" x2="${num(GRADIENT_AXIS.x2)}" y2="${num(GRADIENT_AXIS.y2)}">
${GRADIENT_STOPS.map((s) => `      <stop offset="${num(s.t)}" stop-color="${s.color}"/>`).join("\n")}
    </linearGradient>
    <clipPath id="scs2-badge-clip">
      <rect x="${BADGE_RECT.x}" y="${BADGE_RECT.y}" width="${BADGE_RECT.width}" height="${BADGE_RECT.height}" rx="${BADGE_RECT.rx}"/>
    </clipPath>
  </defs>
  <rect x="${BADGE_RECT.x}" y="${BADGE_RECT.y}" width="${BADGE_RECT.width}" height="${BADGE_RECT.height}" rx="${BADGE_RECT.rx}" fill="url(#scs2-badge-fill)"/>
  <g clip-path="url(#scs2-badge-clip)">
${BADGE.glows.map((g, i) => {
  const cx = num(g.center[0] * CANVAS);
  const cy = num(g.center[1] * CANVAS);
  const r = num(g.radius * CANVAS);
  return `    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#scs2-glow-${i + 1})"/>`;
}).join("\n")}
  </g>
  <rect x="${num(inset)}" y="${num(inset)}" width="${num(BADGE_RECT.width - rim.width)}" height="${num(BADGE_RECT.height - rim.width)}" rx="${num(BADGE_RECT.rx - rim.width)}" fill="none" stroke="${rim.color}" stroke-opacity="${rim.alpha}" stroke-width="${rim.width}"/>
  <g transform="${transform}">
${ribbon}
${circles()}
  </g>
</svg>
`;
}

function buildMarkOnlySvg() {
  const ribbon = ribbonPath(false);
  const transform = markTransform("foreground").svg;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" role="img" aria-labelledby="scs2-only-title scs2-only-desc">
  <title id="scs2-only-title">${TITLE}</title>
  <desc id="scs2-only-desc">${DESC_MARK}</desc>
  <defs>
    <linearGradient id="scs2-ribbon" gradientUnits="userSpaceOnUse" x1="${num(GRADIENT_AXIS.x1)}" y1="${num(GRADIENT_AXIS.y1)}" x2="${num(GRADIENT_AXIS.x2)}" y2="${num(GRADIENT_AXIS.y2)}">
${GRADIENT_STOPS.map((s) => `      <stop offset="${num(s.t)}" stop-color="${s.color}"/>`).join("\n")}
    </linearGradient>
  </defs>
  <g transform="${transform}">
${ribbon}
${circles()}
  </g>
</svg>
`;
}

/* --- Kontrola struktury XML ---------------------------------------------- */

const ENTITIES = /^(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+)$/;

/**
 * Zkontroluje atributy značky: v XML je každý musí mít hodnotu v uvozovkách,
 * jinak je dokument špatně zformovaný. Vrací seznam nálezů.
 */
function checkAttributes(region, tagName, line) {
  const problems = [];
  let p = 0;
  while (p < region.length) {
    while (p < region.length && /\s/.test(region[p])) p += 1;
    if (p >= region.length || region[p] === "/") break;

    const nameStart = p;
    while (p < region.length && !/[\s=/>]/.test(region[p])) p += 1;
    const attrName = region.slice(nameStart, p);
    if (!attrName) {
      problems.push(`řádek ${line}: neočekávaný znak v atributech <${tagName}>`);
      break;
    }

    while (p < region.length && /\s/.test(region[p])) p += 1;
    if (region[p] !== "=") {
      problems.push(`řádek ${line}: atribut "${attrName}" v <${tagName}> nemá hodnotu`);
      continue;
    }
    p += 1;
    while (p < region.length && /\s/.test(region[p])) p += 1;
    const quote = region[p];
    if (quote !== '"' && quote !== "'") {
      problems.push(`řádek ${line}: hodnota atributu "${attrName}" v <${tagName}> není v uvozovkách`);
      while (p < region.length && region[p] !== ">" && !/\s/.test(region[p])) p += 1;
      continue;
    }
    const end = region.indexOf(quote, p + 1);
    if (end < 0) {
      problems.push(`řádek ${line}: nedokončená hodnota atributu "${attrName}" v <${tagName}>`);
      break;
    }
    p = end + 1;
  }
  return problems;
}

/**
 * Ruční kontrola vyváženosti značek (xmllint v prostředí není). Kontroluje
 * párování otevíracích/uzavíracích značek, korektní zavírací uvozovky u
 * atributů, entity v textu a duplicitní `id`.
 */
export function checkXml(source) {
  const problems = [];
  const stack = [];
  const ids = new Map();
  let tagCount = 0;
  let rootCount = 0;

  const lineOf = (index) => source.slice(0, index).split("\n").length;

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;

    const text = source.slice(i, lt);
    if (text.includes("&")) {
      for (const raw of text.split("&")) {
        const semi = raw.indexOf(";");
        const name = semi >= 0 ? raw.slice(semi + 1).trim() : null;
        if (name === null || !ENTITIES.test(name)) {
          problems.push(`řádek ${lineOf(lt)}: surové nebo neplatné "&" v textu`);
        }
      }
    }
    if (text.includes("]]>")) problems.push(`řádek ${lineOf(lt)}: "]]>" v textu`);
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i);
      if (end < 0) {
        problems.push(`řádek ${lineOf(i)}: neuzavřený komentář`);
        break;
      }
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i);
      if (end < 0) {
        problems.push(`řádek ${lineOf(i)}: neuzavřená instrukce zpracování`);
        break;
      }
      i = end + 2;
      continue;
    }
    if (source.startsWith("<!", i)) {
      const end = source.indexOf(">", i);
      if (end < 0) {
        problems.push(`řádek ${lineOf(i)}: neuzavřená deklarace`);
        break;
      }
      i = end + 1;
      continue;
    }

    // Konec značky, ale uvnitř uvozovaných hodnot atributů ignorováno.
    let j = i + 1;
    let quote = null;
    while (j < source.length) {
      const ch = source[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }
    if (j >= source.length) {
      problems.push(`řádek ${lineOf(i)}: neuzavřená značka`);
      break;
    }
    if (quote) problems.push(`řádek ${lineOf(i)}: nedokončený hodnota atributu`);

    const inner = source.slice(i + 1, j);
    const closing = inner.startsWith("/");
    const selfClosing = inner.endsWith("/");
    const body = closing ? inner.slice(1) : selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(body.trim());
    if (!nameMatch) {
      problems.push(`řádek ${lineOf(i)}: značka bez platného názvu`);
      i = j + 1;
      continue;
    }
    const name = nameMatch[1];
    tagCount += 1;

    const idMatch = /\bid\s*=\s*"([^"]*)"/.exec(body);
    if (idMatch) {
      if (ids.has(idMatch[1])) {
        problems.push(`řádek ${lineOf(i)}: duplicitní id "${idMatch[1]}"`);
      } else {
        ids.set(idMatch[1], lineOf(i));
      }
    }

    // Atributy: v XML musí mít každý hodnotu v uvozovkách.
    for (const problem of checkAttributes(body.slice(name.length), name, lineOf(i))) problems.push(problem);

    if (closing) {
      const open = stack.pop();
      if (!open) {
        problems.push(`řádek ${lineOf(i)}: </${name}> bez otevírací značky`);
      } else if (open.name !== name) {
        problems.push(`řádek ${lineOf(i)}: </${name}> ale očekáváno </${open.name}> z řádku ${open.line}`);
      }
    } else if (stack.length === 0) {
      rootCount += 1;
      if (!selfClosing) stack.push({ name, line: lineOf(i) });
    } else if (!selfClosing) {
      stack.push({ name, line: lineOf(i) });
    }

    i = j + 1;
  }

  for (const open of stack) problems.push(`řádek ${open.line}: <${open.name}> zůstalo neuzavřené`);
  if (rootCount !== 1) problems.push(`očekáván právě jeden kořenový element, nalezeno ${rootCount}`);

  return { ok: problems.length === 0, problems, tagCount, ids: ids.size };
}

/* --- Zápis --------------------------------------------------------------- */

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const outputs = [
    ["scs2-mark.svg", buildBadgeSvg()],
    ["scs2-mark-only.svg", buildMarkOnlySvg()],
  ];

  let failed = false;
  for (const [name, svg] of outputs) {
    const path = join(OUT_DIR, name);
    await writeFile(path, svg, "utf8");
    const result = checkXml(svg);
    const bytes = Buffer.byteLength(svg, "utf8");
    console.log(`${result.ok ? "OK  " : "FAIL"} ${name}  ${bytes} B  ${result.tagCount} značek  ${result.ids} id`);
    for (const problem of result.problems) console.log(`     - ${problem}`);
    if (!result.ok) failed = true;
  }

  const ribbon = ribbonPolygon();
  console.log(`pás: ${ribbon.count} vrcholů, d = ${Buffer.byteLength(ribbon.d, "utf8")} B`);
  console.log(`barvy: ${JSON.stringify(PALETTE)}`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}