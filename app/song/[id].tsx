import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { CoverArt, EmptyState, Field, IconButton, LoadingState, PrimaryButton, RatingStars, SectionTitle, formatFileSize } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { VersionAudioPlayer } from "@/components/version-audio-player";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { assetToArrayBuffer } from "@/lib/file-base64";
import { saveFinishedMp3 } from "@/lib/download-and-share";
import { trpc } from "@/lib/trpc";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

export default function SongDetailScreen() {
  const colors = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const songId = id;
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionOrder, setVersionOrder] = useState<"rating" | "newest">("rating");
  const [pendingMp3, setPendingMp3] = useState<{ uri: string; name: string; mimeType?: string | null; base64?: string | null } | null>(null);
  const [youtubeEditor, setYoutubeEditor] = useState<null | { field: "description" | "tags"; autoGenerate?: boolean }>(null);
  const upload = trpc.studio.upload.useMutation();
  const createVersion = trpc.studio.createVersion.useMutation();
  const updateSong = trpc.studio.updateSong.useMutation();

  const song = snapshot.data?.songs.find((entry) => entry.id === songId);
  const legacyDocument = snapshot.data?.documents.find((entry) => entry.id === song?.sourceDocumentId);
  const album = snapshot.data?.albums.find((entry) => entry.id === song?.albumId);
  const versions = useMemo(() => snapshot.data?.versions.filter((entry) => entry.songId === songId) ?? [], [snapshot.data?.versions, songId]);
  const sortedVersions = useMemo(() => [...versions].sort((left, right) => versionOrder === "rating" ? right.rating - left.rating || Number(right.isFinal) - Number(left.isFinal) || Number(right.isPrimary) - Number(left.isPrimary) || right.createdAt.getTime() - left.createdAt.getTime() : right.createdAt.getTime() - left.createdAt.getTime()), [versionOrder, versions]);

  if (snapshot.isLoading) return <ScreenContainer><LoadingState label="Načítám skladbu…" /></ScreenContainer>;
  if (!song) return <ScreenContainer centered><EmptyState icon="music-off" title="Skladba nebyla nalezena" text="Vrať se do knihovny a zkus otevřít položku znovu." action={<PrimaryButton label="Do knihovny" icon="library-music" onPress={() => router.replace("/(tabs)/library" as never)} />} /></ScreenContainer>;
  const songContent = { stylePrompt: song.stylePrompt ?? legacyDocument?.stylePrompt ?? "", lyrics: song.lyrics ?? legacyDocument?.lyrics ?? "", coverUrl: song.coverUrl ?? legacyDocument?.coverUrl ?? album?.coverUrl };

  const copyText = async (content: string, label: string) => {
    if (!content.trim()) return;
    try {
      await Clipboard.setStringAsync(content);
      Alert.alert("Zkopírováno", `${label} je připravený ve schránce.`);
    } catch {
      Alert.alert("Kopírování se nezdařilo", "V prohlížeči povol přístup ke schránce a zkus to znovu.");
    }
  };

  const chooseMp3 = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: ["audio/mpeg", "audio/mp3"], copyToCacheDirectory: true });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (asset.size && asset.size > 25 * 1024 * 1024) {
      Alert.alert("Soubor je příliš velký", "Jedna MP3 verze může mít pro bezpečné nahrání nejvýše 25 MB.");
      return;
    }
    setPendingMp3({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, base64: asset.base64 });
  };
  const saveMp3 = async (label: string, note: string) => {
    if (!pendingMp3) return;
    try {
      const bytes = await assetToArrayBuffer(pendingMp3.uri, pendingMp3.base64);
      const uploaded = await upload.mutateAsync({
        folder: "audio",
        fileName: pendingMp3.name,
        contentType: pendingMp3.mimeType ?? "audio/mpeg",
        bytes,
      });
      const versionId = await createVersion.mutateAsync({
        songId,
        label,
        originalFileName: uploaded.originalFileName,
        storageKey: uploaded.key,
        storageUrl: uploaded.url,
        mimeType: uploaded.mimeType,
        byteSize: uploaded.byteSize,
        id3Title: song.title,
        id3Artist: "Temney",
        id3Album: album?.name ?? null,
        id3TrackNumber: null,
        id3Year: album?.releaseYear ? String(album.releaseYear) : null,
        id3Genre: null,
        id3Comment: note || null,
        rating: 0,
        isPrimary: versions.length === 0,
      });
      await utils.studio.snapshot.invalidate();
      setPendingMp3(null);
    } catch (error) {
      Alert.alert("Příprava MP3 se nezdařila", error instanceof Error ? error.message : "Zkus soubor nahrát znovu.");
    }
  };
  const importMultiple = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true, type: ["audio/mpeg", "audio/mp3"], copyToCacheDirectory: true });
    if (picked.canceled) return;
    const validAssets = picked.assets.filter((asset) => !asset.size || asset.size <= 25 * 1024 * 1024);
    if (!validAssets.length) { Alert.alert("Soubory jsou příliš velké", "Každá MP3 verze může mít pro bezpečné nahrání nejvýše 25 MB."); return; }
    if (validAssets.length !== picked.assets.length) Alert.alert("Část souborů byla vynechána", "MP3 větší než 25 MB nebyly do importu zařazeny.");
    try {
      for (const [index, asset] of validAssets.entries()) {
        const label = `V${versions.length + index + 1}`;
        const bytes = await assetToArrayBuffer(asset.uri, asset.base64);
        const uploaded = await upload.mutateAsync({ folder: "audio", fileName: asset.name, contentType: asset.mimeType ?? "audio/mpeg", bytes });
        const versionId = await createVersion.mutateAsync({ songId, label, originalFileName: uploaded.originalFileName, storageKey: uploaded.key, storageUrl: uploaded.url, mimeType: uploaded.mimeType, byteSize: uploaded.byteSize, id3Title: song.title, id3Artist: "Temney", id3Album: album?.name ?? null, id3TrackNumber: null, id3Year: album?.releaseYear ? String(album.releaseYear) : null, id3Genre: null, id3Comment: "Hromadný import", rating: 0, isPrimary: versions.length === 0 && index === 0 });
      }
      await utils.studio.snapshot.invalidate();
      Alert.alert("Hromadný import je hotový", `${validAssets.length} ${validAssets.length === 1 ? "verze byla připravena" : "verze byly připraveny"} a uloženy do cloudu.`);
    } catch (error) { Alert.alert("Hromadný import se nezdařil", error instanceof Error ? error.message : "Zkus import zopakovat."); }
  };

  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.topbar}><IconButton label="Do knihovny" icon="arrow-back" onPress={() => router.replace("/(tabs)/library" as never)} /><Text numberOfLines={1} style={[styles.topbarTitle, { color: colors.foreground }]}>Detail skladby</Text><IconButton label="Upravit" icon="edit" onPress={() => router.push(`/song/${song.id}/edit` as never)} /></View>
    <View style={[styles.songHero, { backgroundColor: colors.surface, borderColor: colors.border }]}><CoverArt uri={songContent.coverUrl} title={song.title} size={92} /><View style={styles.songHeroCopy}><Text style={[styles.songName, { color: colors.foreground }]}>{song.title}</Text><Text style={[styles.songAlbum, { color: colors.muted }]}>{album?.name ?? "Bez alba"}</Text><View style={styles.complete}><MaterialIcons name="check-circle" size={15} color={colors.success} /><Text style={[styles.completeText, { color: colors.success }]}>položka skladby</Text></View></View></View>
    <ContentCard icon="auto-awesome" title="Prompt stylu" text={songContent.stylePrompt || "Prompt zatím nebyl vyplněn."} actionLabel="Kopírovat prompt" disabled={!songContent.stylePrompt} onAction={() => void copyText(songContent.stylePrompt, "Prompt")} />
    <ContentCard icon="description" title="Popis na YouTube" text={song.youtubeDescription || "Popis videa zatím nebyl vyplněn."} actionLabel="Kopírovat popis" disabled={!song.youtubeDescription} onAction={() => void copyText(song.youtubeDescription ?? "", "Popis na YouTube")} onEdit={() => setYoutubeEditor({ field: "description", autoGenerate: !song.youtubeDescription })} />
    <ContentCard icon="sell" title="Tagy na YouTube" text={song.youtubeTags || "Tagy zatím nebyly vyplněny."} actionLabel="Kopírovat tagy" disabled={!song.youtubeTags} onAction={() => void copyText(song.youtubeTags ?? "", "Tagy na YouTube")} onEdit={() => setYoutubeEditor({ field: "tags", autoGenerate: !song.youtubeTags })} />
    <View style={[styles.publishCard, { backgroundColor: colors.surface, borderColor: song.isPublished ? `${colors.success}55` : colors.border }]}>
      <View style={styles.publishHead}>
        <View style={[styles.publishIcon, { backgroundColor: song.isPublished ? `${colors.success}20` : `${colors.muted}20` }]}><MaterialIcons name={song.isPublished ? "public" : "public-off"} size={20} color={song.isPublished ? colors.success : colors.muted} /></View>
        <View style={styles.publishCopy}><Text style={[styles.publishTitle, { color: colors.foreground }]}>{song.isPublished ? "Publikováno na YouTube" : "Zatím nepublikováno"}</Text><Text style={[styles.publishText, { color: colors.muted }]}>{song.isPublished ? `${song.publishedVideoId ? `Video ${song.publishedVideoId} • ` : ""}${song.publishedAt ? new Date(song.publishedAt).toLocaleDateString("cs-CZ") : ""}` : "Označ, až nahraješ hotové video na YouTube – získáš přehled v knihovně."}</Text></View>
      </View>
      <View style={styles.publishActions}>
        {song.isPublished && song.publishedVideoId ? <Pressable onPress={() => void copyText(`https://youtu.be/${song.publishedVideoId}`, "YouTube link")} style={({ pressed }) => [styles.publishSecondary, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name="link" size={16} color={colors.primary} /><Text style={[styles.publishSecondaryText, { color: colors.primary }]}>Kopírovat link</Text></Pressable> : null}
        <Pressable onPress={() => router.push("/export/youtube" as never)} style={({ pressed }) => [styles.publishPrimary, { backgroundColor: song.isPublished ? colors.surface : colors.success, borderColor: song.isPublished ? colors.border : colors.success, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name={song.isPublished ? "open-in-new" : "auto-awesome"} size={16} color={song.isPublished ? colors.foreground : OnPrimary} /><Text style={[styles.publishPrimaryText, { color: song.isPublished ? colors.foreground : OnPrimary }]}>{song.isPublished ? "Otevřít video" : "Publikovat přes AI"}</Text></Pressable>
      </View>
    </View>
    <ContentCard icon="format-align-left" title="Text písně" text={songContent.lyrics || "Text písně zatím nebyl vyplněn."} actionLabel="Kopírovat text" disabled={!songContent.lyrics} onAction={() => void copyText(songContent.lyrics, "Text písně")} />
    <VersionAudioPlayer versions={sortedVersions} />
    <SectionTitle title={`Přiřazené MP3 (${versions.length})`} right={<View style={styles.pair}><Pressable onPress={() => void importMultiple()} disabled={upload.isPending || createVersion.isPending}><Text style={[styles.addLink, { color: colors.muted }]}>{upload.isPending || createVersion.isPending ? "Ukládám…" : "Import více"}</Text></Pressable><Pressable onPress={() => void chooseMp3()} disabled={upload.isPending || createVersion.isPending}><Text style={[styles.addLink, { color: colors.primary }]}>{upload.isPending || createVersion.isPending ? "" : "Přidat MP3"}</Text></Pressable></View>} />
    {versions.length ? <Pressable onPress={() => setVersionOrder((current) => current === "rating" ? "newest" : "rating")} style={({ pressed }) => [styles.sortControl, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.68 : 1 }]}><MaterialIcons name={versionOrder === "rating" ? "star" : "schedule"} size={17} color={colors.primary} /><Text style={[styles.sortControlText, { color: colors.foreground }]}>{versionOrder === "rating" ? "Řazení: nejlepší hodnocení" : "Řazení: nejnovější verze"}</Text><MaterialIcons name="swap-vert" size={18} color={colors.muted} /></Pressable> : null}
    {sortedVersions.length ? sortedVersions.map((version) => <Pressable key={version.id} onPress={() => setSelectedVersion(version.id)} style={({ pressed }) => [styles.versionRow, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}><View style={[styles.versionIcon, { backgroundColor: `${colors.primary}20` }]}><MaterialIcons name={version.isFinal ? "verified" : version.isPrimary ? "star" : "music-note"} size={21} color={version.isFinal ? colors.success : colors.primary} /></View><View style={styles.versionCopy}><View style={styles.versionTitleRow}><Text numberOfLines={1} style={[styles.versionLabel, { color: colors.foreground }]}>{version.label}</Text><View style={styles.statusBadges}>{version.isPrimary ? <Text style={[styles.mainBadge, { color: colors.primary }]}>HLAVNÍ</Text> : null}{version.isFinal ? <Text style={[styles.finalBadge, { color: colors.success }]}>FINÁLNÍ</Text> : null}</View></View><View style={styles.ratingLine}><RatingStars rating={version.rating} /><Text style={[styles.versionFile, { color: colors.muted }]}>{version.originalFileName} · {formatFileSize(version.byteSize)}</Text></View></View><MaterialIcons name="edit" size={19} color={colors.muted} /></Pressable>) : <EmptyState icon="audio-file" title="Zatím žádná zvuková verze" text="Přidej MP3 z telefonu nebo počítače. Ke každé skladbě můžeš vést více verzí." action={<PrimaryButton label="Přidat první MP3" icon="upload-file" onPress={() => void chooseMp3()} />} />}
  </ScrollView><VersionEditor id={selectedVersion} onClose={() => setSelectedVersion(null)} /><Mp3IntakeSheet asset={pendingMp3} defaultLabel={`V${versions.length + 1}`} loading={upload.isPending || createVersion.isPending} onClose={() => setPendingMp3(null)} onSave={saveMp3} />{youtubeEditor ? <YoutubeTextEditor songId={songId} field={youtubeEditor.field} autoGenerate={youtubeEditor.autoGenerate} onClose={() => setYoutubeEditor(null)} /> : null}</ScreenContainer>;
}

function YoutubeTextEditor({ songId, field, autoGenerate, onClose }: { songId: string; field: "description" | "tags"; autoGenerate?: boolean; onClose: () => void }) {
  const colors = useColors();
  const utils = trpc.useUtils();
  const snapshot = trpc.studio.snapshot.useQuery();
  const update = trpc.studio.updateSong.useMutation();
  const generate = trpc.studio.generateYoutubeText.useMutation();
  const song = snapshot.data?.songs.find((entry) => entry.id === songId);
  const [value, setValue] = useState(field === "description" ? song?.youtubeDescription ?? "" : song?.youtubeTags ?? "");
  const [autoRan, setAutoRan] = useState(false);
  const isDescription = field === "description";
  useEffect(() => {
    if (autoGenerate && !autoRan && !generate.isPending) {
      setAutoRan(true);
      void runGeneration();
    }
  }, [autoGenerate, autoRan]);
  const title = isDescription ? "Popis na YouTube" : "Tagy na YouTube";

  const runGeneration = async () => {
    try {
      const result = await generate.mutateAsync({ action: isDescription ? "description" : "tags", songId });
      setValue(result.text);
      Alert.alert("AI je hotová", isDescription ? "Popis byl vygenerovaný z textu a žánru skladby. Můžeš ho upravit a uložit." : "Tagy byly vygenerované. Zkontroluj je, uprav a ulož.");
    } catch (error) { Alert.alert("Generování se nezdařilo", error instanceof Error ? error.message : "Zkus to znovu za chvíli."); }
  };
  const save = async () => {
    try {
      await update.mutateAsync(isDescription ? { id: songId, youtubeDescription: value.trim() || null } : { id: songId, youtubeTags: value.trim() || null });
      await utils.studio.snapshot.invalidate();
      onClose();
    } catch (error) { Alert.alert("Uložení se nezdařilo", error instanceof Error ? error.message : "Zkus to znovu."); }
  };

  return <Modal visible transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalShade}><View style={[styles.sheet, { backgroundColor: colors.background }]}><View style={[styles.handle, { backgroundColor: colors.border }]} /><View style={styles.sheetTop}><View><Text style={[styles.sheetTitle, { color: colors.foreground }]}>{title}</Text><Text numberOfLines={1} style={[styles.sheetFile, { color: colors.muted }]}>Ruční zápis nebo návrh od AI</Text></View><IconButton icon="close" label="Zavřít" onPress={onClose} /></View><ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
    <PrimaryButton label={generate.isPending ? "AI píše…" : `Vygenerovat ${isDescription ? "popis" : "tagy"} pomocí AI`} icon="auto-awesome" onPress={() => void runGeneration()} disabled={generate.isPending} />
    {generate.isPending ? <Text style={[styles.metaDescription, { color: colors.muted }]}>Čtu text, žánr a styl skladby…</Text> : null}
    <Field label={isDescription ? "Popis videa" : "Tagy (oddělené čárkou)"} value={value} onChangeText={setValue} multiline placeholder={isDescription ? "Text popisu můžeš přepsat vlastníma rukama…" : "temney, nová skladba, synthwave, …"} />
    <PrimaryButton label="Uložit ke skladbě" icon="save" onPress={() => void save()} disabled={update.isPending || generate.isPending} />
  </ScrollView></View></View></Modal>;
}

function ContentCard({ icon, title, text, actionLabel, disabled, onAction, onEdit }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; title: string; text: string; actionLabel: string; disabled: boolean; onAction: () => void; onEdit?: () => void }) {
  const colors = useColors();
  return <View style={[styles.contentCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.cardTitle}><View style={[styles.cardIcon, { backgroundColor: `${colors.primary}1E` }]}><MaterialIcons name={icon} size={18} color={colors.primary} /></View><Text style={[styles.cardTitleText, { color: colors.foreground }]}>{title}</Text></View><Text numberOfLines={5} style={[styles.cardText, { color: colors.muted }]}>{text}</Text><View style={styles.cardActions}>{onEdit ? <Pressable onPress={onEdit} style={({ pressed }) => [styles.aiButton, { backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1 }]}><MaterialIcons name="auto-awesome" size={15} color={OnPrimary} /><Text style={styles.aiButtonText}>Vygenerovat AI / upravit</Text></Pressable> : null}<Pressable disabled={disabled} onPress={onAction} style={({ pressed }) => [styles.copyButton, { borderColor: colors.border, opacity: disabled ? 0.45 : pressed ? 0.65 : 1 }]}><MaterialIcons name="content-copy" size={16} color={colors.primary} /><Text style={[styles.copyButtonText, { color: colors.primary }]}>{actionLabel}</Text></Pressable></View></View>;
}

function Mp3IntakeSheet({ asset, defaultLabel, loading, onClose, onSave }: { asset: { name: string } | null; defaultLabel: string; loading: boolean; onClose: () => void; onSave: (label: string, note: string) => Promise<void> }) {
  const colors = useColors();
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (asset) { setLabel(defaultLabel); setNote(""); } }, [asset, defaultLabel]);
  if (!asset) return null;
  return <Modal visible transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalShade}><View style={[styles.sheet, { backgroundColor: colors.background }]}><View style={[styles.handle, { backgroundColor: colors.border }]} /><View style={styles.sheetTop}><View><Text style={[styles.sheetTitle, { color: colors.foreground }]}>Přidat MP3 verzi</Text><Text numberOfLines={1} style={[styles.sheetFile, { color: colors.muted }]}>{asset.name}</Text></View><IconButton icon="close" label="Zavřít" onPress={onClose} /></View><View style={styles.sheetContent}><Text style={[styles.metaDescription, { color: colors.muted }]}>MP3 se ihned bezpečně uloží do cloudu. Název, interpret, album a poznámka zůstanou u verze jako metadata; novou souborovou kopii s ID3 tagy můžeš vytvořit později v detailu verze.</Text><Field label="Název verze MP3" value={label} onChangeText={setLabel} placeholder="Např. Master V1" /><Field label="Poznámka k verzi" value={note} onChangeText={setNote} placeholder="Např. čistší vokál, před publikováním" multiline /><PrimaryButton label={loading ? "Ukládám MP3 do cloudu…" : "Uložit MP3 verzi"} icon="cloud-upload" onPress={() => void onSave(label.trim() || asset.name.replace(/\.mp3$/i, ""), note)} disabled={loading} /></View></View></View></Modal>;
}

function VersionEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const colors = useColors();
  const utils = trpc.useUtils();
  const snapshot = trpc.studio.snapshot.useQuery();
  const version = snapshot.data?.versions.find((entry) => entry.id === id);
  const update = trpc.studio.updateVersion.useMutation();
  const setPrimary = trpc.studio.setPrimaryVersion.useMutation();
  const setFinal = trpc.studio.setFinalVersion.useMutation();
  const remove = trpc.studio.deleteVersion.useMutation();
  const exportTagged = trpc.studio.exportTaggedCopy.useMutation();
  const [form, setForm] = useState({ label: "", title: "", artist: "", album: "", track: "", year: "", genre: "", comment: "", rating: 0 });

  useEffect(() => {
    if (version) setForm({ label: version.label, title: version.id3Title ?? "", artist: version.id3Artist ?? "", album: version.id3Album ?? "", track: version.id3TrackNumber ?? "", year: version.id3Year ?? "", genre: version.id3Genre ?? "", comment: version.id3Comment ?? "", rating: version.rating });
  }, [version]);
  if (!version || id === null) return null;

  const payload = () => ({ id: version.id, label: form.label.trim() || version.label, id3Title: form.title || null, id3Artist: form.artist || null, id3Album: form.album || null, id3TrackNumber: form.track || null, id3Year: form.year || null, id3Genre: form.genre || null, id3Comment: form.comment || null, rating: form.rating });
  const save = async () => { try { await update.mutateAsync(payload()); await utils.studio.snapshot.invalidate(); onClose(); } catch (error) { Alert.alert("Metadata se nepodařilo uložit", error instanceof Error ? error.message : "Zkus to znovu."); } };
  const makePrimary = async () => { try { await update.mutateAsync(payload()); await setPrimary.mutateAsync({ id: version.id }); await utils.studio.snapshot.invalidate(); } catch { Alert.alert("Změna hlavní verze se nezdařila", "Zkus to znovu."); } };
  const makeFinal = () => Alert.alert("Označit jako finální verzi?", "Tato verze bude také hlavní. Dosavadní hlavní nebo finální označení ostatních verzí se zruší.", [{ text: "Zrušit", style: "cancel" }, { text: "Označit jako finální", onPress: async () => { try { await update.mutateAsync(payload()); await setFinal.mutateAsync({ id: version.id }); await utils.studio.snapshot.invalidate(); } catch { Alert.alert("Změna finální verze se nezdařila", "Zkus to znovu."); } } }]);
  const tagged = async () => { try { await update.mutateAsync(payload()); const result = await exportTagged.mutateAsync({ id: version.id }); await utils.studio.snapshot.invalidate(); await saveFinishedMp3(result.url, result.fileName); Alert.alert("Nová MP3 kopie je připravená", "Můžeš ji uložit do telefonu nebo odeslat přes systémové sdílení."); } catch (error) { Alert.alert("Export se nezdařil", error instanceof Error ? error.message : "Zkontroluj soubor a zkus to znovu."); } };
  const saveMp3ToDevice = async () => { try { await saveFinishedMp3(version.taggedStorageUrl ?? version.storageUrl, version.originalFileName); } catch (error) { Alert.alert("Uložení MP3 se nezdařilo", error instanceof Error ? error.message : "Zkus to znovu."); } };
  const confirmDelete = () => Alert.alert("Odebrat tuto verzi?", "Z katalogu se odebere jen tato MP3 položka. Originál zůstane v uložené historii.", [{ text: "Zrušit", style: "cancel" }, { text: "Odebrat", style: "destructive", onPress: async () => { await remove.mutateAsync({ id: version.id }); await utils.studio.snapshot.invalidate(); onClose(); } }]);

  return <Modal visible transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalShade}><View style={[styles.sheet, { backgroundColor: colors.background }]}><View style={[styles.handle, { backgroundColor: colors.border }]} /><View style={styles.sheetTop}><View><Text style={[styles.sheetTitle, { color: colors.foreground }]}>Verze MP3</Text><Text numberOfLines={1} style={[styles.sheetFile, { color: colors.muted }]}>{version.originalFileName}</Text></View><IconButton icon="close" label="Zavřít" onPress={onClose} /></View><ScrollView contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}><PrimaryButton label="Uložit MP3 do telefonu / sdílet" icon="download" onPress={() => void saveMp3ToDevice()} /><Field label="Označení verze" value={form.label} onChangeText={(label) => setForm((current) => ({ ...current, label }))} /><View style={styles.ratingEditor}><View><Text style={[styles.sheetLabel, { color: colors.foreground }]}>Hodnocení verze</Text><Text style={[styles.ratingHint, { color: colors.muted }]}>{form.rating ? `${form.rating} z 5 hvězd` : "Zatím nehodnoceno"}</Text></View><RatingStars rating={form.rating} onRate={(rating) => setForm((current) => ({ ...current, rating }))} /></View><Text style={[styles.metaHeading, { color: colors.foreground }]}>ID3 metadata</Text><Text style={[styles.metaDescription, { color: colors.muted }]}>Uprav metadata; export vytvoří novou MP3 kopii a originál nezmění.</Text><Field label="Název skladby" value={form.title} onChangeText={(title) => setForm((current) => ({ ...current, title }))} /><Field label="Interpret" value={form.artist} placeholder="Jméno interpreta" onChangeText={(artist) => setForm((current) => ({ ...current, artist }))} /><Field label="Album" value={form.album} onChangeText={(album) => setForm((current) => ({ ...current, album }))} /><View style={styles.pair}><View style={styles.pairChild}><Field label="Číslo stopy" value={form.track} placeholder="01" onChangeText={(track) => setForm((current) => ({ ...current, track }))} /></View><View style={styles.pairChild}><Field label="Rok" value={form.year} placeholder="2026" onChangeText={(year) => setForm((current) => ({ ...current, year }))} /></View></View><Field label="Žánr" value={form.genre} placeholder="Např. pop, rock, ambient" onChangeText={(genre) => setForm((current) => ({ ...current, genre }))} /><Field label="Komentář" value={form.comment} placeholder="Poznámka k verzi" multiline onChangeText={(comment) => setForm((current) => ({ ...current, comment }))} /><PrimaryButton label={update.isPending ? "Ukládám metadata" : "Uložit metadata"} icon="save" onPress={() => void save()} disabled={update.isPending} /><Pressable onPress={() => void makePrimary()} style={({ pressed }) => [styles.outlineAction, { borderColor: colors.border, opacity: setPrimary.isPending || pressed ? 0.65 : 1 }]}><MaterialIcons name="star" size={19} color={colors.primary} /><Text style={[styles.outlineActionText, { color: colors.primary }]}>{version.isPrimary ? "Toto je hlavní verze" : "Nastavit jako hlavní verzi"}</Text></Pressable><Pressable onPress={makeFinal} style={({ pressed }) => [styles.outlineAction, { borderColor: version.isFinal ? colors.success : colors.border, opacity: setFinal.isPending || pressed ? 0.65 : 1 }]}><MaterialIcons name="verified" size={19} color={colors.success} /><Text style={[styles.outlineActionText, { color: colors.success }]}>{version.isFinal ? "Toto je finální verze" : "Označit jako finální verzi"}</Text></Pressable><Pressable onPress={() => void tagged()} style={({ pressed }) => [styles.outlineAction, { borderColor: colors.border, opacity: exportTagged.isPending || pressed ? 0.65 : 1 }]}><MaterialIcons name="drive-file-rename-outline" size={19} color={colors.primary} /><Text style={[styles.outlineActionText, { color: colors.primary }]}>{exportTagged.isPending ? "Vytvářím kopii…" : "Vytvořit novou MP3 kopii s ID3 tagy"}</Text></Pressable><Pressable onPress={confirmDelete} style={({ pressed }) => [styles.deleteAction, { opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name="delete-outline" size={19} color={colors.error} /><Text style={[styles.deleteText, { color: colors.error }]}>Odebrat verzi z katalogu</Text></Pressable></ScrollView></View></View></Modal>;
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 15 }, topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, topbarTitle: { fontSize: 16, fontWeight: "800" }, topbarSpacer: { width: 44 }, songHero: { borderWidth: 1, borderRadius: Radius.lg, padding: 13, flexDirection: "row", alignItems: "center", gap: 14 }, songHeroCopy: { flex: 1, gap: 5 }, songName: { ...Type.title, lineHeight: 25, fontWeight: "900" }, songAlbum: { ...Type.label }, complete: { flexDirection: "row", gap: 4, alignItems: "center" }, completeText: { ...Type.caption },   contentCard: { borderWidth: 1, borderRadius: Radius.lg, padding: 15, gap: 11 }, publishCard: { borderWidth: 1, borderRadius: Radius.lg, padding: 14, gap: 12 }, publishHead: { flexDirection: "row", gap: 11, alignItems: "center" }, publishIcon: { width: 38, height: 38, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, publishCopy: { flex: 1, gap: 3 }, publishTitle: { fontSize: 15, fontWeight: "800" }, publishText: { ...Type.caption, lineHeight: 16 }, publishActions: { flexDirection: "row", gap: 8, flexWrap: "wrap" }, publishPrimary: { height: 38, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center" }, publishPrimaryText: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "900" }, publishSecondary: { height: 38, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6 }, publishSecondaryText: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "800" }, cardTitle: { flexDirection: "row", alignItems: "center", gap: 9 }, cardIcon: { width: 33, height: 33, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, cardTitleText: { fontSize: 16, fontWeight: "800" }, cardText: { ...Type.label, lineHeight: 19 }, cardActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }, aiButton: { height: 36, borderRadius: Radius.sm, paddingHorizontal: 12, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" }, aiButtonText: { color: OnPrimary, fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "900" }, copyButton: { alignSelf: "flex-start", height: 36, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 11, flexDirection: "row", gap: 6, alignItems: "center" }, copyButtonText: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "800" }, addLink: { ...Type.label }, sortControl: { minHeight: 39, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 7, marginTop: -7 }, sortControlText: { flex: 1, fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "800" }, versionRow: { borderWidth: 1, borderRadius: Radius.md, minHeight: 73, padding: 11, flexDirection: "row", gap: 10, alignItems: "center", marginBottom: 8 }, versionIcon: { height: 42, width: 42, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, versionCopy: { flex: 1, gap: 4 }, versionTitleRow: { flexDirection: "row", gap: 6, alignItems: "center" }, versionLabel: { flex: 1, fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, versionFile: { ...Type.caption, flex: 1 }, ratingLine: { flexDirection: "row", alignItems: "center", gap: 7 }, stars: { flexDirection: "row", alignItems: "center", gap: 1 }, statusBadges: { flexDirection: "row", alignItems: "center", gap: 5 }, mainBadge: { fontSize: 9, fontWeight: "900", letterSpacing: 0.5 }, finalBadge: { fontSize: 9, fontWeight: "900", letterSpacing: 0.5 }, ratingEditor: { minHeight: 51, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 1 }, ratingHint: { ...Type.caption, marginTop: 2 }, modalShade: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.58)" }, sheet: { maxHeight: "92%", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 9 }, handle: { height: 4, width: 40, borderRadius: 3, alignSelf: "center", marginBottom: 12 }, sheetTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingBottom: 12 }, sheetTitle: { fontSize: Type.title.fontSize, lineHeight: Type.title.lineHeight, fontWeight: "900" }, sheetFile: { maxWidth: 240, ...Type.caption, marginTop: 2 }, sheetContent: { padding: 20, paddingTop: 5, paddingBottom: 40, gap: 14 }, metaHeading: { fontSize: 16, fontWeight: "900", marginTop: 4 }, metaDescription: { ...Type.caption, lineHeight: 19, marginTop: -9 }, sheetField: { gap: 6 }, sheetLabel: { ...Type.label }, sheetInput: { minHeight: 45, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, ...Type.label }, sheetMultiline: { minHeight: 88, paddingVertical: 11, lineHeight: 19 }, pair: { flexDirection: "row", gap: 10 }, pairChild: { flex: 1 }, outlineAction: { height: 49, borderRadius: Radius.sm, borderWidth: 1, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }, outlineActionText: { ...Type.label }, deleteAction: { height: 42, borderRadius: Radius.sm, flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center", marginTop: 2 }, deleteText: { ...Type.label },
});
