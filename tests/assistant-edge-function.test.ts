import { describe, expect, it } from "vitest";

const SUPABASE_URL = "https://hfykngbhcxmnpxvjagoj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";
const functionUrl = `${SUPABASE_URL}/functions/v1/songcraft-studio-assistant`;

async function signInTemney() {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "temney@songcraft.test", password: process.env.SONGCRAFT_TEMNEY_PASSWORD }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string };
}

describe("experimentální Studio asistent", () => {
  it("odmítne požadavek bez JWT", async () => {
    const response = await fetch(functionUrl, { method: "POST", headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ message: "Ahoj" }) });
    expect(response.status).toBe(401);
  });

  it("odpoví přihlášenému účtu přes bezplatný Gemini model", async () => {
    const session = await signInTemney();
    const response = await fetch(functionUrl, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "V jedné větě popiš, s čím mi můžeš pomoci.", history: [] }),
    });
    const rawBody = await response.text();
    expect(response.status, rawBody).toBe(200);
    const body = JSON.parse(rawBody);
    expect(body.answer).toEqual(expect.any(String));
    expect(body.answer.length).toBeGreaterThan(10);
  }, 30_000);
});
