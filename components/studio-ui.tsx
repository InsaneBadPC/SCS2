import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { memo, type ReactNode, useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useColors } from "@/hooks/use-colors";
import { getApiBaseUrl } from "@/constants/oauth";
import { Hairline, OnPrimary, Radius, Space, TouchTarget, Type, alpha, glow } from "@/lib/design-tokens";

export function resolveAssetUrl(uri?: string | null) {
  if (!uri || /^(?:https?:|data:|file:|content:)/i.test(uri)) return uri ?? null;
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${uri.startsWith("/") ? uri : `/${uri}`}` : uri;
}

export function Shimmer({ width = "100%", height = 16, radius = 12 }: { width?: any; height?: number; radius?: number }) {
  const colors = useColors();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.timing(anim, { toValue: 1, duration: 1300, useNativeDriver: true })).start();
  }, [anim]);
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-200, 200] });
  return (
    <View style={{ width: width as any, height, borderRadius: radius, backgroundColor: alpha(colors.primary, 0.06), borderWidth: 1, borderColor: alpha(colors.primary, 0.1), overflow: "hidden" }}>
      <Animated.View style={{ width: "55%", height: "100%", backgroundColor: "rgba(255,255,255,0.06)", transform: [{ translateX }] }} />
    </View>
  );
}

/** Hlavicka obrazovky. Gradient jen jako tenka cara, ne jako plocha. */
export const StudioHeader = memo(function StudioHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        {eyebrow ? <Text style={[Type.overline, styles.eyebrow, { color: colors.muted }]}>{eyebrow.toUpperCase()}</Text> : null}
        <View style={styles.titleRow}>
          <Text style={[Type.display, styles.title, { color: colors.foreground }]}>{title}</Text>
          <View style={[styles.titleDot, { backgroundColor: colors.primary, ...glow(colors.primary, 0.5) }]} />
        </View>
        <View style={styles.headerAccent}>
          <LinearGradient
            colors={[colors.primary, colors.secondary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.headerGradient}
          />
        </View>
      </View>
      {action ? <View style={styles.headerAction}>{action}</View> : null}
    </View>
  );
});

/**
 * Primarni akce. Plna sata plocha s tmavym textem - ne gradient.
 * Gradient je vyhradne pro `variant="hero"`, max. jednou na obrazovce.
 */
export function PrimaryButton({
  label,
  icon = "add",
  onPress,
  disabled = false,
  variant = "solid",
}: {
  label: string;
  icon?: React.ComponentProps<typeof MaterialIcons>["name"];
  onPress: () => void;
  disabled?: boolean;
  variant?: "solid" | "hero";
}) {
  const colors = useColors();
  const handlePress = () => {
    if (!disabled) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      onPress();
    }
  };
  const solid = variant === "solid";
  const content = (
    <>
      {solid ? (
        <LinearGradient
          colors={[colors.primary, colors.primaryVibrant]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill as any}
        />
      ) : (
        <LinearGradient
          colors={[colors.primary, colors.secondary, colors.accent]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill as any}
        />
      )}
      {!solid ? <View style={styles.buttonSheen} pointerEvents="none" /> : null}
      <MaterialIcons name={icon} size={19} color={solid ? colors.onPrimary : "#FFFFFF"} style={styles.buttonIcon} />
      <Text style={[Type.heading, styles.primaryButtonText, { color: solid ? colors.onPrimary : "#FFFFFF" }]}>{label}</Text>
    </>
  );
  return (
    <Pressable
      disabled={disabled}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.primaryButton,
        {
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
          ...(disabled
            ? {}
            : solid
              ? glow(colors.primary, pressed ? 0.22 : 0.34)
              : { ...glow(colors.primary, pressed ? 0.16 : 0.26) }),
        },
      ]}
    >
      {content}
    </Pressable>
  );
}

export function SecondaryButton({ label, icon, onPress }: { label: string; icon: React.ComponentProps<typeof MaterialIcons>["name"]; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.secondaryButton,
        {
          backgroundColor: pressed ? colors.surfaceHighlight : colors.surfaceElevated,
          borderColor: Hairline,
          opacity: pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      <MaterialIcons name={icon} size={18} color={colors.foregroundMuted} />
      <Text style={[Type.label, styles.secondaryText, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({ icon, label, onPress }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.iconButton,
        {
          backgroundColor: pressed ? colors.surfaceHighlight : colors.surfaceElevated,
          borderColor: Hairline,
          opacity: pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        },
      ]}
    >
      <MaterialIcons name={icon} size={20} color={colors.foregroundMuted} />
    </Pressable>
  );
}

/** Zakladni karta. Rozhoduje vizualni jednotnost - plocha, hana, polomer. */
export function GlassCard({ children, style }: { children: ReactNode; style?: any }) {
  const colors = useColors();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: Hairline }, style]}>{children}</View>
  );
}

/**
 * Pole formulare. Jedna implementace pro vsechny obrazovky - driv vyre,
 * nebylo ve ctyre kopich s roznymi polomery.
 */
export function Field({
  label,
  helper,
  value,
  onChangeText,
  placeholder,
  multiline,
  tall,
  autoFocus,
  keyboardType,
  disableFullscreenUI,
}: {
  label: string;
  helper?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  tall?: boolean;
  autoFocus?: boolean;
  keyboardType?: "number-pad";
  disableFullscreenUI?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={styles.field}>
      <Text style={[Type.label, styles.fieldLabel, { color: colors.foreground }]}>{label}</Text>
      {helper ? <Text style={[Type.caption, { color: colors.muted }]}>{helper}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        multiline={multiline}
        autoFocus={autoFocus}
        keyboardType={keyboardType}
        disableFullscreenUI={disableFullscreenUI}
        textAlignVertical={multiline ? "top" : "center"}
        style={[
          Type.body,
          styles.input,
          multiline ? styles.inputMultiline : null,
          tall ? styles.inputTall : null,
          {
            color: colors.foreground,
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
      />
    </View>
  );
}

/**
 * Filtracni chip. Nahradil dve kopie (jedna s barevnou teckou, druha s ikonou),
 * ktere se liskly pouze v propu.
 */
export function FilterChip({
  active,
  label,
  icon,
  dotColor,
  onPress,
}: {
  active: boolean;
  label: string;
  icon?: React.ComponentProps<typeof MaterialIcons>["name"];
  dotColor?: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filterChip,
        {
          backgroundColor: active ? colors.primary : colors.surface,
          borderColor: active ? colors.primary : colors.border,
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      {dotColor ? <View style={[styles.filterDot, { backgroundColor: dotColor }]} /> : null}
      {icon ? <MaterialIcons name={icon} size={14} color={active ? colors.onPrimary : colors.muted} /> : null}
      <Text numberOfLines={1} style={[Type.label, { color: active ? colors.onPrimary : colors.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Zobrazeni i zadavani hodnoceni v hvezdickach. */
export function RatingStars({
  rating,
  onRate,
  size = 24,
}: {
  rating: number;
  onRate?: (rating: number) => void;
  size?: number;
}) {
  const colors = useColors();
  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map((value) => {
        const star = (
          <MaterialIcons
            name={value <= rating ? "star" : "star-border"}
            size={size}
            color={value <= rating ? colors.warning : colors.border}
          />
        );
        if (!onRate) return <View key={value}>{star}</View>;
        return (
          <Pressable key={value} onPress={() => onRate(rating === value ? 0 : value)} hitSlop={6} accessibilityRole="button">
            {star}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Vyberovy chip s vizualne zvolenou plochou. */
export function AlbumChip({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.albumChip,
        {
          backgroundColor: active ? colors.primary : colors.surface,
          borderColor: active ? colors.primary : colors.border,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text numberOfLines={1} style={[Type.label, { color: active ? OnPrimary : colors.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={styles.sectionTitle}>
      <View style={styles.sectionTitleLeft}>
        <View style={[styles.sectionBar, { backgroundColor: colors.primary, ...glow(colors.primary, 0.3) }]} />
        <Text style={[Type.heading, { color: colors.foreground }]}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

export function StatusChip({ state }: { state: "draft" | "complete" | "cloud" }) {
  const colors = useColors();
  const complete = state === "complete" || state === "cloud";
  const draft = state === "draft";
  const tone = complete ? colors.success : draft ? colors.muted : colors.primary;
  const label = draft ? "ROZPRACOVÁNO" : state === "complete" ? "HOTOVO" : "CLOUD";
  return (
    <View style={[styles.statusChip, { backgroundColor: alpha(tone, 0.12), borderColor: alpha(tone, 0.28) }]}>
      <View style={[styles.statusDot, { backgroundColor: tone }]} />
      <Text style={[Type.overline, { color: tone }]}>{label}</Text>
    </View>
  );
}

export function CoverArt({ uri, title, size = 64 }: { uri?: string | null; title: string; size?: number }) {
  const colors = useColors();
  const radius = size >= 56 ? Radius.md : Radius.sm;
  const resolvedUri = resolveAssetUrl(uri);
  if (resolvedUri) {
    return (
      <View style={{ width: size, height: size, borderRadius: radius, borderWidth: 1, borderColor: Hairline, backgroundColor: colors.surfaceElevated, overflow: "hidden" }}>
        <Image source={{ uri: resolvedUri }} contentFit="cover" style={{ width: size, height: size }} />
      </View>
    );
  }
  return (
    <View style={[styles.coverFallback, { width: size, height: size, borderRadius: radius, backgroundColor: alpha(colors.primary, 0.1), borderWidth: 1, borderColor: alpha(colors.primary, 0.24) }]}>
      <MaterialIcons name="music-note" size={size * 0.3} color={colors.primary} />
      <Text numberOfLines={1} style={[Type.title, styles.coverLetter, { color: colors.primary }]}>
        {title.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; title: string; text: string; action?: ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.empty, { borderColor: Hairline, backgroundColor: colors.surface }]}>
      <View style={[styles.emptyIcon, { backgroundColor: alpha(colors.primary, 0.1), borderWidth: 1, borderColor: alpha(colors.primary, 0.22) }]}>
        <MaterialIcons name={icon} size={26} color={colors.primary} />
      </View>
      <Text style={[Type.title, { color: colors.foreground }]}>{title}</Text>
      <Text style={[Type.body, styles.emptyText, { color: colors.muted }]}>{text}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function LoadingState({ label = "Načítám studio…" }: { label?: string }) {
  const colors = useColors();
  return (
    <View style={styles.loading}>
      <View style={styles.loadingRow}>
        <Shimmer height={14} radius={Radius.sm} />
        <Shimmer height={14} radius={Radius.sm} width="75%" />
        <Shimmer height={14} radius={Radius.sm} width="50%" />
      </View>
      <Text style={[Type.label, { color: colors.muted }]}>{label}</Text>
    </View>
  );
}

export function formatDate(value?: Date | string | null) {
  if (!value) return "bez data";
  const date = new Date(value);
  return new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "short" }).format(date);
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: Space.lg,
    marginBottom: Space.xxl,
    paddingTop: Space.sm,
  },
  headerCopy: { flex: 1, gap: Space.sm },
  eyebrow: { opacity: 0.85 },
  titleRow: { flexDirection: "row", alignItems: "flex-end", gap: Space.sm },
  title: { flexShrink: 1 },
  titleDot: { width: 7, height: 7, borderRadius: 4, marginBottom: Space.md },
  headerAccent: { marginTop: Space.md, height: 2, width: 88, borderRadius: 1, overflow: "hidden" },
  headerGradient: { flex: 1 },
  headerAction: { paddingBottom: 2 },

  primaryButton: {
    minHeight: 48,
    minWidth: TouchTarget,
    borderRadius: Radius.md,
    paddingHorizontal: Space.xl,
    flexDirection: "row",
    gap: Space.sm,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  primaryButtonText: { letterSpacing: -0.2 },
  buttonSheen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: Radius.md,
  },
  buttonIcon: { zIndex: 1 },

  secondaryButton: {
    minHeight: TouchTarget,
    minWidth: TouchTarget,
    borderRadius: Radius.md,
    paddingHorizontal: Space.lg,
    flexDirection: "row",
    gap: Space.sm,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  secondaryText: {},

  iconButton: {
    width: TouchTarget,
    height: TouchTarget,
    borderRadius: Radius.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },

  card: { borderRadius: Radius.lg, borderWidth: 1, padding: Space.lg, overflow: "hidden" },

  sectionTitle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: Space.xxxl,
    marginBottom: Space.lg,
    gap: Space.md,
  },
  sectionTitleLeft: { flexDirection: "row", alignItems: "center", gap: Space.sm, flexShrink: 1 },
  sectionBar: { width: 3, height: 16, borderRadius: 2 },

  field: { gap: Space.xs },
  fieldLabel: { marginBottom: Space.xs },
  input: {
    minHeight: TouchTarget + 4,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
  },
  inputMultiline: { minHeight: 88, paddingTop: Space.md },
  inputTall: { minHeight: 132 },

  albumChip: {
    height: 36,
    paddingHorizontal: Space.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    maxWidth: 180,
  },
  filterChip: {
    height: TouchTarget,
    paddingHorizontal: Space.lg,
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: Radius.pill,
    minWidth: TouchTarget,
    flexDirection: "row",
    alignItems: "center",
    gap: Space.xs,
  },
  filterDot: { width: 7, height: 7, borderRadius: 4 },
  stars: { flexDirection: "row", alignItems: "center", gap: 1 },

  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.xs,
    paddingHorizontal: Space.md,
    height: 24,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  statusDot: { height: 6, width: 6, borderRadius: 3 },

  coverFallback: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  coverLetter: { position: "absolute", bottom: 7, right: 8, opacity: 0.55 },

  empty: {
    borderWidth: 1,
    borderRadius: Radius.xl,
    padding: Space.xxxl,
    alignItems: "center",
    marginTop: Space.md,
    overflow: "hidden",
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: Radius.lg,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Space.lg,
  },
  emptyText: { textAlign: "center", maxWidth: 300, marginTop: Space.xs },
  emptyAction: { marginTop: Space.xl, alignSelf: "stretch" },

  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: Space.lg, paddingTop: Space.xxxl },
  loadingRow: { gap: Space.md, width: "100%", paddingHorizontal: Space.xxxl },
});