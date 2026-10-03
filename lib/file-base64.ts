import { File } from "expo-file-system";
import { Platform } from "react-native";

export async function assetToBase64(uri: string, providedBase64?: string | null) {
  if (providedBase64) return providedBase64;
  if (Platform.OS !== "web") return new File(uri).base64();

  const response = await fetch(uri);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Soubor se nepodařilo načíst."));
    reader.onloadend = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.split(",")[1] ?? "");
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * MP3 se nahrává jako binární data. Vyhne se tím několika velkým řetězcovým
 * kopiím base64, které na Androidu při delším souboru mohly ukončit aplikaci.
 */
export async function assetToArrayBuffer(uri: string, providedBase64?: string | null): Promise<ArrayBuffer> {
  if (providedBase64) return base64ToArrayBuffer(providedBase64);
  if (Platform.OS !== "web") return new File(uri).arrayBuffer();
  const response = await fetch(uri);
  if (!response.ok) throw new Error("Vybranou MP3 se nepodařilo načíst.");
  return response.arrayBuffer();
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const payload = base64.includes(",") ? base64.split(",").pop() ?? "" : base64;
  const binary = globalThis.atob(payload);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}
