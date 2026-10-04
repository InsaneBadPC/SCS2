#!/usr/bin/env node
// Zkompiluje `expo prebuild` + podepisování release APK z prostředí.
//
// Proč to není jen v workflow: `expo prebuild` při každém běhu přegeneruje
// `android/app/build.gradle`, takže podpisový blok se musí vkládat opakovaně a
// idempotentně. Zároveň se tím dá otestovat lokálně bez Gradle.
//
// Proměnné prostředí (žádné hodnoty se nelogují):
//   CI_KEYSTORE_B64  base64 obsah .jks / .p12  (primární název)
//   CI_KEYSTORE      totéž pod názvem GitHub Secretu `CI_KEYSTORE`
//   CI_KEYSTORE_PASS  heslo keystore i klíče
//   CI_KEY_ALIAS     alias (výchozí songcraft)
//
// Precedence je deterministická a záměrně zdvojená, protože název Secretu
// (`CI_KEYSTORE`) a název proměnné (`CI_KEYSTORE_B64`) se v minulosti rozcházily
// a release build přitom tiše umíral na prázdné proměnné. Když jsou nastavené
// OBE, musí se po normalizaci shodovat — jinak `fail` (fail closed), protože
// „vyberu náhodnou" je přesně ten stav, který by vydal nepodepsané APK.
//
// Použití: node scripts/configure-android-signing.mjs [--check]

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const KEYSTORE = path.join(ROOT, 'android', 'app', 'songcraft-release.jks');
const PROPERTIES = path.join(ROOT, 'android', 'keystore.properties');
const CHECK_ONLY = process.argv.includes('--check');

// Secret v repu se jmenuje `CI_KEYSTORE`, proměnná v kódu `CI_KEYSTORE_B64`.
// Bereme obě jména, jinak by stačilo jedno překlepnutí v UI GitHubu a release
// build by skončil na `chybí …` bez jediného podepsaného APK.
function resolveKeystoreEnv() {
  const primary = (process.env.CI_KEYSTORE_B64 ?? '').trim();
  const legacy = (process.env.CI_KEYSTORE ?? '').trim();
  // Whitespace uvnitř base64 ignorujeme — `base64 -w 0` v shellu občas zaláme
  // řádky a ekvivalentní hodnota nesmí vyvolat „nejednoznačné" chybovou hlášku.
  const normalize = (value) => value.replace(/\s+/g, '');
  if (primary && legacy && normalize(primary) !== normalize(legacy)) {
    fail('CI_KEYSTORE_B64 a CI_KEYSTORE jsou nastavené na různé hodnoty — odstraň tu nesprávnou proměnnou');
  }
  return normalize(primary || legacy);
}

const keystoreB64 = resolveKeystoreEnv();
const storePassword = (process.env.CI_KEYSTORE_PASS ?? '').trim();
const keyAlias = (process.env.CI_KEY_ALIAS ?? 'songcraft').trim() || 'songcraft';

function fail(message) {
  console.error(`configure-android-signing: ${message}`);
  process.exit(1);
}

if (!existsSync(GRADLE)) fail('android/app/build.gradle neexistuje — nejdřív spusť `npx expo prebuild --platform android`');

const SIGNING_CONFIG_RELEASE = `        release {
            def propsFile = rootProject.file("keystore.properties")
            if (propsFile.exists()) {
                def props = new Properties()
                propsFile.withInputStream { props.load(it) }
                storeFile file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            }
        }
`;

// 2) release buildType musí používat release klíč, ne debug klíč runneru.
//    Blok `release { … }` obsahuje i komentáře, takže ho upravujeme po řádcích
//    s hloubkou závorek, ne jedním regulárním výrazem.
function patchReleaseBlock(gradle) {
  const lines = gradle.split('\n');
  // `signingConfigs { release { … } }` přišlo jako první — hledáme až za buildTypes.
  const buildTypesIndex = lines.findIndex((line) => /^\s{4}buildTypes \{/.test(line));
  const startIndex = lines.findIndex((line, index) => index > buildTypesIndex && /^\s{8}release \{/.test(line));
  if (startIndex === -1) throw new Error('v build.gradle chybí release buildType');
  let depth = 0;
  let endIndex = -1;
  for (let index = startIndex; index < lines.length; index += 1) {
    depth += (lines[index].match(/\{/g) ?? []).length - (lines[index].match(/\}/g) ?? []).length;
    if (index > startIndex && depth === 0) {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) throw new Error('release buildType nemá uzavírající závorku');
  const block = lines.slice(startIndex, endIndex + 1);
  const withoutDebug = block.filter((line) => !/signingConfig signingConfigs\.debug/.test(line));
  if (withoutDebug.some((line) => /signingConfig signingConfigs\.release/.test(line))) return gradle;
  const [head, ...rest] = withoutDebug;
  return [
    ...lines.slice(0, startIndex),
    head,
    '        signingConfig signingConfigs.release',
    ...rest,
    ...lines.slice(endIndex + 1),
  ].join('\n');
}

const original = readFileSync(GRADLE, 'utf8');
let patched = original;

// 1) vloží `release` do existujícího `signingConfigs` bloku (šablona RN ho má
//    s `debug`), aby nevznikl duplicitní blok — Gradle by to odmítl.
if (!patched.includes('keystore.properties')) {
  if (!/^ {4}signingConfigs \{$/m.test(patched)) fail('v build.gradle chybí signingConfigs blok');
  patched = patched.replace(/^ {4}signingConfigs \{$/m, `    signingConfigs {\n${SIGNING_CONFIG_RELEASE}`);
}

// 2) release buildType musí používat release klíč, ne debug klíč runneru
try {
  patched = patchReleaseBlock(patched);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
// Kontrola se týká jen release buildType uvnitř `buildTypes` — `debug` buildType
// má debug klíč správně a `signingConfigs.release` je definice, ne buildType.
const releaseBuildType = readReleaseBuildType(patched);
if (/signingConfig signingConfigs\.debug/.test(releaseBuildType)) fail('release buildType stále používá debug klíč');
if (!/signingConfig signingConfigs\.release/.test(releaseBuildType)) fail('nepodařilo se připojit release signingConfig');

function readReleaseBuildType(gradle) {
  const lines = gradle.split('\n');
  const buildTypesIndex = lines.findIndex((line) => /^\s{4}buildTypes \{/.test(line));
  if (buildTypesIndex === -1) return '';
  const start = lines.findIndex((line, index) => index > buildTypesIndex && /^\s{8}release \{/.test(line));
  if (start === -1) return '';
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    depth += (lines[index].match(/\{/g) ?? []).length - (lines[index].match(/\}/g) ?? []).length;
    if (index > start && depth === 0) return lines.slice(start, index + 1).join('\n');
  }
  return '';
}

if (CHECK_ONLY) {
  console.log('build.gradle: signing config ready');
  process.exit(0);
}

if (!keystoreB64 || !storePassword) {
  fail('chybí CI_KEYSTORE_B64 (= CI_KEYSTORE) nebo CI_KEYSTORE_PASS (release APK by nebyl podepsaný)');
}

// `keystore.properties` je prostý text `klíč=hodnota` na řádek — zalomení řádku
// v hesle nebo aliasu by tam propašovalo falešnou vlastnost (např. `storeFile=`),
// takže to odmítáme dřív, než se soubor zapíše.
if (/[\r\n]/.test(storePassword) || /[\r\n]/.test(keyAlias)) {
  fail('CI_KEYSTORE_PASS a CI_KEY_ALIAS nesmí obsahovat zalomení řádku');
}

const keystore = Buffer.from(keystoreB64, 'base64');
// JKS: 4B magicka FEEDFEED, 4B verze, 4B pocet zaznamu.
// PKCS#12: DER SEQUENCE (0x30) + délka vnějšího obalu, takže useknutí je
// zjistitelné přesně. 512 B je pod stropem i nejmenšího realneho keystoreu
// (keytool PKCS12 s jedním RSA-2048 klíčem má ~3 kB), takže hlídá jen blbosti.
const JKS_MAGIC = 0xfeedfeed;
const JKS_HEADER_BYTES = 12;
const JKS_MIN_ENTRY_BYTES = 14; // tag + alias(2B) + timestamp(8B), minimum per entry
const MIN_KEYSTORE_BYTES = 512;

function derOuterLength(bytes) {
  if (bytes[0] !== 0x30 || bytes.length < 3) return null;
  const first = bytes[1];
  if ((first & 0x80) === 0) return 3 + ((first << 8) | bytes[2]); // krátký tvar
  const count = first & 0x7f; // dlouhý tvar: 0x80|počet oktetů
  if (count === 0 || count > 4 || bytes.length < 2 + count) return null;
  let declared = 0;
  for (let index = 0; index < count; index += 1) declared = declared * 256 + bytes[2 + index];
  return 2 + count + declared;
}

function validateKeystore(bytes) {
  if (bytes.length < MIN_KEYSTORE_BYTES) {
    fail(`keystore má jen ${bytes.length} B, méně než ${MIN_KEYSTORE_BYTES} B — base64 se nejspíš rozpadla`);
  }
  if (bytes.readUInt32BE(0) === JKS_MAGIC) {
    const entries = bytes.readUInt32BE(8);
    if (entries < 1) fail('JKS hlasí 0 záznamů — to není podepisovací klíč');
    if (bytes.length < JKS_HEADER_BYTES + entries * JKS_MIN_ENTRY_BYTES) {
      fail(`JKS hlasí ${entries} záznamů, ale soubor má jen ${bytes.length} B — keystore je useknutý`);
    }
    return;
  }
  if (bytes[0] === 0x30) {
    const declared = derOuterLength(bytes);
    if (declared !== null && declared > bytes.length) {
      fail(`PKCS#12 hlasí ${declared} B, ale má jen ${bytes.length} B — keystore je useknutý`);
    }
    return;
  }
  fail(`keystore nezačíná magickou JKS (0xFEEDFEED) ani PKCS#12 (0x30), ale 0x${bytes[0].toString(16).padStart(2, '0').toUpperCase()}`);
}

validateKeystore(keystore);

// Když selže zápis properties po zápisu keystore, nesmí zůstat viset
// polovina hesla na disku — Gradle by si ji vzal i bez platných properties.
try {
  writeFileSync(KEYSTORE, keystore, { mode: 0o600 });
  writeFileSync(
    PROPERTIES,
    [
      'storeFile=songcraft-release.jks',
      `storePassword=${storePassword}`,
      `keyAlias=${keyAlias}`,
      `keyPassword=${storePassword}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
} catch (error) {
  try {
    rmSync(KEYSTORE, { force: true });
    rmSync(PROPERTIES, { force: true });
  } catch {
    // už nic dalšího neuděláme, hláška níže je ta důležitá
  }
  fail(`nepodařilo se zapsat keystore na disk: ${error instanceof Error ? error.message : String(error)}`);
}

if (patched !== original) writeFileSync(GRADLE, patched, 'utf8');
// Alias ani heslo se nelogují — do logu jde jen délka, podle níž se pozná, že
// base64 prošla v pořádku.
console.log(`signing: release klíč zapojen, keystore ${keystore.length} B`);
