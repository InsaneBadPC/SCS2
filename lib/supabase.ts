import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

import { supabaseSessionStorage } from "@/lib/supabase-storage";

/**
 * Veřejný klíč je určený pro klientské aplikace. Soukromí dat prosazují RLS
 * pravidla v externím Supabase projektu, nikoliv utajení tohoto klíče.
 */
export const SUPABASE_URL = "https://hfykngbhcxmnpxvjagoj.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5mOBkLJhXzLb6U6_stJLQQ_j89L0lEH";

const canPersistSession = Platform.OS !== "web" || typeof window !== "undefined";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    ...(canPersistSession ? { storage: supabaseSessionStorage } : {}),
    autoRefreshToken: canPersistSession,
    persistSession: canPersistSession,
    detectSessionInUrl: false,
  },
});
