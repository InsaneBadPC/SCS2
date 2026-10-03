import { Tabs } from "expo-router";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { UpdateBanner } from "@/components/update-banner";
import { useColors } from "@/hooks/use-colors";
import { Hairline, Radius, Space, Type, alpha } from "@/lib/design-tokens";

type SymbolName = React.ComponentProps<typeof IconSymbol>["name"];

function TabIcon({ name, color, focused }: { name: SymbolName; color: string; focused: boolean }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: 40,
        height: 26,
        borderRadius: Radius.sm,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? alpha(colors.primary, 0.14) : "transparent",
      }}
    >
      <IconSymbol size={20} name={name} color={color} />
    </View>
  );
}

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === "web" ? 12 : Math.max(insets.bottom, Space.md);

  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.mutedSubtle,
          tabBarButton: HapticTab,
          tabBarBackground: () => (
            <View style={{ flex: 1, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: Hairline }} />
          ),
          tabBarStyle: {
            height: 62 + bottomPadding,
            paddingTop: Space.sm,
            paddingBottom: bottomPadding,
            paddingHorizontal: Space.sm,
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: Hairline,
            shadowColor: "#000000",
            shadowOpacity: 0.35,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: -6 },
            elevation: 14,
          },
          tabBarLabelStyle: { ...Type.overline, ...Type.overline, letterSpacing: 0.2, marginTop: 3 },
          tabBarItemStyle: { minHeight: 44, minWidth: 44, paddingVertical: 2 },
          tabBarIconStyle: { marginBottom: 0 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Přehled", tabBarIcon: ({ color, focused }) => <TabIcon name="house.fill" color={color} focused={focused} /> }} />
        <Tabs.Screen name="texts" options={{ title: "Texty", tabBarIcon: ({ color, focused }) => <TabIcon name="square.and.pencil" color={color} focused={focused} /> }} />
        <Tabs.Screen name="albums" options={{ title: "Alba", tabBarIcon: ({ color, focused }) => <TabIcon name="rectangle.stack.fill" color={color} focused={focused} /> }} />
        <Tabs.Screen name="library" options={{ title: "Knihovna", tabBarIcon: ({ color, focused }) => <TabIcon name="music.note.list" color={color} focused={focused} /> }} />
        <Tabs.Screen name="assistant" options={{ title: "Temney Agent", tabBarIcon: ({ color, focused }) => <TabIcon name="sparkles" color={color} focused={focused} /> }} />
        <Tabs.Screen name="settings" options={{ title: "Nastavení", tabBarIcon: ({ color, focused }) => <TabIcon name="gearshape.fill" color={color} focused={focused} /> }} />
      </Tabs>
      <UpdateBanner />
    </>
  );
}