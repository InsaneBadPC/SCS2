import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { Radius } from "@/lib/design-tokens";

/** Gradientovy blok pro hero prvky. Dva barvy, ne tri. */
export function NeonGradient({ children, style }: { children?: ReactNode; style?: object }) {
  const colors = useColors();
  return (
    <View style={[styles.wrap, style]}>
      <LinearGradient
        colors={[colors.primary, colors.secondary]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

/** Uzký pruh pod nadpisy a kartami. */
export function NeonAccent({ width = 64 }: { width?: number }) {
  const colors = useColors();
  return (
    <LinearGradient
      colors={[colors.primary, colors.secondary]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={{ height: 3, borderRadius: 2, width }}
    />
  );
}

/** Karta s barevnym okrajem. */
export function GlowCard({ children, style, contentStyle }: { children?: ReactNode; style?: object; contentStyle?: object }) {
  const colors = useColors();
  return (
    <View style={style}>
      <LinearGradient
        colors={[colors.primary, colors.secondary]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.glowBorder}
      >
        <View style={[styles.glowInner, { backgroundColor: colors.surface }, contentStyle]}>{children}</View>
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: Radius.lg, overflow: "hidden" },
  glowBorder: { borderRadius: Radius.lg, padding: 1.5 },
  glowInner: { borderRadius: Radius.lg - 1.5 },
});