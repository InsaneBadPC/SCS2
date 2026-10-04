import * as Linking from "expo-linking";
import { useCallback, useEffect, useState } from "react";

import { STUDIO_ACCOUNTS, type StudioAccount } from "@/lib/accounts";
import { supabase } from "@/lib/supabase";

/**
 * Zapomenute heslo - spojka mezi resetovacim e-mailem a obrazovkou.
 *
 * Supabase posle na `redirectTo` tokeny DVEMA zpuisoby:
 *   - implicit (vychozi `flowType` v @supabase/supabase-js v2):
 *     `songcraftstudio://reset-password#access_token=..&refresh_token=..&type=recovery`
 *   - PKCE (kdyby se klient nastavil na `flowType: 'pkce'` nebo po behu ve webu):
 *     `songcraftstudio://reset-password?code=..`
 *
 * Oboji parsuje tento modul primo z `expo-linking`, protoze expo-router bere
 * z deep linku JENOM cestu a fragment s tokeny zahazuje.
 *
 * Zadna hlaska z Supabase ani z URL se nikdy neloguje - token by v logu byl
 * stejne tak citlivy jako heslo. Uzivatel vidi jen fixni ceske vety.
 */

/** Cesta, kterou musi deep link resolver v `app/_layout.tsx` najit. */
export const RESET_LINK_ROUTE = "reset-password";

/** Schema z `app.config.ts` (`env.scheme`), stejne jako `app/auth.tsx`. */
export const RESET_LINK_URI = `songcraftstudio://${RESET_LINK_ROUTE}`;

/**
 * Dolni mez delky hesla. Supabase sam minimum 6 odmita, tady je vetsi, aby
 * `updateUser` nemohl spadnout na serverovem pravidlu a nechalo uzivatele
 * na upravenem formulari.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Uzivatelske hlasky - jediny text, ktery jde ven. Chyby Supabase se neprekladaji. */
const LINK_EXPIRED =
  "Odkaz už neplatí nebo byl jednou použitý. vrať se na přihlášení a nech si poslat nový.";
const LINK_NOT_ALLOWED = "Tento účet není v seznamu tří SCS2 účtů.";
const LINK_FAILED = "Odkaz se nepodařilo zpracovat. Zkus to prosím znovu.";
const PASSWORD_FAILED = "Nové heslo se nepodařilo uložit. Zkus to prosím znovu.";
const PASSWORD_SHORT = `Heslo musí mít aspoň ${MIN_PASSWORD_LENGTH} znaků.`;
const PASSWORD_MISMATCH = "Obě hesla se neshodují.";

export type RecoveryPhase =
  | "idle"
  | "awaiting_link"
  | "ready"
  | "submitting"
  | "done"
  | "error";

export interface RecoveryState {
  phase: RecoveryPhase;
  /**
   * Ucet, kteremu recovery session patri, a je proto v `lib/accounts.ts`.
   * `null` dokud se link nezpracuje - bez nej se formular nikdy neukaze.
   * V fazi `error` zustava nenulovy, pokud selhalo az samotne ulozeni hesla
   * (uzivatel ma zustat na formulari).
   */
  account: StudioAccount | null;
  /** Ceska hlaska pro uzivatele. Plna jen pro neuspesne overeni. */
  message: string | null;
}

export type RecoveryPayload =
  | { kind: "pkce"; code: string }
  | { kind: "implicit"; accessToken: string; refreshToken: string };

const IDLE_STATE: RecoveryState = { phase: "idle", account: null, message: null };

/* --- stav ---------------------------------------------------------------- */

/**
 * Stav je jeden pro celou aplikaci, ne na obrazovku: resetovaci link je
 * jedina udalost v procesu a obrazovka mu musi umet odpovidat i kdyz je
 * otevrena az PO tom, co link dorazil. Proto se to drzi tady a ne ve stavu
 * komponenty - obrazovka se jen prihlasi.
 */
let recoveryState: RecoveryState = IDLE_STATE;
const subscribers = new Set<(snapshot: RecoveryState) => void>();

/** Dedupe: pri studenem startu dorazi stejny URL z `getInitialURL` i z udalosti. */
let lastHandledLink: string | null = null;
/** Zamek proti soubecnemu zpracovani dvou ruznych linku. */
let handlingLink = false;
let watcherStarted = false;

function setRecoveryState(next: RecoveryState): void {
  recoveryState = next;
  for (const notify of subscribers) notify(next);
}

/** Prihlaseni na stav; vraceje odhlaseni. */
export function subscribeToRecovery(notify: (snapshot: RecoveryState) => void): () => void {
  subscribers.add(notify);
  notify(recoveryState);
  return () => {
    subscribers.delete(notify);
  };
}

/* --- parsovani URL ------------------------------------------------------- */

/**
 * Rozlozi `a=1&b=2` na zaznam. Rucne, ne presem `URL`/`URLSearchParams` -
 * ty nejsou v React Native spolehlive a resetovaci URL parsuje jednou.
 */
function parseParams(input: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = input.startsWith("?") || input.startsWith("#") ? input.slice(1) : input;
  if (!body) return params;

  for (const pair of body.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const key = decodeParam(separator === -1 ? pair : pair.slice(0, separator));
    if (!key) continue;
    params[key] = decodeParam(separator === -1 ? "" : pair.slice(separator + 1));
  }
  return params;
}

function decodeParam(value: string): string {
  try {
    // `+` znamena mezeru v application/x-www-form-urlencoded, ne znamenko.
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    // Rozbite percent-encoding nechame byt, nezadame o nic vetsi nez puvodni retezec.
    return value;
  }
}

/** Vytazne z deep linku resetovaci payload, jinak `null`. */
export function parseRecoveryUrl(url: string): RecoveryPayload | null {
  const hash = url.indexOf("#");
  const beforeFragment = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash + 1);

  const queryAt = beforeFragment.indexOf("?");
  const code = queryAt === -1 ? undefined : parseParams(beforeFragment.slice(queryAt + 1)).code;
  if (code) return { kind: "pkce", code };

  // `type=recovery` se nerozparuje zamerne - magic link ma stejnou relaci
  // jako recovery a oba tokeny patri uzivateli. Rozhoduje allowlist, ne typ.
  const hashParams = parseParams(fragment);
  const accessToken = hashParams.access_token;
  const refreshToken = hashParams.refresh_token;
  if (accessToken && refreshToken) return { kind: "implicit", accessToken, refreshToken };

  return null;
}

/**
 * Otisk URL pro dedupe. Neni to token - je to hruby hash, takze URL s tokenem
 * v pameti niz zustava a v logu se nikdy neobjevi.
 */
function linkFingerprint(url: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${url.length}:${hash.toString(16)}`;
}

/* --- overeni ucetu ------------------------------------------------------- */

/**
 * Fail-closed shoda s `isAllowedPrivateUser` ze
 * `supabase/functions/_shared/access.ts`: bez `id` neni povoleny zadny ucet a
 * shoda se hleda podle UUID i podle e-mailu.
 *
 * Allowlist se tu vezme z `lib/accounts.ts` misto z toho helperu zamerne:
 * `supabase/functions/**` je v tsconfig.json vylouceno z aplikace (viz
 * `"exclude"`), jde o Deno Edge Function kod a jeho vetaeni do RN bundlu by
 * zrusilo tu hranici. `lib/accounts.ts` obsahuje presne ty same tri ucty.
 */
function findAllowedAccount(
  user: { id?: string; email?: string | null } | null | undefined,
): StudioAccount | undefined {
  if (!user?.id) return undefined;

  const id = user.id.toLowerCase();
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
  return STUDIO_ACCOUNTS.find(
    (account) =>
      account.id.toLowerCase() === id || (email.length > 0 && account.email.toLowerCase() === email),
  );
}

/**
 * `true`, kdyz auth krok prosel. auth-js v2 vraci `{ error }`, ale nektere
 * sestaveni (napr. s `throwOnError`) hod AuthError - resi se obe cesty.
 * Chyba se nikdy nepreklada ani neloguje, takze zpet kousek chyby neni.
 */
async function authSucceeded(
  run: () => Promise<{ error?: unknown } | null | undefined>,
): Promise<boolean> {
  try {
    return !(await run())?.error;
  } catch {
    return false;
  }
}

/* --- zpracovani linku ---------------------------------------------------- */

async function openRecoveryLink(url: string): Promise<void> {
  const payload = parseRecoveryUrl(url);
  if (!payload) return;

  const print = linkFingerprint(url);
  if (handlingLink || print === lastHandledLink) return;
  lastHandledLink = print;
  handlingLink = true;
  setRecoveryState({ phase: "awaiting_link", account: null, message: null });

  try {
    const exchanged = await authSucceeded(() =>
      payload.kind === "pkce"
        ? supabase.auth.exchangeCodeForSession(payload.code)
        : supabase.auth.setSession({
            access_token: payload.accessToken,
            refresh_token: payload.refreshToken,
          }),
    );
    if (!exchanged) {
      setRecoveryState({ phase: "error", account: null, message: LINK_EXPIRED });
      return;
    }

    // getUser jde na server, takze overena relace neni jen to, co se podarilo
    // dekodovat z odkazu.
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      setRecoveryState({ phase: "error", account: null, message: LINK_EXPIRED });
      return;
    }

    const account = findAllowedAccount(data?.user);
    if (!account) {
      // Cizi ucet nesmi v relaci zustat - odhlas ho jeste pred ukazanim formulare.
      await supabase.auth.signOut().catch(() => undefined);
      setRecoveryState({ phase: "error", account: null, message: LINK_NOT_ALLOWED });
      return;
    }

    setRecoveryState({ phase: "ready", account, message: null });
  } finally {
    handlingLink = false;
  }
}

function handleIncomingUrl(url: string | null): void {
  if (!url) return;
  void openRecoveryLink(url).catch(() => {
    setRecoveryState({ phase: "error", account: null, message: LINK_FAILED });
  });
}

/**
 * Poslouchej resetovací odkazy - JEDNOU za zivot aplikace. Volaji
 * `app/_layout.tsx` pri startu, aby link nestihl prijit drivek, nez se
 * obrazovka vykresli, a `usePasswordRecovery` jako zalohu. Opakovane volani
 * nic nemeni.
 */
export function startRecoveryLinkWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  Linking.addEventListener("url", ({ url }) => handleIncomingUrl(url));
  Linking.getInitialURL()
    .then(handleIncomingUrl)
    .catch(() => undefined);
}

/** Znovu se podiv na startovni URL - pro tlacitko, kdyz uzivatel nevi, kam klikl. */
export function retryRecoveryLink(): void {
  lastHandledLink = null;
  setRecoveryState({ phase: "awaiting_link", account: null, message: null });
  Linking.getInitialURL()
    .then(handleIncomingUrl)
    .catch(() => undefined);
}

/* --- ulozeni hesla ------------------------------------------------------- */

/**
 * Doporuceni pod formular - stejne vety, jaky vraci `submitNewPassword`, jen
 * drivek, aby uzivatel videl pricinu jeste pred odeslanim.
 */
export function passwordHint(password: string, confirmPassword: string): string | null {
  if (password.length > 0 && password.length < MIN_PASSWORD_LENGTH) return PASSWORD_SHORT;
  if (confirmPassword.length > 0 && confirmPassword !== password) return PASSWORD_MISMATCH;
  return null;
}

/**
 * Ulozi nove heslo pres `supabase.auth.updateUser`. Vrati `true`, kdyz se
 * podarilo (faze `done`), jinak `false` a ve stavu je ceska hlaska.
 * Delku a shodu obou hesel taky overi tady, aby neslo obejit formular.
 */
export async function submitNewPassword(password: string, confirmPassword: string): Promise<boolean> {
  const account = recoveryState.account;
  if (!account || recoveryState.phase === "submitting" || recoveryState.phase === "done") {
    return false;
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    setRecoveryState({ ...recoveryState, phase: "error", message: PASSWORD_SHORT });
    return false;
  }
  if (password !== confirmPassword) {
    setRecoveryState({ ...recoveryState, phase: "error", message: PASSWORD_MISMATCH });
    return false;
  }

  setRecoveryState({ phase: "submitting", account, message: null });
  const saved = await authSucceeded(() => supabase.auth.updateUser({ password }));
  if (!saved) {
    setRecoveryState({ phase: "error", account, message: PASSWORD_FAILED });
    return false;
  }

  // Relace po predchozím setSession je plnohodnotna, takze po zmeně hesla
  // uzivatel zustava prihlaseny a obrazovka ho pusti do studia.
  setRecoveryState({ phase: "done", account, message: null });
  return true;
}

export interface PasswordRecovery {
  state: RecoveryState;
  submitPassword: (password: string, confirmPassword: string) => Promise<boolean>;
  retryLink: () => void;
}

/** Obrazovka: stav + akce. Nic si nedrzi sama, jen se prihlasi ke stavu. */
export function usePasswordRecovery(): PasswordRecovery {
  const [state, setState] = useState<RecoveryState>(recoveryState);

  useEffect(() => subscribeToRecovery(setState), []);
  useEffect(() => {
    startRecoveryLinkWatcher();
  }, []);

  const submitPassword = useCallback(
    (password: string, confirmPassword: string) => submitNewPassword(password, confirmPassword),
    [],
  );
  const retryLink = useCallback(() => retryRecoveryLink(), []);

  return { state, submitPassword, retryLink };
}