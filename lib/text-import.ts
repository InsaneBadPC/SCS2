export function cleanImportedText(content: string, fileName = "") {
  const isHtml = /\.html?$/i.test(fileName) || /<\/?(?:p|div|br|h\d|li|body|html)[\s>]/i.test(content);
  const plain = isHtml
    ? content
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
    : content;
  return plain.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const SECTION_NAMES: Record<string, string> = {
  verse: "Sloka", sloka: "Sloka", chorus: "Refrén", refrain: "Refrén", refrén: "Refrén", refren: "Refrén",
  bridge: "Bridge", intro: "Intro", outro: "Outro", "pre-chorus": "Pre-refrén", prerefrén: "Pre-refrén", "pre-refrén": "Pre-refrén",
  interlude: "Mezihra", mezihra: "Mezihra", hook: "Hook",
};

// Značka na celém řádku. V importech se píší jak [Sloka 1], tak (Sloka 1)
// nebo Sloka 1 — 0:21. Dřív se závorková forma nechytila a zůstala v textu
// doslova, takže se pak nedala poznat jako oddíl.
const MARKER_LINE = /^\s*[\[(]?\s*(verse|sloka|chorus|refrain|refr[ée]n|refren|bridge|pre-chorus|prerefr[ée]n|pre-refr[ée]n|interlude|mezihra|hook|intro|outro)\b\s*(\d+)?\s*[\])]?\s*[:\-–—]?\s*(?:.{0,80})?$/i;

export function annotateSongSections(content: string) {
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (/^#{1,6}\s/.test(trimmed)) return trimmed;
    const match = trimmed.match(MARKER_LINE);
    if (!match) return line;
    const key = match[1].toLocaleLowerCase("cs-CZ");
    const label = SECTION_NAMES[key] ?? match[1];
    return `[${label}${match[2] ? ` ${match[2]}` : ""}]`;
  }).join("\n");
}

/**
 * Značka, podle níž začíná text písně.
 *
 * Musí sedět na celém řádku a být krátká. Kdyby stačilo obsahovat slovo
 * „Intro“ kdekoliv, chytla by se i věta uvnitř promptu stylu. Markdown nadpisy
 * (`## Název`) záměrně nepatří — v importech z nich začíná až text písně.
 */
const LYRIC_MARKER = /^[([]?\s*(?:intro|outro|verse|sloka|chorus|refrain|refr[ée]n|refren|bridge|prerefr[ée]n|pre-?chorus|interlude|mezihra|hook)\b[^\])\n]{0,80}[)\]]?\s*$/i;

/** Hlavičky, co patří do vyhození, ne do promptu stylu. */
const STYLE_META_LINES = [
  /^\s*#{1,6}\s*prompt\s+pro\s+ai[^\n]*$/i,
  /^\s*\(?\s*popis\s+stylu\s+pro\s+ai[^)\n]*\)?\s*$/i,
  /^\s*[=]{2,}\s*popis\s+stylu\s*[=]{2,}\s*$/i,
  /^\s*\[[\s*]?style\s*prompt[\s*]?\]\s*$/i,
  /^\s*styl(?:ov[ýy])?\s+prompt\s*$/i,
  /^\s*style\s+prompt\s*$/i,
];

const STYLE_PREFIX = /^(?:styl(?:ov[ýy])?\s*prompt|style\s*prompt|styl|style)\s*[:\-]\s*/i;

/** Zahodí hlavičku typu „### Prompt pro AI“ a rozpustí „Style:“ na začátku. */
export function stripStyleMeta(text: string): string {
  const lines = text.split("\n");
  while (lines.length && (lines[0].trim() === "" || STYLE_META_LINES.some((pattern) => pattern.test(lines[0])))) {
    lines.shift();
  }
  while (lines.length && lines[0].trim() === "") lines.shift();
  return lines.join("\n").replace(STYLE_PREFIX, "").trim();
}

/**
 * Rozdělí import na prompt stylu a text písně.
 *
 * Původně se bral první odstavec a všechno v něm se poskládalo do stylu. Když
 * měl soubor mezi stylem a textem jen jednořádkové zalomení, patřily do stylu
 * i sloky — tak to skončilo u „Náhody“, kde měl prompt stylu 2 000 znaků včetně
 * pěti slok a dvou refrénů. Teď se hledá první řádek, který je značka sloky, a
 * vše před ním je styl.
 */
export function splitImportedSongContent(content: string) {
  const lines = content.split("\n");
  const firstLyricLine = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^#{1,6}\s/.test(trimmed)) return true;
    return LYRIC_MARKER.test(trimmed);
  });

  if (firstLyricLine === 0) {
    return { stylePrompt: null, lyrics: annotateSongSections(content.trim()) };
  }
  if (firstLyricLine > 0) {
    const stylePrompt = stripStyleMeta(lines.slice(0, firstLyricLine).join("\n"));
    const lyrics = lines.slice(firstLyricLine).join("\n").trim();
    return { stylePrompt: stylePrompt || null, lyrics: annotateSongSections(lyrics) };
  }

  // Bez jediné značky sloky zůstává staré chování podle prázdných řádků.
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length < 2) {
    return { stylePrompt: null, lyrics: annotateSongSections(content) };
  }
  const first = paragraphs.shift() ?? "";
  const stylePrompt = stripStyleMeta(first);
  return { stylePrompt: stylePrompt || null, lyrics: annotateSongSections(paragraphs.join("\n\n")) };
}

export function googleDocumentId(url: string) {
  const match = url.trim().match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}
