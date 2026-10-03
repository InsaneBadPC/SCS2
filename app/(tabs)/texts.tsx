import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeInDown, Layout } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CoverArt, EmptyState, FilterChip, IconButton, Shimmer, StatusChip, StudioHeader, formatDate } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { firstQueryParam } from "@/lib/query-params";
import { TextImporter } from "@/components/text-importer";
import { Radius, Type } from "@/lib/design-tokens";

type Phase = "draft" | "album" | "mp3" | "published";
const phaseMeta = (phase: Phase, colors: any) => {
  switch (phase) {
    case "published": return { label: "Publikováno", icon: "public" as const, color: colors.success, bg: "rgba(16,185,129,0.14)", border: colors.success };
    case "mp3": return { label: "S MP3", icon: "music-note" as const, color: colors.success, bg: "rgba(16,185,129,0.10)", border: colors.success };
    case "album": return { label: "V albu", icon: "album" as const, color: colors.primary, bg: "rgba(0,217,236,0.12)", border: colors.primary };
    default: return { label: "Rozpracováno", icon: "edit-note" as const, color: colors.muted, bg: "rgba(148,163,184,0.10)", border: colors.muted };
  }
};

export default function TextsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, loading } = useAuth();
  const { album: albumParam } = useLocalSearchParams<{ album?: string | string[] }>();
  const albumFromQuery = firstQueryParam(albumParam);
  const [search, setSearch] = useState("");
  const [albumId, setAlbumId] = useState<string | null>(albumFromQuery);
  useEffect(() => { setAlbumId(albumFromQuery); }, [albumFromQuery]);
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "complete">("all");
  const [phaseFilter, setPhaseFilter] = useState<Phase | "all">("all");
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); Haptics.selectionAsync().catch(()=>{}); await snapshot.refetch(); setRefreshing(false); }, [snapshot]);

  const allDocuments = snapshot.data?.documents ?? [];
  const draftCount = allDocuments.filter((d) => d.status === "draft").length;
  const completeCount = allDocuments.filter((d) => d.status === "complete").length;
  // phase counts
  const phaseOf = (doc: any) => {
    const song = snapshot.data?.songs.find((s: any) => s.sourceDocumentId === doc.id);
    const hasMp3 = !!snapshot.data?.versions.find((v: any) => v.songId === song?.id);
    if ((song as any)?.isPublished) return "published" as Phase;
    if (hasMp3) return "mp3" as Phase;
    if (doc.albumId || (song as any)?.albumId) return "album" as Phase;
    return "draft" as Phase;
  };
  const records = useMemo(() => allDocuments.filter((d) => {
    const linkedSong = snapshot.data?.songs.find((song) => song.sourceDocumentId === d.id);
    const recordAlbumId = d.albumId ?? linkedSong?.albumId ?? null;
    if (albumId && recordAlbumId !== albumId) return false;
    if (statusFilter !== "all" && d.status !== statusFilter) return false;
    if (phaseFilter !== "all" && phaseOf(d) !== phaseFilter) return false;
    return `${d.title} ${d.lyrics ?? ""} ${d.stylePrompt ?? ""}`.toLowerCase().includes(search.toLowerCase());
  }), [albumId, search, statusFilter, phaseFilter, allDocuments, snapshot.data?.songs, snapshot.data?.versions]);

  if (loading || (isAuthenticated && snapshot.isLoading)) {
    return <ScreenContainer inset><View style={{ paddingTop: 14, gap: 12 }}><Shimmer height={36} radius={16} /><Shimmer height={48} radius={16} /><View style={{ gap: 10, marginTop: 12 }}>{[1,2,3].map(i=> <View key={i} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}><Shimmer width={60} height={60} radius={16} /><View style={{ flex:1, gap:8 }}><Shimmer height={14} width="60%" /><Shimmer height={12} width="80%" /></View></View>)}</View></View></ScreenContainer>;
  }
  if (!isAuthenticated) return <ScreenContainer centered><EmptyState icon="lock" title="Přihlášení je potřeba" text="Texty se ukládají do soukromého cloudového prostoru." action={<Pressable onPress={() => void startPrivateLogin()} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Přihlásit se</Text></Pressable>} /></ScreenContainer>;

  return (
    <ScreenContainer inset>
      <Animated.FlatList
        data={records}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />}
        ListHeaderComponent={<>
          <StudioHeader eyebrow="Kreativní dílna" title="Texty" action={<View style={styles.headerActions}><TextImporter /><Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(()=>{}); router.push("/text/new" as never); }} style={({ pressed }) => [{ transform: [{ scale: pressed ? 0.97 : 1 }] }]}><LinearGradient colors={[colors.primary, colors.primaryVibrant]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.fabGradient}><MaterialIcons name="add" size={22} color="#FFFFFF" /></LinearGradient></Pressable></View>} />
          <View style={[styles.search, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }]}>
            <MaterialIcons name="search" size={20} color={colors.muted} />
            <TextInput value={search} onChangeText={setSearch} placeholder="Hledat v názvech, textech a promptech" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} />
            {search.length>0 && <Pressable onPress={()=>setSearch("")} hitSlop={8} style={styles.searchClear}><MaterialIcons name="close" size={18} color={colors.muted} /></Pressable>}
          </View>
          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.muted }]}>STAV</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              <StatusFilterChip active={statusFilter==="all"} label={`Všechny (${allDocuments.length})`} onPress={()=>{Haptics.selectionAsync().catch(()=>{}); setStatusFilter("all");}} colors={colors} />
              <StatusFilterChip active={statusFilter==="draft"} label={`✎ Rozpracované (${draftCount})`} onPress={()=>{Haptics.selectionAsync().catch(()=>{}); setStatusFilter("draft");}} colors={colors} />
              <StatusFilterChip active={statusFilter==="complete"} label={`✓ Hotové (${completeCount})`} onPress={()=>{Haptics.selectionAsync().catch(()=>{}); setStatusFilter("complete");}} colors={colors} />
            </ScrollView>
          </View>
          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.muted }]}>FÁZE</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              <FilterChip active={phaseFilter==="all"} label="Vše" onPress={() => { Haptics.selectionAsync().catch(()=>{}); setPhaseFilter("all"); }} />
              <FilterChip active={phaseFilter==="draft"} label="Rozpracované" dotColor={colors.muted} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setPhaseFilter("draft"); }} />
              <FilterChip active={phaseFilter==="album"} label="V albu" dotColor={colors.primary} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setPhaseFilter("album"); }} />
              <FilterChip active={phaseFilter==="mp3"} label="S MP3" dotColor={colors.success} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setPhaseFilter("mp3"); }} />
              <FilterChip active={phaseFilter==="published"} label="Publikované" dotColor={colors.success} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setPhaseFilter("published"); }} />
            </ScrollView>
          </View>
          <View style={styles.filterGroup}>
            <Text style={[styles.filterLabel, { color: colors.muted }]}>ALBUM</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              <FilterChip active={!albumId} label="Všechna" onPress={() => { Haptics.selectionAsync().catch(()=>{}); setAlbumId(null); }} />
              {snapshot.data?.albums.map((album) => <FilterChip key={album.id} active={albumId===album.id} label={album.name} onPress={() => { Haptics.selectionAsync().catch(()=>{}); setAlbumId(album.id); }} />)}
            </ScrollView>
          </View>
          <View style={styles.countRow}>
            <Text style={[styles.countText, { color: colors.foreground }]}>{records.length} {records.length===1 ? "položka" : records.length<5 ? "položky" : "položek"}</Text>
            <Text style={[styles.countSub, { color: colors.muted }]}>tažením obnovíš</Text>
          </View>
        </>}
        renderItem={({ item, index }) => {
          const song = snapshot.data?.songs.find((s: any) => s.sourceDocumentId === item.id);
          const hasMp3 = !!snapshot.data?.versions.find((v: any) => v.songId === (song as any)?.id);
          const phase = (() => { if ((song as any)?.isPublished) return "published" as Phase; if (hasMp3) return "mp3" as Phase; if (item.albumId || (song as any)?.albumId) return "album" as Phase; return "draft" as Phase; })();
          const meta = phaseMeta(phase, colors);
          const album = snapshot.data?.albums.find((a) => a.id === (item.albumId || (song as any)?.albumId));
          return (
          <Animated.View entering={FadeInDown.delay(index*32).duration(360)} layout={Layout.springify()}>
            <Pressable onPress={() => { Haptics.selectionAsync().catch(()=>{}); router.push(`/text/${item.id}` as never); }} style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: meta.border, borderLeftWidth: 3, borderLeftColor: meta.border, shadowColor: "#000", shadowOpacity: pressed?0.2:0.12, shadowRadius: pressed?8:16, shadowOffset:{width:0,height:pressed?4:8}, elevation:6, opacity: pressed?0.96:1, transform:[{scale: pressed?0.98:1}] }]}>
              <View style={styles.coverStack}>
                <CoverArt uri={item.coverUrl} title={item.title} size={60} />
                {album?.coverUrl ? <View style={[styles.albumBadge, { borderColor: colors.background, backgroundColor: colors.surface }]}><CoverArt uri={album.coverUrl} title={album.name} size={26} /></View> : null}
              </View>
              <View style={styles.copy}>
                <View style={styles.copyTop}><Text numberOfLines={2} style={[styles.name, { color: colors.foreground }]}>{item.title}</Text><StatusChip state={item.status} /></View>
                <View style={styles.phaseRow}>
                  <View style={[styles.phaseChip, { backgroundColor: meta.bg, borderColor: `${meta.color}30` }]}><MaterialIcons name={meta.icon} size={12} color={meta.color} /><Text style={[styles.phaseText, { color: meta.color }]}>{meta.label}</Text></View>
                  {album ? <View style={[styles.phaseChip, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.08)" }]}><MaterialIcons name="album" size={11} color={colors.muted} /><Text style={[styles.phaseText, { color: colors.muted }]}>{album.name}</Text></View> : null}
                </View>
                <Text numberOfLines={2} style={[styles.details, { color: colors.muted }]}>{item.lyrics?.trim() ? item.lyrics.trim().replace(/\n+/g," · ") : "Zatím bez textu"}</Text>
                <Text style={[styles.date, { color: colors.muted }]}>Upraveno {formatDate(item.updatedAt)}</Text>
              </View>
              <View style={[styles.chevron, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.08)" }]}><MaterialIcons name="chevron-right" size={18} color={colors.muted} /></View>
            </Pressable>
          </Animated.View>
        )}}
        ListEmptyComponent={<EmptyState icon="description" title={search ? "Žádná shoda" : "Textová dílna je prázdná"} text={search ? "Zkus změnit hledaný výraz nebo filtr alba." : "Založ koncept. Prompt, text, poznámky a přebal zůstanou pohromadě."} />}
      />
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom+12, backgroundColor: colors.background, borderTopColor: "rgba(255,255,255,0.06)" }]}>
        <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(()=>{}); router.push("/text/new" as never); }} style={({ pressed }) => [styles.bottomCta, { transform:[{scale: pressed?0.97:1}] }]}>
          <LinearGradient colors={[colors.primary, colors.primaryVibrant]} start={{x:0,y:0}} end={{x:1,y:0}} style={StyleSheet.absoluteFill as any} />
          <MaterialIcons name="edit" size={19} color="#FFFFFF" />
          <Text style={styles.bottomCtaText}>Nový text</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}

function StatusFilterChip({ active, label, onPress, colors }: { active: boolean; label: string; onPress: () => void; colors: ReturnType<typeof useColors> }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.statusChip, { backgroundColor: active ? colors.primary : colors.surface, borderColor: active ? colors.primary : "rgba(255,255,255,0.08)", opacity: pressed?0.85:1, transform:[{scale: pressed?0.97:1}] }]}><Text style={[styles.statusChipText, { color: active ? "#FFFFFF" : colors.foreground }]}>{label}</Text></Pressable>;
}
const styles = StyleSheet.create({
  content: { paddingTop: 14 },
  headerActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  fabGradient: { width: 44, height: 44, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  search: { height: 48, borderRadius: Radius.md, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0, fontWeight: "500" },
  searchClear: { width: 32, height: 32, borderRadius: Radius.md, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.06)" },
  filterGroup: { marginTop: 16, gap: 8 },
  filterLabel: { ...Type.overline, letterSpacing: 1, marginLeft: 2 },
  filters: { paddingRight: 20, gap: 8, paddingVertical: 2 },
  filter: { height: 44, paddingHorizontal: 14, justifyContent: "center", borderWidth: 1, borderRadius: Radius.md, minWidth: 44, flexDirection: "row", alignItems: "center", gap: 6 },
  filterText: { ...Type.label, letterSpacing: -0.1 },
  statusChip: { height: 44, paddingHorizontal: 14, justifyContent: "center", borderWidth: 1, borderRadius: Radius.md },
  statusChipText: { fontSize: 12.5, fontWeight: "700" },
  countRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 20, marginBottom: 8, paddingHorizontal: 2 },
  countText: { ...Type.label, letterSpacing: -0.2 },
  countSub: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "500", opacity: 0.7 },
  row: { borderWidth: 1, borderRadius: Radius.lg, padding: 12, flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  coverStack: { width: 60, height: 60, alignItems: "center", justifyContent: "center" },
  albumBadge: { position: "absolute", bottom: -4, right: -6, width: 30, height: 30, borderRadius: Radius.sm, borderWidth: 2, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 4 },
  copyTop: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "space-between" },
  name: { flex: 1, fontSize: 15, fontWeight: "700", letterSpacing: -0.2, lineHeight: 19 },
  phaseRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  phaseChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, height: 20, borderRadius: Radius.sm, borderWidth: 1 },
  phaseText: { ...Type.overline, letterSpacing: 0.2 },
  details: { ...Type.caption, lineHeight: 16, opacity: 0.9 },
  date: { ...Type.caption, opacity: 0.7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  chevron: { width: 32, height: 32, borderRadius: Radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  login: { minHeight: 48, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  loginText: { color: "#FFFFFF", fontWeight: "700" },
  bottomBar: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingHorizontal: 20, paddingTop: 12, flexDirection: "row" },
  bottomCta: { flex: 1, height: 52, borderRadius: Radius.md, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  bottomCtaText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
});
