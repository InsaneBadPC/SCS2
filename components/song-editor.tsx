import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AlbumChip, Field, IconButton, LoadingState, SectionTitle } from "@/components/studio-ui";
import { RhymeFinder } from "@/components/rhyme-finder";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { pickImage, pickVideo } from "@/lib/pick-media";
import { clearDraft, loadDraft, shouldRestoreDraft, useDraftStorage } from "@/lib/use-draft-storage";
import { takePickedStylePrompt } from "@/lib/style-prompt-picker";
import { trpc } from "@/lib/trpc";
import { useUndoableText } from "@/lib/use-undoable-text";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

type SongForm = { title: string; albumId: string | null; stylePrompts: string[]; lyrics: string; notes: string; coverStorageKey: string | null; coverUrl: string | null; sourceVideoStorageKey: string | null };
const emptyForm: SongForm = { title: "", albumId: null, stylePrompts: [""], lyrics: "", notes: "", coverStorageKey: null, coverUrl: null, sourceVideoStorageKey: null };

export function SongEditor({ songId }: { songId?: string }) {
  const colors = useColors();
  const { isAuthenticated, user } = useAuth();
  const utils = trpc.useUtils();
  const userId = user?.id ?? null;
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const song = useMemo(() => snapshot.data?.songs.find((entry) => entry.id === songId), [snapshot.data?.songs, songId]);
  const [form, setForm] = useState<SongForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const upload = trpc.studio.upload.useMutation();
  const create = trpc.studio.createSong.useMutation();
  const update = trpc.studio.updateSong.useMutation();
  const createStylePrompt = trpc.studio.createStylePrompt.useMutation();
  const createCoverGeneration = trpc.studio.createCoverGeneration.useMutation();
  const checkCoverGeneration = trpc.studio.checkCoverGeneration.useMutation();
  const [coverGenerating, setCoverGenerating] = useState(false);
  const [coverDialogVisible, setCoverDialogVisible] = useState(false);
  const [coverNote, setCoverNote] = useState("");
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const draftRunRef = useRef(0);
  const lyricsHistory = useUndoableText("");
  const { reset: resetLyricsHistory } = lyricsHistory;
  const albumName = snapshot.data?.albums.find((album) => album.id === form.albumId)?.name ?? "Bez alba";
  const songUpdatedAt = song?.updatedAt instanceof Date ? song.updatedAt.getTime() : song?.updatedAt ? new Date(song.updatedAt as unknown as string).getTime() : null;
  const songStylePromptsKey = Array.isArray(song?.stylePrompts) ? song.stylePrompts.join("\u0000") : null;

  useEffect(() => {
    const run = ++draftRunRef.current;
    setDraftReady(false);
    setDraftRestored(false);
    if (!userId) {
      setForm(emptyForm);
      resetLyricsHistory("");
      return;
    }
    if (songId && snapshot.isLoading) {
      setForm(emptyForm);
      resetLyricsHistory("");
      return;
    }
    if (songId && !song) {
      setForm(emptyForm);
      resetLyricsHistory("");
      setDraftReady(false);
      return;
    }

    const serverForm: SongForm = song ? {
      title: song.title,
      albumId: song.albumId,
      stylePrompts: Array.isArray(song.stylePrompts) && song.stylePrompts.length ? [...song.stylePrompts] : [""],
      lyrics: song.lyrics ?? "",
      notes: song.notes ?? "",
      coverStorageKey: song.coverStorageKey,
      sourceVideoStorageKey: song.sourceVideoStorageKey,
      coverUrl: song.coverUrl,
    } : emptyForm;
    setForm(serverForm);
    resetLyricsHistory(serverForm.lyrics);

    let cancelled = false;
    void loadDraft(songId ?? null, userId, "song").then((draft) => {
      if (cancelled || run !== draftRunRef.current) return;
      if (draft && shouldRestoreDraft(songUpdatedAt, draft.savedAt)) {
        setForm({ title: draft.title, albumId: draft.albumId, stylePrompts: draft.stylePrompts?.length ? draft.stylePrompts : [draft.stylePrompt || ""], lyrics: draft.lyrics, notes: draft.notes, coverStorageKey: draft.coverStorageKey, coverUrl: draft.coverUrl, sourceVideoStorageKey: draft.sourceVideoStorageKey ?? null });
        resetLyricsHistory(draft.lyrics);
        setDraftRestored(true);
      } else if (draft) {
        void clearDraft(songId ?? null, userId, "song");
      }
      setDraftReady(true);
    });

    return () => { cancelled = true; };
    // Server fields are listed individually so a new cache object does not wipe an unsaved form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetLyricsHistory, song?.albumId, song?.coverStorageKey, song?.coverUrl, song?.id, song?.lyrics, song?.notes, song?.sourceVideoStorageKey, song?.title, songId, songStylePromptsKey, songUpdatedAt, snapshot.isLoading, userId]);

  useDraftStorage(form, songId ?? null, userId, draftReady, "song");
  useFocusEffect(useMemo(() => () => {
    const picked = takePickedStylePrompt();
    if (picked) setForm((current) => ({ ...current, stylePrompts: [...current.stylePrompts.filter((entry) => entry.trim()), picked] }));
  }, []));
  if (isAuthenticated && userId && !draftReady && (!songId || song)) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (songId && snapshot.isLoading) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (songId && !song) return <ScreenContainer centered><Text style={[styles.error, { color: colors.muted }]}>Skladba nebyla nalezena.</Text></ScreenContainer>;

  const save = async () => {
    if (!form.title.trim()) { Alert.alert("Chybí název skladby", "Zadej název, pod kterým chceš skladbu vést v katalogu."); return; }
    setSaving(true);
    try {
      const stylePrompts = form.stylePrompts.map((entry) => entry.trim()).filter(Boolean);
      const payload = { title: form.title.trim(), albumId: form.albumId, stylePrompts, lyrics: form.lyrics || null, notes: form.notes || null, coverStorageKey: form.coverStorageKey, coverUrl: form.coverUrl, sourceVideoStorageKey: form.sourceVideoStorageKey };
      const savedId = songId ? (await update.mutateAsync({ id: songId, ...payload }), songId) : await create.mutateAsync(payload);
      await clearDraft(songId ?? null, userId, "song");
      await clearDraft(savedId, userId, "song");
      setDraftRestored(false);
      await utils.studio.snapshot.invalidate();
      router.replace(`/song/${savedId}` as never);
    } catch (error) { Alert.alert("Skladbu se nepodařilo uložit", error instanceof Error ? error.message : "Zkus to znovu."); } finally { setSaving(false); }
  };
  const uploadCover = async () => {
    // Androidův vestavěný editor může i při zadaném 16:9 vynutit čtvercový ořez.
    // Obrázek proto jen vybereme a celou kompozici zachováme v 16:9 rámečku.
    try {
      const picked = await pickImage();
      if (!picked) return;
      const uploaded = await upload.mutateAsync({
        folder: "covers",
        fileName: picked.fileName,
        contentType: picked.mimeType,
        bytes: picked.bytes,
      });
      setForm((current) => ({ ...current, coverStorageKey: uploaded.key, coverUrl: uploaded.url }));
    } catch (error) {
      Alert.alert("Obrázek se nepodařilo nahrát", error instanceof Error ? error.message : "Zkus jiný obrázek.");
    }
  };
  const uploadVideo = async () => {
    try {
      const picked = await pickVideo();
      if (!picked) return;
      const uploaded = await upload.mutateAsync({
        folder: "videos",
        fileName: picked.fileName,
        contentType: picked.mimeType,
        bytes: picked.bytes,
      });
      setForm((current) => ({ ...current, sourceVideoStorageKey: uploaded.key }));
      Alert.alert("Video je nahrané", "Render z něj udělá smyčku přes celou skladbu.");
    } catch (error) {
      Alert.alert("Video se nepodařilo nahrát", error instanceof Error ? error.message : "Zkus jiné video.");
    }
  };
  const openCoverDialog = () => {
    if (!songId) { Alert.alert("Nejprve skladbu ulož", "Nejdřív ulož název, album a text. Pak může aplikace vytvořit obal z přesně těchto uložených údajů."); return; }
    if (!form.stylePrompts.some((entry) => entry.trim()) && !form.lyrics.trim()) { Alert.alert("Doplň obsah skladby", "Pro lepší cover zapiš alespoň prompt pro styl nebo část textu písně."); return; }
    setCoverNote("");
    setCoverDialogVisible(true);
  };
  const generateCover = async () => {
    if (!songId) return;
    setCoverGenerating(true);
    setCoverDialogVisible(false);
    try {
      const created = await createCoverGeneration.mutateAsync({ entityType: "song", entityId: songId, format: "youtube_16_9", userNote: coverNote.trim() || null });
      for (let attempt = 0; attempt < 36; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const status = await checkCoverGeneration.mutateAsync({ entityType: "song", entityId: songId, jobId: created.jobId, format: "youtube_16_9" });
        // Backend v 16:9 větvi obraz NEvydá jako obal skladby — ukládá ho jen jako
        // soukromý zdrojový soubor (covers/raw) a nepřepisuje sc_songs.cover_path.
        // Dřívější text "byl uložen ke skladbě a použije se na YouTube" byl nepravda.
        if (status.status === "completed") { await utils.studio.snapshot.invalidate(); await snapshot.refetch(); Alert.alert("Zdrojový obrázek je uložený", "AI obraz má 512 × 512 a žádný text. Aplikace zatím neskládá široký 16:9 obal, takže se obrázek skladby nezmění."); return; }
        if (status.status === "failed") throw new Error(status.error);
      }
      Alert.alert("Cover je stále ve frontě", "Cloudová AI má nyní delší frontu. Zkus generování za chvíli spustit znovu.");
    } catch (error) { Alert.alert("Cover se nepodařilo vytvořit", error instanceof Error ? error.message : "Zkus to znovu za chvíli."); } finally { setCoverGenerating(false); }
  };
  const saveFirstPromptToLibrary = async () => {
    const content = form.stylePrompts.map((entry) => entry.trim()).filter(Boolean)[0];
    if (!content) return;
    try {
      await createStylePrompt.mutateAsync({ content });
      await utils.studio.snapshot.invalidate();
      Alert.alert("Uloženo do databáze", "Prompt najdeš v databázi promptů stylu a můžeš ho použít u další skladby.");
    } catch (error) { Alert.alert("Uložení se nezdařilo", error instanceof Error ? error.message : "Zkus to znovu."); }
  };
  const updateLyrics = (lyrics: string, coalesce = true) => {
    lyricsHistory.change(lyrics, coalesce);
    setForm((current) => ({ ...current, lyrics }));
  };
  const undoLyrics = () => {
    const lyrics = lyricsHistory.undo();
    if (lyrics !== undefined) setForm((current) => ({ ...current, lyrics }));
  };
  const redoLyrics = () => {
    const lyrics = lyricsHistory.redo();
    if (lyrics !== undefined) setForm((current) => ({ ...current, lyrics }));
  };

  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0} style={{ flex: 1 }}><ScrollView contentContainerStyle={[styles.content, { paddingBottom: 180 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>{draftRestored ? <View style={[styles.draftNotice, { backgroundColor: `${colors.accent}14`, borderColor: `${colors.accent}55` }]}><MaterialIcons name="restore" size={16} color={colors.accent} /><Text style={[styles.draftNoticeText, { color: colors.foreground }]}>Obnoven rozpracovaný text — klepni na Uložit pro potvrzení.</Text></View> : null}<View style={styles.topbar}><IconButton label="Zpět" icon="arrow-back" onPress={() => router.back()} /><Text numberOfLines={1} style={[styles.topbarName, { color: colors.foreground }]}>{songId ? "Upravit skladbu" : "Nová skladba"}</Text><Pressable onPress={() => void save()} style={({ pressed }) => [styles.save, { opacity: saving || pressed ? 0.6 : 1 }]}><Text style={[styles.saveText, { color: colors.primary }]}>{saving ? "Ukládám" : "Uložit"}</Text></Pressable></View>
    <View style={[styles.flow, { backgroundColor: `${colors.primary}13`, borderColor: `${colors.primary}45` }]}><MaterialIcons name="account-tree" size={20} color={colors.primary} /><Text style={[styles.flowText, { color: colors.muted }]}>Tato položka drží pohromadě text, obrázek, MP3 verze, metadata a album.</Text></View>
    <View style={styles.coverBlock}><Pressable onPress={() => void uploadCover()} style={({ pressed }) => [styles.cover, { borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed ? 0.72 : 1 }]}>{form.coverUrl ? <Image source={{ uri: form.coverUrl }} style={styles.coverImage} resizeMode="contain" /> : <><View style={[styles.coverIcon, { backgroundColor: `${colors.primary}20` }]}><MaterialIcons name="add-photo-alternate" size={25} color={colors.primary} /></View><Text style={[styles.coverTitle, { color: colors.foreground }]}>Přidat vlastní obrázek skladby</Text><Text style={[styles.coverText, { color: colors.muted }]}>Celá kompozice bez ořezu v 16:9 pro katalog i YouTube video.</Text></>}</Pressable><Pressable onPress={openCoverDialog} disabled={coverGenerating} style={({ pressed }) => [styles.generateCover, { borderColor: colors.primary, backgroundColor: `${colors.primary}12`, opacity: coverGenerating || pressed ? 0.62 : 1 }]}><MaterialIcons name={coverGenerating ? "hourglass-top" : "auto-awesome"} size={19} color={colors.primary} /><View style={styles.generateCopy}><Text style={[styles.generateTitle, { color: colors.primary }]}>{coverGenerating ? "Bezplatná AI kreslí obraz…" : "Vygenerovat obrázek skladby"}</Text><Text style={[styles.generateText, { color: colors.muted }]}>{songId ? "AI obraz 512 × 512 bez textu. Temney, album a název skladby si aplikace ukládá jako data a zobrazuje je u skladby, ne v obrázku." : "Nejprve skladbu ulož, pak můžeš vytvořit obal."}</Text></View></Pressable><Pressable onPress={() => void uploadVideo()} style={({ pressed }) => [styles.generateCover, { borderColor: colors.border, backgroundColor: `${colors.muted}12`, opacity: pressed ? 0.62 : 1 }]}><MaterialIcons name={form.sourceVideoStorageKey ? "movie" : "video-library"} size={19} color={colors.muted} /><View style={styles.generateCopy}><Text style={[styles.generateTitle, { color: colors.muted }]}>{form.sourceVideoStorageKey ? "Video skladby je nahrané" : "Nahrát video místo obrázku"}</Text><Text style={[styles.generateText, { color: colors.muted }]}>Z krátkého MP4 udělá render smyčku přes celou skladbu.</Text></View></Pressable></View>
    <Field label="Název skladby" value={form.title} onChangeText={(title) => setForm((current) => ({ ...current, title }))} placeholder="Např. Noční signál" autoFocus={!songId} />
    <SectionTitle title="Album" />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.albumChips}><AlbumChip active={!form.albumId} label="Bez alba" onPress={() => setForm((current) => ({ ...current, albumId: null }))} />{snapshot.data?.albums.map((album) => <AlbumChip key={album.id} active={form.albumId === album.id} label={album.name} onPress={() => setForm((current) => ({ ...current, albumId: album.id }))} />)}</ScrollView>
    <SectionTitle title="Prompty pro styl" />
    <View style={styles.promptTools}><Pressable onPress={() => router.push("/prompts?pick=1" as never)} style={({ pressed }) => [styles.promptTool, { borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}><MaterialIcons name="library-books" size={16} color={colors.primary} /><Text style={[styles.promptToolText, { color: colors.primary }]}>Vybrat z databáze</Text></Pressable><Pressable onPress={() => void saveFirstPromptToLibrary()} disabled={!form.stylePrompts.some((entry) => entry.trim())} style={({ pressed }) => [styles.promptTool, { borderColor: colors.border, opacity: !form.stylePrompts.some((entry) => entry.trim()) || pressed ? 0.45 : 1 }]}><MaterialIcons name="bookmarks" size={16} color={colors.primary} /><Text style={[styles.promptToolText, { color: colors.primary }]}>Uložit do databáze</Text></Pressable></View>
    {form.stylePrompts.map((value, index) => (
      <View key={index} style={styles.promptRow}>
        <View style={styles.promptField}>
          <Field label={`Prompt stylu ${index + 1}`} helper={index === 0 ? "Například žánr, tempo, nálada, nástroje a typ hlasu." : undefined} value={value} onChangeText={(text) => setForm((current) => ({ ...current, stylePrompts: current.stylePrompts.map((entry, position) => position === index ? text : entry) }))} placeholder={index === 0 ? "Atmosférický pop, 96 BPM, jemný mužský vokál…" : "Další varianta nebo rozšíření promptu…"} multiline />
        </View>
        {form.stylePrompts.length > 1 ? <IconButton label="Odebrat prompt" icon="remove-circle-outline" onPress={() => setForm((current) => ({ ...current, stylePrompts: current.stylePrompts.filter((_, position) => position !== index) }))} /> : null}
      </View>
    ))}
    <Pressable onPress={() => setForm((current) => ({ ...current, stylePrompts: [...current.stylePrompts, ""] }))} style={({ pressed }) => [styles.addPrompt, { borderColor: colors.primary, opacity: pressed ? 0.62 : 1 }]}><MaterialIcons name="add" size={19} color={colors.primary} /><Text style={[styles.addPromptText, { color: colors.primary }]}>Přidat další prompt</Text></Pressable>
    <View style={styles.lyricsHead}><Text style={[styles.lyricsLabel, { color: colors.foreground }]}>Text písně</Text><View style={styles.historyRow}><Pressable onPress={undoLyrics} disabled={!lyricsHistory.canUndo} style={({ pressed }) => [styles.historyButton, { borderColor: colors.border, backgroundColor: colors.surface, opacity: !lyricsHistory.canUndo || pressed ? 0.4 : 1 }]}><MaterialIcons name="undo" size={18} color={colors.primary} /><Text style={[styles.historyButtonText, { color: colors.primary }]}>Zpět</Text></Pressable><Pressable onPress={redoLyrics} disabled={!lyricsHistory.canRedo} style={({ pressed }) => [styles.historyButton, { borderColor: colors.border, backgroundColor: colors.surface, opacity: !lyricsHistory.canRedo || pressed ? 0.4 : 1 }]}><MaterialIcons name="redo" size={18} color={colors.primary} /><Text style={[styles.historyButtonText, { color: colors.primary }]}>Vpřed</Text></Pressable></View></View>
     <TextInput value={lyricsHistory.value} onChangeText={updateLyrics} placeholder="[Sloka 1]\n…" multiline textAlignVertical="top" disableFullscreenUI style={[styles.input, styles.tall, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <Field label="Poznámky" value={form.notes} onChangeText={(notes) => setForm((current) => ({ ...current, notes }))} placeholder="Aranž, reference, nápady na klip…" multiline />
    <Pressable onPress={() => void save()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary, opacity: saving || pressed ? 0.68 : 1 }]}><MaterialIcons name="save" size={20} color={OnPrimary} /><Text style={styles.saveButtonText}>{saving ? "Ukládám skladbu…" : "Uložit položku skladby"}</Text></Pressable>
  </ScrollView></KeyboardAvoidingView><RhymeFinder variant="floating" onInsert={(word) => { const next = `${lyricsHistory.value}${lyricsHistory.value && !/\s$/.test(lyricsHistory.value) ? " " : ""}${word}`; updateLyrics(next, false); }} /><CoverGenerationDialog visible={coverDialogVisible} title={form.title} albumName={albumName} lyrics={form.lyrics} note={coverNote} onChangeNote={setCoverNote} onClose={() => setCoverDialogVisible(false)} onGenerate={() => void generateCover()} colors={colors} /></ScreenContainer>;
}

function CoverGenerationDialog({ visible, title, albumName, lyrics, note, onChangeNote, onClose, onGenerate, colors }: { visible: boolean; title: string; albumName: string; lyrics: string; note: string; onChangeNote: (value: string) => void; onClose: () => void; onGenerate: () => void; colors: ReturnType<typeof useColors> }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalShade}><View style={[styles.coverSheet, { backgroundColor: colors.background }]}><View style={[styles.sheetHandle, { backgroundColor: colors.border }]} /><View style={styles.dialogTop}><View style={styles.dialogHeading}><View style={[styles.dialogIcon, { backgroundColor: `${colors.primary}20` }]}><MaterialIcons name="auto-awesome" size={20} color={colors.primary} /></View><View><Text style={[styles.dialogTitle, { color: colors.foreground }]}>Vygenerovat obal</Text><Text style={[styles.dialogSubtitle, { color: colors.muted }]}>AI ilustrace bez nápisů</Text></View></View><IconButton label="Zavřít" icon="close" onPress={onClose} /></View><ScrollView contentContainerStyle={styles.dialogContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets><Text style={[styles.dialogIntro, { color: colors.muted }]}>AI nakreslí obraz podle údajů níže. Do obrázku se žádný text nekreslí — Temney, album a název skladby si aplikace ukládá jako data a zobrazuje je u skladby a ve videu.</Text><ContextLine label="Interpret" value="Temney" colors={colors} /><ContextLine label="Album" value={albumName} colors={colors} /><ContextLine label="Skladba" value={title || "Bez názvu"} colors={colors} /><View style={styles.contextBlock}><Text style={[styles.contextLabel, { color: colors.muted }]}>Text písně</Text><Text numberOfLines={6} style={[styles.lyricsPreview, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]}>{lyrics || "Text písně zatím nebyl vyplněn."}</Text></View><View style={styles.field}><Text style={[styles.fieldLabel, { color: colors.foreground }]}>Volitelná poznámka pro obrázek</Text><TextInput value={note} onChangeText={onChangeNote} placeholder="Např. déšť, noční město, červené světlo…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.noteInput, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]} /></View><View style={[styles.guarantee, { backgroundColor: `${colors.primary}13`, borderColor: `${colors.primary}45` }]}><MaterialIcons name="verified" size={18} color={colors.primary} /><Text style={[styles.guaranteeText, { color: colors.foreground }]}>Bezplatná AI vrátí obrázek 512 × 512 a bez nápisů. Čtvercový zdroj zatím aplikace neskládá do širokého 16:9 obalu, takže obrázek skladby se nezmění.</Text></View><Pressable onPress={onGenerate} style={({ pressed }) => [styles.dialogGenerate, { backgroundColor: colors.primary, opacity: pressed ? 0.72 : 1 }]}><MaterialIcons name="auto-awesome" size={19} color={OnPrimary} /><Text style={styles.dialogGenerateText}>Vytvořit obrázek zdarma</Text></Pressable></ScrollView></View></View></Modal>;
}

function ContextLine({ label, value, colors }: { label: string; value: string; colors: ReturnType<typeof useColors> }) { return <View style={[styles.contextLine, { backgroundColor: colors.surface, borderColor: colors.border }]}><Text style={[styles.contextLabel, { color: colors.muted }]}>{label}</Text><Text numberOfLines={2} style={[styles.contextValue, { color: colors.foreground }]}>{value}</Text></View>; }

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 18 }, draftNotice: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, paddingVertical: 9 }, draftNoticeText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontWeight: "600" }, topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, topbarName: { flex: 1, fontSize: 15, fontWeight: "800", textAlign: "center" }, save: { minWidth: 49, minHeight: 42, alignItems: "flex-end", justifyContent: "center" }, saveText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, flow: { borderWidth: 1, borderRadius: Radius.md, padding: 13, flexDirection: "row", gap: 9, alignItems: "center" }, flowText: { flex: 1, ...Type.caption, lineHeight: 17 },
  promptTools: { flexDirection: "row", gap: 8 },
  promptTool: { borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, height: 34, flexDirection: "row", alignItems: "center", gap: 6 },
  promptToolText: { fontSize: 12.5, fontWeight: "800" },
  promptRow: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  promptField: { flex: 1 },
  addPrompt: { minHeight: 44, borderWidth: 1, borderStyle: "dashed", borderRadius: Radius.sm, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  addPromptText: { fontSize: 13.5, fontWeight: "800" },
  lyricsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  lyricsLabel: { fontSize: 15, fontWeight: "800" },
  historyRow: { flexDirection: "row", gap: 7 },
  historyButton: { height: 34, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 5 },
  historyButtonText: { fontSize: 12.5, fontWeight: "900" },
  coverBlock: { gap: 9 }, cover: { minHeight: 180, aspectRatio: 16 / 9, borderWidth: 1, borderRadius: Radius.lg, padding: 18, alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden" }, coverImage: { width: "100%", height: "100%", borderRadius: Radius.sm }, coverIcon: { width: 47, height: 47, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, coverTitle: { fontSize: 15, fontWeight: "800" }, coverText: { ...Type.caption, textAlign: "center", lineHeight: 17 }, generateCover: { minHeight: 66, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 }, generateCopy: { flex: 1, gap: 2 }, generateTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, generateText: { ...Type.caption, lineHeight: 15 }, field: { gap: 7 }, fieldLabel: { fontSize: 15, fontWeight: "800" }, fieldHelper: { ...Type.caption, lineHeight: 17 }, input: { minHeight: 49, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 14, fontSize: 15 }, multiline: { minHeight: 116, paddingVertical: 13, lineHeight: 21 }, tall: { minHeight: 255 }, albumChips: { gap: 8, paddingRight: 20 }, albumChip: { borderWidth: 1, height: 37, borderRadius: Radius.lg, justifyContent: "center", paddingHorizontal: 14 }, albumChipText: { ...Type.label }, saveButton: { minHeight: 53, borderRadius: Radius.md, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }, saveButtonText: { color: OnPrimary, fontSize: 15, fontWeight: "900" }, error: { fontSize: 15, textAlign: "center" }, modalShade: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.58)" }, coverSheet: { maxHeight: "93%", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 9 }, sheetHandle: { height: 4, width: 40, borderRadius: 3, alignSelf: "center", marginBottom: 12 }, dialogTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingBottom: 12 }, dialogHeading: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, dialogIcon: { height: 38, width: 38, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, dialogTitle: { fontSize: Type.heading.fontSize, lineHeight: Type.heading.lineHeight, fontWeight: "900" }, dialogSubtitle: { ...Type.caption, marginTop: 2 }, dialogContent: { gap: 12, padding: 20, paddingTop: 4, paddingBottom: 40 }, dialogIntro: { ...Type.caption, lineHeight: 17 }, contextLine: { minHeight: 57, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, paddingVertical: 9, justifyContent: "center", gap: 3 }, contextBlock: { gap: 6 }, contextLabel: { ...Type.caption, textTransform: "uppercase", letterSpacing: 0.35 }, contextValue: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, lyricsPreview: { borderWidth: 1, borderRadius: Radius.sm, padding: 12, minHeight: 78, ...Type.label, lineHeight: 18 }, noteInput: { minHeight: 92, borderWidth: 1, borderRadius: Radius.sm, padding: 12, ...Type.label, lineHeight: 19 }, guarantee: { borderWidth: 1, borderRadius: Radius.sm, padding: 12, flexDirection: "row", gap: 8, alignItems: "flex-start" }, guaranteeText: { flex: 1, ...Type.caption, lineHeight: 17 }, dialogGenerate: { minHeight: 52, borderRadius: Radius.md, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 2 }, dialogGenerateText: { color: OnPrimary, fontSize: 15, fontWeight: "900" } });
