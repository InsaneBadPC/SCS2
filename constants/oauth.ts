import { router } from "expo-router";

/** Opens the private SongCraft sign-in screen. Kept in this file for existing imports. */
export async function startPrivateLogin(): Promise<void> {
  router.push("/auth" as never);
}

/** Retained only for legacy internal helpers that do not call a remote OAuth flow. */
export const getApiBaseUrl = () => "";

/** Legacy storage keys retained for unused internal compatibility helpers. */
export const SESSION_TOKEN_KEY = "songcraft-supabase-session";
export const USER_INFO_KEY = "songcraft-supabase-user";
