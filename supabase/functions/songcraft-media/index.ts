import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import NodeID3 from "npm:node-id3";
import { Buffer } from "node:buffer";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const safeFileName = (name: string) => name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[_.-]+/, "").replace(/_+/g, "_").slice(-180) || "songcraft-file";

function ownedPath(userId: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("..") || value.startsWith("/") || value.includes("//")) return null;
  return value === userId || value.startsWith(`${userId}/`) ? value : null;
}

function validAudio(bytes: Uint8Array, mime: string | null) {
  if (bytes.byteLength > MAX_AUDIO_BYTES || bytes.byteLength === 0) return false;
  if (mime === "audio/mp4" || mime === "audio/x-m4a") return bytes.byteLength >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp";
  if (mime === "audio/aac") return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  return mime === "audio/mpeg" || mime === "audio/mp3" || mime === "application/octet-stream"
    ? bytes.byteLength >= 3 && (new TextDecoder().decode(bytes.slice(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    : false;
}

function validImage(bytes: Uint8Array, mime: string | null) {
  if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.byteLength === 0) return false;
  if (mime === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Externí cloud není správně nakonfigurován." }, 503);

  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);

  const input = await request.json().catch(() => null) as { action?: unknown; versionId?: unknown; label?: unknown; note?: unknown } | null;
  if (input?.action === "health") return json({ ok: true, service: "songcraft-media" });
  if (input?.action !== "prepare_tagged_copy" || typeof input.versionId !== "string" || typeof input.label !== "string" || !input.label.trim()) {
    return json({ error: "Neplatný požadavek na přípravu MP3 kopie." }, 400);
  }
  const versionId = input.versionId.trim();
  const label = input.label.trim().slice(0, 120);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : null;
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return json({ error: "Neplatné ID zvukové verze." }, 400);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: version, error: versionError } = await admin
    .from("sc_audio_versions")
    .select("id,user_id,song_id,original_file_name,original_storage_path,storage_path,tagged_storage_path,mime_type,byte_size,id3_album,id3_track_number,id3_year,id3_genre,id3_comment")
    .eq("id", versionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (versionError || !version) return json({ error: "Zvuková verze nebyla nalezena." }, 404);

  const { data: song, error: songError } = await admin.from("sc_songs").select("id,user_id,title,album_id,cover_path").eq("id", version.song_id).eq("user_id", user.id).maybeSingle();
  if (songError || !song) return json({ error: "Skladba pro zvukovou verzi nebyla nalezena." }, 404);
  const { data: album } = song.album_id
    ? await admin.from("sc_albums").select("name,cover_path,user_id").eq("id", song.album_id).eq("user_id", user.id).maybeSingle()
    : { data: null };

  // original_storage_path is immutable after the core-schema migration. The
  // fallback is only for legacy rows and is still constrained to this tenant.
  const sourcePath = ownedPath(user.id, version.original_storage_path ?? version.storage_path);
  if (!sourcePath) return json({ error: "Původní MP3 nemá platnou cestu vlastníka." }, 409);
  const { data: sourceBlob, error: sourceError } = await admin.storage.from("songcraft").download(sourcePath);
  if (sourceError || !sourceBlob) return json({ error: "Původní MP3 se nepodařilo načíst." }, 502);
  const source = new Uint8Array(await sourceBlob.arrayBuffer());
  if (!validAudio(source, sourceBlob.type || version.mime_type)) return json({ error: "Soubor není platný podporovaný MP3/audio soubor." }, 415);

  let image: { mime: string; type: { id: number }; description: string; imageBuffer: Buffer } | undefined;
  const coverPath = ownedPath(user.id, song.cover_path ?? album?.cover_path);
  if (coverPath) {
    const { data: coverBlob } = await admin.storage.from("songcraft").download(coverPath);
    if (coverBlob) {
      const coverBytes = new Uint8Array(await coverBlob.arrayBuffer());
      const mime = coverBlob.type || (coverBytes[0] === 0x89 ? "image/png" : coverBytes[0] === 0xff ? "image/jpeg" : "image/webp");
      if (validImage(coverBytes, mime)) image = { mime, type: { id: mime === "image/png" ? 3 : mime === "image/jpeg" ? 3 : 6 }, description: "SongCraft cover", imageBuffer: Buffer.from(coverBytes) };
    }
  }

  const tagged = NodeID3.update({
    title: song.title,
    artist: "Temney",
    performerInfo: "Temney",
    album: album?.name || version.id3_album || "",
    trackNumber: version.id3_track_number || undefined,
    year: version.id3_year || undefined,
    genre: version.id3_genre || undefined,
    comment: note ? { language: "eng", text: note } : version.id3_comment ? { language: "eng", text: version.id3_comment } : undefined,
    image,
  }, Buffer.from(source));
  if (!Buffer.isBuffer(tagged)) return json({ error: "ID3 tagy se nepodařilo vložit do MP3." }, 500);

  const baseName = safeFileName(`Temney - ${song.title}${album?.name ? ` - ${album.name}` : ""} - ${label}`).replace(/\.mp3$/i, "");
  const targetPath = `${user.id}/audio/tagged/${crypto.randomUUID()}-${baseName}.mp3`;
  const { error: uploadError } = await admin.storage.from("songcraft").upload(targetPath, tagged, { contentType: "audio/mpeg", upsert: false });
  if (uploadError) return json({ error: "Hotovou MP3 kopii se nepodařilo uložit." }, 502);

  const { error: updateError } = await admin
    .from("sc_audio_versions")
    .update({ tagged_storage_path: targetPath, label, id3_title: song.title, id3_artist: "Temney", id3_album: album?.name || null, id3_comment: note ?? version.id3_comment ?? null, updated_at: new Date().toISOString() })
    .eq("id", version.id)
    .eq("user_id", user.id);
  if (updateError) {
    // The object is private and unreferenced; a later cleanup job can remove it.
    return json({ error: "Hotovou MP3 se sice podařilo uložit, ale nepodařilo se aktualizovat metadata." }, 502);
  }

  return json({ path: targetPath, fileName: `${baseName}.mp3` });
});
