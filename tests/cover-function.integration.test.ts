import { describe, expect, it } from "vitest";

const url = "https://hfykngbhcxmnpxvjagoj.supabase.co";
const key = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";

describe("songcraft-cover-ai", () => {
  it("ověřený účet Temney může zadat 16:9 obal se zadanou poznámkou", async () => {
    const password = process.env.SONGCRAFT_TEMNEY_PASSWORD;
    expect(password, "Chybí bezpečně uložené heslo Temney.").toBeTruthy();
    const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "temney@songcraft.test", password }) });
    if (!auth.ok) throw new Error(await auth.text());
    const session = await auth.json() as { access_token: string };
    const songs = await fetch(`${url}/rest/v1/sc_songs?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${session.access_token}` } });
    if (!songs.ok) throw new Error(await songs.text());
    const [song] = await songs.json() as Array<{ id: string }>;
    if (!song) return;

    const response = await fetch(`${url}/functions/v1/songcraft-cover-ai`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", entityType: "song", entityId: song.id, format: "youtube_16_9", userNote: "noční elektrické město" }) });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json() as { jobId?: string };
    expect(result.jobId).toEqual(expect.any(String));
  }, 45_000);
});
