import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { getPlayableAudioUrl } from "@/lib/audio-source";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

export type PlayableVersion = {
  id: string;
  label: string;
  originalFileName: string;
  storageUrl: string;
  isPrimary: boolean;
  isFinal: boolean;
};

/**
 * Android nikdy nevytváří nativní audio zdroj při samotném otevření detailu.
 * Přehrávač se aktivuje až vědomým stiskem „Připravit poslech“.
 */
export function VersionAudioPlayer({ versions }: { versions: PlayableVersion[] }) {
  const colors = useColors();
  const [activated, setActivated] = useState(false);
  if (!versions.length) return null;
  if (activated) return <ActiveVersionAudioPlayer versions={versions} onDeactivate={() => setActivated(false)} />;

  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.titleRow}><View style={[styles.titleIcon, { backgroundColor: `${colors.primary}20` }]}><MaterialIcons name="headphones" size={19} color={colors.primary} /></View><View style={styles.titleCopy}><Text style={[styles.title, { color: colors.foreground }]}>Poslech a porovnání</Text><Text numberOfLines={2} style={[styles.subtitle, { color: colors.muted }]}>Přehrávač se načte až po stisku. Otevření nebo návrat ze skladby tím nemění nativní audio stav.</Text></View></View>
    <Pressable onPress={() => setActivated(true)} style={({ pressed }) => [styles.activate, { borderColor: colors.primary, backgroundColor: `${colors.primary}12`, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name="play-circle-outline" size={20} color={colors.primary} /><Text style={[styles.activateText, { color: colors.primary }]}>Připravit poslech MP3</Text></Pressable>
  </View>;
}

function ActiveVersionAudioPlayer({ versions, onDeactivate }: { versions: PlayableVersion[]; onDeactivate: () => void }) {
  const colors = useColors();
  const defaultVersion = useMemo(() => versions.find((entry) => entry.isFinal) ?? versions.find((entry) => entry.isPrimary) ?? versions[0], [versions]);
  const [activeId, setActiveId] = useState<string | null>(defaultVersion?.id ?? null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const activeVersion = versions.find((entry) => entry.id === activeId) ?? defaultVersion;
  const activeUrl = getPlayableAudioUrl(activeVersion?.storageUrl);
  const player = useAudioPlayer(null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    if (!versions.some((entry) => entry.id === activeId)) setActiveId(defaultVersion?.id ?? null);
  }, [activeId, defaultVersion?.id, versions]);
  useEffect(() => () => { try { player.pause(); } catch { /* Přehrávač může být při odchodu již uvolněný hookem. */ } }, [player]);

  if (!activeVersion) return null;
  const duration = Number.isFinite(status.duration) ? status.duration : 0;
  const currentTime = Math.min(Math.max(status.currentTime || 0, 0), duration || Number.MAX_SAFE_INTEGER);
  const progress = duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;
  const sourceReady = loadedUrl === activeUrl && !sourceError;

  const chooseVersion = (next: PlayableVersion) => {
    if (next.id === activeVersion.id) return;
    try { player.pause(); } catch { /* Neúspěšné zastavení nesmí blokovat volbu jiné verze. */ }
    setSourceError(null);
    setLoadedUrl(null);
    setActiveId(next.id);
  };
  const togglePlayback = async () => {
    if (!activeUrl) { setSourceError("Zvuková adresa této verze není dostupná. MP3 můžeš nahrát znovu."); return; }
    try {
      await setAudioModeAsync({ playsInSilentMode: true });
      if (loadedUrl !== activeUrl) {
        player.replace(activeUrl);
        setLoadedUrl(activeUrl);
        setSourceError(null);
      }
      if (status.playing) player.pause();
      else {
        if (duration > 0 && currentTime >= duration - 0.05) player.seekTo(0);
        player.play();
      }
    } catch {
      setSourceError("Zvuk se nepodařilo bezpečně načíst. Zkus MP3 nahrát znovu.");
      setLoadedUrl(null);
    }
  };
  const skip = (seconds: number) => { if (sourceReady) player.seekTo(Math.min(Math.max(currentTime + seconds, 0), duration || 0)); };

  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.titleRow}><View style={[styles.titleIcon, { backgroundColor: `${colors.primary}20` }]}><MaterialIcons name="headphones" size={19} color={colors.primary} /></View><View style={styles.titleCopy}><Text style={[styles.title, { color: colors.foreground }]}>Poslech a porovnání</Text><Text numberOfLines={1} style={[styles.subtitle, { color: colors.muted }]}>Přepnutím verze se předchozí poslech zastaví.</Text></View><Pressable onPress={onDeactivate} hitSlop={8}><MaterialIcons name="close" size={20} color={colors.muted} /></Pressable></View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.versions}>{versions.map((version) => { const active = version.id === activeVersion.id; return <Pressable key={version.id} onPress={() => chooseVersion(version)} style={({ pressed }) => [styles.versionChip, { backgroundColor: active ? colors.primary : colors.background, borderColor: active ? colors.primary : colors.border, opacity: pressed ? 0.68 : 1 }]}><MaterialIcons name={active && status.playing ? "graphic-eq" : version.isFinal ? "verified" : version.isPrimary ? "star" : "music-note"} size={15} color={active ? OnPrimary : colors.primary} /><Text numberOfLines={1} style={[styles.versionChipText, { color: active ? OnPrimary : colors.foreground }]}>{version.label}</Text></Pressable>; })}</ScrollView>
    <View style={[styles.nowPlaying, { backgroundColor: colors.background, borderColor: sourceError ? colors.error : colors.border }]}><View style={styles.nowCopy}><Text numberOfLines={1} style={[styles.nowLabel, { color: colors.foreground }]}>{activeVersion.label}</Text><Text numberOfLines={2} style={[styles.nowFile, { color: sourceError ? colors.error : colors.muted }]}>{sourceError ?? (status.isBuffering ? "Načítám zvuk…" : status.playing ? "Přehrává se" : sourceReady ? "Připraveno k poslechu" : "Přehrávání připravíš tlačítkem ▶")}</Text></View><View style={[styles.playState, { backgroundColor: status.playing ? `${colors.success}20` : `${colors.primary}18` }]}><MaterialIcons name={sourceError ? "error-outline" : status.playing ? "equalizer" : "play-arrow"} size={18} color={sourceError ? colors.error : status.playing ? colors.success : colors.primary} /></View></View>
    <View style={styles.timelineLabels}><Text style={[styles.time, { color: colors.muted }]}>{formatTime(currentTime)}</Text><Text style={[styles.time, { color: colors.muted }]}>{formatTime(duration)}</Text></View><View style={[styles.track, { backgroundColor: colors.border }]}><View style={[styles.trackProgress, { width: `${progress}%`, backgroundColor: colors.primary }]} /></View>
    <View style={styles.controls}><Pressable onPress={() => skip(-10)} disabled={!duration || !sourceReady} style={({ pressed }) => [styles.minorControl, { borderColor: colors.border, opacity: !duration || !sourceReady ? 0.38 : pressed ? 0.65 : 1 }]}><MaterialIcons name="replay-10" size={23} color={colors.foreground} /></Pressable><Pressable onPress={() => void togglePlayback()} disabled={!!sourceError} style={({ pressed }) => [styles.playControl, { backgroundColor: colors.primary, opacity: sourceError ? 0.38 : pressed ? 0.78 : 1 }]}><MaterialIcons name={status.playing ? "pause" : "play-arrow"} size={29} color={OnPrimary} /></Pressable><Pressable onPress={() => skip(10)} disabled={!duration || !sourceReady} style={({ pressed }) => [styles.minorControl, { borderColor: colors.border, opacity: !duration || !sourceReady ? 0.38 : pressed ? 0.65 : 1 }]}><MaterialIcons name="forward-10" size={23} color={colors.foreground} /></Pressable></View>
  </View>;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.lg, padding: 15, gap: 12 }, titleRow: { flexDirection: "row", alignItems: "center", gap: 9 }, titleIcon: { width: 34, height: 34, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, titleCopy: { flex: 1, gap: 2 }, title: { fontSize: 16, fontWeight: "800" }, subtitle: { ...Type.caption, lineHeight: 15 }, activate: { minHeight: 44, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }, activateText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, versions: { gap: 8, paddingRight: 4 }, versionChip: { maxWidth: 150, minHeight: 35, borderRadius: Radius.md, borderWidth: 1, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 5 }, versionChipText: { flexShrink: 1, fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "800" }, nowPlaying: { minHeight: 54, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 9 }, nowCopy: { flex: 1, gap: 2 }, nowLabel: { ...Type.label }, nowFile: { ...Type.caption, lineHeight: 15 }, playState: { width: 33, height: 33, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, timelineLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: -2 }, time: { ...Type.caption, fontVariant: ["tabular-nums"] }, track: { height: 5, borderRadius: 3, overflow: "hidden", marginTop: -7 }, trackProgress: { height: "100%", borderRadius: 3 }, controls: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 18 }, minorControl: { width: 46, height: 42, borderRadius: Radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center" }, playControl: { width: 54, height: 54, borderRadius: Radius.md, alignItems: "center", justifyContent: "center" },
});
