import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

import { supabaseSessionStorage } from "@/lib/supabase-storage";

/**
 * Veřejný klíč je určený pro klientské aplikace. Soukromí dat prosazují RLS
 * pravidla v externím Supabase projektu, nikoliv utajení tohoto klíče.
 */
export const SUPABASE_URL = "https://gpgbgjxeybfncrexrpbr.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";

const canPersistSession = Platform.OS !== "web" || typeof window !== "undefined";

/**
 * `detectSessionInUrl: false` je pro React Native spravne a nesmi se to menit:
 * auth-js ho vyhodnocuje jen podminkou `isBrowser()`, takze na RN je to
 * nepoužitelné a prohlížečové okno jen chybně otevřít session.
 *
 * `flowType` tu zamerne neni. V @supabase/supabase-js v2 je default
 * `flowType: 'implicit'` (DEFAULT_OPTIONS v auth-js/GoTrueClient) a to plati
 * i pro React Native - zadny runtime detektor, ktery by na RN prepnul na PKCE.
 * Resetovací e-mail proto chodi v podobe
 * `songcraftstudio://reset-password#access_token=..&refresh_token=..&type=recovery`
 * a tu ji parsuje `lib/reset-password.ts`. Prepnuti na PKCE by zmenilo tvar
 * e-mailu na `?code=..` a prinelo by s sebou spravu code verifieru v ulozisti;
 * to je zmenova vyzadujici vlastni test, ne oprava tohoto bugu. Oba tvary
 * modul zvlada, takze se to da udelat pozdeji.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    ...(canPersistSession ? { storage: supabaseSessionStorage } : {}),
    autoRefreshToken: canPersistSession,
    persistSession: canPersistSession,
    detectSessionInUrl: false,
  },
});
