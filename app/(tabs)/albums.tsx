import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { CoverArt, EmptyState, IconButton, LoadingState, StudioHeader } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

export default function AlbumsScreen() {
  const colors = useColors();
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const createCoverGeneration = trpc.studio.createCoverGeneration.useMutation();
  const checkCoverGeneration = trpc.studio.checkCoverGeneration.useMutation();
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  if (loading || (isAuthenticated && snapshot.isLoading)) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (!isAuthenticated) return <ScreenContainer centered><EmptyState icon="lock" title="Alba jsou soukromá" text="Přihlas se a vytvoř své první album v cloudu." action={<Pressable onPress={() => void startPrivateLogin()} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Přihlásit se</Text></Pressable>} /></ScreenContainer>;

  const generateCover = async (albumId: string) => {
    setGeneratingId(albumId);
    try {
      const created = await createCoverGeneration.mutateAsync({ entityType: "album", entityId: albumId });
      for (let attempt = 0; attempt < 36; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const status = await checkCoverGeneration.mutateAsync({ entityType: "album", entityId: albumId, jobId: created.jobId });
        if (status.status === "completed") { await utils.studio.snapshot.invalidate(); await snapshot.refetch(); Alert.alert("Obal alba je připraven", "Nový obrázek byl uložen k albu a použije se i u skladeb bez vlastního obrázku."); return; }
        if (status.status === "failed") throw new Error(status.error);
      }
      Alert.alert("Obal je stále ve frontě", "Bezplatná AI má nyní delší frontu. Zkus generování za chvíli znovu.");
    } catch (error) { Alert.alert("Obal alba se nepodařilo vytvořit", error instanceof Error ? error.message : "Zkus to znovu za chvíli."); } finally { setGeneratingId(null); }
  };

  const albums = snapshot.data?.albums ?? [];
  return <ScreenContainer inset><FlatList data={albums} keyExtractor={(item) => String(item.id)} numColumns={2} columnWrapperStyle={albums.length ? styles.columns : undefined} showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} ListHeaderComponent={<StudioHeader eyebrow="Katalog projektu" title="Alba" action={<IconButton label="Nové album" icon="add" onPress={() => router.push("/album/new" as never)} />} />} renderItem={({ item }) => { const documents = snapshot.data?.documents.filter((document) => document.albumId === item.id).length ?? 0; const songs = snapshot.data?.songs.filter((song) => song.albumId === item.id).length ?? 0; return <Pressable onPress={() => router.push(`/(tabs)/texts?album=${item.id}` as never)} style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.72 : 1 }]}><CoverArt uri={item.coverUrl} title={item.name} size={130} /><Text numberOfLines={2} style={[styles.albumName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.albumMeta, { color: colors.muted }]}>{item.releaseYear ?? "bez roku"} · {documents} textů · {songs} skladeb</Text><View style={styles.cardFooter}><Pressable disabled={Boolean(generatingId)} onPress={() => void generateCover(item.id)} style={({ pressed }) => [styles.aiChip, { borderColor: `${colors.primary}88`, opacity: generatingId === item.id || pressed ? 0.6 : 1 }]}><MaterialIcons name={generatingId === item.id ? "hourglass-top" : "auto-awesome"} size={13} color={colors.primary} /><Text numberOfLines={1} style={[styles.aiChipText, { color: colors.primary }]}>{generatingId === item.id ? "AI tvoří…" : "AI obrázek"}</Text></Pressable><View style={styles.open}><Text style={[styles.openText, { color: colors.primary }]}>Otevřít</Text><MaterialIcons name="arrow-forward" size={15} color={colors.primary} /></View></View></Pressable>; }} ListEmptyComponent={<EmptyState icon="album" title="Zatím nemáš žádné album" text="Vytvoř album a uspořádej do něj koncepty, hotové skladby i přebaly." action={<Pressable onPress={() => router.push("/album/new" as never)} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Vytvořit album</Text></Pressable>} />} />
  </ScreenContainer>;
}
const styles = StyleSheet.create({ content: { paddingTop: 14, paddingBottom: 30 }, columns: { gap: 10, marginBottom: 10 }, card: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: Radius.lg, padding: 10, gap: 10 }, albumName: { fontSize: 15, lineHeight: 19, fontWeight: "800", minHeight: 38 }, albumMeta: { ...Type.caption, lineHeight: 15 }, open: { flexDirection: "row", gap: 4, alignItems: "center", marginLeft: "auto" }, openText: { ...Type.caption }, cardFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }, aiChip: { borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 8, height: 27, flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "60%" }, aiChipText: { fontSize: 10.5, fontWeight: "900" }, login: { minHeight: 48, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, loginText: { color: OnPrimary, fontWeight: "800" } });
