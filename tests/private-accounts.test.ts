import { describe, expect, it } from "vitest";

const SUPABASE_URL = "https://hfykngbhcxmnpxvjagoj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";

const accounts = [
  { name: "Temney", email: "temney@songcraft.test", password: process.env.SONGCRAFT_TEMNEY_PASSWORD },
  { name: "DJ Palačinka", email: "dj.palacinka@songcraft.test", password: process.env.SONGCRAFT_DJ_PALACINKA_PASSWORD },
  { name: "Verča", email: "verca@songcraft.test", password: process.env.SONGCRAFT_VERCA_PASSWORD },
];

const privateTables = ["sc_albums", "sc_lyrics", "sc_songs", "sc_audio_versions", "sc_rhyme_words"];

describe("private SongCraft accounts", () => {
  it.each(accounts)("authenticates $name and returns only its profile", async ({ name, email, password }) => {
    expect(password, `A password must be configured for ${name}`).toBeTruthy();

    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    expect(response.status, `${name} must be able to sign in`).toBe(200);
    const body = await response.json();
    expect(body.user?.email).toBe(email);
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

      expect(otherUsersResponse.status, `${name} must be allowed to query ${table}`).toBe(200);
      expect(otherUsersResponse.headers.get("content-range"), `${name} must not see another user's ${table}`).toMatch(/\/0$/);
    }
  });
});
