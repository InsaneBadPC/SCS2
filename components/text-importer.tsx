import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { assetToBase64 } from "@/lib/file-base64";
import { cleanImportedText, splitImportedSongContent } from "@/lib/text-import";
import { trpc } from "@/lib/trpc";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

export function TextImporter() {
  const colors = useColors();
  const utils = trpc.useUtils();
  const createDocument = trpc.studio.createDocument.useMutation();
  const importDocx = trpc.studio.importDocx.useMutation();
  const importPdf = trpc.studio.importPdf.useMutation();
  const importGoogleDocument = trpc.studio.importGoogleDocument.useMutation();
  const [visible, setVisible] = useState(false);
  const [googleLinks, setGoogleLinks] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const pending = createDocument.isPending || importDocx.isPending || importPdf.isPending || importGoogleDocument.isPending;

  const finish = async (id: string) => { await utils.studio.snapshot.invalidate(); setVisible(false); router.push(`/text/${id}` as never); };
  const readFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ["text/plain", "text/markdown", "text/html", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream"], multiple: true, copyToCacheDirectory: true });
    if (result.canceled || !result.assets.length) return;
    const assets = result.assets;
    setProgress({ done: 0, total: assets.length });
    const createdIds: string[] = [];
    const failed: string[] = [];
    const processAsset = async (asset: { uri: string; name: string; mimeType?: string | null; base64?: string | null }) => {
      try {
        if (/^application\/vnd\.google-apps\./i.test(asset.mimeType ?? "")) { failed.push(asset.name); return; }
        if (/\.docx$/i.test(asset.name)) {
          const base64 = await assetToBase64(asset.uri, asset.base64);
          createdIds.push(await importDocx.mutateAsync({ fileName: asset.name, base64 }));
          return;
        }
        if (/\.pdf$/i.test(asset.name) || asset.mimeType === "application/pdf") {
          const base64 = await assetToBase64(asset.uri, asset.base64);
          createdIds.push(await importPdf.mutateAsync({ fileName: asset.name, base64 }));
          return;
        }
        if (!/\.(txt|md|markdown|html?|csv)$/i.test(asset.name)) {
          try {
            const raw = Platform.OS === "web" ? await fetch(asset.uri).then((response) => response.text()) : await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
            if (/[\u0100-\uFFFF]/.test(raw.slice(0, 4000)) || /<html|<!doctype/i.test(raw.slice(0, 200))) {
              const imported = splitImportedSongContent(cleanImportedText(raw, asset.name));
              if (imported.lyrics.trim()) {
                const title = asset.name.replace(/\.[^.]+$/, "") || "Importovaný text";
                createdIds.push(await createDocument.mutateAsync({ title, albumId: null, stylePrompt: imported.stylePrompt, lyrics: imported.lyrics, notes: `Importováno ze souboru ${asset.name}`, coverStorageKey: null, coverUrl: null }));
                return;
              }
            }
          } catch {}
          failed.push(asset.name);
          return;
        }
        const raw = Platform.OS === "web" ? await fetch(asset.uri).then((response) => response.text()) : await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
        const imported = splitImportedSongContent(cleanImportedText(raw, asset.name));
        if (!imported.lyrics) throw new Error("empty");
        const title = asset.name.replace(/\.[^.]+$/, "") || "Importovaný text";
        createdIds.push(await createDocument.mutateAsync({ title, albumId: null, stylePrompt: imported.stylePrompt, lyrics: imported.lyrics, notes: `Importováno ze souboru ${asset.name}`, coverStorageKey: null, coverUrl: null }));
      } catch {
        failed.push(asset.name);
      } finally {
        setProgress((current) => (current ? { ...current, done: current.done + 1 } : current));
      }
    };
    try {
      let cursor = 0;
      const workers = Array.from({ length: Math.max(1, Math.min(4, assets.length)) }, async () => {
        while (cursor < assets.length) {
          const asset = assets[cursor];
          cursor += 1;
          await processAsset(asset);
        }
      });
      await Promise.all(workers);
    } finally {
      setProgress(null);
    }
    if (!createdIds.length) {
      Alert.alert(
        failed.length ? "Tyto soubory se importovat nepodařilo" : "Nic se neimportovalo",
        `${failed.slice(0, 10).map((name) => `• ${name}`).join("\n")}${failed.length > 10 ? `\n• …a dalších ${failed.length - 10}` : ""}${failed.length ? "\n\n" : ""}Pokud jde o živé Google Dokumenty z Disku, stáhni je nejprve jako PDF nebo DOCX, případně použij import přes odkaz níže.`,
      );
      return;
    }
    await utils.studio.snapshot.invalidate();
    setVisible(false);
    if (failed.length) Alert.alert("Import částečně dokončen", `Vytvořeno ${createdIds.length} textů. Nepodařilo se ${failed.length}: ${failed.slice(0, 6).join(", ")}${failed.length > 6 ? "…" : ""}`);
    else if (createdIds.length === 1) router.push(`/text/${createdIds[0]}` as never);
    else Alert.alert("Import dokončen", `Bylo vytvořeno ${createdIds.length} nových textů. Najdeš je v katalogu Texty.`);
  };
  const importGoogle = async () => {
    const links = googleLinks.split(/\n+/).map((line) => line.trim()).filter((line) => /^https:\/\/docs\.google\.com\//.test(line));
    if (!links.length) { Alert.alert("Chybí odkazy", "Vlož aspoň jeden odkaz na Google Dokument (docs.google.com/…). Každý odkaz na nový řádek."); return; }
    try {
      const createdIds: string[] = [];
      const failed: string[] = [];
      setProgress({ done: 0, total: links.length });
      for (const [index, link] of links.entries()) {
        try { createdIds.push(await importGoogleDocument.mutateAsync({ url: link })); } catch { failed.push(`odkaz ${index + 1}`); }
        setProgress({ done: index + 1, total: links.length });
      }
      setProgress(null);
      if (!createdIds.length) throw new Error("Žádný z dokumentů se nepodařilo načíst. Ověř, že jsou sdílené „pro každého s odkazem“.");
      await utils.studio.snapshot.invalidate();
      setVisible(false); setGoogleLinks("");
      if (failed.length) Alert.alert("Import částečně dokončen", `Vytvořeno ${createdIds.length} textů, ${failed.length} odkazů se nepodařilo načíst.`);
      else if (createdIds.length === 1) router.push(`/text/${createdIds[0]}` as never);
      else Alert.alert("Import dokončen", `Bylo vytvořeno ${createdIds.length} nových textů. Najdeš je v katalogu Texty.`);
    } catch (error) { Alert.alert("Google Dokumenty se nepodařilo importovat", error instanceof Error ? error.message : "Ověř, že jsou sdílené pro každého s odkazem."); }
  };

  return <><Pressable onPress={() => setVisible(true)} style={({ pressed }) => [styles.trigger, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.68 : 1 }]}><MaterialIcons name="file-download" size={20} color={colors.primary} /><Text style={[styles.triggerText, { color: colors.foreground }]}>Importovat</Text></Pressable>
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => setVisible(false)}><View style={styles.shade}><View style={[styles.sheet, { backgroundColor: colors.background }]}><View style={[styles.handle, { backgroundColor: colors.border }]} /><View style={styles.top}><View><Text style={[styles.title, { color: colors.foreground }]}>Importovat text</Text><Text style={[styles.subtitle, { color: colors.muted }]}>Vznikne nový návrh v katalogu textů.</Text></View><Pressable onPress={() => setVisible(false)} style={[styles.close, { backgroundColor: colors.surface }]}><MaterialIcons name="close" size={20} color={colors.foreground} /></Pressable></View>
      <View style={[styles.importCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.cardIcon, { backgroundColor: `${colors.primary}1A` }]}><MaterialIcons name="description" size={22} color={colors.primary} /></View><View style={styles.cardCopy}><Text style={[styles.cardTitle, { color: colors.foreground }]}>Soubory z telefonu nebo webu</Text><Text style={[styles.cardText, { color: colors.muted }]}>TXT, Markdown, HTML, CSV, DOCX i PDF. Můžeš vybrat více souborů najednou.</Text><Text style={[styles.hint, { color: colors.primary }]}>💡 V dialogu nejprve dlouze podrž prst na prvním souboru, pak můžeš klepat na další.</Text></View></View>{progress ? <View style={[styles.progressBox, { borderColor: `${colors.primary}66` }]}><ActivityIndicator size="small" color={colors.primary} /><Text style={[styles.progressText, { color: colors.foreground }]}>Importuji {progress.done}/{progress.total}…</Text></View> : null}<Pressable disabled={pending} onPress={() => void readFile()} style={({ pressed }) => [styles.action, { backgroundColor: colors.primary, opacity: pending || pressed ? 0.65 : 1 }]}><MaterialIcons name="upload-file" size={19} color={OnPrimary} /><Text style={styles.actionText}>{pending ? "Importuji…" : "Vybrat textové soubory"}</Text></Pressable>
      <View style={styles.divider}><View style={[styles.line, { backgroundColor: colors.border }]} /><Text style={[styles.or, { color: colors.muted }]}>nebo</Text><View style={[styles.line, { backgroundColor: colors.border }]} /></View>
      <View style={[styles.importCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.cardIcon, { backgroundColor: `${colors.primary}1A` }]}><MaterialIcons name="article" size={22} color={colors.primary} /></View><View style={styles.cardCopy}><Text style={[styles.cardTitle, { color: colors.foreground }]}>Google Dokumenty přes odkaz</Text><Text style={[styles.cardText, { color: colors.muted }]}>V Drive u dokumentu zvol Sdílet → Kopírovat odkaz („pro každého s odkazem“). Názvy se načtou automaticky.</Text></View></View><TextInput value={googleLinks} onChangeText={setGoogleLinks} autoCapitalize="none" autoCorrect={false} multiline textAlignVertical="top" placeholder={"https://docs.google.com/document/d/…\nhttps://docs.google.com/document/d/…"} placeholderTextColor={colors.muted} style={[styles.input, styles.linksInput, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]} /><Pressable disabled={pending} onPress={() => void importGoogle()} style={({ pressed }) => [styles.outlineAction, { borderColor: colors.primary, opacity: pending || pressed ? 0.65 : 1 }]}><MaterialIcons name="cloud-download" size={19} color={colors.primary} /><Text style={[styles.outlineText, { color: colors.primary }]}>{importGoogleDocument.isPending ? "Načítám dokumenty…" : "Importovat Google Dokumenty"}</Text></Pressable>
    </View></View></Modal></>;
}

const styles = StyleSheet.create({ trigger: { height: 42, borderRadius: Radius.sm, borderWidth: 1, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6 }, triggerText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, shade: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.48)" }, sheet: { borderTopLeftRadius: 27, borderTopRightRadius: 27, paddingHorizontal: 20, paddingBottom: 28 }, handle: { width: 42, height: 4, borderRadius: 3, alignSelf: "center", marginVertical: 10 }, top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 15 }, title: { fontSize: Type.heading.fontSize, lineHeight: Type.heading.lineHeight, fontWeight: "900" }, subtitle: { ...Type.caption, marginTop: 3 }, close: { width: 38, height: 38, borderRadius: Radius.sm, justifyContent: "center", alignItems: "center" }, importCard: { borderWidth: 1, borderRadius: Radius.md, padding: 12, flexDirection: "row", gap: 10, marginBottom: 10 }, cardIcon: { width: 39, height: 39, borderRadius: Radius.sm, justifyContent: "center", alignItems: "center" }, cardCopy: { flex: 1, gap: 3 }, cardTitle: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, cardText: { ...Type.caption, lineHeight: 15 }, hint: { ...Type.caption, marginTop: 5, lineHeight: 15 }, action: { minHeight: 48, borderRadius: Radius.sm, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }, actionText: { color: OnPrimary, fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, divider: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 15 }, line: { flex: 1, height: 1 }, or: { ...Type.caption }, input: { minHeight: 46, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, ...Type.label, marginBottom: 8 }, linksInput: { minHeight: 92, paddingVertical: 10, lineHeight: 18 }, outlineAction: { minHeight: 48, borderRadius: Radius.sm, borderWidth: 1, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" }, outlineText: { fontSize: Type.label.fontSize, lineHeight: Type.label.lineHeight, fontWeight: "900" }, progressBox: { minHeight: 44, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 9 }, progressText: { ...Type.label, flex: 1 } });
