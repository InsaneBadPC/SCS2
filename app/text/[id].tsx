import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AlbumChip, Field, IconButton, LoadingState, PrimaryButton, SectionTitle, StatusChip } from "@/components/studio-ui";
import { RhymeFinder } from "@/components/rhyme-finder";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { pickImage } from "@/lib/pick-media";
import { clearDraft, loadDraft, shouldRestoreDraft, useDraftStorage } from "@/lib/use-draft-storage";
import { trpc } from "@/lib/trpc";
import { useUndoableText } from "@/lib/use-undoable-text";
import { Radius, Type } from "@/lib/design-tokens";

type EditorForm = { title: string; albumId: string | null; stylePrompt: string; lyrics: string; notes: string; coverStorageKey: string | null; coverUrl: string | null };
const emptyForm: EditorForm = { title: "", albumId: null, stylePrompt: "", lyrics: "", notes: "", coverStorageKey: null, coverUrl: null };

export default function TextEditorScreen() {
  const colors = useColors();
  const { id: rawId } = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(rawId) ? rawId[0] ?? null : rawId === "new" || !rawId ? null : rawId;
  const { isAuthenticated, user } = useAuth();
  const utils = trpc.useUtils();
  const userId = user?.id ?? null;
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const document = useMemo(() => snapshot.data?.documents.find((item) => item.id === id), [id, snapshot.data?.documents]);
  const [form, setForm] = useState<EditorForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const upload = trpc.studio.upload.useMutation();
  const create = trpc.studio.createDocument.useMutation();
  const update = trpc.studio.updateDocument.useMutation();
  const complete = trpc.studio.completeDocument.useMutation();
  const createCoverGeneration = trpc.studio.createCoverGeneration.useMutation();
  const checkCoverGeneration = trpc.studio.checkCoverGeneration.useMutation();
  const [coverGenerating, setCoverGenerating] = useState(false);
  const lyricsHistory = useUndoableText("");
  const { reset: resetLyricsHistory } = lyricsHistory;
  const [draftReady, setDraftReady] = useState(false);
  const draftRunRef = useRef(0);
  const documentUpdatedAt = document?.updatedAt instanceof Date ? document.updatedAt.getTime() : document?.updatedAt ? new Date(document.updatedAt as unknown as string).getTime() : null;

  useEffect(() => {
    const run = ++draftRunRef.current;
    setDraftReady(false);
    setDraftRestored(false);
    if (!userId) {
      setForm(emptyForm);
      resetLyricsHistory("");
      return;
    }
    if (id && snapshot.isLoading) {
      setForm(emptyForm);
      resetLyricsHistory("");
      return;
    }

    const serverForm: EditorForm = document ? {
      title: document.title,
      albumId: document.albumId,
      stylePrompt: document.stylePrompt ?? "",
      lyrics: document.lyrics ?? "",
      notes: document.notes ?? "",
      coverStorageKey: document.coverStorageKey,
      coverUrl: document.coverUrl,
    } : emptyForm;
    setForm(serverForm);
    resetLyricsHistory(serverForm.lyrics);

    let cancelled = false;
    void loadDraft(id, userId, "text").then((draft) => {
      if (cancelled || run !== draftRunRef.current) return;
      if (draft && shouldRestoreDraft(documentUpdatedAt, draft.savedAt)) {
        setForm({ title: draft.title, albumId: draft.albumId, stylePrompt: draft.stylePrompt, lyrics: draft.lyrics, notes: draft.notes, coverStorageKey: draft.coverStorageKey, coverUrl: draft.coverUrl });
        resetLyricsHistory(draft.lyrics);
        setDraftRestored(true);
      } else if (draft) {
        void clearDraft(id, userId, "text");
      }
      setDraftReady(true);
    });

    return () => { cancelled = true; };
    // Server fields are listed individually so a new cache object does not wipe an unsaved form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document?.albumId, document?.coverStorageKey, document?.coverUrl, document?.id, document?.lyrics, document?.notes, document?.stylePrompt, document?.title, documentUpdatedAt, id, resetLyricsHistory, snapshot.isLoading, userId]);

  useDraftStorage(form, id, userId, draftReady, "text");
  if (isAuthenticated && userId && !draftReady && (!id || document)) return <ScreenContainer><LoadingState /></ScreenContainer>;
  if (id && snapshot.isLoading) return <ScreenContainer><LoadingState /></ScreenContainer>;

  const save = async () => {
    if (!form.title.trim()) { Alert.alert("Chybí název", "Doplň název skladby nebo konceptu."); return null; }
    setSaving(true);
    try {
      const payload = { title: form.title.trim(), albumId: form.albumId, stylePrompt: form.stylePrompt || null, lyrics: form.lyrics || null, notes: form.notes || null, coverStorageKey: form.coverStorageKey, coverUrl: form.coverUrl };
      const savedId = id ? (await update.mutateAsync({ id, ...payload }), id) : await create.mutateAsync(payload);
      await clearDraft(id ?? null, userId, "text");
      await clearDraft(savedId, userId, "text");
      setDraftRestored(false);
      await utils.studio.snapshot.invalidate();
      if (!id) router.replace(`/text/${savedId}` as never);
      return savedId;
    } catch (error) { Alert.alert("Uložení se nezdařilo", error instanceof Error ? error.message : "Zkus to znovu."); return null; } finally { setSaving(false); }
  };
  const uploadCover = async () => {
    try {
      const picked = await pickImage();
      if (!picked) return;
      const uploaded = await upload.mutateAsync({ folder: "covers", fileName: picked.fileName, contentType: picked.mimeType, bytes: picked.bytes });
      setForm((current) => ({ ...current, coverStorageKey: uploaded.key, coverUrl: uploaded.url }));
    } catch (error) { Alert.alert("Přebal se nepodařilo nahrát", error instanceof Error ? error.message : "Zkus jiný obrázek."); }
  };
  const generateCover = async () => {
    if (!id) { Alert.alert("Nejprve text ulož", "AI vytváří obal z uloženého názvu, promptu a textu. Nejdřív klepni na Uložit."); return; }
    setCoverGenerating(true);
    try {
      const created = await createCoverGeneration.mutateAsync({ entityType: "lyric", entityId: id, format: "youtube_16_9" });
      for (let attempt = 0; attempt < 36; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const status = await checkCoverGeneration.mutateAsync({ entityType: "lyric", entityId: id, jobId: created.jobId, format: "youtube_16_9" });
        if (status.status === "completed") { await utils.studio.snapshot.invalidate(); Alert.alert("Obrázek je připravený", "Nový 16:9 obal byl uložen k textu a použije se i pro YouTube video."); return; }
        if (status.status === "failed") throw new Error(status.error);
      }
      Alert.alert("Obal je stále ve frontě", "Bezplatná AI má nyní delší frontu. Zkus to za chvíli znovu.");
    } catch (error) { Alert.alert("Obrázek se nepodařilo vytvořit", error instanceof Error ? error.message : "Zkus to znovu za chvíli."); } finally { setCoverGenerating(false); }
  };
  const markComplete = async () => { const saved = await save(); if (!saved) return; try { await complete.mutateAsync({ id: saved }); await utils.studio.snapshot.invalidate(); Alert.alert("Skladba je hotová", "Text byl zařazen do knihovny skladeb.", [{ text: "Otevřít knihovnu", onPress: () => router.replace("/(tabs)/library" as never) }]); } catch (error) { Alert.alert("Změna stavu se nezdařila", error instanceof Error ? error.message : "Zkus to znovu."); } };
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
  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0} style={{ flex: 1 }}><ScrollView contentContainerStyle={[styles.content, { paddingBottom: 180 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>{draftRestored ? <View style={[styles.draftNotice, { backgroundColor: `${colors.accent}14`, borderColor: `${colors.accent}55` }]}><MaterialIcons name="restore" size={16} color={colors.accent} /><Text style={[styles.draftNoticeText, { color: colors.foreground }]}>Obnoven rozpracovaný text — klepni na Uložit pro potvrzení.</Text></View> : null}<View style={styles.topbar}><IconButton label="Zpět" icon="arrow-back" onPress={() => router.back()} /><View style={styles.topbarTitle}><Text numberOfLines={1} style={[styles.topbarName, { color: colors.foreground }]}>{id ? "Editor textu" : "Nový text"}</Text>{document ? <StatusChip state={document.status} /> : null}</View><Pressable onPress={() => void save()} style={({ pressed }) => [styles.save, { opacity: saving || pressed ? 0.6 : 1 }]}><Text style={[styles.saveText, { color: colors.primary }]}>{saving ? "Ukládám" : "Uložit"}</Text></Pressable></View>
    <View style={styles.coverBlock}>
    <Pressable onPress={() => void uploadCover()} style={({ pressed }) => [styles.cover, { borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed ? 0.72 : 1 }]}>{form.coverUrl ? <Image source={{ uri: form.coverUrl }} style={styles.coverImage} resizeMode="contain" /> : <><View style={[styles.coverIcon, { backgroundColor: `${colors.primary}20` }]}><MaterialIcons name="add-photo-alternate" size={25} color={colors.primary} /></View><Text style={[styles.coverTitle, { color: colors.foreground }]}>Přidat přebal skladby</Text><Text style={[styles.coverText, { color: colors.muted }]}>Použiješ ho v katalogu i při přípravě obrázku pro YouTube.</Text></>}</Pressable>
    <Pressable onPress={() => void generateCover()} disabled={coverGenerating} style={({ pressed }) => [styles.generateCover, { borderColor: colors.primary, backgroundColor: `${colors.primary}12`, opacity: coverGenerating || pressed ? 0.62 : 1 }]}><MaterialIcons name={coverGenerating ? "hourglass-top" : "auto-awesome"} size={19} color={colors.primary} /><View style={styles.generateCopy}><Text style={[styles.generateTitle, { color: colors.primary }]}>{coverGenerating ? "Bezplatná AI vytváří 16:9 obal…" : "Vygenerovat obrázek skladby 16:9"}</Text><Text style={[styles.generateText, { color: colors.muted }]}>{id ? "Vytvoří široký obal z názvu, stylu a textu — ideální pro YouTube." : "Nejdřív text ulož, pak můžeš vytvořit obal."}</Text></View></Pressable>
    </View>
    <Field label="Název" value={form.title} onChangeText={(title) => setForm((current) => ({ ...current, title }))} placeholder="Např. Noční signál" autoFocus={!id} />
    <SectionTitle title="Zařazení do alba" />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.albumChips}><AlbumChip active={!form.albumId} label="Bez alba" onPress={() => setForm((current) => ({ ...current, albumId: null }))} />{snapshot.data?.albums.map((album) => <AlbumChip key={album.id} active={form.albumId === album.id} label={album.name} onPress={() => setForm((current) => ({ ...current, albumId: album.id }))} />)}</ScrollView>
    <Field label="Prompt stylu pro hudební generátor" value={form.stylePrompt} onChangeText={(stylePrompt) => setForm((current) => ({ ...current, stylePrompt }))} placeholder="Žánr, tempo, nálada, nástroje, hlas…" multiline helper="V hotové skladbě jej zkopíruješ jedním klepnutím." />
    <View style={styles.lyricsHead}><Text style={[styles.lyricsLabel, { color: colors.foreground }]}>Text písně</Text><View style={styles.historyRow}><Pressable onPress={undoLyrics} disabled={!lyricsHistory.canUndo} style={({ pressed }) => [styles.historyButton, { borderColor: colors.border, backgroundColor: colors.surface, opacity: !lyricsHistory.canUndo || pressed ? 0.4 : 1 }]}><MaterialIcons name="undo" size={18} color={colors.primary} /><Text style={[styles.historyButtonText, { color: colors.primary }]}>Zpět</Text></Pressable><Pressable onPress={redoLyrics} disabled={!lyricsHistory.canRedo} style={({ pressed }) => [styles.historyButton, { borderColor: colors.border, backgroundColor: colors.surface, opacity: !lyricsHistory.canRedo || pressed ? 0.4 : 1 }]}><MaterialIcons name="redo" size={18} color={colors.primary} /><Text style={[styles.historyButtonText, { color: colors.primary }]}>Vpřed</Text></Pressable></View></View>
    <TextInput value={lyricsHistory.value} onChangeText={updateLyrics} placeholder="[Verse]\n…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" disableFullscreenUI style={[styles.input, styles.tall, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <Field label="Poznámky k produkci" value={form.notes} onChangeText={(notes) => setForm((current) => ({ ...current, notes }))} placeholder="Aranž, reference, nápady na klip…" multiline />
    <View style={[styles.completeBox, { backgroundColor: `${colors.success}16`, borderColor: `${colors.success}55` }]}><MaterialIcons name="check-circle" size={23} color={colors.success} /><View style={styles.completeCopy}><Text style={[styles.completeTitle, { color: colors.foreground }]}>Připraveno pro knihovnu?</Text><Text style={[styles.completeText, { color: colors.muted }]}>Označením zůstane dokument zachovaný a vytvoří se katalogová skladba.</Text></View></View><PrimaryButton label={document?.status === "complete" ? "Aktualizovat hotovou skladbu" : "Označit jako hotové"} icon="task-alt" onPress={() => void markComplete()} disabled={saving || complete.isPending} />
   </ScrollView></KeyboardAvoidingView><RhymeFinder variant="floating" onInsert={(word) => { const next = `${lyricsHistory.value}${lyricsHistory.value && !/\s$/.test(lyricsHistory.value) ? " " : ""}${word}`; updateLyrics(next, false); }} /></ScreenContainer>;
}

const styles = StyleSheet.create({ content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 18 }, draftNotice: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, paddingVertical: 9 }, draftNoticeText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontWeight: "600" }, topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }, topbarTitle: { flex: 1, alignItems: "center", gap: 4 }, topbarName: { fontSize: 15, fontWeight: "800" }, save: { minWidth: 49, minHeight: 42, alignItems: "flex-end", justifyContent: "center" }, saveText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, coverBlock: { gap: 9 }, lyricsHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }, lyricsLabel: { fontSize: 15, fontWeight: "800" }, historyRow: { flexDirection: "row", gap: 7 }, historyButton: { height: 34, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 5 }, historyButtonText: { fontSize: 12.5, fontWeight: "900" }, generateCover: { minHeight: 62, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 }, generateCopy: { flex: 1, gap: 2 }, generateTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, generateText: { ...Type.caption, lineHeight: 15 }, cover: { minHeight: 135, borderWidth: 1, borderRadius: Radius.lg, padding: 18, alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden" }, coverImage: { width: "100%", height: 210, borderRadius: Radius.sm }, coverIcon: { width: 47, height: 47, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" }, coverTitle: { fontSize: 15, fontWeight: "800" }, coverText: { ...Type.caption, textAlign: "center", lineHeight: 17 }, field: { gap: 7 }, fieldLabel: { fontSize: 15, fontWeight: "800" }, fieldHelper: { ...Type.caption, lineHeight: 17 }, input: { minHeight: 49, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 14, fontSize: 15 }, multiline: { minHeight: 116, paddingVertical: 13, lineHeight: 21 }, tall: { minHeight: 255 }, albumChips: { gap: 8, paddingRight: 20 }, albumChip: { borderWidth: 1, height: 37, borderRadius: Radius.lg, justifyContent: "center", paddingHorizontal: 14 }, albumChipText: { ...Type.label }, completeBox: { flexDirection: "row", gap: 11, padding: 14, borderRadius: Radius.md, borderWidth: 1 }, completeCopy: { flex: 1, gap: 3 }, completeTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "800" }, completeText: { ...Type.caption, lineHeight: 17 } });
