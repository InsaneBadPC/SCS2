import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { EmptyState, IconButton, LoadingState, RatingStars, SectionTitle } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { setPickedStylePrompt } from "@/lib/style-prompt-picker";
import { trpc } from "@/lib/trpc";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

export default function StylePromptLibraryScreen() {
  const colors = useColors();
  const { pick } = useLocalSearchParams<{ pick?: string }>();
  const pickMode = pick === "1" || pick === "true";
  const { isAuthenticated, loading } = useAuth();
  const utils = trpc.useUtils();
  const snapshot = trpc.studio.snapshot.useQuery(undefined, { enabled: isAuthenticated });
  const createPrompt = trpc.studio.createStylePrompt.useMutation();
  const updatePrompt = trpc.studio.updateStylePrompt.useMutation();
  const deletePrompt = trpc.studio.deleteStylePrompt.useMutation();

  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [rating, setRating] = useState(0);
  const [sortByStars, setSortByStars] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editNote, setEditNote] = useState("");

  const prompts = useMemo(() => {
    const list = [...(snapshot.data?.stylePrompts ?? [])];
    return sortByStars
      ? list.sort((left, right) => right.rating - left.rating || right.updatedAt.getTime() - left.updatedAt.getTime())
      : list.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }, [snapshot.data?.stylePrompts, sortByStars]);

  if (loading || (isAuthenticated && snapshot.isLoading)) return <ScreenContainer><LoadingState label="Otevírám databázi promptů…" /></ScreenContainer>;
  if (!isAuthenticated) return <ScreenContainer centered><EmptyState icon="lock" title="Přihlášení je potřeba" text="Databáze promptů je součást tvého soukromého cloudového studia." action={<Pressable onPress={() => void startPrivateLogin()} style={[styles.login, { backgroundColor: colors.primary }]}><Text style={styles.loginText}>Přihlásit se</Text></Pressable>} /></ScreenContainer>;

  const saveNew = async () => {
    if (!content.trim()) { Alert.alert("Chybí text promptu", "Zapiš prompt, který chceš do databáze uložit."); return; }
    try {
      await createPrompt.mutateAsync({ content, note: note || null, rating });
      await utils.studio.snapshot.invalidate();
      setContent(""); setNote(""); setRating(0);
    } catch (error) { Alert.alert("Uložení se nezdařilo", error instanceof Error ? error.message : "Zkus to znovu."); }
  };
  const rate = async (id: string, value: number) => {
    try { await updatePrompt.mutateAsync({ id, rating: value }); await utils.studio.snapshot.invalidate(); } catch { Alert.alert("Hodnocení se nepodařilo uložit", "Zkus to znovu."); }
  };
  const remove = (id: string) => Alert.alert("Smazat prompt?", "Prompt zmizí z databáze. Skladby, kde je použitý, se nezmění.", [{ text: "Zrušit", style: "cancel" }, { text: "Smazat", style: "destructive", onPress: async () => { try { await deletePrompt.mutateAsync({ id }); await utils.studio.snapshot.invalidate(); } catch { Alert.alert("Mazání se nezdařilo", "Zkus to znovu."); } } }]);
  const copyPrompt = async (text: string) => { try { await Clipboard.setStringAsync(text); Alert.alert("Zkopírováno", "Prompt je ve schránce."); } catch {} };
  const applyPrompt = (text: string) => {
    if (!pickMode) return;
    setPickedStylePrompt(text);
    router.back();
  };

  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={styles.topbar}><IconButton label="Zpět" icon="arrow-back" onPress={() => router.back()} /><Text numberOfLines={1} style={[styles.title, { color: colors.foreground }]}>Databáze promptů</Text><View style={styles.spacer} /></View>
    <View style={[styles.intro, { backgroundColor: `${colors.primary}13`, borderColor: `${colors.primary}45` }]}><MaterialIcons name="library-books" size={20} color={colors.primary} /><Text style={[styles.introText, { color: colors.muted }]}>Knihovna tvých osvědčených promptů pro hudební generátory. U každého můžeš vést poznámku a hvězdičkové hodnocení; řazení podle hvězd je výchozí.</Text></View>

    <SectionTitle title="Nový prompt" />
    <TextInput value={content} onChangeText={setContent} placeholder="Např. Temný synthwave, 92 BPM, hluboký mužský vokál, analogový bas…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.input, styles.contentInput, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <TextInput value={note} onChangeText={setNote} placeholder="Poznámka (volitelná) — k čemu se prompt hodí…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.input, styles.noteInput, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]} />
    <View style={styles.newRow}>
      <RatingStars rating={rating} onRate={setRating} size={26} />
      <Pressable onPress={() => void saveNew()} disabled={createPrompt.isPending || !content.trim()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary, opacity: !content.trim() || createPrompt.isPending || pressed ? 0.55 : 1 }]}>
        <MaterialIcons name="bookmark-add" size={18} color={OnPrimary} /><Text style={styles.saveButtonText}>{createPrompt.isPending ? "Ukládám…" : "Uložit do databáze"}</Text>
      </Pressable>
    </View>

    <SectionTitle title={`${prompts.length} ${prompts.length === 1 ? "prompt" : prompts.length < 5 ? "prompty" : "promptů"} v databázi`} />
    <Pressable onPress={() => setSortByStars((current) => !current)} style={({ pressed }) => [styles.sortControl, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.68 : 1 }]}>
      <MaterialIcons name={sortByStars ? "star" : "schedule"} size={17} color={colors.primary} /><Text style={[styles.sortText, { color: colors.foreground }]}>{sortByStars ? "Řazení: podle hvězdiček" : "Řazení: nejnovější"}</Text><MaterialIcons name="swap-vert" size={18} color={colors.muted} />
    </Pressable>
    {prompts.length ? prompts.map((entry) => (
      <View key={entry.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.cardHead}>
          <RatingStars rating={entry.rating} onRate={(value) => void rate(entry.id, value)} size={19} />
          <View style={styles.cardActions}>
            <IconButton label="Kopírovat" icon="content-copy" onPress={() => void copyPrompt(entry.content)} />
            {pickMode ? <IconButton label="Použít" icon="check" onPress={() => applyPrompt(entry.content)} /> : null}
            <IconButton label="Upravit" icon="edit" onPress={() => { setEditingId(entry.id); setEditContent(entry.content); setEditNote(entry.note ?? ""); }} />
            <IconButton label="Smazat" icon="delete-outline" onPress={() => remove(entry.id)} />
          </View>
        </View>
        {editingId === entry.id ? (
          <View style={styles.editBox}>
            <TextInput value={editContent} onChangeText={setEditContent} multiline textAlignVertical="top" style={[styles.input, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]} />
            <TextInput value={editNote} onChangeText={setEditNote} placeholder="Poznámka…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.input, styles.noteInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]} />
            <View style={styles.editRow}>
              <PrimarySmall label="Uložit změny" onPress={async () => { try { await updatePrompt.mutateAsync({ id: entry.id, content: editContent, note: editNote || null }); await utils.studio.snapshot.invalidate(); setEditingId(null); } catch { Alert.alert("Uložení se nezdařilo", "Zkus to znovu."); } }} colors={colors} />
              <PrimarySmall label="Zrušit" onPress={() => setEditingId(null)} muted colors={colors} />
            </View>
          </View>
        ) : (
          <>
            <Pressable disabled={!pickMode} onPress={() => applyPrompt(entry.content)} style={({ pressed }) => ({ opacity: pressed && pickMode ? 0.7 : 1 })}>
              <Text style={[styles.promptText, { color: colors.foreground }]}>{entry.content}</Text>
              {entry.note ? <Text style={[styles.noteText, { color: colors.muted }]}>📝 {entry.note}</Text> : null}
              {!pickMode ? null : <Text style={[styles.pickHint, { color: colors.primary }]}>Klepnutím použiješ tento prompt ve skladbě</Text>}
            </Pressable>
          </>
        )}
      </View>
    )) : <EmptyState icon="library-books" title="Databáze je prázdná" text="Ulož si první prompt — příště ho jen vybereš a nemusíš ho psát znovu." />}
  </ScrollView></ScreenContainer>;
}

function PrimarySmall({ label, onPress, muted, colors }: { label: string; onPress: () => void; muted?: boolean; colors: ReturnType<typeof useColors> }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.smallButton, { backgroundColor: muted ? colors.surface : colors.primary, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}><Text style={[styles.smallButtonText, { color: muted ? colors.muted : OnPrimary }]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 13 },
  topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 16, fontWeight: "900" },
  spacer: { width: 44 },
  intro: { borderWidth: 1, borderRadius: Radius.md, padding: 12, flexDirection: "row", gap: 9, alignItems: "center" },
  introText: { flex: 1, ...Type.caption, lineHeight: 17 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 13, ...Type.label },
  contentInput: { minHeight: 84, paddingVertical: 11, lineHeight: 20 },
  noteInput: { minHeight: 58, lineHeight: 18 },
  newRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  stars: { flexDirection: "row", gap: 2, alignItems: "center" },
  saveButton: { minHeight: 44, borderRadius: Radius.sm, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  saveButtonText: { color: OnPrimary, fontWeight: "900", fontSize: 13.5 },
  sortControl: { minHeight: 40, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 7 },
  sortText: { flex: 1, fontSize: 12.5, fontWeight: "800" },
  card: { borderWidth: 1, borderRadius: Radius.md, padding: 13, gap: 10 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardActions: { flexDirection: "row", alignItems: "center" },
  promptText: { ...Type.label, lineHeight: 21 },
  noteText: { marginTop: 6, ...Type.caption, lineHeight: 16 },
  pickHint: { marginTop: 6, fontSize: 11.5, fontWeight: "800" },
  editBox: { gap: 8 },
  editRow: { flexDirection: "row", gap: 8 },
  smallButton: { minHeight: 38, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 13, alignItems: "center", justifyContent: "center" },
  smallButtonText: { fontWeight: "900", fontSize: 12.5 },
  login: { minHeight: 48, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  loginText: { color: OnPrimary, fontWeight: "800" },
});
