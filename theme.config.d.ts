export const themeColors: {
  primary: { light: string; dark: string };
  primaryVibrant: { light: string; dark: string };
  onPrimary: { light: string; dark: string };
  secondary: { light: string; dark: string };
  accent: { light: string; dark: string };
  accentWarm: { light: string; dark: string };
  background: { light: string; dark: string };
  surface: { light: string; dark: string };
  surfaceElevated: { light: string; dark: string };
  surfaceHighlight: { light: string; dark: string };
  foreground: { light: string; dark: string };
  foregroundMuted: { light: string; dark: string };
  muted: { light: string; dark: string };
  mutedSubtle: { light: string; dark: string };
  border: { light: string; dark: string };
  borderHighlight: { light: string; dark: string };
  borderStrong: { light: string; dark: string };
  success: { light: string; dark: string };
  warning: { light: string; dark: string };
  error: { light: string; dark: string };
  overlay: { light: string; dark: string };
  scrim: { light: string; dark: string };
};

declare const themeConfig: {
  themeColors: typeof themeColors;
};

export default themeConfig;