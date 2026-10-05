#!/usr/bin/env node
// =============================================================================
// bundle-edge-functions.mjs — sbalení všech Supabase Edge Functions do jednoho souboru
// =============================================================================
//
// PROČ TENTO SKRIPT existuje
// ---------------------------
// Management API bere v poli `body` JEDINÝ soubor. Supabase CLI to řeší tím, že
// před nasazením funkci zbundluje (esbuild) — a ten balíček si interně vyřeší
// relativní importy (`../_shared/access.ts`, `./motion-recipe.ts`, …) do jednoho
// flat souboru.
//
// Když se ale nahraje SUROVÝ `index.ts`, `_shared/` se nenasadí a Deno v runtime
// selže ještě před prvním řádkem aplikačního kódu:
//
//   503  BOOT_ERROR  "Module not found \"file:///.../_shared/access.ts\""
//
// Tedy: 17 z 18 funkcí v SCS2 bylo dlouho mrtvých a nikdo to nevěděl, protože
// `GET /functions/<slug>` vrací 200/401 (brána funguje) i když tělo spadne.
// Jediný platný test je funkci OPRAVDU zavolat.
//
// -----------------------------------------------------------------------------
// PROČ SE BALÍK MUSÍ POPSAT — a proč to NEODHALÍ "funguje to lokálně"
// -----------------------------------------------------------------------------
// Dvě pasti, obě přežily první opravu (17 mrtvých bundleů v produkci):
//
// 1) SUROVÝ .TS (relativní importy)
//    Management API nenainstaluje `_shared/`. Relativní specifikátor v balíčku
//    = mrtvá funkce. Řeší se inlinováním (viz `deno bundle` níže).
//
// 2) `jsr:` SCHÉMA  ← tohle je ta pravá chyba, která propustila 17 mrtvých balíků
//    `deno bundle` nechá externí balíčky v balíčku viset, takže dole zůstane
//        import "jsr:@supabase/functions-js/edge-runtime.d.ts";
//        import { createClient } from "jsr:@supabase/supabase-js@2";
//    Supabase Edge Runtime `jsr:` UMÍ resolvovat — na papíře. A PŘEČ JEN TO
//    NEUMÍ. Výsledek je 503 BOOT_ERROR ještě před prvním řádkem handleru.
//
//    Řízený A/B experiment (deploynuto, pak reálně zavoláno):
//        varianta A: import `.d.ts` pryč, `jsr:@supabase/supabase-js@2` ponechán
//                   → 503 BOOT_ERROR            (mrtvé)
//        varianta B: import `.d.ts` pryč, `jsr:` → `npm:` přepsáno
//                   → 401 {"error":"Neplatné přihlášení."}  (LOADED — to je
//                     vlastní doménová odpověď handleru, ne gateway chyba)
//    Závěr: NEJDE o typy, NEJDE o import jako tak. Rozhoduje scheme.
//    A/B byl dělaný proti živým funkcím, ne „lokálně" — viz níže.
//
//    PROČ TO LOKÁLNÍ KONTROLA NECHYTÍ (a proč je acceptance test takhle tvrdý):
//    `deno bundle` skončí exit 0, `deno check` skončí exit 0, všechna schémata
//    (`jsr:`, `npm:`, `node:`) jsou lokálně platná a Deno je umí resolvovat.
//    Chyba se projeví AŽ v Supabase Edge Runtime, který má jinou resolver
//    tabulku než lokální Deno. Jediná automatizovatelná pojistka, kterou máme
//    před odesláním na servery, je proto tvrdý textový assert nad výstupem:
//
//        ZELENÁ = „tento bundle BOOTNE".  jinak ne-commitnout, ne-deploynout.
//
// -----------------------------------------------------------------------------
// JAK SE POUŽÍVÁ
// --------------
//   node scripts/bundle-edge-functions.mjs                  # jen balit + assert
//   node scripts/bundle-edge-functions.mjs legal agent-...  # jen vybrané funkce
//   node scripts/bundle-edge-functions.mjs --deploy         # balit + assert + PATCH
//   node scripts/bundle-edge-functions.mjs --deploy --only legal,youtube-sync-stats
//
// Výstup: supabase/functions-dist/<slug>/index.js  (gitignorovaný adresář)
//
// Acceptance test (po každém balení, NELZE přeskočit)
// ----------------------------------------------------
//   1. 0 relativních specifikátorů        → jinak 503 BOOT_ERROR
//   2. 0 `jsr:` kdekoliv ve výstupu      → jinak 503 BOOT_ERROR
//   3. 0 side-effect importů na `.d.ts`  → typy do runtime nepatří
//   4. každý zbývající externí specifikátor musí být `npm:`/`node:`/`http(s):`
//      → neznámé scheme = runtime, které ho neumí
// Kterákoliv chyba = okamžitý exit 1. Žádný WARN, žádný „a uvidíme".
//
// -----------------------------------------------------------------------------
// NASAZENÍ (`--deploy`) — DVĚ FAKTY, O KTERÝCH SE UŽ KLOPÁLO
// -----------------------------------------------------------------------------
// A) `POST /v1/projects/{ref}/functions` JE ROZBITÉ PRO AKTUALIZACI.
//    Management API v POST těle vyžaduje `name` A `slug` zároveň a varianta
//    jen se `slug` odmítne: 400 "Function name must be provided".
//    Pro existující funkce se proto používá VÝHRADNĚ:
//        PATCH /v1/projects/{ref}/functions/{slug}
//    Tento skript nikdy nepoužívá POST pro update. POST je legitimní jen pro
//    vytvoření zcela nové funkce.
//
// B) `verify_jwt` SE NESMÍ PŘEPOJNIT.
//    Přepnutí otočí `authenticate`/`authorize` na gateway a tiše zabije veřejný
//    přístup (nebo naopak odkryje funkci). Stav pro projekt gpgbgjxeybfncrexrpbr:
//
//        false: legal, youtube-oauth-callback, youtube-sync-stats,
//               youtube-publish-scheduler
//        true : všech ostatních 14
//
//    `--deploy` před odesláním NAČTE živý stav a porovná ho s tabulkou níže.
//    Při jakémkoli rozdílu SE NASADÍ VŮBEC NIC a skript spadne (fail-closed):
//    je to znamení, že tabulka zastarala a musí se ručně ověřit, co je správně.
//
// -----------------------------------------------------------------------------
// POUŽITÍ NA RUKOU
// -----------------------------------------------------------------------------
//   cd <repo-root>
//   set -a && . ./.env.local && set +a      # SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF
//   node scripts/bundle-edge-functions.mjs
//
//   # Vypiš aktuální stav (neodhalí tajemství):
//   curl -sS "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions" \
//     -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
//     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
//         JSON.parse(s).sort((a,b)=>a.slug.localeCompare(b.slug))
//           .forEach(f=>console.log(f.slug, "verify_jwt="+f.verify_jwt))})'
//
//   # Deploy z balíčku (PATCH, ne POST):
//   node scripts/bundle-edge-functions.mjs --deploy
//
//   # Po NASAZENÍ JE POVINNÝ RUNTIME TEST — nasazení bez provedení je blind-fold:
//   curl -sS -w '\n%{http_code}\n' -X POST \
//     "https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/<slug>" \
//     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
//     -H "Content-Type: application/json" -d '{}'
//   # 400 = tělo se načetalo (chybí pole) = OK.
//   # 401 {"error":"Neplatné přihlášení."} = tělo se načetalo a běží = OK.
//   # 503 BOOT_ERROR = mrtvé. NEPOČÍTEJ NA TO, ŽE TO UŽ NASKOČILO DŘÍV.
//
// POZNÁMKA: `SUPABASE_ACCESS_TOKEN` je Personal Access Token z
// dashboardu/tokenu, NEJWT řidič projektu. Management API ho nezná — použije se
// jen uvnitř Authorization hlavičky.
//
// Alternativa k `deno bundle`: Supabase CLI (`supabase functions deploy`) —
// ale ten v default režimu potřebuje Docker (image `edge-runtime:local`),
// který tu není a nebude. `deno bundle` Docker nepotřebuje.
// =============================================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FUNCTIONS_DIR = join(REPO_ROOT, "supabase", "functions");
const DIST_DIR = join(REPO_ROOT, "supabase", "functions-dist");

/** Adresáře modulů, které nejsou nasazitelnou funkcí (chybí jim index.ts). */
const NON_FUNCTION_DIRS = new Set(["_shared"]);

/**
 * Specifikace, které se NECHÁVAJÍ rozbalit — balíme jen to, co Edge Runtime
 * neumí načíst z disku. Kdybychom zabalili i npm závislosti, museli bychom do
 * balíčku vtáhnout celý @supabase/supabase-js (phoenix, iceberg-js, …).
 * Výsledek by byl obrovský a křehký.
 *
 * POZOR: `jsr:*` tu zůstává ZÁMĚRNĚ jako externí jen proto, že se tím dá
 * `deno bundle` přesvědčit, aby balíček vůbec sestavil — visí v něm ale jako
 * `import` a je pak přepsán na `npm:` (viz `rewriteSpecifier`). Edge Runtime
 * `jsr:` resolvovat neumí.
 */
const EXTERNAL_SPECIFIERS = ["jsr:*", "npm:*", "node:*", "https://*", "http://*"];

/** Scheme, které Supabase Edge Runtime v balíčku OPRAVDU umí resolvovat. */
const RUNTIME_SAFE_SCHEMES = ["npm:", "node:", "https:", "http:", "data:"];

/** Relativní specifikátor = smrt funkce. Po balení jich smí být nula. */
const RELATIVE_IMPORT = /(?:^|[\s;])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?["'](\.{1,2}\/[^"']*)["']/gm;

/**
 * ESM import příkaz. Mezi `import` a uvozovkou nesmí být `;`, uvozovka ani
 * závorka — tím se nemůže přesmyknout přes konec jednoho příkazu na další.
 * Zachytí `import "x"`, `import a from "x"`, `import {a, b} from "x"`,
 * `import a, {b} from "x"`.
 */
const ESM_IMPORT = /(^|[\n;])([ \t]*)import\s+([^;'"()]*?\bfrom\s+)?(["'])([^"']+)\4([ \t]*;?)/g;

/** `import("...")` — dynamický import má jiné parens, proto samostatný vzor. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;

/**
 * Živý stav `verify_jwt`, který se NESMÍ při deployi změnit.
 * Klíč = slug funkce, hodnota = požadovaný stav.
 * Ověřeno proti živým funkcím 2026-10-04 (18/18 loadnuto spuštěním).
 */
const VERIFY_JWT = {
  legal: false,
  "youtube-oauth-callback": false,
  "youtube-sync-stats": false,
  "youtube-publish-scheduler": false,
  "agent-confirm": true,
  "agent-orchestrator": true,
  "songcraft-copywriter": true,
  "songcraft-cover-ai": true,
  "songcraft-imports": true,
  "songcraft-media": true,
  "songcraft-rhymes": true,
  "songcraft-studio-assistant": true,
  "songcraft-utilities": true,
  "songcraft-youtube": true,
  "video-renderer-dispatch": true,
  "youtube-oauth-start": true,
  "youtube-publish": true,
  "youtube-status": true,
};

function discoverFunctionSlugs() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("_"))
    .filter((entry) => !NON_FUNCTION_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .filter((slug) => existsSync(join(FUNCTIONS_DIR, slug, "index.ts")))
    .sort();
}

/**
 * `jsr:` → `npm:` pro skutečné závislosti.
 * JSR i npm registry sdílejí stejný namespace (`@scope/name`), takže
 * `jsr:@supabase/supabase-js@2` → `npm:@supabase/supabase-js@2`. Balíček existuje
 * na npm i na JSR, Edge Runtime umí jen npm.
 */
function rewriteSpecifier(specifier) {
  return specifier.startsWith("jsr:") ? `npm:${specifier.slice("jsr:".length)}` : specifier;
}

/** Side-effect import na deklaraci typů (`import "…d.ts"`). Za běhu je nepotřebný a škodí. */
function isTypeOnlySideEffect(specifier, clause) {
  return !clause && /\.d\.[cm]?ts$/.test(specifier);
}

/**
 * Post-processing balíčku: vyhodí typové side-effect importy a přepíše `jsr:`
 * na `npm:`. Vrací `{ code, stripped, rewritten }`.
 */
function rewriteBundle(code) {
  const stripped = [];
  const rewritten = [];

  let out = code.replace(ESM_IMPORT, (match, lead, indent, clause, quote, specifier, tail) => {
    if (isTypeOnlySideEffect(specifier, clause)) {
      stripped.push(specifier);
      return lead;
    }
    const next = rewriteSpecifier(specifier);
    if (next !== specifier) rewritten.push(`${specifier} → ${next}`);
    return `${lead}${indent}import ${clause ?? ""}${quote}${next}${quote}${tail}`;
  });

  out = out.replace(DYNAMIC_IMPORT, (match, quote, specifier) => {
    const next = rewriteSpecifier(specifier);
    if (next !== specifier) rewritten.push(`${specifier} → ${next}`);
    return `import(${quote}${next}${quote})`;
  });

  return { code: out, stripped, rewritten };
}

/** Všechny specifikátory importů v kódu (i ty, které už nejsou v hlavičce). */
function importSpecifiersIn(code) {
  const found = [];
  for (const match of code.matchAll(ESM_IMPORT)) found.push(match[5]);
  for (const match of code.matchAll(DYNAMIC_IMPORT)) found.push(match[2]);
  return [...new Set(found)];
}

function relativeImportsIn(code) {
  const found = new Set();
  for (const match of code.matchAll(RELATIVE_IMPORT)) found.add(match[1]);
  return [...found];
}

/** Řádky, kde se `needle` vyskytuje — pro výstup chyby, která musí být čitelná. */
function linesWith(code, needle, limit = 5) {
  const hits = [];
  code.split("\n").forEach((line, i) => {
    if (hits.length < limit && line.includes(needle)) hits.push(`      ${i + 1}: ${line.trim().slice(0, 160)}`);
  });
  return hits;
}

/**
 * ACCEPTANCE TEST. Zelená = „tento bundle BOOTNE".
 * Cokoliv jiného je chyba a vyhozeno — nikoli warn.
 */
function assertBootable(slug, code) {
  const problems = [];

  const relative = relativeImportsIn(code);
  if (relative.length > 0) {
    problems.push(
      `zbyl relativní specifikátor (Edge Runtime nenasadí _shared/ → 503 BOOT_ERROR): ${relative.join(", ")}`,
    );
  }

  if (code.includes("jsr:")) {
    problems.push(
      `zbyl specifikátor \`jsr:\` (Edge Runtime ho neresolvuje → 503 BOOT_ERROR).\n` +
        linesWith(code, "jsr:").join("\n"),
    );
  }

  const typeOnly = importSpecifiersIn(code).filter((s) => /\.d\.[cm]?ts$/.test(s));
  if (typeOnly.length > 0) {
    problems.push(
      `zbyl typový side-effect import (jen pro editor, v runtime škodí): ${typeOnly.join(", ")}`,
    );
  }

  const unsafe = importSpecifiersIn(code)
    .filter((s) => !s.startsWith("."))
    .filter((s) => !RUNTIME_SAFE_SCHEMES.some((scheme) => s.startsWith(scheme)));
  if (unsafe.length > 0) {
    problems.push(
      `specifikátor se schématem, který Edge Runtime neumí: ${unsafe.join(", ")}` +
        ` (povolené: ${RUNTIME_SAFE_SCHEMES.join(" ")})`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`acceptance test selhal pro ${slug}:\n    - ${problems.join("\n    - ")}`);
  }
}

function bundleOne(slug) {
  const entry = join(slug, "index.ts");
  const outFile = join(DIST_DIR, slug, "index.js");
  mkdirSync(dirname(outFile), { recursive: true });

  const args = [
    "bundle",
    entry,
    "-o",
    outFile,
    "--packages",
    "external",
    "--platform",
    "deno",
  ];
  for (const specifier of EXTERNAL_SPECIFIERS) args.push("--external", specifier);

  // cwd = supabase/functions, aby Deno našel functions/deno.json
  // (nodeModulesDir: auto) a functions/deno.lock. Bez toho se npm/jsr resolvují
  // proti globálnímu cache a balení spadne na chybějící transitivní závislosti.
  execFileSync("deno", args, { cwd: FUNCTIONS_DIR, stdio: ["ignore", "pipe", "pipe"] });

  const raw = readFileSync(outFile, "utf8");
  const { code, stripped, rewritten } = rewriteBundle(raw);
  writeFileSync(outFile, code);

  assertBootable(slug, code);

  return {
    slug,
    bytes: statSync(outFile).size,
    stripped,
    rewritten,
    external: importSpecifiersIn(code).filter((s) => !s.startsWith(".")),
  };
}

// -----------------------------------------------------------------------------
// NASAZENÍ přes Management API
// -----------------------------------------------------------------------------
const API = "https://api.supabase.com/v1";

async function apiRequest(path, token, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, json };
}

async function deploy(slugs) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!token || !ref) {
    console.error(
      "chybí SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF (např. `set -a && . ./.env.local && set +a`)",
    );
    process.exit(1);
  }

  console.log(`\nživý stav funkcí (${ref}):`);
  const list = await apiRequest(`/projects/${ref}/functions`, token);
  if (!list.ok) {
    console.error(`  Management API GET /functions selhal: ${list.status} ${JSON.stringify(list.json)}`);
    process.exit(1);
  }
  const live = new Map(list.json.map((f) => [f.slug, f]));

  // Fail-closed: verify_jwt se nesmí přepsat. Když se živý stav liší od tabulky,
  // někdo to změnil schválně a tabulka je zastaralá — radši nic neposlat.
  const drift = [];
  for (const slug of slugs) {
    const expected = VERIFY_JWT[slug];
    if (expected === undefined) {
      drift.push(`${slug}: není v tabulce VERIFY_JWT`);
      continue;
    }
    const current = live.get(slug);
    if (!current) drift.push(`${slug}: v projektu neexistuje`);
    else if (Boolean(current.verify_jwt) !== expected) {
      drift.push(`${slug}: živě verify_jwt=${current.verify_jwt}, tabulka říká ${expected}`);
    }
  }
  for (const slug of Object.keys(VERIFY_JWT).filter((s) => !slugs.includes(s))) {
    const current = live.get(slug);
    if (current && Boolean(current.verify_jwt) !== VERIFY_JWT[slug]) {
      drift.push(`${slug}: živě verify_jwt=${current.verify_jwt}, tabulka říká ${VERIFY_JWT[slug]}`);
    }
  }
  if (drift.length > 0) {
    console.error(`\nverify_jwt nesouhlasí s tabulkou — NASAZENO NIC:\n  - ${drift.join("\n  - ")}`);
    console.error("oprav tabulku VERIFY_JWT ve skriptu teprve po ručním ověření, kdo a proč to změnil");
    process.exit(1);
  }

  console.log("\nnasazuji PATCHem (POST by požadoval `name` i `slug` a update by selhal):");
  for (const slug of slugs) {
    const verifyJwt = VERIFY_JWT[slug];
    const body = readFileSync(join(DIST_DIR, slug, "index.js"), "utf8");
    const payload = JSON.stringify({ slug, body, verify_jwt: verifyJwt });
    const result = await apiRequest(`/projects/${ref}/functions/${slug}`, token, {
      method: "PATCH",
      body: payload,
    });
    if (!result.ok) {
      console.error(`  FAIL  ${slug.padEnd(30)} HTTP ${result.status} ${JSON.stringify(result.json)}`);
      process.exit(1);
    }
    console.log(`  OK    ${slug.padEnd(30)} verify_jwt=${String(verifyJwt).padEnd(5)} (${body.length} B)`);
  }

  const loop = [
    `  for s in ${slugs.join(" ")}; do`,
    '    curl -sS -o /dev/null -w "$s %{http_code}\\n" -X POST \\',
    `      "https://${ref}.supabase.co/functions/v1/$s" \\`,
    '      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \\',
    '      -H "Content-Type: application/json" -d "{}"',
    "  done",
  ].join("\n");

  console.log(`\nPOZOR: nasazení NENÍ runtime test. Zavolej funkci a ověř, že NEVRACÍ 503 BOOT_ERROR:\n${loop}`);
}

// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const options = { deploy: false, slugs: [] };
  const onlyLists = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deploy") options.deploy = true;
    else if (arg.startsWith("--only=")) onlyLists.push(arg.slice("--only=".length));
    else if (arg === "--only") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("--only potřebuje seznam slugů oddělený čárkou");
      onlyLists.push(value);
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`neznámý přepínač: ${arg}`);
    else options.slugs.push(arg);
  }
  for (const list of onlyLists) {
    options.slugs.push(...list.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return { deploy: options.deploy, slugs: [...new Set(options.slugs)] };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const slugs = options.slugs.length > 0 ? options.slugs : discoverFunctionSlugs();

  const unknown = slugs.filter((slug) => !existsSync(join(FUNCTIONS_DIR, slug, "index.ts")));
  if (unknown.length > 0) {
    console.error(`neznámé funkce: ${unknown.join(", ")}`);
    process.exit(1);
  }
  if (slugs.length === 0) {
    console.error(`v ${FUNCTIONS_DIR} není žádná nasaditelná funkce`);
    process.exit(1);
  }

  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });

  console.log(`balím ${slugs.length} funkcí do supabase/functions-dist/ (deno bundle)\n`);
  const results = [];
  const failures = [];

  for (const slug of slugs) {
    try {
      const result = bundleOne(slug);
      results.push(result);
      const kb = (result.bytes / 1024).toFixed(1);
      const notes = [
        result.stripped.length > 0 ? `odstraněno typových importů: ${result.stripped.length}` : null,
        result.rewritten.length > 0 ? `jsr:→npm: ${result.rewritten.length}` : null,
      ].filter(Boolean);
      console.log(`  OK    ${slug.padEnd(30)} ${kb.padStart(8)} kB   ${notes.join(" · ") || "jen runtime scheme"}`);
    } catch (error) {
      failures.push(slug);
      const detail = error.stderr ? String(error.stderr).trim() : error.message;
      console.error(`  FAIL  ${slug.padEnd(30)} ${detail.split("\n").join("\n")}`);
    }
  }

  console.log(`\nbundleno ${results.length}/${slugs.length}`);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} funkcí se nepovedlo zbundlovat nebo neprošlo acceptance testem:\n  ${failures.join("\n  ")}\n` +
        "Balíček, který neprojde acceptance testem, NIKDY neposílat — je to 503 v produkci.",
    );
    process.exit(1);
  }

  const external = [...new Set(results.flatMap((r) => r.external))].sort();
  console.log("\nzbylé externí specifikace (Edge Runtime je resolvuje za běhu):");
  for (const specifier of external) console.log(`  ${specifier}`);
  const rewritten = [...new Set(results.flatMap((r) => r.rewritten))].sort();
  if (rewritten.length > 0) {
    console.log("\nproč toto nebyl jen kosmetický detail:");
    for (const line of rewritten) console.log(`  ${line}   ← jsr: by skončilo 503 BOOT_ERROR`);
  }
  const stripped = [...new Set(results.flatMap((r) => r.stripped))].sort();
  if (stripped.length > 0) {
    console.log("\nvyhozené typové importy (jen pro editor):");
    for (const specifier of stripped) console.log(`  ${specifier}`);
  }
  console.log(
    "\nacceptance prošel: 0 relativních specifikátorů, 0 `jsr:`, 0 typových importů,\n" +
      "každá zbývající specifikace je scheme, který Edge Runtime umí.",
  );

  if (!options.deploy) {
    console.log("\nrežim pouze balení. Nasazení záměrně NEproběhlo.");
    console.log("pro nasazení: node scripts/bundle-edge-functions.mjs --deploy");
    return;
  }
  await deploy(slugs);
}

await main();
