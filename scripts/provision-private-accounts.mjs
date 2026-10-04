#!/usr/bin/env node
// Zajišťuje, že v Supabase projektu studia existují PŘESNĚ tři soukromé účty.
// Seznam účtů (jméno, e-mail, UUID) se neopakuje tady — čte se z `lib/accounts.ts`,
// což je jediný zdroj pravdy sdílený s aplikací i s živými testy.
//
// Skript je záměrně fail-closed a nikdy nepřepíše existující účet:
//   * bez výslovného `--i-know-this-touches-live-accounts` odmítne běžet,
//   * ref projektu musí souhlasit s `lib/supabase.ts` (jinak běžet odmítne),
//   * účty se hledají POUZE podle e-mailu — nikdy podle `display_name`
//     (jména se opakují mezi lidmi, shoda jména by přepsala cizí účet),
//   * existující účet se nikdy neupravuje: shoda = no-op, rozdíl = hlášení
//     a přeskočení; zápis `PUT /auth/v1/admin/users/{id}` tu není a nesmí
//     se přidat, protože přepsal by cizí `user_metadata` (a heslo by přepsal
//     jen kdyby bylo v těle požadavku — jeho sem patřit nesmí),
//   * hlášení rozdílů má TŘI koše, ne jeden (viz `describeDrift`), aby
//     zdravý účet s jedním kosmetickým nedostatkem nebyl hlášený jako rozpad,
//   * heslo, service_role klíč ani PAT se nikdy nevypisují (viz `redact`).
//
//   node scripts/provision-private-accounts.mjs --i-know-this-touches-live-accounts
//
// Exit code: 0 = vše v pořádku (případně jen metadata k doplnění),
//            1 = odmítnuto / nesoulad,
//            2 = chybné použití.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPT_IN_FLAG = '--i-know-this-touches-live-accounts';

const USAGE = [
  `Použití: node scripts/provision-private-accounts.mjs ${OPT_IN_FLAG}`,
  '',
  'Bez přepínače skript odmítne běžet a nic nezmění.',
].join('\n');

// Záměrně duplicitní konstanta: musí souhlasit s `lib/supabase.ts`, jinak skript
// odmítne běžet. Tak se nikdy nepodáhá starý projekt hfykngbhcxmnpxvjagoj.
const EXPECTED_PROJECT_REF = 'gpgbgjxeybfncrexrpbr';
const FORBIDDEN_PROJECT_REFS = new Set(['hfykngbhcxmnpxvjagoj']);
const EXPECTED_ACCOUNT_COUNT = 3;
const MIN_PASSWORD_LENGTH = 8;

// ── Tajemství ────────────────────────────────────────────────────────────────
// Každá tajná hodnota, kterou skript načte, se zaregistruje tady. `redact` pak
// odmítne vypsat řádek, který by ji obsahoval, takže budoucí úprava nemůže
// vypisovat heslo ani klíč.
const secretValues = new Set();
const SECRET_SHAPES = [
  /\bsb_secret_[A-Za-z0-9_-]{8,}/g,
  /\bsbp_[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:sbp|gh[pousr])_[A-Za-z0-9_-]{20,}/g,
];

function rememberSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secretValues.add(value);
}

function redact(line) {
  let safe = String(line);
  for (const secret of secretValues) {
    if (safe.includes(secret)) safe = safe.split(secret).join('[REDIGOVÁNO]');
  }
  for (const shape of SECRET_SHAPES) {
    shape.lastIndex = 0;
    if (shape.test(safe)) safe = '[REDIGOVÁNO — řádek měl tvar tajné hodnoty]';
  }
  return safe;
}

function say(line = '') {
  console.log(redact(line));
}

function shout(line = '') {
  console.error(redact(line));
}

function fail(message, code = 1) {
  shout(`provision-private-accounts: odmítnuto — ${message}`);
  process.exit(code);
}

// ── Zdroje pravdy z repozitáře ───────────────────────────────────────────────

function readSource(...segments) {
  try {
    return readFileSync(path.join(ROOT, ...segments), 'utf8');
  } catch {
    fail(`nelze přečíst ${path.join(...segments)}`);
  }
}

/** @returns {{id: string, email: string, name: string}[]} */
function readStudioAccounts() {
  const source = readSource('lib', 'accounts.ts');
  const array = source.match(/STUDIO_ACCOUNTS[^=]*=\s*\[([\s\S]*?)\]\s*(?:as const)?;/);
  if (!array) fail('v lib/accounts.ts se nepodařilo najít STUDIO_ACCOUNTS');
  const entries = [...array[1].matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]);
  if (entries.length !== EXPECTED_ACCOUNT_COUNT) {
    fail(`v lib/accounts.ts je ${entries.length} účtů, očekávám přesně ${EXPECTED_ACCOUNT_COUNT}`);
  }

  const accounts = entries.map((entry) => {
    const field = (key) => entry.match(new RegExp(`${key}:\\s*"([^"]*)"`))?.[1];
    const id = field('id');
    const email = field('email');
    const name = field('name');
    if (!id || !email || !name) fail(`účet v lib/accounts.ts nemá id/email/name: ${entry.trim().slice(0, 40)}`);
    return { id, email, name };
  });

  const emails = new Set();
  const ids = new Set();
  for (const account of accounts) {
    const email = account.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`nepřijatelný e-mail v lib/accounts.ts: ${account.email}`);
    if (email.endsWith('.test')) fail(`lib/accounts.ts obsahuje testovací e-mail ${account.email}`);
    if (emails.has(email)) fail(`lib/accounts.ts má duplicitní e-mail ${account.email}`);
    if (ids.has(account.id)) fail(`lib/accounts.ts má duplicitní id ${account.id}`);
    emails.add(email);
    ids.add(account.id);
  }
  return accounts;
}

function readProjectRef() {
  const source = readSource('lib', 'supabase.ts');
  const match = source.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/);
  if (!match) fail('v lib/supabase.ts se nepodařilo najít SUPABASE_URL');
  const ref = match[1];
  if (FORBIDDEN_PROJECT_REFS.has(ref)) fail(`projekt ${ref} je zakázaný`);
  if (ref !== EXPECTED_PROJECT_REF) {
    fail(`ref v lib/supabase.ts (${ref}) nesouhlasí s očekávaným (${EXPECTED_PROJECT_REF}) — nikdy nesáhnu do jiného projektu`);
  }
  return ref;
}

// ── Hesla ───────────────────────────────────────────────────────────────────
// Název proměnné se odvozuje z jména účtu (`Verča` → `SONGCRAFT_VERCA_PASSWORD`),
// takže se v repu neopakuje ani e-mail, ani UUID, ani heslo.

function passwordEnvVar(name) {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) fail(`z jména „${name}“ nejde odvodit název proměnné s heslem`);
  return `SONGCRAFT_${slug}_PASSWORD`;
}

function resolvePassword(name) {
  const variable = passwordEnvVar(name);
  const password = (process.env[variable] ?? '').trim();
  if (!password) fail(`chybí ${variable} (heslo se nikdy nedává do repa ani do příkazové řádky)`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`${variable} má méně než ${MIN_PASSWORD_LENGTH} znaků`);
  }
  return { variable, password };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    say(USAGE);
    process.exit(0);
  }
  const unknown = args.filter((argument) => argument !== OPT_IN_FLAG);
  if (unknown.length > 0) fail(`neznámý přepínač: ${unknown.join(' ')}\n${USAGE}`, 2);
  if (!args.includes(OPT_IN_FLAG)) {
    fail(`chybí ${OPT_IN_FLAG}. Tento skript mění živé účty a spouští se jen výslovně.\n${USAGE}`);
  }
}

// ── Supabase admin API ──────────────────────────────────────────────────────

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** Rozhodující je e-mail. `display_name` se nikdy neporovnává. */
export function findByEmail(users, email) {
  const wanted = normalizeEmail(email);
  return users.find((user) => normalizeEmail(user?.email) === wanted);
}

/**
 * POTVRZENÍ E-MAILU — tady byla chyba, která hlásila falešné drifty.
 *
 * GoTrue admin API (`GET /auth/v1/admin/users` i `.../users/{id}`) při čtení
 * vrací pole **`email_confirmed_at`** (ISO 8601, nebo `null`). Pole
 * `email_confirm` vrací jen jako VSTUP při vytvoření
 * (`POST /auth/v1/admin/users`) — ve výsledku ho není nikdy, takže
 * `existing.email_confirm !== true` byla pravda pro KAŽDÝ účet a skript
 * považoval tři zdravé účty za rozpad, skončil exit 1 a vypsal
 * „ROZDÍLY, KTERÉ SE NEPŘEPÍŠOU". Skript, který křičí „všechno je rozbité"
 * na zdravém projektu, se pak buď ignoruje, nebo použije k něčemu horšímu.
 * (Ověřeno živým dotazem 2026-10-04: `email_confirm` chybí ve všech 3
 * živých účtech, `email_confirmed_at` je vyplněné u všech 3.)
 *
 * Jsou tu TŘI stavy, ne dva. `unknown` = API nevrátilo žádné z polí (nebo
 * vrátilo nesmysl). To je chyba skriptu proti API, ne rozpadlý účet, takže se
 * hlásí zvlášť — ale „nevím" nesmí projít jako „v pořádku", protože by to
 * přesně zopakovalo původní poplach.
 *
 * @returns {{state: "confirmed"|"unconfirmed"|"unknown", field: string|null}}
 */
export function readEmailConfirmation(user) {
  // 1) Dokumentované čtené pole GoTrue — to je to, na co se ptáme.
  if (user && Object.hasOwn(user, 'email_confirmed_at')) {
    const value = user.email_confirmed_at;
    if (value === null || value === undefined || value === '') {
      return { state: 'unconfirmed', field: 'email_confirmed_at' };
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return { state: 'confirmed', field: 'email_confirmed_at' };
    }
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
      return { state: 'confirmed', field: 'email_confirmed_at' };
    }
    return { state: 'unknown', field: 'email_confirmed_at' };
  }
  // 2) Starší GoTrue build nebo proxy, co boolean vrací. Tolerujeme, ale
  //    NEPREFERUJEME ho — pokud je jednou přítomno, vyhraje (1).
  if (user && Object.hasOwn(user, 'email_confirm')) {
    return user.email_confirm === true
      ? { state: 'confirmed', field: 'email_confirm' }
      : { state: 'unconfirmed', field: 'email_confirm' };
  }
  return { state: 'unknown', field: null };
}

/**
 * Rozdělení nálezu na tři koše, aby zdravý účet nevypadal jako rozpadlý:
 *
 *   `conflict`     skutečný rozpor s `lib/accounts.ts` — jiné `id`,
 *                  nepotvrzený e-mail, nebo `display_name`, který EXISTUJE
 *                  a jiný. Tady se nic nepřepíše, exit je 1.
 *   `adoptable`    `display_name` chybí. Účet je zdravý — jen nemá jméno.
 *                  Hláseno zvlášť, exit NEselhá (viz níže).
 *   `unverifiable` API nevrátilo pole, které skript čte. Exit 1, protože
 *                  „nevím" není totéž co „v pořádku".
 *
 * PROČ `adoptable` NENÍ drift a PROČ sem display_name NEZAPÍŠEME:
 * chybějící jméno nemá vliv na běh. Přihlášení jde podle e-mailu
 * (`lib/accounts.ts` + `findAccountByEmail`) a `hooks/use-auth.ts:26` už teď
 * padá na bezpečný default, když `user_metadata.display_name` není string.
 * Doplnění by navíc znamenalo `PUT /auth/v1/admin/users/{id}` na živý účet
 * jen kvůli kosmetice — a to je přesně ten zápis, kvůli kterému má tenhle
 * skript zákaz na `PUT`. Jedno ruční doplnění v Dashboardu je levnější
 * riziko než automatická mutace produkčního auth stavu.
 */
export function describeDrift(existing, account) {
  const conflict = [];
  const adoptable = [];
  const unverifiable = [];

  if (existing.id !== account.id) {
    conflict.push(`id v Supabase (${existing.id}) nesouhlasí s lib/accounts.ts (${account.id})`);
  }

  const confirmation = readEmailConfirmation(existing);
  if (confirmation.state === 'unconfirmed') {
    conflict.push(`e-mail není potvrzený (${confirmation.field} je prázdný)`);
  } else if (confirmation.state === 'unknown') {
    unverifiable.push(
      confirmation.field
        ? `${confirmation.field} má neočekávanou hodnotu — potvrzení e-mailu nelze rozhodnout`
        : 'GoTrue nevrátil ani email_confirmed_at, ani email_confirm — potvrzení e-mailu nelze ověřit',
    );
  }

  const displayName = existing.user_metadata?.display_name;
  if (displayName === undefined || displayName === null || displayName === '') {
    adoptable.push(
      `user_metadata.display_name chybí, v lib/accounts.ts je ${JSON.stringify(account.name)} — účet funguje, jméno doplní Dashboard`,
    );
  } else if (displayName !== account.name) {
    conflict.push(
      `user_metadata.display_name je ${JSON.stringify(displayName)}, v lib/accounts.ts je ${JSON.stringify(account.name)}`,
    );
  }

  return { conflict, adoptable, unverifiable };
}

async function listUsers(apiBaseUrl, headers) {
  const response = await fetch(`${apiBaseUrl}/auth/v1/admin/users?per_page=1000&page=1`, { headers });
  if (!response.ok) fail(`nepodařilo se vypsat uživatele (HTTP ${response.status})`);
  const body = await response.json();
  return body.users ?? [];
}

async function createMissingAccount(apiBaseUrl, headers, account, password) {
  // Tělo obsahuje heslo — nikdy se nevypisuje, ani v chybě.
  // `email_confirm: true` ZDE je správně: to je vstupní pole pro
  // vytvoření. Asymetrie je záměrná — při čtení ho GoTrue nevrací
  // (vrací `email_confirmed_at`, viz `readEmailConfirmation`).
  const response = await fetch(`${apiBaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: account.email,
      password,
      email_confirm: true,
      user_metadata: { display_name: account.name, private_account: true },
    }),
  });
  if (!response.ok) fail(`nepodařilo se vytvořit ${account.email} (HTTP ${response.status})`);
  const created = await response.json();
  if (created?.id !== account.id) {
    return `vytvořen ${account.email} s id ${created?.id ?? '?'}, ale allowlist na serveru má ${account.id}`;
  }
  return `vytvořen ${account.email} (id ${created.id})`;
}

// ── Běh ─────────────────────────────────────────────────────────────────────

async function main() {
  parseArgs(process.argv);
  const accounts = readStudioAccounts();
  const projectRef = readProjectRef();
  const apiBaseUrl = `https://${projectRef}.supabase.co`;

  shout('');
  shout('════════════════════════════════════════════════════════════════════');
  shout(`  CÍL: Supabase projekt ${projectRef}`);
  shout('  ÚČTY, KTERÉ CHCI ZAJISTIT:');
  for (const account of accounts) shout(`    - ${account.name} <${account.email}> (${account.id})`);
  shout('  Existující účet se NEPŘEPÍŠE — jen se ověří a při nesouladu nahlásí.');
  shout('  Hesla, klíče ani tokeny se nevypisují.');
  shout('════════════════════════════════════════════════════════════════════');
  shout('');

  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) fail('chybí SUPABASE_SERVICE_ROLE_KEY');
  rememberSecret(serviceRoleKey);
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  const users = await listUsers(apiBaseUrl, headers);
  const knownEmails = new Set(accounts.map((account) => normalizeEmail(account.email)));
  const extraUsers = users.filter((user) => !knownEmails.has(normalizeEmail(user?.email))).length;

  let unchanged = 0;
  const created = [];
  const drifted = [];
  const adoptable = [];
  const unverifiable = [];

  for (const account of accounts) {
    const existing = findByEmail(users, account.email);
    if (!existing) {
      const { variable, password } = resolvePassword(account.name);
      rememberSecret(password);
      created.push(`${await createMissingAccount(apiBaseUrl, headers, account, password)} (heslo z ${variable})`);
      continue;
    }
    const verdict = describeDrift(existing, account);
    if (verdict.unverifiable.length > 0) unverifiable.push({ account, lines: verdict.unverifiable });
    if (verdict.conflict.length > 0) {
      drifted.push({ account, lines: verdict.conflict });
      continue;
    }
    if (verdict.adoptable.length > 0) {
      adoptable.push({ account, lines: verdict.adoptable });
      continue;
    }
    unchanged += 1;
    say(`  beze změny: ${account.name} <${account.email}> (e-mail potvrzený, id i display_name sedí)`);
  }

  for (const message of created) say(`  nový účet: ${message}`);
  say('');
  say(
    `  Projekt ${projectRef}: ${unchanged} účtů beze změny, ${created.length} nových, ` +
      `${adoptable.length} k doplnění metadat, ${drifted.length} k nahlášení.`,
  );
  say(`  V projektu je navíc ${extraUsers} účtů mimo seznam; tenhle skript je nemaže ani neupravuje.`);

  if (adoptable.length > 0) {
    say('');
    say('  METADATA DOPLNÍM (účet je zdravý, jen nemá jméno — tímto skriptem se NEdoplní):');
    for (const { account, lines } of adoptable) {
      say(`    - ${account.name} <${account.email}>`);
      for (const line of lines) say(`        · ${line}`);
    }
  }

  if (drifted.length === 0 && unverifiable.length === 0) return;

  if (unverifiable.length > 0) {
    shout('');
    shout('  NELZE OVĚŘIT (chyba skriptu proti API, ne rozpad účtu):');
    for (const { account, lines } of unverifiable) {
      shout(`    - ${account.name} <${account.email}>`);
      for (const line of lines) shout(`        · ${line}`);
    }
  }

  if (drifted.length > 0) {
    shout('');
    shout('  ROZDÍLY, KTERÉ SE NEPŘEPÍŠOU (řeš ručně v Supabase Dashboard):');
    for (const { account, lines } of drifted) {
      shout(`    - ${account.name} <${account.email}>`);
      for (const line of lines) shout(`        · ${line}`);
    }
  }
  process.exit(1);
}

// Běh jen jako skript. Import tohoto souboru (replay driftu, test) nesmí
// spustit `main` — jinak by „test" sahal na živé účty.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
