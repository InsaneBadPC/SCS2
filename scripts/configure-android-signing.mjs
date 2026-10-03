#!/usr/bin/env node
// Zkompiluje `expo prebuild` + podepisování release APK z prostředí.
//
// Proč to není jen v workflow: `expo prebuild` při každém běhu přegeneruje
// `android/app/build.gradle`, takže podpisový blok se musí vkládat opakovaně a
// idempotentně. Zároveň se tím dá otestovat lokálně bez Gradle.
//
// Proměnné prostředí (žádné hodnoty se nelogují):
//   CI_KEYSTORE_B64  base64 obsah .jks
//   CI_KEYSTORE_PASS  heslo keystore i klíče
//   CI_KEY_ALIAS     alias (výchozí songcraft)
//
// Použití: node scripts/configure-android-signing.mjs [--check]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');
const KEYSTORE = path.join(ROOT, 'android', 'app', 'songcraft-release.jks');
const PROPERTIES = path.join(ROOT, 'android', 'keystore.properties');
const CHECK_ONLY = process.argv.includes('--check');

const keystoreB64 = (process.env.CI_KEYSTORE_B64 ?? '').trim();
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
  fail('chybí CI_KEYSTORE_B64 nebo CI_KEYSTORE_PASS (release APK by nebyl podepsaný)');
}

const keystore = Buffer.from(keystoreB64.replace(/\s+/g, ''), 'base64');
// JKS začíná magickou FEEDFEED (0xFE), PKCS#12 je DER SEQUENCE (0x30).
if (keystore.length < 512 || (keystore[0] !== 0xfe && keystore[0] !== 0x30)) {
  fail('CI_KEYSTORE_B64 nevypadá jako platný JKS/PKCS12 keystore');
}
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

if (patched !== original) writeFileSync(GRADLE, patched, 'utf8');
console.log(`signing: release klíč (alias ${keyAlias}) zapojen, keystore ${keystore.length} B`);
