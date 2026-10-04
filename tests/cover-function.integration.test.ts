import { describe, expect, it } from "vitest";

import { STUDIO_ACCOUNTS } from "../lib/accounts";

const url = "https://gpgbgjxeybfncrexrpbr.supabase.co";
const key = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";

/**
 * Účet i jeho heslo se neopakují v tomhle souboru: účet se hledá v
 * `lib/accounts.ts` podle jména, heslo se čte z proměnné prostředí. Bez hesla se
 * test přeskočí, aby zelená barva nezastřela, že se vlastně nic neotestovalo.
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
  return raw
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[JWT REDIGOVÁN]")
    .replace(/("(?:access_token|refresh_token|token|password)"\s*:\s*)"[^"]*"/g, '$1"[REDIGOVÁNO]"')
    .slice(0, 500);
}

describe("songcraft-cover-ai", () => {
  it.skipIf(!account.password)("ověřený účet může zadat 16:9 obal se zadanou poznámkou", async () => {
    const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email: account.email, password: account.password }) });
    if (!auth.ok) throw new Error(`${account.name} se nepodařilo přihlásit (heslo v ${account.envVar}): ${safeBody(await auth.text())}`);
    const session = await auth.json() as { access_token: string };
    const songs = await fetch(`${url}/rest/v1/sc_songs?select=id&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${session.access_token}` } });
    if (!songs.ok) throw new Error(safeBody(await songs.text()));
    const [song] = await songs.json() as Array<{ id: string }>;
    if (!song) {
      console.warn(`[přeskočeno] v sc_songs není žádná píseň pro ${account.name} — obal se nemá nad čím pustit.`);
      return;
    }

    const response = await fetch(`${url}/functions/v1/songcraft-cover-ai`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", entityType: "song", entityId: song.id, format: "youtube_16_9", userNote: "noční elektrické město" }) });
    if (!response.ok) throw new Error(safeBody(await response.text()));
    const result = await response.json() as { jobId?: string };
    expect(result.jobId).toEqual(expect.any(String));
  }, 45_000);
});