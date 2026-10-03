import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { ComponentProps } from "react";

/**
 * SCS2 ma tri ucety a prihlaseni je fail-closed: vyber ze seznamu, zadna
 * registrace, zadny vlastni e-mail. E-mail ani UUID nesmi lezet v logu.
 * Server to stejne overi proti allowlistu (SONGCRAFT_ALLOWED_EMAILS /
 * SONGCRAFT_ALLOWED_USER_IDS), takze cizi ucet se ani nedostane do relace.
 *
 * UUID jsou stabilni - nesmime se generovat novy ani prevadet na jiny Supabase
 * projekt bez upravy allowlistu na serveru.
 */
export type AccountIconName = ComponentProps<typeof MaterialIcons>["name"];

export interface StudioAccount {
  /** auth.users.id */
  id: string;
  email: string;
  /** Jmeno, podle ktereho se ucet vybira */
  name: string;
  /** Kratky popisek pod jmenem */
  hint: string;
  icon: AccountIconName;
}

export const STUDIO_ACCOUNTS: readonly StudioAccount[] = [
  {
    id: "296b2989-d9d4-455c-ae08-c1271b9f29d3",
    email: "insanebad2@gmail.com",
    name: "Temney",
    hint: "Hlavní účet",
    icon: "music-note",
  },
  {
    id: "236aa29b-215f-4d88-ab31-a89ec6e871f5",
    email: "verca.bukovska@gmail.com",
    name: "Verča",
    hint: "Druhý účet",
    icon: "favorite",
  },
  {
    id: "911f9648-6247-4387-81b5-7526290226a5",
    email: "petr.lukes0711@gmail.com",
    name: "DJ-Palačinka",
    hint: "Třetí účet",
    icon: "headphones",
  },
] as const;

export function findAccountByEmail(email: string): StudioAccount | undefined {
  const normalized = email.trim().toLowerCase();
  return STUDIO_ACCOUNTS.find((account) => account.email.toLowerCase() === normalized);
}