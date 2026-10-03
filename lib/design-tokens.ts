/**
 * Skaly design tokenu pro SongCraft Studio.
 *
 * Barva zije v theme.config.js. Cokoliv dalsiho (rozmer, pismo, hloubka)
 * zde - aby se nepouzivalo 15 ruznych polomeru a 12 velikosti pisma.
 */

/** Polomery: pet hodnot, nic jineho. */
export const Radius = {
  sm: 10, // chipy, odznaky, male ikony
  md: 16, // tlacitka, pole
  lg: 22, // karty
  xl: 28, // hero karty, sheety
  pill: 999,
} as const;

/** Rozestupy: 4/8/12/16/20/24/32. */
export const Space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/**
 * Typografie: sedm stepu. Tiha klesa s velikosti - vetsi text je cistsi,
 * drobny je ucineny. Nic neni permanentne "900".
 */
export const Type = {
  display: { fontSize: 34, lineHeight: 38, fontWeight: "800", letterSpacing: -0.8 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700", letterSpacing: -0.4 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "700", letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 21, fontWeight: "500", letterSpacing: 0 },
  label: { fontSize: 13, lineHeight: 17, fontWeight: "600", letterSpacing: 0 },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.3 },
  overline: { fontSize: 10, lineHeight: 13, fontWeight: "700", letterSpacing: 1.3 },
} as const;

export type TypeToken = keyof typeof Type;

/**
 * Hloubka. Na téměř černém pozadí stín není vidět, proto je tlumený a
 * skutečné oddělení dělá hrana. Glow je jediný stín, ktery se da čist.
 */
export const Elevation = {
  none: {},
  low: {
    shadowColor: "#000000",
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  mid: {
    shadowColor: "#000000",
    shadowOpacity: 0.38,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  high: {
    shadowColor: "#000000",
    shadowOpacity: 0.46,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 16 },
    elevation: 16,
  },
} as const;

/** Dusejici linka - jedina hrana v aplikaci, ktera neni barevna. */
export const Hairline = "rgba(255,255,255,0.07)";

/**
 * Text a ikona na sate ploše (primary i success).
 * Staticky export, protoze ho treba i ve StyleSheet.create() mimo hook.
 * Test `design-tokens.test.ts` hlida, aby zustal v souladu s themeColors.
 */
export const OnPrimary = "#04141B";

/** Minimalni dotykova plocha. */
export const TouchTarget = 44;

/** Prida prühlednost k hex barve: alpha("#00D9EC", 0.2). */
export function alpha(hex: string, opacity: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return `rgba(${r},${g},${b},${Math.round(a / 255 * 100) / 100})`;
}

/** Glow pod akcentem - bezny jediny vizualni "efekt" v UI. */
export function glow(color: string, opacity = 0.35) {
  return {
    shadowColor: color,
    shadowOpacity: opacity,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  } as const;
}