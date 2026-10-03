import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clearUserClientData } from "@/lib/client-session-cleanup";
import { supabase } from "@/lib/supabase";

export type SongCraftUser = {
  id: string;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: "supabase";
  lastSignedIn: Date;
};

export function useAuth() {
  const [user, setUser] = useState<SongCraftUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const queryClient = useQueryClient();
  const previousUserIdRef = useRef<string | null>(null);

  const mapUser = useCallback((source: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null): SongCraftUser | null => source ? {
    id: source.id,
    openId: source.id,
    name: typeof source.user_metadata?.display_name === "string" ? source.user_metadata.display_name : "Temney",
    email: source.email ?? null,
    loginMethod: "supabase",
    lastSignedIn: new Date(),
  } : null, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: authError } = await supabase.auth.getUser();
    setUser(mapUser(data.user));
    setError(authError ?? null);
    setLoading(false);
  }, [mapUser]);

  useEffect(() => {
    void refresh();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(mapUser(session?.user ?? null));
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, [mapUser, refresh]);

  // Auth state changes also cover token expiry and account switching, not only
  // the explicit logout button.
  useEffect(() => {
    const currentUserId = user?.id ?? null;
    const previousUserId = previousUserIdRef.current;
    if (previousUserId && previousUserId !== currentUserId) {
      void clearUserClientData(queryClient, previousUserId);
    }
    previousUserIdRef.current = currentUserId;
  }, [queryClient, user?.id]);

  const logout = useCallback(async () => {
    const userId = user?.id ?? null;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw signOutError;
    setUser(null);
    setError(null);
    await clearUserClientData(queryClient, userId);
  }, [queryClient, user?.id]);

  return { user, loading, error, isAuthenticated: useMemo(() => Boolean(user), [user]), refresh, logout };
}

