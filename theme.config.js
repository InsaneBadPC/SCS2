/**
 * Jeden zdroj pravdy pro barvy cele aplikace.
 *
 * Zmena barvy celeho UI = zmena jednoho radku zde.
 * Aplikace je vzdy tmava (viz lib/theme-provider.tsx), proto light === dark.
 *
 * Zasada: cerna zazemi + JEDEN akcent (primary). Sekundarni syte barvy
 * (secondary / accent) se pouzivaji vyhradne pro stavy a vyzadujici akci,
 * nikoli jako dekor. Gradient max. jednou na obrazovce.
 */
const themeColors = {
  // --- Akcent ---------------------------------------------------------------
  primary: { light: "#00D9EC", dark: "#00D9EC" }, // elektricka azurova
  primaryVibrant: { light: "#5FF3FF", dark: "#5FF3FF" }, // svetla pro glow
  onPrimary: { light: "#04141B", dark: "#04141B" }, // text na akcentove ploche

  secondary: { light: "#FF9500", dark: "#FF9500" }, // horaci jantar - forge
  accentWarm: { light: "#FFC53D", dark: "#FFC53D" }, // tepla zluta
  accent: { light: "#FF2E4E", dark: "#FF2E4E" }, // sytý karmín

  // --- Plochy ---------------------------------------------------------------
  background: { light: "#070A0D", dark: "#070A0D" }, // téměř černá, chladná
  surface: { light: "#0D1117", dark: "#0D1117" },
  surfaceElevated: { light: "#151B23", dark: "#151B23" },
  surfaceHighlight: { light: "#1E2731", dark: "#1E2731" },

  // --- Text -----------------------------------------------------------------
  foreground: { light: "#EEF3F6", dark: "#EEF3F6" },
  foregroundMuted: { light: "#C3CCD4", dark: "#C3CCD4" },
  muted: { light: "#7E8B96", dark: "#7E8B96" },
  mutedSubtle: { light: "#525D67", dark: "#525D67" },

  // --- Hrany ----------------------------------------------------------------
  // border je neutralni, aby karty nesvitezly barvou. Akcentove odliseni
  // nesou az teprve borderHighlight / borderStrong.
  border: { light: "rgba(255,255,255,0.07)", dark: "rgba(255,255,255,0.07)" },
  borderHighlight: { light: "rgba(0,217,236,0.24)", dark: "rgba(0,217,236,0.24)" },
  borderStrong: { light: "rgba(0,217,236,0.42)", dark: "rgba(0,217,236,0.42)" },

  // --- Stavy ----------------------------------------------------------------
  success: { light: "#00E08A", dark: "#00E08A" },
  warning: { light: "#FFB020", dark: "#FFB020" },
  error: { light: "#FF3B47", dark: "#FF3B47" },

  // --- Prekryti -------------------------------------------------------------
  overlay: { light: "rgba(7,10,13,0.86)", dark: "rgba(7,10,13,0.86)" },
  scrim: { light: "rgba(0,0,0,0.55)", dark: "rgba(0,0,0,0.55)" },
};

module.exports = { themeColors };