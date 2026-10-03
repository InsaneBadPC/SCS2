import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useCallback, useMemo, type ComponentProps } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { CoverArt, EmptyState, LoadingState, PrimaryButton, SectionTitle, StatusChip, StudioHeader, formatDate } from "@/components/studio-ui";
import { VideoJobsCard } from "@/components/video-jobs-card";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { Radius, Type } from "@/lib/design-tokens";

export default function HomeScreen() {
  const colors = useColors();
  const { isAuthenticated, loading } = useAuth();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });

  const onRefresh = useCallback(() => {
    void snapshot.refetch();
  }, [snapshot]);

  const data = snapshot.data;
  const drafts = useMemo(() => data?.documents.filter((document) => document.status === "draft") ?? [], [data?.documents]);
  const recent = useMemo(() => data?.documents.slice(0, 4) ?? [], [data?.documents]);
  const songs = data?.songs ?? [];
  const versions = data?.versions ?? [];
  const albums = data?.albums ?? [];
  const missingCoverCount = songs.filter((song) => {
    const album = albums.find((entry) => entry.id === song.albumId);
    return !song.coverUrl && !album?.coverUrl;
  }).length;
  const awaitingFinalCount = songs.filter((song) => !versions.some((version) => version.songId === song.id && version.isFinal)).length;
  const publishedCount = songs.filter((song) => song.isPublished).length;
  const nextDraft = drafts[0];

  if (loading || (isAuthenticated && snapshot.isLoading)) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (!isAuthenticated) {
    return <ScreenContainer centered>
      <EmptyState icon="lock" title="Tvoje studio je soukromé" text="Přihlas se a pokračuj v textech, obalech a verzích skladeb." action={<PrimaryButton label="Přihlásit se" icon="login" onPress={() => void startPrivateLogin()} />} />
    </ScreenContainer>;
  }

  if (snapshot.isError) {
    return <ScreenContainer centered>
      <EmptyState icon="cloud-off" title="Studio se nepodařilo načíst" text={snapshot.error instanceof Error ? snapshot.error.message : "Zkontroluj připojení a zkus synchronizaci zopakovat."} action={<PrimaryButton label="Zkusit znovu" icon="refresh" onPress={onRefresh} />} />
    </ScreenContainer>;
  }

  return <ScreenContainer inset>
    <FlatList
      data={recent}
      keyExtractor={(item) => String(item.id)}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.content}
      refreshing={snapshot.isFetching}
      onRefresh={onRefresh}
      ListHeaderComponent={<>
        <View style={styles.topRow}>
          <StudioHeader eyebrow="Tvůj hudební workspace" title="Přehled" />
          <Pressable accessibilityRole="button" accessibilityLabel="Synchronizovat studio" onPress={onRefresh} style={({ pressed }) => [styles.syncButton, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed || snapshot.isFetching ? 0.65 : 1 }]}>
            <MaterialIcons name={snapshot.isFetching ? "sync" : "cloud-done"} size={19} color={snapshot.isFetching ? colors.warning : colors.success} />
          </Pressable>
        </View>

        <View style={styles.syncLine}><View style={[styles.syncDot, { backgroundColor: snapshot.isFetching ? colors.warning : colors.success }]} /><Text style={[styles.syncText, { color: colors.muted }]}>{snapshot.isFetching ? "Synchronizuji změny…" : "Synchronizováno s bezpečným cloudem"}</Text></View>

        <View style={[styles.hero, { backgroundColor: colors.surface, borderColor: `${colors.primary}55` }]}>
          <View style={styles.heroCopy}>
            <Text style={[styles.eyebrow, { color: colors.primary }]}>DALŠÍ KROK</Text>
            <Text style={[styles.heroTitle, { color: colors.foreground }]}>{nextDraft ? `Pokračovat u „${nextDraft.title}“` : "Založit další píseň"}</Text>
            <Text style={[styles.heroText, { color: colors.muted }]}>{nextDraft ? "Tvůj koncept čeká na dokončení. Všechno ostatní je bezpečně uložené." : "Vytvoř text, přidej styl a později k němu připoj finální MP3."}</Text>
          </View>
          <View style={styles.heroActions}>
            <PrimaryButton label={nextDraft ? "Pokračovat" : "Nová skladba"} icon={nextDraft ? "edit" : "add"} onPress={() => router.push((nextDraft ? `/text/${nextDraft.id}` : "/song/new") as never)} />
            <Pressable accessibilityRole="button" onPress={() => router.push("/text/new" as never)} style={({ pressed }) => [styles.secondaryAction, { borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name="description" size={17} color={colors.foreground} /><Text style={[styles.secondaryActionText, { color: colors.foreground }]}>Nový text</Text></Pressable>
          </View>
        </View>

        <View style={styles.quickActions}>
          <QuickAction icon="library-music" label="Knihovna" detail={`${songs.length} skladeb`} onPress={() => router.push("/(tabs)/library" as never)} colors={colors} />
          <QuickAction icon="auto-awesome" label="AI asistent" detail="Nápady a metadata" onPress={() => router.push("/(tabs)/assistant" as never)} colors={colors} />
          <QuickAction icon="album" label="Alba" detail={`${albums.length} alb`} onPress={() => router.push("/(tabs)/albums" as never)} colors={colors} />
        </View>

        <SectionTitle title="Co potřebuje pozornost" />
        <View style={styles.attentionGrid}>
          <AttentionCard icon="edit-note" value={drafts.length} label="Rozpracované texty" color={colors.primary} onPress={() => router.push("/(tabs)/texts" as never)} />
          <AttentionCard icon="image" value={missingCoverCount} label="Bez obalu" color={colors.warning} onPress={() => router.push("/(tabs)/library" as never)} />
          <AttentionCard icon="music-note" value={awaitingFinalCount} label="Bez finální MP3" color={colors.foreground} onPress={() => router.push("/(tabs)/library" as never)} />
          <AttentionCard icon="public" value={publishedCount} label="Publikované" color={colors.success} onPress={() => router.push("/(tabs)/library" as never)} />
        </View>
        <VideoJobsCard />

        <SectionTitle title="Poslední práce" right={<Pressable onPress={() => router.push("/(tabs)/texts" as never)}><Text style={[styles.link, { color: colors.primary }]}>Všechny texty</Text></Pressable>} />
      </>}
      renderItem={({ item }) => {
        const album = albums.find((entry) => entry.id === item.albumId);
        return <Pressable accessibilityRole="button" onPress={() => router.push(`/text/${item.id}` as never)} style={({ pressed }) => [styles.documentRow, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
          <CoverArt uri={item.coverUrl ?? album?.coverUrl} title={item.title} size={54} />
          <View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, { color: colors.foreground }]}>{item.title}</Text><Text numberOfLines={1} style={[styles.rowMeta, { color: colors.muted }]}>{album?.name ?? "Bez alba"} · {formatDate(item.updatedAt)}</Text></View>
          <StatusChip state={item.status} />
          <MaterialIcons name="chevron-right" size={19} color={colors.muted} />
        </Pressable>;
      }}
      ListEmptyComponent={<EmptyState icon="edit-note" title="Zatím tu nejsou žádné texty" text="Začni prvním konceptem. Můžeš přidat prompt, text písně, poznámky i obal." action={<PrimaryButton label="Vytvořit první text" icon="add" onPress={() => router.push("/text/new" as never)} />} />}
    />
  </ScreenContainer>;
}

function QuickAction({ icon, label, detail, onPress, colors }: { icon: ComponentProps<typeof MaterialIcons>["name"]; label: string; detail: string; onPress: () => void; colors: ReturnType<typeof useColors> }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.quickAction, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name={icon} size={20} color={colors.primary} /><Text style={[styles.quickLabel, { color: colors.foreground }]}>{label}</Text><Text style={[styles.quickDetail, { color: colors.muted }]}>{detail}</Text></Pressable>;
}

function AttentionCard({ icon, value, label, color, onPress }: { icon: ComponentProps<typeof MaterialIcons>["name"]; value: number; label: string; color: string; onPress: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.attentionCard, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name={icon} size={18} color={color} /><Text style={[styles.attentionValue, { color }]}>{value}</Text><Text style={[styles.attentionLabel, { color: colors.muted }]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  content: { paddingTop: 14, paddingBottom: 36, gap: 12 },
  topRow: { flexDirection: "row", alignItems: "flex-start" },
  syncButton: { width: 44, height: 44, borderRadius: Radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 5, marginLeft: 8 },
  syncLine: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: -4, marginBottom: 2 },
  syncDot: { width: 7, height: 7, borderRadius: 4 },
  syncText: { ...Type.caption },
  hero: { borderWidth: 1, borderRadius: Radius.xl, padding: 20, gap: 18, marginTop: 2 },
  heroCopy: { gap: 7 },
  eyebrow: { fontSize: Type.overline.fontSize, lineHeight: Type.overline.lineHeight, fontWeight: "900", letterSpacing: 1.1 },
  heroTitle: { ...Type.title, lineHeight: 28, fontWeight: "900" },
  heroText: { ...Type.label, lineHeight: 20 },
  heroActions: { gap: 9 },
  secondaryAction: { minHeight: 44, borderRadius: Radius.sm, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  secondaryActionText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" },
  quickActions: { flexDirection: "row", gap: 8, marginTop: 2 },
  quickAction: { flex: 1, minHeight: 82, borderRadius: Radius.md, borderWidth: 1, padding: 11, gap: 4 },
  quickLabel: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "800" },
  quickDetail: { ...Type.overline, lineHeight: 14 },
  attentionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  attentionCard: { width: "48.5%", minHeight: 88, borderRadius: Radius.md, borderWidth: 1, padding: 12, gap: 4 },
  attentionValue: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900" },
  attentionLabel: { ...Type.caption },
  documentRow: { minHeight: 72, borderRadius: Radius.md, borderWidth: 1, padding: 10, flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 2 },
  rowCopy: { flex: 1, gap: 4 },
  rowTitle: { fontSize: 15, fontWeight: "800" },
  rowMeta: { ...Type.caption, lineHeight: 15 },
  link: { ...Type.label },
});
