import { View, type ViewProps } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";

import { useColors } from "@/hooks/use-colors";
import { Hairline, Radius, Space, alpha } from "@/lib/design-tokens";

export interface ScreenContainerProps extends ViewProps {
  edges?: Edge[];
  /** Vodorovne odsazeni obsahu. */
  inset?: boolean;
  /** Vycentrovat obsah uprostred obrazovky. */
  centered?: boolean;
}

export function ScreenContainer({
  children,
  edges = ["top", "left", "right"],
  inset,
  centered,
  style,
  ...props
}: ScreenContainerProps) {
  const colors = useColors();
  return (
    <View style={[{ backgroundColor: colors.background }, style]} {...props}>
      {/* Jeden zklidneny akcentovy glow odev, ne plocha. */}
      <LinearGradient
        colors={[alpha(colors.primary, 0.13), alpha(colors.primary, 0.04), "transparent"]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 380 }}
        pointerEvents="none"
      />
      {/* Tepla stopa, ktera odlise stranku od sousedni. */}
      <View
        style={{
          position: "absolute",
          top: -60,
          right: -50,
          width: 220,
          height: 220,
          borderRadius: Radius.pill,
          backgroundColor: alpha(colors.secondary, 0.07),
        }}
        pointerEvents="none"
      />
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: Hairline }} pointerEvents="none" />
      <SafeAreaView edges={edges} style={{ flex: 1 }}>
        <View
          style={[
            { flex: 1 },
            inset ? { paddingHorizontal: Space.xl } : null,
            centered ? { alignItems: "center", justifyContent: "center", padding: Space.xl } : null,
          ]}
        >
          {children}
        </View>
      </SafeAreaView>
    </View>
  );
}