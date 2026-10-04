import { describe, expect, it } from "vitest";

import { STUDIO_ACCOUNTS } from "../lib/accounts";

const SUPABASE_URL = "https://gpgbgjxeybfncrexrpbr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";

const privateTables = ["sc_albums", "sc_lyrics", "sc_songs", "sc_audio_versions", "sc_rhyme_words"];

/**
 * Účty, e-maily i UUID se tu neopakují — berou se z `lib/accounts.ts`, což je
 * jediný zdroj pravdy. Heslo se nikdy neukládá do repa: jen se přečte z
 * proměnné prostředí, jejíž název se odvodí ze jména účtu
 * (`Verča` → SONGCRAFT_VERCA_PASSWORD).
 */
function passwordEnvVar(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `SONGCRAFT_${slug}_PASSWORD`;
}

const accounts = STUDIO_ACCOUNTS.map((account) => {
  const envVar = passwordEnvVar(account.name);
  const password = process.env[envVar];
  if (!password) {
    console.warn(
      `[přeskočeno] ${account.name} <${account.email}>: není nastavena proměnná ${envVar}. ` +
        "Heslo patří do prostředí, ne do repa — bez ní se test jen přeskočí.",
    );
  }
  return { ...account, envVar, password };
});

describe("private SongCraft accounts", () => {
  it("zná přesně tři reálné účty a žádný testovací e-mail", () => {
    expect(STUDIO_ACCOUNTS).toHaveLength(3);
    for (const account of STUDIO_ACCOUNTS) {
      expect(account.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      expect(account.email).not.toMatch(/\.test$/);
      expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(STUDIO_ACCOUNTS.map((account) => account.email)).size).toBe(3);
  });

  for (const { name, email, id, envVar, password } of accounts) {
    it.skipIf(!password)(`${name} se přihlásí a uvidí jen vlastní data`, async () => {
      expect(password, `Chybí heslo v ${envVar}.`).toBeTruthy();

      const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      expect(response.status, `${name} se musí umět přihlásit`).toBe(200);
      const body = await response.json();
      expect(body.user?.email).toBe(email);
      expect(body.user?.id).toBe(id);
      expect(body.user?.user_metadata?.display_name).toBe(name);
      expect(body.access_token).toEqual(expect.any(String));

      for (const table of privateTables) {
        const otherUsersResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/${table}?select=id&user_id=neq.${body.user.id}`,
          {
            method: "HEAD",
            headers: {
              apikey: SUPABASE_PUBLISHABLE_KEY,
              Authorization: `Bearer ${body.access_token}`,
              Prefer: "count=exact",
            },
          },
        );

        expect(otherUsersResponse.status, `${name} smí dotazovat na ${table}`).toBe(200);
        expect(otherUsersResponse.headers.get("content-range"), `${name} nesmí vidět data jiného uživatele v ${table}`).toMatch(/\/0$/);
      }
    });
  }
});