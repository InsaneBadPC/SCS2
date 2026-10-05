import { describe, expect, it } from "vitest";

const SUPABASE_URL = "https://gpgbgjxeybfncrexrpbr.supabase.co";

/**
 * Klíč se čte z proměnné prostředí, nikdy z repa. Bez něj se test přeskočí,
 * aby zelená barva nezastřela, že se vlastně nic neotestovalo — stejně jako
 * u `cover-function.integration.test.ts`. Bez této větve `expect(...).toBeTruthy()`
 * selhal a `pnpm test:live` končil chybou místo přeskočení.
 */
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceRoleKey) {
  console.warn(
    "[přeskočeno] není nastavena proměnná SUPABASE_SERVICE_ROLE_KEY. " +
      "Klíč patří do prostředí, ne do repa — bez ní se test jen přeskočí.",
  );
}

describe("Supabase service role configuration", () => {
  it.skipIf(!serviceRoleKey)("accepts the configured server key for a read-only administrative request", async () => {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=1&page=1`, {
      headers: {
        apikey: serviceRoleKey!,
        Authorization: `Bearer ${serviceRoleKey!}`,
      },
    });

    expect(response.status, "Supabase service role key must authorize administrative reads").toBe(200);
  });
});
