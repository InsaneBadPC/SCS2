import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useMemo, useState, useCallback } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeInDown, Layout } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CoverArt, EmptyState, FilterChip, GlassCard, IconButton, Shimmer, StudioHeader } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { Radius, Type } from "@/lib/design-tokens";

export default function LibraryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, loading } = useAuth();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const [search, setSearch] = useState("");
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [finalOnly, setFinalOnly] = useState(false);
  const [publishedOnly, setPublishedOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    Haptics.selectionAsync().catch(() => {});
    await snapshot.refetch();
    setRefreshing(false);
  }, [snapshot]);

  const songs = useMemo(() => {
    const versions = snapshot.data?.versions ?? [];
    return (snapshot.data?.songs ?? []).filter(
      (song) =>
        (!albumId || song.albumId === albumId) &&
        song.title.toLowerCase().includes(search.toLowerCase()) &&
        (!finalOnly || versions.some((v) => v.songId === song.id && v.isFinal)) &&
        (!publishedOnly || (song as any).isPublished)
    );
  }, [albumId, finalOnly, publishedOnly, search, snapshot.data?.songs, snapshot.data?.versions]);

  if (loading || (isAuthenticated && snapshot.isLoading)) {
    return (
      <ScreenContainer inset>
        <View style={{ paddingTop: 14, gap: 12 }}>
          <Shimmer height={36} radius={16} />
          <Shimmer height={48} radius={16} />
          <View style={{ gap: 10, marginTop: 12 }}>
            {[1, 2, 3].map((i) => (
              <View key={i} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Shimmer width={62} height={62} radius={16} />
                <View style={{ flex: 1, gap: 8 }}>
                  <Shimmer height={14} width="60%" />
                  <Shimmer height={12} width="40%" />
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScreenContainer>
    );
  }

  if (!isAuthenticated) {
    return (
      <ScreenContainer centered>
        <EmptyState icon="lock" title="Knihovna je soukromá" text="Přihlas se, aby se hotové skladby načetly z tvého cloudu." action={<Pressable onPress={() => void startPrivateLogin()} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Přihlásit se</Text></Pressable>} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer inset>
      <Animated.FlatList
        data={songs}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />}
        ListHeaderComponent={
          <>
            <StudioHeader eyebrow="Databáze skladeb" title="Knihovna" action={
              <View style={styles.headerActions}>
                <IconButton label="YouTube export" icon="video-library" onPress={() => { Haptics.selectionAsync().catch(()=>{}); router.push("/export/youtube" as never); }} />
                <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(()=>{}); router.push("/song/new" as never); }} style={({ pressed }) => [{ transform: [{ scale: pressed ? 0.97 : 1 }], opacity: pressed ? 0.9 : 1 }]}>
                  <LinearGradient colors={[colors.primary, colors.primaryVibrant]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.fabGradient}>
                    <MaterialIcons name="add" size={22} color="#FFFFFF" />
                  </LinearGradient>
                </Pressable>
              </View>
            } />
            {/* Search with glassmorphism */}
            <View style={[styles.search, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }]}>
              <MaterialIcons name="search" size={20} color={colors.muted} />
              <TextInput value={search} onChangeText={setSearch} placeholder="Hledat skladbu, album, náladu…" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} />
              {search.length > 0 && (
                <Pressable onPress={() => setSearch("")} hitSlop={8} style={styles.searchClear}>
                  <MaterialIcons name="close" size={18} color={colors.muted} />
                </Pressable>
              )}
            </View>

            <View style={styles.filterGroup}>
              <Text style={[styles.filterLabel, { color: colors.muted }]}>ALBUM</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
                <FilterChip active={!albumId} label="Všechna" onPress={() => { Haptics.selectionAsync().catch(()=>{}); setAlbumId(null); }} />
                {snapshot.data?.albums.map((album) => <FilterChip key={album.id} active={albumId === album.id} label={album.name} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setAlbumId(album.id); }} />)}
              </ScrollView>
            </View>

            <View style={styles.filterGroup}>
              <Text style={[styles.filterLabel, { color: colors.muted }]}>STAV</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
                <FilterChip active={!finalOnly && !publishedOnly} label="Všechny" onPress={() => { setFinalOnly(false); setPublishedOnly(false); }} />
                <FilterChip active={finalOnly} label="Finální" icon="verified" onPress={() => { Haptics.selectionAsync().catch(()=>{}); setFinalOnly(!finalOnly); setPublishedOnly(false); }} />
                <FilterChip active={publishedOnly} label="Publikované" icon="public" onPress={() => { Haptics.selectionAsync().catch(()=>{}); setPublishedOnly(!publishedOnly); setFinalOnly(false); }} />
              </ScrollView>
            </View>

            <View style={styles.countRow}>
              <Text style={[styles.countText, { color: colors.foreground }]}>{songs.length} {songs.length === 1 ? "skladba" : songs.length < 5 ? "skladby" : "skladeb"}</Text>
              <Text style={[styles.countSub, { color: colors.muted }]}>tažením obnovíš • podrž pro náhled</Text>
            </View>
          </>
        }
        renderItem={({ item, index }) => {
          const source = snapshot.data?.documents.find((d) => d.id === (item as any).sourceDocumentId);
          const songVersions = snapshot.data?.versions.filter((v) => v.songId === item.id) ?? [];
          const finalVersion = songVersions.find((v) => v.isFinal);
          const album = snapshot.data?.albums.find((a) => a.id === item.albumId);
          const isPublished = (item as any).isPublished;
          return (
            <Animated.View entering={FadeInDown.delay(index * 40).duration(420)} layout={Layout.springify()}>
              <Pressable onPress={() => { Haptics.selectionAsync().catch(()=>{}); router.push(`/song/${item.id}` as never); }} style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: pressed ? 0.2 : 0.12, shadowRadius: pressed ? 8 : 16, shadowOffset: { width: 0, height: pressed ? 4 : 8 }, elevation: 6, opacity: pressed ? 0.96 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
                <CoverArt uri={(item as any).coverUrl ?? (source as any)?.coverUrl ?? (album as any)?.coverUrl} title={item.title} size={64} />
                <View style={styles.copy}>
                  <Text numberOfLines={1} style={[styles.songName, { color: colors.foreground }]}>{item.title}</Text>
                  <Text numberOfLines={1} style={[styles.songMeta, { color: colors.muted }]}>{album?.name ?? "Bez alba"} • {songVersions.length} {songVersions.length === 1 ? "verze" : "verzí"} • {isPublished ? "na YouTube" : finalVersion ? "připraveno" : "koncept"}</Text>
                  <View style={styles.badges}>
                    {finalVersion ? (
                      <View style={[styles.badge, { backgroundColor: "rgba(16,185,129,0.12)", borderColor: "rgba(16,185,129,0.22)" }]}>
                        <MaterialIcons name="verified" size={12} color={colors.success} />
                        <Text style={[styles.badgeText, { color: colors.success }]}>{finalVersion.label}</Text>
                      </View>
                    ) : (
                      <View style={[styles.badge, { backgroundColor: "rgba(148,163,184,0.10)", borderColor: "rgba(255,255,255,0.08)" }]}>
                        <View style={[styles.dot, { backgroundColor: colors.muted }]} />
                        <Text style={[styles.badgeText, { color: colors.muted }]}>koncept</Text>
                      </View>
                    )}
                    {isPublished && (
                      <View style={[styles.badge, { backgroundColor: "rgba(0,217,236,0.12)", borderColor: "rgba(0,217,236,0.22)" }]}>
                        <MaterialIcons name="public" size={12} color={colors.primary} />
                        <Text style={[styles.badgeText, { color: colors.primary }]}>YouTube</Text>
                      </View>
                    )}
                  </View>
                </View>
                <View style={[styles.chevron, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.08)" }]}>
                  <MaterialIcons name="chevron-right" size={18} color={colors.muted} />
                </View>
              </Pressable>
            </Animated.View>
          );
        }}
        ListEmptyComponent={<EmptyState icon={finalOnly || publishedOnly ? "verified" : "library-music"} title={finalOnly ? "Zatím bez finální" : publishedOnly ? "Zatím nic na YouTube" : "Knihovna je prázdná"} text={finalOnly ? "Označ MP3 jako finální." : publishedOnly ? "Publikuj video přes YouTube export." : "Označ text jako hotový – vznikne skladba."} action={!finalOnly && !publishedOnly ? <Pressable onPress={() => router.push("/(tabs)/texts" as never)} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Otevřít texty</Text></Pressable> : undefined} />}
      />

      {/* Thumb-zone primary CTA */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12, backgroundColor: colors.background, borderTopColor: "rgba(255,255,255,0.06)" }]}>
        <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(()=>{}); router.push("/song/new" as never); }} style={({ pressed }) => [styles.bottomCta, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
          <LinearGradient colors={[colors.primary, colors.primaryVibrant]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill as any} />
          <MaterialIcons name="add" size={20} color="#FFFFFF" />
          <Text style={styles.bottomCtaText}>Nová skladba</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 14 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  fabGradient: { width: 44, height: 44, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  search: { height: 48, borderRadius: Radius.md, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0, fontWeight: "500" },
  searchClear: { width: 32, height: 32, borderRadius: Radius.md, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.06)" },
  filterGroup: { marginTop: 16, gap: 8 },
  filterLabel: { ...Type.overline, letterSpacing: 1, marginLeft: 2 },
  filters: { paddingRight: 20, gap: 8, paddingVertical: 2 },
  filter: { height: 44, paddingHorizontal: 14, justifyContent: "center", borderWidth: 1, borderRadius: Radius.md, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 44 },
  filterText: { ...Type.label, letterSpacing: -0.1 },
  countRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 20, marginBottom: 8, paddingHorizontal: 2 },
  countText: { ...Type.label, letterSpacing: -0.2 },
  countSub: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "500", opacity: 0.7 },
  row: { borderWidth: 1, borderRadius: Radius.lg, padding: 12, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  copy: { flex: 1, gap: 5 },
  songName: { fontSize: 16, fontWeight: "700", letterSpacing: -0.3, lineHeight: 20 },
  songMeta: { ...Type.caption, opacity: 0.9 },
  badges: { flexDirection: "row", gap: 6, marginTop: 2 },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, height: 22, borderRadius: Radius.sm, borderWidth: 1 },
  badgeText: { ...Type.overline, letterSpacing: 0.3 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  chevron: { width: 32, height: 32, borderRadius: Radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  login: { minHeight: 48, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  loginText: { color: "#FFFFFF", fontWeight: "700" },
  bottomBar: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingHorizontal: 20, paddingTop: 12, flexDirection: "row", gap: 12 },
  bottomCta: { flex: 1, height: 52, borderRadius: Radius.md, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  bottomCtaText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
});
