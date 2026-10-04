import { describe, expect, it } from "vitest";

import { STUDIO_ACCOUNTS } from "../lib/accounts";

const SUPABASE_URL = "https://gpgbgjxeybfncrexrpbr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";
const functionUrl = `${SUPABASE_URL}/functions/v1/songcraft-studio-assistant`;

/**
 * Účet se hledá v `lib/accounts.ts` podle jména — e-mail ani UUID se tady
 * neopakují a neodradnou od aplikace. Heslo se čte jen z prostředí; bez něj se
 * test přeskočí, nikdy nepadne.
 */
function requireAccount(name: string) {
  const account = STUDIO_ACCOUNTS.find((candidate) => candidate.name === name);
  if (!account) {
    throw new Error(
      `lib/accounts.ts neobsahuje účet „${name}“. Seznam uživatelů se změnil — oprav tenhle test.`,
    );
  }
  const envVar = `SONGCRAFT_${name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}_PASSWORD`;
  const password = process.env[envVar];
  if (!password) {
    console.warn(
      `[přeskočeno] ${name} <${account.email}>: není nastavena proměnná ${envVar}. ` +
        "Heslo patří do prostředí, ne do repa — bez ní se test jen přeskočí.",
    );
  }
  return { ...account, envVar, password };
}

const account = requireAccount("Temney");

/** Chybová hláška do výstupu testu, ale nikdy JWT ani heslo. */
function safeBody(raw: string): string {
  return redactTokens(raw).slice(0, 500);
}

function redactTokens(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[JWT REDIGOVÁN]")
    .replace(/("(?:access_token|refresh_token|token|password)"\s*:\s*)"[^"]*"/g, '$1"[REDIGOVÁNO]"');
}

async function signIn() {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  expect(response.status, `${account.name} se musí umět přihlásit (heslo v ${account.envVar})`).toBe(200);
  return (await response.json()) as { access_token: string };
}

describe("experimentální Studio asistent", () => {
  it("odmítne požadavek bez JWT", async () => {
    const response = await fetch(functionUrl, { method: "POST", headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ message: "Ahoj" }) });
    expect(response.status).toBe(401);
  });

  it.skipIf(!account.password)("odpoví přihlášenému účtu přes bezplatný Gemini model", async () => {
    const session = await signIn();
    const response = await fetch(functionUrl, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "V jedné větě popiš, s čím mi můžeš pomoci.", history: [] }),
    });
    const rawBody = await response.text();
    expect(response.status, safeBody(rawBody)).toBe(200);
    const body = JSON.parse(rawBody);
    expect(body.answer).toEqual(expect.any(String));
    expect(body.answer.length).toBeGreaterThan(10);
  }, 30_000);
});