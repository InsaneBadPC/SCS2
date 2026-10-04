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
//     se přidat, protože přepsal by heslo i cizí `user_metadata`,
//   * heslo, service_role klíč ani PAT se nikdy nevypisují (viz `redact`).
//
//   node scripts/provision-private-accounts.mjs --i-know-this-touches-live-accounts
//
// Exit code: 0 = vše v pořádku, 1 = odmítnuto / nesoulad, 2 = chybné použití.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function findByEmail(users, email) {
  const wanted = normalizeEmail(email);
  return users.find((user) => normalizeEmail(user?.email) === wanted);
}

function describeDrift(existing, account) {
  const drift = [];
  if (existing.id !== account.id) {
    drift.push(`id v Supabase (${existing.id}) nesouhlasí s lib/accounts.ts (${account.id})`);
  }
  if (existing.email_confirm !== true) {
    drift.push('e-mail není potvrzený (email_confirm !== true)');
  }
  const displayName = existing.user_metadata?.display_name;
  if (displayName !== account.name) {
    drift.push(`user_metadata.display_name je ${JSON.stringify(displayName ?? null)}, v lib/accounts.ts je ${JSON.stringify(account.name)}`);
  }
  return drift;
}

async function listUsers(apiBaseUrl, headers) {
  const response = await fetch(`${apiBaseUrl}/auth/v1/admin/users?per_page=1000&page=1`, { headers });
  if (!response.ok) fail(`nepodařilo se vypsat uživatele (HTTP ${response.status})`);
  const body = await response.json();
  return body.users ?? [];
}

async function createMissingAccount(apiBaseUrl, headers, account, password) {
  // Tělo obsahuje heslo — nikdy se nevypisuje, ani v chybě.
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

  for (const account of accounts) {
    const existing = findByEmail(users, account.email);
    if (!existing) {
      const { variable, password } = resolvePassword(account.name);
      rememberSecret(password);
      created.push(`${await createMissingAccount(apiBaseUrl, headers, account, password)} (heslo z ${variable})`);
      continue;
    }
    const drift = describeDrift(existing, account);
    if (drift.length > 0) {
      drifted.push({ account, drift });
      continue;
    }
    unchanged += 1;
    say(`  beze změny: ${account.name} <${account.email}> (e-mail, id i display_name sedí)`);
  }

  for (const message of created) say(`  nový účet: ${message}`);
  say('');
  say(`  Projekt ${projectRef}: ${unchanged} účtů beze změny, ${created.length} nových, ${drifted.length} k nahlášení.`);
  say(`  V projektu je navíc ${extraUsers} účtů mimo seznam; tenhle skript je nemaže ani neupravuje.`);
  say('');

  if (drifted.length === 0) return;

  shout('  ROZDÍLY, KTERÉ SE NEPŘEPÍŠOU (řeš ručně v Supabase Dashboard):');
  for (const { account, drift } of drifted) {
    shout(`    - ${account.name} <${account.email}>`);
    for (const line of drift) shout(`        · ${line}`);
  }
  process.exit(1);
}

await main();