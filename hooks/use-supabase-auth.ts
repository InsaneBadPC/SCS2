import { useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";

import { clearUserClientData } from "@/lib/client-session-cleanup";
import { supabase } from "@/lib/supabase";

/** Připravené externí přihlášení pro Android i web. */
export function useSupabaseAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const queryClient = useQueryClient();

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: authError } = await supabase.auth.getUser();
    setUser(data.user ?? null);
    setError(authError ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  const logout = useCallback(async () => {
    const userId = user?.id ?? null;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw signOutError;
    setUser(null);
    await clearUserClientData(queryClient, userId);
  }, [queryClient, user?.id]);

  return { user, loading, error, isAuthenticated: useMemo(() => Boolean(user), [user]), refresh, logout };
}
