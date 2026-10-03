import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Linking, Platform } from "react-native";

import { getApiBaseUrl } from "@/constants/oauth";

function absoluteUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  const apiBaseUrl = getApiBaseUrl();
  return apiBaseUrl ? `${apiBaseUrl}${url}` : url;
}

function safeName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "songcraft-download";
}

export async function downloadOrShareFile(url: string, fileName: string, mimeType: string, title: string) {
  const remoteUrl = absoluteUrl(url);
  if (Platform.OS === "web") {
    if (typeof document !== "undefined") {
      const anchor = document.createElement("a");
      anchor.href = remoteUrl;
      anchor.download = safeName(fileName);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    await Linking.openURL(remoteUrl);
    return;
  }
  const localUri = `${FileSystem.cacheDirectory}${Date.now()}-${safeName(fileName)}`;
  const result = await FileSystem.downloadAsync(remoteUrl, localUri);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, { mimeType, dialogTitle: title });
    return;
  }
  await Linking.openURL(result.uri);
}

export async function saveFinishedMp3(url: string, fileName: string) {
  return downloadOrShareFile(url, fileName, "audio/mpeg", "Uložit nebo sdílet hotovou MP3");
}

const VIDEO_FOLDER_KEY = "songcraft.videoFolderUri";

async function ensureVideoFolder(): Promise<string | null> {
  const saf = FileSystem.StorageAccessFramework;
  const persisted = await AsyncStorage.getItem(VIDEO_FOLDER_KEY).catch(() => null);
  if (persisted) {
    try { await saf.readDirectoryAsync(persisted); return persisted; } catch { /* oprávnění zaniklo */ }
  }
  const granted = await saf.requestDirectoryPermissionsAsync("content://com.android.externalstorage.documents/root/primary%3ADownload");
  if (!granted.granted) return null;
  const entries = await saf.readDirectoryAsync(granted.directoryUri);
  let folderUri = entries.find((uri) => uri.toLowerCase().endsWith("/songcraft studio"));
  if (!folderUri) folderUri = await saf.makeDirectoryAsync(granted.directoryUri, "SongCraft Studio");
  await AsyncStorage.setItem(VIDEO_FOLDER_KEY, folderUri).catch(() => {});
  return folderUri;
}

export async function saveFinishedVideoToDownloads(url: string, fileName: string): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const remoteUrl = absoluteUrl(url);
  const videoFolder = await ensureVideoFolder();
  if (!videoFolder) return false;
  const safeVideoName = safeName(fileName);
  const localUri = `${FileSystem.cacheDirectory}${Date.now()}-${safeVideoName}`;
  try {
    const download = await FileSystem.downloadAsync(remoteUrl, localUri);
    if (download.status < 200 || download.status >= 300) return false;
    const targetUri = await FileSystem.StorageAccessFramework.createFileAsync(videoFolder, safeVideoName, "video/mp4");
    const content = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    await FileSystem.StorageAccessFramework.writeAsStringAsync(targetUri, content, { encoding: FileSystem.EncodingType.Base64 });
    return true;
  } catch {
    return false;
  } finally {
    await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
  }
}
