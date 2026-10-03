import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Text s historií kroků zpět/vpřed pro editory písní.
 * Rychlé psaní se ukládá jako jeden krok (okno 700 ms),
 * takže Zpět vrátí smysluplné celé úseky, ne jednotlivá písmena.
 */
export function useUndoableText(initial: string = "") {
  const [value, setValue] = useState(initial);
  const history = useRef<{ v: string; t: number }[]>([{ v: initial, t: Date.now() }]);
  const index = useRef(0);
  const [, bump] = useState(0);
  const valueRef = useRef(initial);
  valueRef.current = value;

  /** Nahradí obsah zvenčí (načtení skladby) bez zápisu do historie. */
  const reset = useCallback((next: string) => {
    history.current = [{ v: next, t: Date.now() }];
    index.current = 0;
    valueRef.current = next;
    setValue(next);
    bump((n) => n + 1);
  }, []);

  const change = useCallback((next: string, coalesce = true) => {
    const now = Date.now();
    const entries = history.current;
    // Psaní po Zpět zahodí nepoužitou budoucnost.
    if (index.current < entries.length - 1) entries.splice(index.current + 1);
    const last = entries[entries.length - 1];
    if (coalesce && last && now - last.t < 700 && Math.abs(next.length - last.v.length) < 40) {
      last.v = next;
      last.t = now;
    } else {
      entries.push({ v: next, t: now });
      if (entries.length > 500) entries.shift();
    }
    index.current = entries.length - 1;
    setValue(next);
    bump((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    if (index.current <= 0) return undefined;
    index.current -= 1;
    const entry = history.current[index.current];
    setValue(entry.v);
    bump((n) => n + 1);
    return entry.v;
  }, []);

  const redo = useCallback(() => {
    if (index.current >= history.current.length - 1) return undefined;
    index.current += 1;
    const entry = history.current[index.current];
    setValue(entry.v);
    bump((n) => n + 1);
    return entry.v;
  }, []);

  useEffect(() => { reset(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [initial]);

  return { value, change, reset, undo, redo, canUndo: index.current > 0, canRedo: index.current < history.current.length - 1 };
}
