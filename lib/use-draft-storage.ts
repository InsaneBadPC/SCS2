import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef } from "react";

import {
  DRAFT_STORAGE_PREFIX,
  draftKey,
  isLegacyDraftKey,
  isUserDraftKey,
  type DraftKind,
} from "@/lib/draft-storage-key";

export { DRAFT_STORAGE_PREFIX, draftKey, isLegacyDraftKey, isUserDraftKey, userDraftPrefix, type DraftKind } from "@/lib/draft-storage-key";
export { shouldRestoreDraft } from "@/lib/draft-policy";

/**
 * Automaticky ukládá rozepsaný text editoru do AsyncStorage.
 * Chrání proti ztrátě dat při selhání uložení nebo obnovení stránky.
 */

export type DraftData = {
  title: string;
  albumId: string | null;
  stylePrompt: string;
  stylePrompts: string[];
  lyrics: string;
  notes: string;
  coverStorageKey: string | null;
  coverUrl: string | null;
  sourceVideoStorageKey?: string | null;
  savedAt: number;
};

const MAX_AGE_MS = 86_400_000;

const isString = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown): string | null => isString(value) ? value : null;

function normalizeDraft(value: unknown): DraftData | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<DraftData>;
  const savedAt = source.savedAt;
  if (!isString(source.title) || !isString(source.lyrics) || !isString(source.notes) || typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  return {
    title: source.title,
    albumId: nullableString(source.albumId),
    stylePrompt: isString(source.stylePrompt) ? source.stylePrompt : "",
    stylePrompts: Array.isArray(source.stylePrompts) ? source.stylePrompts.filter(isString) : [],
    lyrics: source.lyrics,
    notes: source.notes,
    coverStorageKey: nullableString(source.coverStorageKey),
    coverUrl: nullableString(source.coverUrl),
    sourceVideoStorageKey: nullableString(source.sourceVideoStorageKey),
    savedAt,
  };
}

/** Načte draft z úložiště. Vrátí null pokud neexistuje, není platný nebo je starší než 24h. */
export async function loadDraft(id: string | null, userId?: string | null, kind: DraftKind = "text"): Promise<DraftData | null> {
  if (!userId) return null;
  try {
    const raw = await AsyncStorage.getItem(draftKey(userId, id, kind));
    if (!raw) return null;
    const draft = normalizeDraft(JSON.parse(raw));
    if (!draft) return null;
    if (Date.now() - draft.savedAt > MAX_AGE_MS) {
      await clearDraft(id, userId, kind);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/** Uloží draft pouze do úložiště aktuálně přihlášeného uživatele. */
export async function saveDraft(id: string | null, data: Omit<DraftData, "savedAt">, userId?: string | null, kind: DraftKind = "text"): Promise<void> {
  if (!userId) return;
  try {
    const entry: DraftData = { ...data, savedAt: Date.now() };
    await AsyncStorage.setItem(draftKey(userId, id, kind), JSON.stringify(entry));
  } catch {
    // Tichá chyba - draft ochrana není kritická.
  }
}

/** Smaže konkrétní draft pouze v namespace aktuálního uživatele. */
export async function clearDraft(id: string | null, userId?: string | null, kind: DraftKind = "text"): Promise<void> {
  if (!userId) return;
  try {
    await AsyncStorage.removeItem(draftKey(userId, id, kind));
  } catch {
    // Tichá chyba.
  }
}

/** Smaže všechny drafty jednoho uživatele, ale ne drafty jiných účtů. */
export async function clearUserDrafts(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ownedKeys = keys.filter((key) => isUserDraftKey(key, userId));
    if (ownedKeys.length) await AsyncStorage.multiRemove(ownedKeys);
  } catch {
    // Tichá chyba.
  }
}

/** Odstraní staré globální drafty, které nelze bezpečně přiřadit k účtu. */
export async function clearLegacyDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const legacyKeys = keys.filter(isLegacyDraftKey);
    if (legacyKeys.length) await AsyncStorage.multiRemove(legacyKeys);
  } catch {
    // Tichá chyba.
  }
}

/** Explicitní úplné vymazání lokálních draftů (např. nové čištění zařízení). */
export async function clearAllDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const draftKeys = keys.filter((key) => key.startsWith(DRAFT_STORAGE_PREFIX));
    if (draftKeys.length) await AsyncStorage.multiRemove(draftKeys);
  } catch {
    // Tichá chyba.
  }
}

type DraftForm = {
  title: string;
  albumId: string | null;
  stylePrompt?: string;
  stylePrompts?: string[];
  lyrics: string;
  notes: string;
  coverStorageKey: string | null;
  coverUrl: string | null;
};

/**
 * Auto-ukládá rozepsaný formulář s debounce 1.5s. `enabled` zůstává false
 * dokud editor skutečně dokončí načtení serverového dokumentu a draftu.
 */
export function useDraftStorage(form: DraftForm, id: string | null, userId?: string | null, enabled = true, kind: DraftKind = "text") {
  const formRef = useRef(form);
  formRef.current = form;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeRef = useRef<string | null>(null);
  const scope = userId && enabled ? draftKey(userId, id, kind) : null;
  scopeRef.current = scope;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!scope || !userId || !enabled) return;

    timerRef.current = setTimeout(() => {
      // Po změně účtu nebo entity nesmí starý timer zapsat nový scope.
      if (scopeRef.current !== scope) return;
      const current = formRef.current;
      void saveDraft(id, {
        title: current.title,
        albumId: current.albumId,
        stylePrompt: current.stylePrompt ?? "",
        stylePrompts: current.stylePrompts ?? [],
        lyrics: current.lyrics,
        notes: current.notes,
        coverStorageKey: current.coverStorageKey,
        coverUrl: current.coverUrl,
      }, userId, kind);
    }, 1500);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, form.title, form.albumId, form.stylePrompt, form.stylePrompts, form.lyrics, form.notes, form.coverStorageKey, form.coverUrl, id, kind, scope, userId]);

  return null;
}
