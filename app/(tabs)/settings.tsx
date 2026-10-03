import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as WebBrowser from "expo-web-browser";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useCallback, useEffect, useState } from "react";

import { BrandLockup } from "@/components/brand-mark";
import { EmptyState, LoadingState, SectionTitle, StudioHeader } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { getYoutubeChannelStatus, type YoutubeChannelStatus } from "@/lib/external-studio";
import { useColors } from "@/hooks/use-colors";
import { checkForUpdate, installUpdate, CURRENT_VERSION, type AppUpdate } from "@/lib/app-update";
import { downloadOrShareFile } from "@/lib/download-and-share";
import { createYouTubeAuthorizationUrl, YOUTUBE_OAUTH_REDIRECT_URL } from "@/lib/youtube-oauth";
import { trpc } from "@/lib/trpc";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

export default function SettingsScreen() {
  const colors = useColors();
  const { user, isAuthenticated, loading, logout } = useAuth();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const exportWholeLibrary = trpc.studio.exportWholeLibrary.useMutation();
  const exportLyricsTxt = trpc.studio.exportLyricsTxt.useMutation();
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [connectingYoutube, setConnectingYoutube] = useState(false);
  const [youtubeState, setYoutubeState] = useState<YoutubeChannelStatus | null>(null);

  const runUpdateCheck = async () => {
    setChecking(true);
    try {
      const found = await checkForUpdate({ force: true });
      setUpdate(found);
      if (!found) Alert.alert("Máš nejnovější verzi", `SCS2 ${CURRENT_VERSION} je aktuální.`);
    } catch (error) {
      Alert.alert("Kontrolu se nepodařilo dokončit", error instanceof Error ? error.message : "Zkontroluj připojení a zkus to znovu.");
    } finally {
      setChecking(false);
    }
  };
  const applyUpdate = async (target: AppUpdate) => {
    setInstalling(true);
    setUpdateProgress(0);
    try {
      await installUpdate(target, setUpdateProgress);
      Alert.alert("Dokonči instalaci", "V systémovém okně potvrď instalaci nové verze SCS2.");
    } catch (error) {
      Alert.alert("Aktualizace se nezdařila", error instanceof Error ? error.message : "Zkus to znovu.");
    } finally {
      setInstalling(false);
      setUpdateProgress(0);
    }
  };

  const refreshYoutubeState = useCallback(async () => {
    try {
      setYoutubeState(await getYoutubeChannelStatus());
    } catch (error) {
      setYoutubeState({ connected: false, checkFailed: true, message: error instanceof Error ? error.message : "Neznámá chyba." });
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    void refreshYoutubeState();
  }, [isAuthenticated, refreshYoutubeState]);

  const connectYoutube = async () => {
    setConnectingYoutube(true);
    try {
      const authorizationUrl = await createYouTubeAuthorizationUrl();
      const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, YOUTUBE_OAUTH_REDIRECT_URL);
      if (result.type === "success") Alert.alert("YouTube je připojený", "Kanál je nyní dostupný pro návrh a potvrzenou publikaci.");
    } catch (error) {
      Alert.alert("YouTube připojení selhalo", error instanceof Error ? error.message : "Zkus to znovu.");
    } finally {
      setConnectingYoutube(false);
    }
  };

  if (loading || (isAuthenticated && snapshot.isLoading)) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (!isAuthenticated) return <ScreenContainer centered><EmptyState icon="lock" title="Připoj své studio" text="Přihlášení vytváří soukromé úložiště pro tvé texty, přebaly a MP3." action={<Pressable onPress={() => void startPrivateLogin()} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Přihlásit se</Text></Pressable>} /></ScreenContainer>;

  const albums = snapshot.data?.albums ?? [];
  const versions = snapshot.data?.versions.length ?? 0;
  const exporting = exportWholeLibrary.isPending;
  const showLogout = () => Alert.alert("Odhlásit SCS2?", "Lokální obrazovka se odhlásí, data zůstanou bezpečně v cloudu.", [{ text: "Zrušit", style: "cancel" }, { text: "Odhlásit", style: "destructive", onPress: async () => { await logout(); } }]);
  const exportLibrary = async (album?: { id: string; name: string }) => {
    setExportStatus(album ? `Sbírám texty, obrázky a MP3 z alba „${album.name}“…` : "Sbírám texty, obrázky, MP3 a metadata z celé knihovny…");
    try {
      const archive = await exportWholeLibrary.mutateAsync(album ? { albumId: album.id } : {});
      setExportStatus("Archiv je připraven. Otevírám uložení do telefonu…");
      await downloadOrShareFile(archive.url, archive.fileName, "application/zip", album ? `Uložit album ${album.name}` : "Uložit kompletní archiv SCS2");
      Alert.alert("Export je připraven", album ? `Archiv alba „${album.name}“ je připravený k uložení.` : "Archiv obsahuje texty, prompty, alba, obrázky, MP3 i metadata.");
    } catch (error) {
      Alert.alert("Export se nezdařil", error instanceof Error ? error.message : "Zkus to znovu.");
    } finally {
      setExportStatus(null);
    }
  };

  return <ScreenContainer inset><ScrollView contentContainerStyle={styles.content}><StudioHeader eyebrow="Osobní pracovní prostor" title="Nastavení" />
    <View style={[styles.profile, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.avatar, { backgroundColor: `${colors.primary}26` }]}><Text style={[styles.avatarText, { color: colors.primary }]}>{(user?.name ?? "S").slice(0, 1).toUpperCase()}</Text></View><View style={styles.profileCopy}>{user?.name ? <Text style={[styles.profileName, { color: colors.foreground }]}>{user?.name}</Text> : <BrandLockup size={28} />}<Text numberOfLines={1} style={[styles.profileMail, { color: colors.muted }]}>{user?.email ?? "Soukromý cloudový účet"}</Text></View><MaterialIcons name="verified-user" size={22} color={colors.success} /></View>
    <SectionTitle title="Synchronizace" /><View style={[styles.syncCard, { backgroundColor: `${colors.success}15`, borderColor: `${colors.success}55` }]}><MaterialIcons name="cloud-done" size={25} color={colors.success} /><View style={styles.syncCopy}><Text style={[styles.syncTitle, { color: colors.foreground }]}>Cloudové studio je propojeno</Text><Text style={[styles.syncText, { color: colors.muted }]}>Obsah se načítá z tvého zabezpečeného prostoru. Soubory zůstávají oddělené od katalogu.</Text></View></View>
    <View style={styles.statRow}><Stat value={albums.length} label="alb" /><Stat value={snapshot.data?.documents.length ?? 0} label="textů" /><Stat value={versions} label="MP3 verzí" /></View>
    <SectionTitle title="YouTube kanál" />{youtubeState?.checkFailed ? <View style={[styles.youtubeConnect, { backgroundColor: `${colors.warning}12`, borderColor: `${colors.warning}55` }]}><View style={[styles.youtubeIcon, { backgroundColor: `${colors.warning}1C` }]}><MaterialIcons name="error-outline" size={21} color={colors.warning} /></View><View style={styles.youtubeCopy}><Text style={[styles.youtubeTitle, { color: colors.foreground }]}>Stav kanálu se nepodařilo ověřit</Text><Text style={[styles.youtubeText, { color: colors.muted }]}>{youtubeState.message ?? "Server neodpověděl."} Zkus to prosím znovu, nebo napiš do chatu.</Text></View><Pressable onPress={() => void refreshYoutubeState()} hitSlop={8}><MaterialIcons name="refresh" size={20} color={colors.warning} /></Pressable></View> : youtubeState?.connected ? <View style={[styles.youtubeConnect, { backgroundColor: `${colors.success}12`, borderColor: `${colors.success}45` }]}><View style={[styles.youtubeIcon, { backgroundColor: `${colors.success}1C` }]}><MaterialIcons name="check-circle" size={21} color={colors.success} /></View><View style={styles.youtubeCopy}><Text style={[styles.youtubeTitle, { color: colors.foreground }]}>{youtubeState.channelTitle ?? "YouTube kanál"}</Text><Text style={[styles.youtubeText, { color: colors.muted }]}>Připojeno. Nahrávání i publikace fungují, tokeny jsou na serveru.</Text></View></View> : <Pressable onPress={() => void connectYoutube()} disabled={connectingYoutube} style={({ pressed }) => [styles.youtubeConnect, { backgroundColor: `${colors.error}12`, borderColor: `${colors.error}45`, opacity: connectingYoutube || pressed ? 0.65 : 1 }]}><View style={[styles.youtubeIcon, { backgroundColor: `${colors.error}1C` }]}><MaterialIcons name="smart-display" size={21} color={colors.error} /></View><View style={styles.youtubeCopy}><Text style={[styles.youtubeTitle, { color: colors.foreground }]}>Připojit YouTube OAuth</Text><Text style={[styles.youtubeText, { color: colors.muted }]}>Když Google přesměruje jinam, musí být u klíče 77741409309 v Google Cloud zapsaná tato adresa: {YOUTUBE_REDIRECT}</Text></View>{connectingYoutube ? <ActivityIndicator size="small" color={colors.error} /> : <MaterialIcons name="chevron-right" size={20} color={colors.muted} />}</Pressable>}
    <SectionTitle title="Kompletní záloha" /><Pressable onPress={() => void exportLibrary()} style={({ pressed }) => [styles.libraryExport, { backgroundColor: colors.primary, opacity: exporting || pressed ? 0.68 : 1 }]} disabled={exporting}><MaterialIcons name="archive" size={21} color={OnPrimary} /><View style={styles.libraryExportCopy}><Text style={styles.libraryExportTitle}>{exporting ? "Vytvářím archiv…" : "Exportovat celou knihovnu"}</Text><Text style={styles.libraryExportText}>Texty, prompty, alba, obrázky, MP3 i metadata v jednom ZIP souboru.</Text></View></Pressable>
    {exportStatus ? <View style={[styles.exportProgress, { backgroundColor: `${colors.primary}16`, borderColor: `${colors.primary}4A` }]}><ActivityIndicator size="small" color={colors.primary} /><Text style={[styles.exportProgressText, { color: colors.foreground }]}>{exportStatus}</Text></View> : null}
    <SectionTitle title="Zálohy jednotlivých alb" />{albums.length ? albums.map((album) => <Pressable key={album.id} disabled={exporting} onPress={() => void exportLibrary(album)} style={({ pressed }) => [styles.albumExport, { backgroundColor: colors.surface, borderColor: colors.border, opacity: exporting || pressed ? 0.65 : 1 }]}><View style={[styles.albumExportIcon, { backgroundColor: `${colors.primary}1C` }]}><MaterialIcons name="folder-zip" size={21} color={colors.primary} /></View><View style={styles.albumExportCopy}><Text numberOfLines={1} style={[styles.albumExportTitle, { color: colors.foreground }]}>{album.name}</Text><Text style={[styles.albumExportText, { color: colors.muted }]}>Exportovat toto album samostatně</Text></View><MaterialIcons name="download" size={20} color={colors.primary} /></Pressable>) : <Text style={[styles.emptyAlbumNote, { color: colors.muted }]}>Založ album, aby šlo stáhnout samostatnou zálohu.</Text>}
    <SectionTitle title="Jak systém pracuje" /><Info icon="edit-note" title="Koncept → skladba" text="Označením textu jako hotového zůstane koncept zachován a vznikne samostatná katalogová položka." /><Info icon="content-copy" title="Bezpečná práce s MP3" text="Při exportu ID3 tagů vzniká nová kopie. Původně nahraná verze se nikdy nepřepisuje." /><Info icon="storage" title="Rozdělené uložení" text="Texty a vazby alb jsou v databázi; přebaly a MP3 jsou v souborovém úložišti." />
    <SectionTitle title="Aplikace" /><View style={{ borderWidth: 1, borderRadius: Radius.lg, padding: 14, gap: 11, backgroundColor: colors.surface, borderColor: colors.border }}><BrandLockup size={28} /><View style={{ flexDirection: "row", alignItems: "center", gap: 11 }}><View style={{ width: 42, height: 42, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: `${colors.primary}1C` }}><MaterialIcons name="system-update" size={22} color={colors.primary} /></View><View style={{ flex: 1, gap: 3 }}><Text style={{ fontSize: 15, fontWeight: "800", color: colors.foreground }}>Verze {CURRENT_VERSION}</Text><Text style={{ ...Type.caption, lineHeight: 17, color: colors.muted }}>{update ? `Je dostupná nová verze ${update.version}.` : "Zkontroluj, jestli máš nejnovější sestavení."}</Text></View></View>{installing ? <View style={{ gap: 7 }}><View style={{ height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: `${colors.primary}1F` }}><View style={{ height: "100%", width: `${Math.round(updateProgress * 100)}%`, backgroundColor: colors.primary }} /></View><Text style={{ ...Type.caption, color: colors.muted }}>Stahuji aktualizaci… {Math.round(updateProgress * 100)} %</Text></View> : update ? <Pressable onPress={() => void applyUpdate(update)} style={({ pressed }) => [{ minHeight: 46, borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.primary, transform: [{ scale: pressed ? 0.97 : 1 }], opacity: pressed ? 0.9 : 1 }]}><MaterialIcons name="download" size={18} color={OnPrimary} /><Text style={{ color: OnPrimary, fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }}>Aktualizovat na {update.version}</Text></Pressable> : <Pressable onPress={() => void runUpdateCheck()} disabled={checking} style={({ pressed }) => [{ minHeight: 46, borderRadius: Radius.sm, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderColor: colors.border, opacity: checking || pressed ? 0.65 : 1 }]}>{checking ? <ActivityIndicator size="small" color={colors.primary} /> : <MaterialIcons name="refresh" size={18} color={colors.foreground} />}<Text style={{ color: colors.foreground, fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }}>{checking ? "Kontroluji…" : "Zkontrolovat aktualizace"}</Text></Pressable>}</View>
    <Pressable onPress={showLogout} style={({ pressed }) => [styles.logout, { borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name="logout" size={20} color={colors.error} /><Text style={[styles.logoutText, { color: colors.error }]}>Odhlásit se</Text></Pressable>
  </ScrollView></ScreenContainer>;
}

const YOUTUBE_REDIRECT = "https://gpgbgjxeybfncrexrpbr.supabase.co/functions/v1/youtube-oauth-callback";

function Stat({ value, label }: { value: number; label: string }) { const colors = useColors(); return <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.statValue, { color: colors.foreground }]}>{value}</Text><Text style={[styles.statLabel, { color: colors.muted }]}>{label}</Text></View>; }
function Info({ icon, title, text }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; title: string; text: string }) { const colors = useColors(); return <View style={styles.info}><View style={[styles.infoIcon, { backgroundColor: `${colors.primary}1C` }]}><MaterialIcons name={icon} size={20} color={colors.primary} /></View><View style={styles.infoCopy}><Text style={[styles.infoTitle, { color: colors.foreground }]}>{title}</Text><Text style={[styles.infoText, { color: colors.muted }]}>{text}</Text></View></View>; }
const styles = StyleSheet.create({ content: { paddingTop: 14, paddingBottom: 33 }, profile: { borderWidth: 1, borderRadius: Radius.lg, padding: 15, flexDirection: "row", alignItems: "center", gap: 12 }, avatar: { width: 45, height: 45, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, avatarText: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900" }, profileCopy: { flex: 1, gap: 3 }, profileName: { fontSize: 15, fontWeight: "800" }, profileMail: { ...Type.caption }, syncCard: { borderWidth: 1, padding: 15, borderRadius: Radius.lg, flexDirection: "row", gap: 11 }, syncCopy: { flex: 1, gap: 3 }, syncTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, syncText: { ...Type.caption, lineHeight: 17 }, youtubeConnect: { minHeight: 68, borderWidth: 1, borderRadius: Radius.md, padding: 12, flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 }, youtubeIcon: { width: 40, height: 40, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, youtubeCopy: { flex: 1, gap: 3 }, youtubeTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, youtubeText: { ...Type.caption, lineHeight: 15 }, statRow: { flexDirection: "row", gap: 9, marginTop: 10 }, stat: { flex: 1, minHeight: 68, borderWidth: 1, borderRadius: Radius.md, padding: 10, justifyContent: "center" }, statValue: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900" }, statLabel: { ...Type.caption }, libraryExport: { minHeight: 76, borderRadius: Radius.md, padding: 14, flexDirection: "row", alignItems: "center", gap: 11 }, libraryExportCopy: { flex: 1, gap: 3 }, libraryExportTitle: { color: OnPrimary, fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, libraryExportText: { color: OnPrimary, ...Type.caption, lineHeight: 15 }, exportProgress: { borderWidth: 1, borderRadius: Radius.sm, padding: 12, marginTop: 10, flexDirection: "row", alignItems: "center", gap: 10 }, exportProgressText: { flex: 1, ...Type.caption }, albumExport: { minHeight: 64, borderWidth: 1, borderRadius: Radius.md, padding: 11, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 }, albumExportIcon: { width: 38, height: 38, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, albumExportCopy: { flex: 1, gap: 3 }, albumExportTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, albumExportText: { ...Type.caption }, emptyAlbumNote: { ...Type.caption, lineHeight: 17, marginBottom: 10 }, info: { flexDirection: "row", gap: 11, marginBottom: 16 }, infoIcon: { width: 39, height: 39, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, infoCopy: { flex: 1, gap: 3 }, infoTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, infoText: { ...Type.caption, lineHeight: 17 }, logout: { marginTop: 15, height: 50, borderRadius: Radius.sm, borderWidth: 1, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }, logoutText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, login: { minHeight: 48, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, loginText: { color: OnPrimary, fontWeight: "800" } });
