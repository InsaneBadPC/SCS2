import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Field, IconButton, PrimaryButton, resolveAssetUrl } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { assetToBase64 } from "@/lib/file-base64";
import { trpc } from "@/lib/trpc";
import { Radius, Type } from "@/lib/design-tokens";

export default function NewAlbumScreen() {
  const colors = useColors();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [releaseYear, setReleaseYear] = useState("");
  const [description, setDescription] = useState("");
  const [cover, setCover] = useState<{ key: string; url: string } | null>(null);
  const upload = trpc.studio.upload.useMutation();
  const create = trpc.studio.createAlbum.useMutation();
  const saving = useRef(false);
  const uploadCover = async () => { const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 0.82, base64: true }); if (result.canceled) return; try { const asset = result.assets[0]; const base64 = await assetToBase64(asset.uri, asset.base64); const uploaded = await upload.mutateAsync({ folder: "covers", fileName: asset.fileName ?? `album-${Date.now()}.jpg`, contentType: asset.mimeType ?? "image/jpeg", base64 }); setCover({ key: uploaded.key, url: uploaded.url }); } catch (error) { Alert.alert("Obal se nepodařilo nahrát", error instanceof Error ? error.message : "Zkus jiný obrázek."); } };
  const save = async () => { if (saving.current) return; saving.current = true; if (!name.trim()) { saving.current = false; Alert.alert("Chybí název alba", "Doplň název, pod kterým chceš tvoji tvorbu třídit."); return; } try { await create.mutateAsync({ name: name.trim(), releaseYear: releaseYear ? Number(releaseYear) : null, description: description || null, coverStorageKey: cover?.key ?? null, coverUrl: cover?.url ?? null }); await utils.studio.snapshot.invalidate(); router.back(); } catch (error) { Alert.alert("Album se nepodařilo vytvořit", error instanceof Error ? error.message : "Zkus to znovu."); } saving.current = false; };
  return <ScreenContainer edges={["top", "bottom", "left", "right"]}><ScrollView contentContainerStyle={styles.content}><View style={styles.topbar}><IconButton label="Zpět" icon="arrow-back" onPress={() => router.back()} /><Text style={[styles.title, { color: colors.foreground }]}>Nové album</Text><View style={styles.spacer} /></View><Pressable onPress={() => void uploadCover()} style={({ pressed }) => [styles.cover, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>{cover ? <Image source={{ uri: resolveAssetUrl(cover.url) ?? cover.url }} style={styles.coverImage} resizeMode="contain" /> : <><MaterialIcons name="add-photo-alternate" size={30} color={colors.primary} /><Text style={[styles.coverText, { color: colors.foreground }]}>Přidat obal alba</Text></>}</Pressable><Field label="Název alba" value={name} onChangeText={setName} placeholder="Např. 2026" /><Field label="Rok" value={releaseYear} onChangeText={setReleaseYear} placeholder="2026" keyboardType="number-pad" /><Field label="Poznámka k albu" value={description} onChangeText={setDescription} placeholder="Zvuk, koncept nebo termín…" multiline /><PrimaryButton label={create.isPending ? "Vytvářím album" : "Vytvořit album"} icon="album" onPress={() => void save()} disabled={create.isPending} /></ScrollView></ScreenContainer>;
}

const styles = StyleSheet.create({ content: { padding: 20, paddingTop: 14, paddingBottom: 38, gap: 20 }, topbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, title: { ...Type.heading }, spacer: { width: 44 }, cover: { height: 180, borderWidth: 1, borderRadius: Radius.lg, alignItems: "center", justifyContent: "center", gap: 9, overflow: "hidden" }, coverImage: { width: "100%", height: "100%" }, coverText: { fontSize: 15, fontWeight: "800" }, field: { gap: 7 }, label: { fontSize: 15, fontWeight: "800" }, input: { minHeight: 49, borderWidth: 1, borderRadius: Radius.sm, paddingHorizontal: 14, fontSize: 15 }, multiline: { minHeight: 118, paddingVertical: 13, lineHeight: 21 } });
