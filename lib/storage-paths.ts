export const STORAGE_LIMITS = {
  cover: 10 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  // 50 MB odpovida dnesnimu limitu bucketu. Po migraci 20260928000000 (200 MB)
  // lze tuto hodnotu zvednout; mit vetsi rezervu nez bucket je zbytecne,
  // uzivatel by dostal chybu az po dlouhem nahravani.
  video: 50 * 1024 * 1024,
} as const;

const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac", "audio/x-m4a"]);

export type StorageFolder = "covers" | "audio" | "videos";

function normalizeMimeType(value: string) {
  const mimeType = value.split(";", 1)[0].trim().toLowerCase();
  return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

export function sanitizeStorageFileName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_");
  const trimmed = normalized.replace(/^[_.-]+/, "").replace(/_+/g, "_").slice(-180);
  return trimmed || "soubor";
}

export function isOwnedStoragePath(userId: string, storagePath: string | null | undefined) {
  if (!userId || !storagePath || storagePath.includes("\\") || storagePath.includes("\0")) return false;
  if (storagePath.includes("..") || storagePath.startsWith("/") || storagePath.includes("//")) return false;
  return storagePath === userId || storagePath.startsWith(`${userId}/`);
}

export function assertOwnedStoragePath(userId: string, storagePath: string | null | undefined) {
  if (!isOwnedStoragePath(userId, storagePath)) {
    throw new Error("Soubor nepatří přihlášenému uživateli.");
  }
  return storagePath as string;
}

function hasAudioSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") {
    const id3 = bytes.length >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "ID3";
    const frameSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    return id3 || frameSync;
  }
  if (mimeType === "audio/mp4" || mimeType === "audio/x-m4a") {
    return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  }
  if (mimeType === "audio/aac") return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  return false;
}

/**
 * Určí obrazový formát přímo z bajtů.
 *
 * Prohlížeč i Android galerie občas označí soubor jinak, než jaký opravdu je
 * (typicky HEIC, který pak neprojde kontrolou podpisu). Věříme bajtům, ne
 * tvrzení volajícího.
 */
export function sniffImageMimeType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  // HEIF/HEIC: 'ftyp' na pozici 4 a brand heic/heix/mif1
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
    const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return null;
  }
  return null;
}

/** Určí, zda je to video, které tady umíme přehrát (MP4 / MOV). */
export function sniffVideoMimeType(bytes: Uint8Array): "video/mp4" | "video/quicktime" | null {
  if (bytes.length < 12) return null;
  if (String.fromCharCode(...bytes.slice(4, 8)) !== "ftyp") return null;
  const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
  if (["qt  ", "qt  "].includes(brand) || brand.startsWith("qt")) return "video/quicktime";
  return "video/mp4";
}

export function validateStorageUpload(input: { folder: StorageFolder; contentType: string; fileName: string; bytes: Uint8Array }) {
  const declared = normalizeMimeType(input.contentType);
  if (input.folder === "videos") {
    const sniffed = sniffVideoMimeType(input.bytes);
    if (!sniffed) throw new Error("Vybraný soubor není MP4 video, které tady umíme použít.");
    if (input.bytes.byteLength <= 0) throw new Error("Soubor je prázdný.");
    if (input.bytes.byteLength > STORAGE_LIMITS.video) {
      throw new Error(`Video je větší než ${Math.round(STORAGE_LIMITS.video / 1024 / 1024)} MB.`);
    }
    return { mimeType: sniffed, fileName: sanitizeStorageFileName(input.fileName) };
  }
  if (input.folder === "covers") {
    // rozhodují bajty; deklarovaný typ jen používáme, když sedí
    const sniffed = sniffImageMimeType(input.bytes);
    if (!sniffed) {
      if (declared === "image/heic" || declared === "image/heif") {
        throw new Error("HEIC/HEIF se tu nepodporuje. Ulož fotku jako JPG nebo PNG (třeba přes editor fotek) a zkus to znovu.");
      }
      throw new Error("Vybraný soubor není obrázek, který tu umíme nahrát (JPG, PNG nebo WebP).");
    }
    const mimeType = sniffed;
    const maxBytes = STORAGE_LIMITS.cover;
    if (input.bytes.byteLength <= 0) throw new Error("Soubor je prázdný.");
    if (input.bytes.byteLength > maxBytes) throw new Error(`Soubor je větší než ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    return { mimeType, fileName: sanitizeStorageFileName(input.fileName) };
  }
  const mimeType = declared;
  const allowed = AUDIO_TYPES;
  if (!allowed.has(mimeType)) throw new Error("Tento typ souboru není pro tento upload povolen.");
  const maxBytes = STORAGE_LIMITS.audio;
  if (input.bytes.byteLength <= 0) throw new Error("Soubor je prázdný.");
  if (input.bytes.byteLength > maxBytes) throw new Error(`Soubor je větší než ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  if (!hasAudioSignature(input.bytes, mimeType)) throw new Error("Soubor neodpovídá deklarovanému audio formátu.");
  return { mimeType, fileName: sanitizeStorageFileName(input.fileName) };
}

export function buildOwnedStoragePath(userId: string, folder: StorageFolder, fileName: string, uniqueSuffix?: string) {
  if (!/^[0-9a-f-]{16,}$/i.test(userId)) throw new Error("Neplatné ID uživatele.");
  const safeName = sanitizeStorageFileName(fileName);
  const cryptoWithUuid = globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined;
  const generatedSuffix = cryptoWithUuid?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const safeSuffix = (uniqueSuffix ?? `${Date.now()}-${generatedSuffix}`).replace(/[^a-zA-Z0-9_-]/g, "_");
  return assertOwnedStoragePath(userId, `${userId}/${folder}/${safeSuffix}-${safeName}`);
}
