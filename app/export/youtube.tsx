import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { CoverArt, EmptyState, IconButton, LoadingState, PrimaryButton } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { downloadOrShareFile, saveFinishedVideoToDownloads, saveFinishedMp3 } from "@/lib/download-and-share";
import { type ExternalVideoMode } from "@/lib/external-studio";
import { trpc } from "@/lib/trpc";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const MODE_OPTIONS: Array<{ value: ExternalVideoMode; label: string; detail: string }> = [
  { value: "static_cover", label: "Statický obal", detail: "Rychlý 16:9 MP4 s finálním MP3" },
  { value: "image_animation", label: "Animace obalu", detail: "Oracle dashboard s pohybem artworku" },
  { value: "full_scenes", label: "Plné scény", detail: "Storyboardová videoscéna podle textu" },
];

export default function YouTubeExportScreen() {
  const colors = useColors();
  const { isAuthenticated } = useAuth();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const createVideo = trpc.studio.createYoutubeVideo.useMutation();
  const checkVideo = trpc.studio.checkYoutubeVideo.useMutation();
  const [exportingSongId, setExportingSongId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [mode, setMode] = useState<ExternalVideoMode>("image_animation");
  const finalSongs = useMemo(() => {
    const songs = snapshot.data?.songs ?? [];
    const versions = snapshot.data?.versions ?? [];
    const albums = snapshot.data?.albums ?? [];
    return songs.flatMap((song) => {
      const version = versions.find((entry) => entry.songId === song.id && entry.isFinal);
      return version ? [{ song, version, album: albums.find((entry) => entry.id === song.albumId) }] : [];
    });
  }, [snapshot.data]);
  const copyTitle = async (title: string) => { await Clipboard.setStringAsync(`Temney – ${title}`); };
  const saveVideo = async (url: string, title: string) => {
    const fileName = `${title.replace(/[^a-z0-9_-]/gi, "_")}-Temney-YouTube-1080p.mp4`;
    const saved = await saveFinishedVideoToDownloads(url, fileName);
    if (saved) {
      Alert.alert("Video je hotové", "Full HD MP4 je uložený ve složce Download / SongCraft Studio a můžeš ho samostatně nahrát na YouTube.");
      return;
    }
    await downloadOrShareFile(url, fileName, "video/mp4", "Uložit nebo sdílet hotové YouTube video");
    Alert.alert("Video je hotové", "Full HD MP4 má cover a název skladby. Můžeš ho uložit do telefonu a samostatně nahrát na YouTube.");
  };
  const exportYoutubeVideo = async (songId: string, versionId: string, title: string) => {
    setExportingSongId(songId);
    setProgress("Odesílám cover a finální MP3 do cloudového rendereru…");
    try {
      const initial = await createVideo.mutateAsync({ songId, versionId, mode });
      if (initial.status === "failed") throw new Error(initial.error);
      if (initial.status === "completed") { await saveVideo(initial.url, title); return; }
      if (!initial.jobId) throw new Error("Renderer nevrátil ID úlohy.");
      let jobId = initial.jobId;
      for (let attempt = 0; attempt < 72; attempt += 1) {
        setProgress(`Cloudový renderer vytváří MP4 (${attempt + 1}/72)…`);
        await wait(5000);
        const result = await checkVideo.mutateAsync({ songId, versionId, jobId });
        if (result.status === "completed") { await saveVideo(result.url, title); return; }
        if (result.status === "failed") throw new Error(result.error);
        jobId = result.jobId ?? jobId;
      }
      throw new Error("Cloudový renderer zatím video nedokončil. Zkus export spustit znovu za chvíli.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Video se nepodařilo vytvořit.";
      const limited = /429|limit|quota|rate/i.test(message);
      Alert.alert(limited ? "Volná kapacita rendereru je vyčerpaná" : "YouTube video se nepodařilo vytvořit", limited ? "Bezplatný cloudový renderer má omezený počet renderů. Zkus to později nebo v dalším měsíčním období." : message);
    } finally { setExportingSongId(null); setProgress(null); }
  };
  if (snapshot.isLoading) return <ScreenContainer><LoadingState label="Připravuji YouTube export…" /></ScreenContainer>;
  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><ScrollView contentContainerStyle={styles.content}><View style={styles.topbar}><IconButton label="Zpět" icon="arrow-back" onPress={() => router.back()} /><Text style={[styles.title, { color: colors.foreground }]}>YouTube export</Text><View style={styles.topbarSpace} /></View><View style={[styles.intro, { backgroundColor: `${colors.success}15`, borderColor: `${colors.success}45` }]}><MaterialIcons name="verified" size={22} color={colors.success} /><View style={styles.introCopy}><Text style={[styles.introTitle, { color: colors.foreground }]}>Finální skladby připravené k publikaci</Text><Text style={[styles.introText, { color: colors.muted }]}>Hotové Full HD MP4 se automaticky uloží do složky Download / SongCraft Studio.</Text></View></View><View style={[styles.effectCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="auto-fix-high" size={19} color={colors.primary} /><View style={styles.effectCopy}><Text style={[styles.effectTitle, { color: colors.foreground }]}>Režim videa</Text><Text style={[styles.effectHint, { color: colors.muted }]}>Vyber statický obal, animaci artworku nebo plnou storyboardovou scénu.</Text></View></View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.effectRow}>{MODE_OPTIONS.map((option) => <Pressable key={option.value} onPress={() => setMode(option.value)} style={({ pressed }) => [styles.effectChip, { backgroundColor: mode === option.value ? colors.primary : colors.surface, borderColor: mode === option.value ? colors.primary : colors.border, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name={mode === option.value ? "check-circle" : "radio-button-unchecked"} size={14} color={mode === option.value ? OnPrimary : colors.muted} /><View style={styles.modeChipCopy}><Text numberOfLines={1} style={[styles.effectChipText, { color: mode === option.value ? OnPrimary : colors.foreground }]}>{option.label}</Text><Text numberOfLines={1} style={[styles.modeChipDetail, { color: mode === option.value ? OnPrimary : colors.muted }]}>{option.detail}</Text></View></Pressable>)}</ScrollView>{progress ? <View style={[styles.progress, { backgroundColor: `${colors.primary}15`, borderColor: `${colors.primary}45` }]}><MaterialIcons name="hourglass-top" size={18} color={colors.primary} /><Text style={[styles.progressText, { color: colors.foreground }]}>{progress}</Text></View> : null}{finalSongs.length ? finalSongs.map(({ song, version, album }) => { const cover = song.coverUrl ?? album?.coverUrl; const exporting = exportingSongId === song.id; return <View key={song.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.cardHead}><CoverArt uri={cover} title={song.title} size={64} /><View style={styles.cardCopy}><Text numberOfLines={1} style={[styles.songTitle, { color: colors.foreground }]}>{song.title}</Text><Text numberOfLines={1} style={[styles.meta, { color: colors.muted }]}>{album?.name ?? "Singl"} · {version.label}</Text><Text style={[styles.ready, { color: colors.success }]}>Finální MP3 připravena</Text></View></View><View style={styles.checks}><Check ok label="Finální MP3 s ID3 tagy" colors={colors} /><Check ok={Boolean(cover)} label="Obrázek pro video" colors={colors} /><Check ok label="Full HD 1080p MP4: cover + hudba + waveform (bez textových popisků)" colors={colors} /></View><View style={styles.actions}>{cover ? <Pressable disabled={Boolean(exportingSongId)} onPress={() => void exportYoutubeVideo(song.id, version.id, song.title)} style={({ pressed }) => [styles.video, { backgroundColor: colors.success, opacity: exporting || pressed || Boolean(exportingSongId) ? 0.62 : 1 }]}><MaterialIcons name={exporting ? "hourglass-top" : "movie-creation"} size={19} color={OnPrimary} /><Text style={styles.videoText}>{exporting ? "Vytvářím Full HD MP4…" : "Vytvořit YouTube video"}</Text></Pressable> : null}<Pressable onPress={() => void saveFinishedMp3(version.taggedStorageUrl ?? version.storageUrl, version.originalFileName)} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name="download" size={18} color={OnPrimary} /><Text style={styles.primaryText}>Uložit MP3 do telefonu</Text></Pressable><Pressable onPress={() => void copyTitle(song.title)} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name="content-copy" size={17} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.primary }]}>Kopírovat název</Text></Pressable>{cover ? <Pressable onPress={() => void downloadOrShareFile(cover, `${song.title}-obal.jpg`, "image/jpeg", "Uložit nebo sdílet obrázek skladby")} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name="image" size={17} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.primary }]}>Uložit obrázek</Text></Pressable> : null}</View></View>; }) : <EmptyState icon="video-library" title="Zatím nemáš finální skladby" text="V detailu skladby označ nejlepší MP3 verzi jako finální. Tady pak vytvoříš Full HD MP4 z coveru a skladby." action={<PrimaryButton label="Do knihovny" icon="library-music" onPress={() => router.replace("/(tabs)/library" as never)} />} />}</ScrollView></ScreenContainer>;
}

function Check({ ok, label, colors }: { ok: boolean; label: string; colors: ReturnType<typeof useColors> }) { return <View style={styles.check}><MaterialIcons name={ok ? "check-circle" : "radio-button-unchecked"} size={15} color={ok ? colors.success : colors.muted} /><Text style={[styles.checkText, { color: ok ? colors.foreground : colors.muted }]}>{label}</Text></View>; }

const styles = StyleSheet.create({ content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 15 }, topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, title: { fontSize: 16, fontWeight: "900" }, topbarSpace: { width: 44 }, intro: { borderWidth: 1, borderRadius: Radius.md, padding: 14, flexDirection: "row", gap: 10 }, introCopy: { flex: 1, gap: 3 }, introTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, introText: { ...Type.caption, lineHeight: 17 }, effectCard: { borderWidth: 1, borderRadius: Radius.md, padding: 12, flexDirection: "row", gap: 9, alignItems: "center" }, effectCopy: { flex: 1, gap: 2 }, effectTitle: { fontSize: 13.5, fontWeight: "900" }, effectHint: { fontSize: 11.5, lineHeight: 15 }, effectRow: { gap: 8, paddingRight: 20 }, effectChip: { borderWidth: 1, borderRadius: Radius.md, minHeight: 48, paddingHorizontal: 13, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 5 }, effectChipText: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "800" }, modeChipCopy: { gap: 1 }, modeChipDetail: { fontSize: 9, lineHeight: 12 }, progress: { borderWidth: 1, borderRadius: Radius.sm, padding: 11, flexDirection: "row", alignItems: "center", gap: 8 }, progressText: { flex: 1, ...Type.caption }, card: { borderWidth: 1, borderRadius: Radius.lg, padding: 13, gap: 13 }, cardHead: { flexDirection: "row", gap: 11 }, cardCopy: { flex: 1, gap: 4 }, songTitle: { fontSize: 16, fontWeight: "900" }, meta: { ...Type.caption }, ready: { ...Type.caption }, checks: { gap: 5 }, check: { flexDirection: "row", gap: 6, alignItems: "center" }, checkText: { ...Type.caption }, actions: { gap: 8 }, video: { height: 48, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }, videoText: { color: OnPrimary, ...Type. label, fontWeight: "900" }, primary: { height: 44, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, primaryText: { color: OnPrimary, ...Type. label, fontWeight: "900" }, secondary: { height: 42, borderWidth: 1, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, secondaryText: { ...Type. caption, fontWeight: "800" } });
