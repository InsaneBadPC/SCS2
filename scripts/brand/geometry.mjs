/**
 * ============================================================================
 * SCS2 — vektorova geometrie znaku (single source of truth)
 * ============================================================================
 *
 * CO TO JE
 * --------
 * Jediny popis prislencneho znaku SCS2. SVG soubory, rasterizator (dalsi prace)
 * i React komponenta chtaji VSE Z ODHUD TADY — proto je tenhle soubor cisty
 * `.mjs` s nulovymi zavislostmi a bez jedineho pixeloveho cyklu. Modul nikdy
 * nic nekresli: popisuje krivky, plochy a barvy. Kdokoliv potom z nej udela
 * SVG, PNG, animaci i nativni view.
 *
 * KONCEPCE (kratce)
 * -----------------
 * Znak je pismeno "S", ktere se zrovna chova jako audio vlna: kosmy tah se
 * lije od praveho horniho rohu do leveho dolniho a tloustne a zužuje se podle
 * průběhu sinusovky, takže ho oko čte zároveň jako zvukovou stopu. Na
 * spodním konci, presne na terminálu, sedí plná koule - nahrávací kapsle
 * (mikrofon / record head) v teplé žluté, obalená oranžovým prstencem. Za ní
 * odlétají tri jiskry směrem ven od osy - to je ta "AI" složka: zvuk, který
 * už odešel do stroje. Celé je to posazené do zaobleného štítku s dvěma
 * světly ve stejném duchu jako `components/screen-container.tsx`.
 *
 * JEDNOTKY
 * --------
 * Veškerá geometrie je v NORMALIZOVANÝCH souřadnicích 0..1 (0,0 = levý
 * horní roh, y dolů, jako v SVG). `CANVAS` je velikost výstupu v pixelech.
 * Každý export, který je v pixelech, je to označený v názvu nebo ve tvaru
 * výstupu (`ribbonPolygon()` vrací px, `bounds()` normalizovaně).
 *
 * JAK ZNOVU LADIT
 * ----------------
 *   Tvar písmena   SPINE_START + SPINE_SEGMENTS — 4 kubické Béziery. Konce
 *                  segmentů MUSÍ navazovat (end[i] === start[i+1]); poslední
 *                  `end` je zároveň střed NODE. Chceš-li jinou osu, měň jen
 *                  tyto body, ničeho jiného.
 *   Síla tahu     H_END (konce) a H_MID (střed). Změna H_END mění tloušťku
 *                  koncových kapsulí, H_MID tloušťku v pasu. Přímka mezi
 *                  nimi je záměrná - plná konstantní šířka vypadá jako
 *                  šablona, zdejší klenutí jako ruční práce.
 *   Tvar tahu     EXPONENT_SMOOTH (1.4) — jak rychle přibývá tloušťka od
 *                  konce do pasu. <1 = plošší pas, >1 = špičatější pas.
 *   Kapsle       CAP_SEGMENTS — počet úseků půlkružnice na každém konci.
 *   Přesnost     SAMPLES (720) na rozvinutí osy. Chyba je ~kvadratická,
 *                  takže i 360 je bezpečných pro 1024 px.
 *   Koule        NODE.diameter / .ringScale / .ringAlpha. ringScale je VNITŘNÍ
 *                  poloměr prstence jako zlomek poloměru koule (0.8 = pás
 *                  široký 10 % průměru); koule se kreslí na prstenci.
 *   Gradient     GRADIENT_STOPS — čtyři zastávky kyle → světlá modrá →
 *                  žlutá → oranžová. Žlutá zastávka je povinná: bez ní by
 *                  lineární směs v RGB prošla zelenou.
 *   Jiskry       SPARK_SPEC.direction (kam letí), .offsets (jak daleko),
 *                  .diameters a .alphas (tri po sobe).
 *   Štítek       BADGE.radius = zaoblení rohu včetně celé plochy 0..1,
 *                  .glows = dvě světla. Bezpečná zóna pro adaptivní ikonu se
 *                  počítá automaticky z `safeScale()`.
 *   Vodotěsnost  `ribbonWatertight()` — prstenec pásu nesmí mít průsečík
 *                  vlastních hran, jinak v rastru vznikne vlasová praska.
 *   Škálování    `markTransform("badge")` pro kompozici ve štítku,
 *                  `markTransform("foreground")` pro adaptivní ikonu, kde
 *                  je bezpečná zóna Androidu (vnitřní kruh 66 %).
 *
 * POZOR NA DRIFT
 * --------------
 * Jestli se tu něco změní, je povinné znovu spustit `node scripts/brand/
 * write-svg.mjs` a přegenerovat `d` v `components/brand-mark.tsx`. Barvy jsou
 * zkopírované z `theme.config.js` - když se tam změní Primary, změň ji i tady.
 */

export const CANVAS = 1024;

/* --- Barvy (shodují se s theme.config.js) --------------------------------- */

export const PRIMARY = "#00D9EC";
export const PRIMARY_VIBRANT = "#5FF3FF";
export const SECONDARY = "#FF9500";
export const ACCENT_WARM = "#FFC53D";
export const SURFACE = "#0D1117";
export const BACKGROUND = "#070A0D";
export const DEEP = "#04070A";
/** Android monochromní adaptivní ikona Android tintuje sama. */
export const MONOCHROME = "#FFFFFF";

export const PALETTE = Object.freeze({
  PRIMARY,
  PRIMARY_VIBRANT,
  SECONDARY,
  ACCENT_WARM,
  SURFACE,
  BACKGROUND,
  DEEP,
});

/* --- Osa pismene S -------------------------------------------------------- */

export const SPINE_START = [0.703, 0.234];

/** Čtyři kubické Béziery za sebou; `end[i]` == `start[i + 1]`. */
export const SPINE_SEGMENTS = Object.freeze([
  Object.freeze({ c1: [0.703, 0.146], c2: [0.547, 0.127], end: [0.459, 0.19] }),
  Object.freeze({ c1: [0.371, 0.252], c2: [0.391, 0.393], end: [0.5, 0.461] }),
  Object.freeze({ c1: [0.609, 0.529], c2: [0.629, 0.672], end: [0.541, 0.732] }),
  Object.freeze({ c1: [0.453, 0.793], c2: [0.297, 0.773], end: [0.297, 0.682] }),
]);

export const SPINE = Object.freeze({
  start: SPINE_START,
  segments: SPINE_SEGMENTS,
  /** Tento endpoint je zároveň středem NODE. */
  end: SPINE_SEGMENTS[SPINE_SEGMENTS.length - 1].end,
});

/* --- Šířka tahu a přesnost ------------------------------------------------ */

/** Poloviční šířka na koncích tahu (také poloměr koncové kapsle). */
export const H_END = 0.0225;
/** Poloviční šířka v nejširším místě (přesně uprostřed, t = 0.5). */
export const H_MID = 0.053;
/** Jak rychle přibývá šířka od konce do pasu. */
export const EXPONENT_SMOOTH = 1.4;
/** Úseků v půlkružnici na každém konci tahu. */
export const CAP_SEGMENTS = 32;
/** Výchozí hustota rozvinutí osy (počet intervalů). */
export const SAMPLES = 720;

/** Proměnná šířka tahu: úzké konce, široký pas. */
export function halfWidth(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return H_END + (H_MID - H_END) * Math.pow(Math.sin(Math.PI * clamped), EXPONENT_SMOOTH);
}

/* --- Kubický Bézier ------------------------------------------------------- */

function cubicAt(p0, c1, c2, p1, u) {
  const m = 1 - u;
  const a = m * m * m;
  const b = 3 * m * m * u;
  const c = 3 * m * u * u;
  const d = u * u * u;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

function cubicTangent(p0, c1, c2, p1, u) {
  const m = 1 - u;
  const a = 3 * m * m;
  const b = 6 * m * u;
  const c = 3 * u * u;
  return [
    a * (c1[0] - p0[0]) + b * (c2[0] - c1[0]) + c * (p1[0] - c2[0]),
    a * (c1[1] - p0[1]) + b * (c2[1] - c1[1]) + c * (p1[1] - c2[1]),
  ];
}

/** Body osy v jejím vlastním `d` tvaru - jen pro referenci a ladění. */
export function spinePathData() {
  const fmt = (n) => Number(n.toFixed(4));
  let d = `M ${fmt(SPINE.start[0])} ${fmt(SPINE.start[1])}`;
  for (const seg of SPINE_SEGMENTS) {
    d += ` C ${fmt(seg.c1[0])} ${fmt(seg.c1[1])} ${fmt(seg.c2[0])} ${fmt(seg.c2[1])} ${fmt(seg.end[0])} ${fmt(seg.end[1])}`;
  }
  return d;
}

/* --- Rozvinutí osy -------------------------------------------------------- */

/**
 * Rozvine Bézierový řetězec na hustou lomenou čáru.
 *
 * Každý bod nese polohu, jednotkovou tečnu, jednotkovou normálu (tečna
 * otočená o +90°, tedy `[-ty, tx]`) a normalizovaný parametr podél délky
 * oblouku `t` (0 na začátku, 1 na konci). `t` je to, co gradient potřebuje.
 */
export function sampleSpine(samples = SAMPLES) {
  const intervals = Math.max(2, Math.round(samples));
  const segmentCount = SPINE_SEGMENTS.length;
  const raw = [];

  for (let i = 0; i <= intervals; i += 1) {
    const u = i / intervals;
    // Zaokrouhlení podle segmentu; u = 1 musí skončit na posledním konci.
    const scaled = u * segmentCount;
    const index = Math.min(segmentCount - 1, Math.floor(scaled));
    const local = Math.min(1, scaled - index);

    const p0 = index === 0 ? SPINE.start : SPINE_SEGMENTS[index - 1].end;
    const seg = SPINE_SEGMENTS[index];
    const [x, y] = cubicAt(p0, seg.c1, seg.c2, seg.end, local);

    let [tx, ty] = cubicTangent(p0, seg.c1, seg.c2, seg.end, local);
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;

    raw.push({ x, y, tx, ty, nx: -ty, ny: tx });
  }

  // Parametr podél délky oblouku z kumulovaných délek tětiv.
  const cumulative = [0];
  for (let i = 1; i < raw.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y));
  }
  const total = cumulative[cumulative.length - 1] || 1;

  const points = raw.map((p, i) => ({ ...p, t: cumulative[i] / total }));
  return { points, count: points.length, arcLength: total };
}

/* --- Pás (ribbon) --------------------------------------------------------- */

/**
 * Pás jako JEDEN uzavřený mnohoúhelník v pixelech.
 *
 * Počítá se jako obal vytvořený z rozvinuté osy: vpřed s kladným posunem po
 * normále, zpět s záporným, na každém konci půlkružnice o poloměru
 * `halfWidth()` v daném konci. Každý vrchol nese svoje `t`, aby rasterizator
 * uměl interpolovat gradient po ploše.
 *
 * VODOTĚSNOST
 * ----------
 * Obě strany se počítají ze STEJNÝCH indexů vzorků osy — pro každý index `i`
 * existuje právě jeden vrchol kladné a jeden záporné strany, takže kaple na
 * koncích napojují na body, které už v prstenci jsou, a žádný vrchol nemá dva
 * různé souřadnicové zápisy. Oblouk kaple se navíc vypisuje ve směru, ve
 * kterém prstenec prochází: od `+n` k `-n` na konci tahu a od `-n` k `+n` na
 * jeho začátku. Obrácený směr by oblouk přeběhl přes celou půlkružnici a
 * uzavřel ji dvěma tětivami dlouhými jako průměr — prstenec by se protínal a
 * sudě-liché vyplňování by na řádku vynechalo proužek.
 *
 * `ribbonWatertight()` je trvalý pojistný test proti návratu té chyby.
 *
 * Vrací: `{ points, count, capSegments, pathSegments }` v pixelech.
 */
export function ribbonPolygon(samples = SAMPLES) {
  const { points } = sampleSpine(samples);
  const last = points.length - 1;

  const px = (x) => Math.round(x * CANVAS * 100) / 100;
  const py = (y) => Math.round(y * CANVAS * 100) / 100;

  // Kladná a záporná strana z JEDNÉHO průchodu vzorky osy.
  const positive = [];
  const negative = [];
  for (let i = 0; i <= last; i += 1) {
    const p = points[i];
    const w = halfWidth(p.t);
    positive.push({ x: px(p.x + p.nx * w), y: py(p.y + p.ny * w), t: p.t });
    negative.push({ x: px(p.x - p.nx * w), y: py(p.y - p.ny * w), t: p.t });
  }

  /**
   * Půlkružnice o poloměru `radius` kolem `center`, od `center + radius·n`
   * přes `outward` do `center - radius·n`. `forward` = true vypisuje vrcholy
   * od `+n` k `-n`, false obráceně — podle toho, kam prstenec právě došel.
   */
  const cap = (center, radius, n, outward, t, forward) => {
    const ring = [];
    for (let s = 1; s < CAP_SEGMENTS; s += 1) {
      const angle = (Math.PI * (forward ? s : CAP_SEGMENTS - s)) / CAP_SEGMENTS;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ring.push({
        x: px(center[0] + radius * (cos * n[0] + sin * outward[0])),
        y: py(center[1] + radius * (cos * n[1] + sin * outward[1])),
        t,
      });
    }
    return ring;
  };

  const ring = [];
  // Vpřed po kladné straně.
  for (let i = 0; i <= last; i += 1) ring.push(positive[i]);
  // Kaple na konci t = 1: navazuje positive[last] -> negative[last].
  ring.push(...cap(SPINE.end, halfWidth(1), [points[last].nx, points[last].ny], [points[last].tx, points[last].ty], 1, true));
  // Zpět po záporné straně.
  for (let i = last; i >= 0; i -= 1) ring.push(negative[i]);
  // Kaple na začátku t = 0: navazuje negative[0] -> positive[0].
  ring.push(...cap(SPINE.start, halfWidth(0), [points[0].nx, points[0].ny], [-points[0].tx, -points[0].ty], 0, false));

  // Prstenec je uzavřený už konstrukcí (`Z` v SVG, `(i + 1) % n` v rastru):
  // poslední vrchol oblouku začátku leží o CAP_SEGMENTS kroků od positive[0]
  // na téže půlkružnici, takže zavírací hrana je krátká tetiva, ne průměr.

  return {
    points: ring,
    count: ring.length,
    capSegments: CAP_SEGMENTS,
    d: ribbonPath(ring),
  };
}

/**
 * Vodotěsnost prstence pásu: počet vlastních průsečíků hran a nejdelší hrana.
 *
 * Prstenec je všechen složený z hran dvou postranních chůzů (jejich délku
 * určuje hustota `SAMPLES`) a dvou oblouků kaplí (délka `capChord`). Rozpočet
 * proto není pevná konstanta, ale násobek typické hrany: hrana mnohokrát
 * delší znamená, že některý vrchol přeskočil o kus geometrie — přesně to,
 * co dělala chybná kaple, když se oblouk vypisoval obráceným směrem a
 * prstenec se zavíral dvěma tětivami dlouhými jako průměr.
 *
 * `selfIntersections` je podmínka sama o sobě: jeden průsečík stačí, aby
 * sudě-liché vyplňování na některém řádku zrušilo proužek.
 */
export function ribbonWatertight(points = ribbonPolygon().points) {
  const n = points.length;
  // halfWidth() je normalizované, `points` jsou v pixelech.
  const capChord = 2 * halfWidth(1) * CANVAS * Math.sin(Math.PI / (2 * CAP_SEGMENTS));

  const orient = (r, p, q) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

  const lengths = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    lengths[i] = Math.hypot(points[(i + 1) % n].x - points[i].x, points[(i + 1) % n].y - points[i].y);
  }
  const sorted = Float64Array.from(lengths).sort();
  const medianEdge = sorted[n >> 1];
  const longestEdge = sorted[n - 1];
  const budget = 4 * Math.max(medianEdge, capChord);

  let selfIntersections = 0;
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      const d1 = orient(d, c, [a.x, a.y]);
      const d2 = orient(d, c, [b.x, b.y]);
      const d3 = orient(b, a, [c.x, c.y]);
      const d4 = orient(b, a, [d.x, d.y]);
      if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) {
        if ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)) selfIntersections += 1;
      }
    }
  }

  const round = (v) => Math.round(v * 100) / 100;
  return {
    vertices: n,
    selfIntersections,
    medianEdge: round(medianEdge),
    longestEdge: round(longestEdge),
    capChord: round(capChord),
    budget: round(budget),
    ok: selfIntersections === 0 && longestEdge <= budget,
  };
}

/**
 * Uzavřený pás jako SVG `d`. Tečky na řádek (po 8 vrcholech), aby šlo `d`
 * zkopírovat do souboru i do TSX a pořád to bylo čitelné - mezery v `d`
 * jsou v XML nepodstatné.
 */
export function ribbonPath(points) {
  const lines = [];
  let current = "";
  points.forEach((p, i) => {
    const command = i === 0 ? "M" : "L";
    current += `${current ? " " : ""}${command} ${p.x} ${p.y}`;
    if ((i + 1) % 8 === 0) {
      lines.push(current);
      current = "";
    }
  });
  if (current) lines.push(current);
  lines.push("Z");
  return lines.join("\n");
}

/* --- Gradient ------------------------------------------------------------- */

/**
 * Zastávky gradientu podél osy.
 *
 * Čtyři zastávky, ne tři: mezi světlou modrou a oranžovou leží ŽLUTÁ, jinak
 * by lineární směs v RGB protínala zelenou (barva `#5FF3FF` -> `#FFC53D` má
 * v polovině odstín `rgb(175,220,158)`, travnatě bledý odstín) a barva by
 * mezi kylem a oranží zmodrála. Žlutá zastávka drží odstín na teplé ose
 * žlutá -> oranžová, kde hue klesá monotonně.
 */
export const GRADIENT_STOPS = Object.freeze([
  Object.freeze({ t: 0, color: PRIMARY }),
  Object.freeze({ t: 0.38, color: PRIMARY_VIBRANT }),
  Object.freeze({ t: 0.68, color: ACCENT_WARM }),
  Object.freeze({ t: 1, color: SECONDARY }),
]);

export function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** Barva gradientu v daném bodě osy. Vrací `{ r, g, b }` v 0..255. */
export function gradientAt(t) {
  const clamped = Math.min(1, Math.max(0, t));
  let lower = GRADIENT_STOPS[0];
  let upper = GRADIENT_STOPS[GRADIENT_STOPS.length - 1];
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i += 1) {
    if (clamped >= GRADIENT_STOPS[i].t && clamped <= GRADIENT_STOPS[i + 1].t) {
      lower = GRADIENT_STOPS[i];
      upper = GRADIENT_STOPS[i + 1];
      break;
    }
  }
  const span = upper.t - lower.t || 1;
  const f = (clamped - lower.t) / span;
  const a = hexToRgb(lower.color);
  const b = hexToRgb(upper.color);
  return {
    r: Math.round(a[0] + (b[0] - a[0]) * f),
    g: Math.round(a[1] + (b[1] - a[1]) * f),
    b: Math.round(a[2] + (b[2] - a[2]) * f),
  };
}

export function rgbToHex({ r, g, b }) {
  const part = (v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/* --- Koule na konci tahu (nahrávací kapsle) ------------------------------- */

/**
 * Nahrávací kapsle: PLNÁ žlutá koule a oranžový PRSTENEC kolem ní.
 *
 * `ringScale` je VNITŘNÍ poloměr prstence jako zlomek poloměru koule, ne
 * poloha středu prstence: 0.8 tedy znamená, že prstenec začíná na 80 %
 * poloměru a jeho pás má šířku 20 % R, tedy 10 % průměru koule. Koule se
 * kreslí až na prstenci, takže prstenec obklopuje plný kotouč a ne holý
 * kruh s obvodovou čarou.
 */
export const NODE = Object.freeze({
  center: Object.freeze([0.297, 0.682]),
  diameter: 0.174,
  fill: ACCENT_WARM,
  ring: SECONDARY,
  ringAlpha: 0.85,
  ringScale: 0.8,
});

/** 1px vnitřní lem štítku - jen aby hrana ne byla mrtvá. */
export const BADGE_RIM = Object.freeze({ color: PRIMARY_VIBRANT, alpha: 0.14, width: 1 });

/* --- Jiskry za koulí (složka "AI") ---------------------------------------- */

export const SPARK_SPEC = Object.freeze({
  direction: Object.freeze([-0.55, 0.6]),
  offsets: Object.freeze([0.155, 0.245, 0.325]),
  diameters: Object.freeze([0.055, 0.042, 0.03]),
  alphas: Object.freeze([1, 0.7, 0.45]),
  fill: PRIMARY_VIBRANT,
});

/** Jiskry s už spočtenými středy v normalizovaných souřadnicích. */
export const SPARKS = Object.freeze(
  SPARK_SPEC.offsets.map((offset, i) => {
    const diameter = SPARK_SPEC.diameters[i];
    return Object.freeze({
      index: i,
      offset,
      center: Object.freeze([
        Math.round((NODE.center[0] + SPARK_SPEC.direction[0] * offset) * 1e5) / 1e5,
        Math.round((NODE.center[1] + SPARK_SPEC.direction[1] * offset) * 1e5) / 1e5,
      ]),
      diameter,
      radius: diameter / 2,
      alpha: SPARK_SPEC.alphas[i],
      fill: SPARK_SPEC.fill,
    });
  }),
);

/* --- Štítek ---------------------------------------------------------------- */

/** Zaoblený čtverec přes celé plátno + dvě světla jako v screen-container. */
export const BADGE = Object.freeze({
  radius: 0.225,
  fillA: SURFACE,
  fillB: DEEP,
  glows: Object.freeze([
    Object.freeze({ center: Object.freeze([0.24, 0.2]), radius: 0.75, color: PRIMARY, alpha: 0.16 }),
    Object.freeze({ center: Object.freeze([0.82, 0.86]), radius: 0.62, color: SECONDARY, alpha: 0.1 }),
  ]),
});

export const BADGE_RECT = Object.freeze({
  x: 0,
  y: 0,
  width: CANVAS,
  height: CANVAS,
  rx: Math.round(BADGE.radius * CANVAS * 100) / 100,
});

/* --- Rozměry, bezpečná zóna, kompozice ------------------------------------ */

const circlePoints = (center, radius) => {
  const points = [];
  const steps = 64;
  for (let i = 0; i < steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return points;
};

const nodeEdgePoints = (scale = 1) => circlePoints(NODE.center, (NODE.diameter * scale) / 2);

/** Všechny body celého znaku (bez štítku), normalizovaně. */
function markOutline() {
  const ribbon = ribbonPolygon(SAMPLES).points.map((p) => [p.x / CANVAS, p.y / CANVAS]);
  const sparks = SPARKS.flatMap((s) => circlePoints(s.center, s.radius));
  return [...ribbon, ...nodeEdgePoints(NODE.ringScale), ...nodeEdgePoints(1), ...sparks];
}

/** Osa-aligned obdélník celého znaku (koule + jiskry + pás), bez štítku. */
export function bounds() {
  const points = markOutline();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: minX + width / 2,
    centerY: minY + height / 2,
    px: {
      minX: Math.round(minX * CANVAS * 100) / 100,
      minY: Math.round(minY * CANVAS * 100) / 100,
      maxX: Math.round(maxX * CANVAS * 100) / 100,
      maxY: Math.round(maxY * CANVAS * 100) / 100,
    },
  };
}

/** Nejvzdálenější bod znaku od středu plátna. */
export function maxRadius() {
  let max = 0;
  for (const [x, y] of markOutline()) {
    const d = Math.hypot(x - 0.5, y - 0.5);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Nejmenší rovnoměrné zmenšení kolem středu, které celý znak vmestí do
 * kruhu o poloměru `targetRadius`. Adaptivní ikona Androidu má bezpečnou
 * zónu vnitřních ~66 %, proto se volí 0.33.
 */
export function safeScale(targetRadius = 0.33) {
  const farthest = maxRadius();
  return farthest > 0 ? targetRadius / farthest : 1;
}

/** Zmenšení, při kterém znak vyplní štítek (bez bezpečné zóny). */
export const BADGE_SCALE = 0.86;

/**
 * Transformace pro dvě kompozice:
 *  - `badge`      znak vyplní štítek (0.86),
 *  - `foreground` znak v bezpečné zóně adaptivní ikony (safeScale()).
 *
 * Vrací `{ mode, scale, translate, matrix, origin, svg }`. `svg` je připravený
 * atribut pro SVG, `matrix` je [a, b, c, d, e, f] pro kohokoli jiného.
 */
export function markTransform(mode = "badge") {
  const scale = mode === "foreground" ? safeScale() : BADGE_SCALE;
  const origin = 0.5;
  const ox = origin * CANVAS;
  const offset = ox * (1 - scale);
  return {
    mode,
    scale: Math.round(scale * 1e6) / 1e6,
    origin,
    translate: [Math.round(offset * 100) / 100, Math.round(offset * 100) / 100],
    matrix: [scale, 0, 0, scale, offset, offset],
    svg: `translate(${ox} ${ox}) scale(${Math.round(scale * 1e6) / 1e6}) translate(${-ox} ${-ox})`,
  };
}

/** Osa gradientu v pixelech - od začátku tahu k jeho konci. */
export const GRADIENT_AXIS = Object.freeze({
  x1: Math.round(SPINE.start[0] * CANVAS * 100) / 100,
  y1: Math.round(SPINE.start[1] * CANVAS * 100) / 100,
  x2: Math.round(SPINE.end[0] * CANVAS * 100) / 100,
  y2: Math.round(SPINE.end[1] * CANVAS * 100) / 100,
});

/* --- Kontrola ------------------------------------------------------------- */

/** Největší odchylka rozvinuté lomené čáry od skutečné křivky. */
export function maxFlatteningError(samples = SAMPLES, oversample = 24) {
  const { points } = sampleSpine(samples);

  const distanceToSegment = (p, a, b) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2)) : 0;
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  };

  // Křivka -> lomená čára.
  const dense = [];
  const intervals = samples * oversample;
  const segmentCount = SPINE_SEGMENTS.length;
  for (let i = 0; i <= intervals; i += 1) {
    const u = i / intervals;
    const scaled = u * segmentCount;
    const index = Math.min(segmentCount - 1, Math.floor(scaled));
    const local = Math.min(1, scaled - index);
    const p0 = index === 0 ? SPINE.start : SPINE_SEGMENTS[index - 1].end;
    const seg = SPINE_SEGMENTS[index];
    const [x, y] = cubicAt(p0, seg.c1, seg.c2, seg.end, local);
    dense.push({ x, y });
  }

  let curveToPoly = 0;
  for (const p of dense) {
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) {
      const d = distanceToSegment(p, points[i - 1], points[i]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > curveToPoly) curveToPoly = best;
  }

  // Lomená čára -> křivka.
  let polyToCurve = 0;
  for (const v of points) {
    let best = Infinity;
    for (let i = 1; i < dense.length; i += 1) {
      const d = distanceToSegment(v, dense[i - 1], dense[i]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > polyToCurve) polyToCurve = best;
  }

  const normalized = Math.max(curveToPoly, polyToCurve);
  return {
    normalized,
    px: normalized * CANVAS,
    curveToPoly,
    polyToCurve,
    denseSamples: dense.length,
  };
}

/** Souhrnná kontrola geometrie - tohle si pustí `write-svg.mjs`. */
export function verify() {
  const spine = sampleSpine(SAMPLES);
  const ribbon = ribbonPolygon(SAMPLES);
  const error = maxFlatteningError(SAMPLES);
  const box = bounds();
  const sparkCentres = SPARKS.map((s) => ({
    index: s.index,
    center: s.center,
    centerPx: [Math.round(s.center[0] * CANVAS * 100) / 100, Math.round(s.center[1] * CANVAS * 100) / 100],
    radiusPx: Math.round(s.radius * CANVAS * 100) / 100,
    alpha: s.alpha,
    insideCanvas:
      s.center[0] - s.radius >= 0 && s.center[1] - s.radius >= 0 && s.center[0] + s.radius <= 1 && s.center[1] + s.radius <= 1,
  }));

  return {
    canvas: CANVAS,
    spineSamples: spine.count,
    spineArcLength: Math.round(spine.arcLength * 1e6) / 1e6,
    flatteningErrorPx: Math.round(error.px * 1e6) / 1e6,
    flatteningErrorNormalized: Math.round(error.normalized * 1e9) / 1e9,
    flatteningBudgetPx: CANVAS / 1024,
    ribbonVertices: ribbon.count,
    ribbonPathBytes: Buffer.byteLength(ribbon.d, "utf8"),
    ribbonWatertight: ribbonWatertight(ribbon.points),
    halfWidthStart: halfWidth(0),
    halfWidthMid: halfWidth(0.5),
    halfWidthEnd: halfWidth(1),
    node: {
      diameter: NODE.diameter,
      radiusPx: (NODE.diameter * CANVAS) / 2,
      ringInnerPx: (NODE.diameter * CANVAS * NODE.ringScale) / 2,
      ringBandPx: ((NODE.diameter * CANVAS) / 2) * (1 - NODE.ringScale),
      diameterPercent: Math.round(NODE.diameter * 1e4) / 100,
    },
    bounds: box,
    maxRadius: Math.round(maxRadius() * 1e6) / 1e6,
    safeScale: Math.round(safeScale() * 1e6) / 1e6,
    badgeScale: BADGE_SCALE,
    sparks: sparkCentres,
    gradient: [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, hex: rgbToHex(gradientAt(t)), ...gradientAt(t) })),
  };
}