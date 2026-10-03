// Výběr obrázku nebo videa z galerie.
//
// Proč to existuje: v appce byla tři místa, kde se obrázek načítal přímo přes
// ImagePicker. Android 13+ ale bez běžového oprávnění READ_MEDIA_IMAGES galerii
// vůbec neotevře, a výjimka z launchImageLibraryAsync v žádném z nich nebyla
// uvnitř try/catch — takže se chyba ztratila a UI vypadalo, jako by se nic
// nestalo. Tady se oprávnění vyžádá, výjimka je vždy zachycena a soubor se
// čte jako binární data (base64 řetězec velké fotky na Androidu umí aplikaci
// ukončit — přesně kvůli tomu existuje assetToArrayBuffer pro zvuk).

import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

import { assetToArrayBuffer } from "./file-base64";

export type PickedMedia = {
  bytes: ArrayBuffer;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

const IMAGE_PICK = { mediaTypes: ["images"] as ImagePicker.MediaType[], allowsEditing: false, quality: 0.92 };
const VIDEO_PICK = { mediaTypes: ["videos"] as ImagePicker.MediaType[], allowsEditing: false };

function extensionFor(mime: string, fallback: string) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/quicktime") return "mov";
  return fallback;
}

async function ensurePermission(): Promise<void> {
  if (Platform.OS === "web") return;
  const current = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (current.granted) return;
  const asked = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (asked.granted) return;
  if (asked.canAskAgain === false) {
    throw new Error("Aplikace nemá přístup k fotkám. Povol ho v Nastavení systému → Aplikace → SCS2 → Fotky a videa.");
  }
  throw new Error("Bez přístupu k fotkám nemůžu vybrat soubor.");
}

async function pick(kind: "images" | "videos"): Promise<PickedMedia | null> {
  await ensurePermission();
  const result = kind === "images"
    ? await ImagePicker.launchImageLibraryAsync(IMAGE_PICK)
    : await ImagePicker.launchImageLibraryAsync(VIDEO_PICK);
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;

  // Binárně, ne base64. Zbytečně velký base64 řetězec je na Androidu riziko.
  const bytes = await assetToArrayBuffer(asset.uri, null);
  if (!bytes || bytes.byteLength === 0) throw new Error("Vybraný soubor se nepodařilo načíst.");

  const declared = asset.mimeType ?? (kind === "images" ? "image/jpeg" : "video/mp4");
  const base = (asset.fileName ?? `soubor-${Date.now()}`).replace(/\.[a-z0-9]+$/i, "");
  return {
    bytes,
    fileName: `${base || "soubor"}.${extensionFor(declared, kind === "images" ? "jpg" : "mp4")}`,
    // typ overi serverova kontrola podle bajtu, tady jen nazev pro ulozeni
    mimeType: declared,
    width: asset.width,
    height: asset.height,
    durationMs: asset.duration ?? undefined,
  };
}

export function pickImage(): Promise<PickedMedia | null> {
  return pick("images");
}

export function pickVideo(): Promise<PickedMedia | null> {
  return pick("videos");
}
