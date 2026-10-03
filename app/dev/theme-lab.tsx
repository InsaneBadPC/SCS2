import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { SchemeColors, type ColorScheme } from "@/constants/theme";
import { useColors } from "@/hooks/use-colors";
import { useThemeContext } from "@/lib/theme-provider";
import { Hairline, OnPrimary, Radius, Space, Type } from "@/lib/design-tokens";

type PaletteName = keyof typeof SchemeColors.light;

const paletteNames: PaletteName[] = Object.keys(SchemeColors.light) as PaletteName[];

function ColorSwatch({ name, value }: { name: PaletteName; value: string }) {
  const colors = useColors();
  return (
    <View style={styles.swatch}>
      <View style={styles.swatchLeft}>
        <View style={[styles.swatchDot, { backgroundColor: value }]} />
        <Text style={[Type.label, { color: colors.foreground }]}>{name}</Text>
      </View>
      <Text style={[Type.caption, { color: colors.muted }]}>{value}</Text>
    </View>
  );
}

export default function ThemeLabScreen() {
  const [pressCount, setPressCount] = useState(0);
  const [lastAction, setLastAction] = useState<string>("None yet");
  const { colorScheme, setColorScheme } = useThemeContext();
  const colors = useColors();

  const swatches = useMemo(
    () =>
      paletteNames.map((name) => ({
        name,
        value: SchemeColors[colorScheme][name],
      })),
    [colorScheme],
  );

  const tileStyles = useMemo(() => {
    const build = (scheme: ColorScheme) => ({
      background: SchemeColors[scheme].background,
      border: SchemeColors[scheme].border,
      text: SchemeColors[scheme].foreground,
      subText: SchemeColors[scheme].muted,
      activeBackground: SchemeColors[scheme].primary,
      activeText: SchemeColors[scheme].background,
    });
    return {
      light: build("light"),
      dark: build("dark"),
    };
  }, []);

  const tokenButtons: { label: string; token: keyof typeof SchemeColors.light; onText: string }[] = [
    { label: "Primary", token: "primary", onText: OnPrimary },
    { label: "Surface", token: "surface", onText: "" },
    { label: "Success", token: "success", onText: OnPrimary },
    { label: "Warning", token: "warning", onText: OnPrimary },
    { label: "Error", token: "error", onText: OnPrimary },
  ];

  return (
    <ScreenContainer inset>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.row}>
          {(["light", "dark"] as ColorScheme[]).map((scheme) => (
            <Pressable
              key={scheme}
              style={[
                styles.schemeToggle,
                {
                  backgroundColor:
                    colorScheme === scheme
                      ? tileStyles[scheme].activeBackground
                      : tileStyles[scheme].background,
                  borderColor:
                    colorScheme === scheme
                      ? tileStyles[scheme].activeBackground
                      : tileStyles[scheme].border,
                },
              ]}
              onPress={() => {
                setColorScheme(scheme);
                setLastAction(`Applied ${scheme} globally`);
              }}
            >
              <Text
                style={[
                  Type.body,
                  {
                    color:
                      colorScheme === scheme
                        ? tileStyles[scheme].activeText
                        : tileStyles[scheme].text,
                  },
                ]}
              >
                {scheme === "light" ? "Light preview" : "Dark preview"}
              </Text>
              <Text
                style={[
                  Type.caption,
                  {
                    color:
                      colorScheme === scheme
                        ? tileStyles[scheme].activeText
                        : tileStyles[scheme].subText,
                  },
                ]}
              >
                Global theme (theme.config.js + useColors)
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={[Type.title, { color: colors.foreground }]}>Barevné tokeny</Text>
          <Text style={[Type.label, styles.cardSubtitle, { color: colors.muted }]}>
            Tlačítka poháněná paletou {colorScheme}
          </Text>

          <View style={styles.buttons}>
            {tokenButtons.map((item) => {
              const onText = item.onText || colors.foreground;
              return (
                <Pressable
                  key={item.label}
                  style={[
                    styles.tokenButton,
                    {
                      backgroundColor: SchemeColors[colorScheme][item.token],
                      borderColor: item.onText ? "transparent" : Hairline,
                    },
                  ]}
                  onPress={() => {
                    setPressCount((count) => count + 1);
                    setLastAction(`Pressed ${item.label} token`);
                  }}
                >
                  <Text style={[Type.label, { color: onText }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.insetCard}>
            <Text style={[Type.heading, { color: colors.foreground }]}>useColors()</Text>
            <Text style={[Type.label, styles.cardSubtitle, { color: colors.muted }]}>
              Background: {colors.background} • Text: {colors.text} • Tint: {colors.tint}
            </Text>
            <View style={styles.rowTight}>
              <IconSymbol name="house.fill" color={colors.tint} size={20} />
              <Text style={[Type.label, { color: colors.foreground }]}>Press count: {pressCount}</Text>
            </View>
            <Text style={[Type.label, { color: colors.muted }]}>Last action: {lastAction}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={[Type.title, { color: colors.foreground }]}>Hodnoty palety</Text>
          <Text style={[Type.label, styles.cardSubtitle, { color: colors.muted }]}>
            Živé hodnoty pro zvolené schéma
          </Text>
          <View style={styles.buttons}>
            {swatches.map((item) => (
              <ColorSwatch key={item.name} name={item.name} value={item.value} />
            ))}
          </View>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { gap: Space.lg, paddingVertical: Space.xl },
  row: { flexDirection: "row", gap: Space.sm },
  rowTight: { flexDirection: "row", alignItems: "center", gap: Space.sm },
  schemeToggle: {
    flex: 1,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.md,
    gap: Space.xs,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    borderColor: Hairline,
    padding: Space.lg,
    backgroundColor: SchemeColors.dark.surface,
  },
  cardSubtitle: { marginTop: Space.xs },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: Space.sm, marginTop: Space.lg },
  tokenButton: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
  insetCard: {
    marginTop: Space.lg,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Hairline,
    padding: Space.lg,
    gap: Space.sm,
  },
  swatch: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Hairline,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    width: "100%",
  },
  swatchLeft: { flexDirection: "row", alignItems: "center", gap: Space.md },
  swatchDot: { height: 24, width: 24, borderRadius: 12, borderWidth: 1, borderColor: Hairline },
});