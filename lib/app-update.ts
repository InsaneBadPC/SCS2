import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";

const REPO = "InsaneBadPC/SCS2";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const APK_MIME = "application/vnd.android.package-archive";
const SKIPPED_VERSION_KEY = "songcraft.skippedUpdateVersion";
const CHECK_CACHE_KEY = "songcraft.updateCheck";
// GitHub API bez tokenu má 60 požadavků na hodinu na IP — kontrolu proto
// throttlujeme a výsledek (včetně „žádná aktualizace“) cachujeme.
const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export const CURRENT_VERSION: string = Constants.expoConfig?.version ?? "0.0.0";

export type AppUpdate = {
  version: string;
  apkUrl: string;
  size: number;
  notes: string;
  pageUrl: string;
};

type GithubRelease = {
  tag_name: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; size: number }[];
};

function parseVersion(value: string): number[] {
  return value
    .replace(/^app-v/i, "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  for (let index = 0; index < Math.max(next.length, now.length); index += 1) {
    const difference = (next[index] ?? 0) - (now[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

// Vrátí informace o novější verzi, nebo null když je aplikace aktuální.
// `force: true` obejde throttle (ruční tlačítko v Nastavení).
export async function checkForUpdate(options: { force?: boolean } = {}): Promise<AppUpdate | null> {
  if (Platform.OS === "web") return null;
  if (!options.force) {
    const cached = await readCheckCache();
    if (cached && Date.now() - cached.at < MIN_CHECK_INTERVAL_MS) return cached.update;
  }
  const found = await fetchLatestUpdate();
  await writeCheckCache({ at: Date.now(), update: found });
  return found;
}

type CheckCache = { at: number; update: AppUpdate | null };

async function readCheckCache(): Promise<CheckCache | null> {
  try {
    const raw = await AsyncStorage.getItem(CHECK_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CheckCache;
    if (typeof parsed?.at !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCheckCache(value: CheckCache): Promise<void> {
  try {
    await AsyncStorage.setItem(CHECK_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Cache je optimalizace; její selhání nesmí rozbít kontrolu aktualizace.
  }
}

async function fetchLatestUpdate(): Promise<AppUpdate | null> {
  const response = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`GitHub odpověděl ${response.status}`);
  const releases = (await response.json()) as GithubRelease[];
  const newest = releases
    .filter((release) => !release.draft && /^app-v\d+\.\d+\.\d+$/i.test(release.tag_name))
    .map((release) => ({ release, parts: parseVersion(release.tag_name) }))
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = (right.parts[index] ?? 0) - (left.parts[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    })[0];
  if (!newest) return null;
  const apk = newest.release.assets.find((asset) => asset.name.toLowerCase().endsWith(".apk"));
  if (!apk) return null;
  const version = newest.release.tag_name.replace(/^app-v/i, "");
  if (!isNewerVersion(version, CURRENT_VERSION)) return null;
  return {
    version,
    apkUrl: apk.browser_download_url,
    size: apk.size,
    notes: (newest.release.body ?? "").trim(),
    pageUrl: newest.release.html_url,
  };
}

export async function getSkippedVersion(): Promise<string | null> {
  return AsyncStorage.getItem(SKIPPED_VERSION_KEY);
}

export async function skipVersion(version: string): Promise<void> {
  await AsyncStorage.setItem(SKIPPED_VERSION_KEY, version);
}

// Stáhne nové APK a otevře systémový instalátor. Android si vyžádá potvrzení.
export async function installUpdate(update: AppUpdate, onProgress?: (ratio: number) => void): Promise<void> {
  if (Platform.OS !== "android") throw new Error("Aktualizace je dostupná pouze pro Android.");
  const target = `${FileSystem.cacheDirectory}songcraft-${update.version}.apk`;
  const existing = await FileSystem.getInfoAsync(target);
  if (existing.exists) await FileSystem.deleteAsync(target, { idempotent: true });
  const download = FileSystem.createDownloadResumable(update.apkUrl, target, {}, (snapshot) => {
    if (onProgress && snapshot.totalBytesExpectedToWrite > 0) {
      onProgress(Math.min(1, snapshot.totalBytesWritten / snapshot.totalBytesExpectedToWrite));
    }
  });
  const result = await download.downloadAsync();
  if (!result?.uri) throw new Error("Stažení aktualizace se nezdařilo.");
  const contentUri = await FileSystem.getContentUriAsync(result.uri);
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    type: APK_MIME,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
  });
}
