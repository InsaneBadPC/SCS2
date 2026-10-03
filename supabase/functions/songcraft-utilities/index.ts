import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import JSZip from "npm:jszip";
import mammoth from "npm:mammoth";
import { Buffer } from "node:buffer";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const truncate = (value: string | null | undefined, limit: number) => (value ?? "").trim().slice(0, limit);
const safe = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "soubor";
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;
const MAX_LIBRARY_ITEMS = 5_000;
const MAX_STORED_FILE_BYTES = 50 * 1024 * 1024;
const ownedPath = (userId: string, value: unknown) => typeof value === "string" && value.length <= 1024 && !value.includes("\\") && !value.includes("..") && value.startsWith(`${userId}/`) ? value : null;
const ext = (path: string | null | undefined, fallback: string) => { const candidate = path?.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, ""); return candidate ? `.${candidate}` : fallback; };
const sections: Record<string, string> = { verse: "Sloka", sloka: "Sloka", chorus: "Refrén", refrain: "Refrén", "refrén": "Refrén", refren: "Refrén", bridge: "Bridge", intro: "Intro", outro: "Outro", "pre-chorus": "Pre-refrén", "pre-refrén": "Pre-refrén", interlude: "Mezihra", mezihra: "Mezihra", hook: "Hook" };
const annotate = (content: string) => content.replace(/\r\n?/g, "\n").split("\n").map((line) => { const match = line.trim().match(/^\[?\s*(verse|sloka|chorus|refrain|refr[ée]n|bridge|intro|outro|pre-chorus|pre-refr[ée]n|interlude|mezihra|hook)\s*(\d+)?\s*\]?[:\-]?\s*$/i); if (!match) return line; const key = match[1].toLocaleLowerCase("cs-CZ"); return `[${sections[key] ?? match[1]}${match[2] ? ` ${match[2]}` : ""}]`; }).join("\n").replace(/\n{3,}/g, "\n\n").trim();

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  if (!authorization || !url || !key) return json({ error: "Chybí bezpečné připojení k externímu cloudu." }, 401);
  const supabase = createClient(url, key, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input?.action) return json({ error: "Chybí akce." }, 400);

  if (input.action === "import_docx") {
    const fileName = typeof input.fileName === "string" ? input.fileName : "Importovaný text.docx";
    const base64 = typeof input.base64 === "string" ? input.base64 : "";
    if (!base64) return json({ error: "DOCX soubor chybí." }, 400);
    if (base64.length > 28 * 1024 * 1024) return json({ error: "DOCX soubor je větší než povolený limit." }, 413);
    const extracted = await mammoth.extractRawText({ buffer: Buffer.from(base64, "base64") });
    const lyrics = annotate(extracted.value);
    if (!lyrics) return json({ error: "DOCX neobsahuje importovatelný text." }, 400);
    const { data, error } = await supabase.from("sc_lyrics").insert({ user_id: user.id, title: fileName.replace(/\.docx$/i, "") || "Importovaný text", lyrics, notes: `Importováno z DOCX ${fileName}` }).select("id").single();
    return error ? json({ error: error.message }, 400) : json({ id: data.id });
  }

  if (input.action === "import_google_document") {
    const sourceUrl = typeof input.url === "string" ? input.url : "";
    const title = typeof input.title === "string" ? input.title.trim() : "Importovaný text";
    const match = sourceUrl.match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return json({ error: "Vlož platný odkaz na Google Dokument." }, 400);
    const response = await fetch(`https://docs.google.com/document/d/${match[1]}/export?format=txt`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return json({ error: "Dokument se nepodařilo načíst. Nastav sdílení pro každého s odkazem." }, 400);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > 10 * 1024 * 1024) return json({ error: "Importovaný dokument je větší než povolený limit." }, 413);
    const remoteText = await response.text();
    if (remoteText.length > 10 * 1024 * 1024) return json({ error: "Importovaný dokument je větší než povolený limit." }, 413);
    const lyrics = annotate(remoteText);
    if (!lyrics) return json({ error: "Google Dokument neobsahuje importovatelný text." }, 400);
    const { data, error } = await supabase.from("sc_lyrics").insert({ user_id: user.id, title: title || "Importovaný text", lyrics, notes: "Importováno z Google Dokumentu" }).select("id").single();
    return error ? json({ error: error.message }, 400) : json({ id: data.id });
  }

  if (input.action === "export_library") {
    const albumId = typeof input.albumId === "string" ? input.albumId : null;
    const [albumsResult, lyricsResult, songsResult, versionsResult] = await Promise.all([
      supabase.from("sc_albums").select("*").eq("user_id", user.id).order("sort_order").order("name").limit(MAX_LIBRARY_ITEMS),
      supabase.from("sc_lyrics").select("*").eq("user_id", user.id).limit(MAX_LIBRARY_ITEMS),
      supabase.from("sc_songs").select("*").eq("user_id", user.id).limit(MAX_LIBRARY_ITEMS),
      supabase.from("sc_audio_versions").select("*").eq("user_id", user.id).limit(MAX_LIBRARY_ITEMS),
    ]);
    if (albumsResult.error || lyricsResult.error || songsResult.error || versionsResult.error) return json({ error: albumsResult.error?.message || lyricsResult.error?.message || songsResult.error?.message || versionsResult.error?.message || "Export se nepodařilo načíst." }, 400);
    const allAlbums = albumsResult.data ?? [];
    if (allAlbums.length + (lyricsResult.data?.length ?? 0) + (songsResult.data?.length ?? 0) + (versionsResult.data?.length ?? 0) > MAX_LIBRARY_ITEMS) return json({ error: "Knihovna je pro jeden export příliš velká. Exportuj po albech." }, 413);
    const selectedAlbum = albumId ? allAlbums.find((entry) => entry.id === albumId) : null;
    if (albumId && !selectedAlbum) return json({ error: "Vybrané album nebylo nalezeno." }, 404);
    const albums = selectedAlbum ? [selectedAlbum] : allAlbums;
    const lyrics = selectedAlbum ? (lyricsResult.data ?? []).filter((entry) => entry.album_id === selectedAlbum.id) : (lyricsResult.data ?? []);
    const songs = selectedAlbum ? (songsResult.data ?? []).filter((entry) => entry.album_id === selectedAlbum.id) : (songsResult.data ?? []);
    const songIds = new Set(songs.map((entry) => entry.id));
    const versions = (versionsResult.data ?? []).filter((entry) => songIds.has(entry.song_id));
    const zip = new JSZip();
    const createdAt = new Date().toISOString();
    const title = selectedAlbum ? `Album ${selectedAlbum.name}` : "Kompletní knihovna";
    zip.file("SongCraft-Studio-export.json", JSON.stringify({ exportedAt: createdAt, artist: "Temney", exportTitle: title, albums, lyrics, songs, versions }, null, 2));
    zip.file("README.txt", `SongCraft Studio — ${title}\n\nTexty obsahují prompt pro styl, samotný text a poznámky. Skladby obsahují MP3 verze s upravenými ID3 tagy, obrázky a metadata.\n`);
    const addStored = async (storagePath: string | null | undefined, target: string) => {
      const path = ownedPath(user.id, storagePath);
      if (!path) return;
      const { data } = await supabase.storage.from("songcraft").download(path);
      if (!data) return;
      if (data.size <= 0 || data.size > MAX_STORED_FILE_BYTES) throw new Error("Soubor v exportu překračuje limit.");
      zip.file(target, new Uint8Array(await data.arrayBuffer()));
    };
    for (const album of albums) await addStored(album.cover_path, `Alba/${safe(album.name)}-${album.id}/obal${ext(album.cover_path, ".jpg")}`);
    for (const lyric of lyrics) { const folder = `Texty/${safe(lyric.title)}-${lyric.id}`; zip.file(`${folder}/text-pisne.txt`, lyric.lyrics ?? ""); zip.file(`${folder}/prompt-stylu.txt`, lyric.style_prompt ?? ""); zip.file(`${folder}/poznamky.txt`, lyric.notes ?? ""); zip.file(`${folder}/metadata.json`, JSON.stringify(lyric, null, 2)); await addStored(lyric.cover_path, `${folder}/obrazek${ext(lyric.cover_path, ".jpg")}`); }
    for (const song of songs) { const album = allAlbums.find((entry) => entry.id === song.album_id); const folder = `Skladby/${safe(album?.name ?? "Single")}/${safe(song.title)}-${song.id}`; zip.file(`${folder}/text-pisne.txt`, song.lyrics ?? ""); zip.file(`${folder}/prompt-stylu.txt`, song.style_prompt ?? ""); zip.file(`${folder}/poznamky.txt`, song.notes ?? ""); zip.file(`${folder}/metadata.json`, JSON.stringify(song, null, 2)); await addStored(song.cover_path ?? album?.cover_path, `${folder}/obrazek${ext(song.cover_path ?? album?.cover_path, ".jpg")}`); for (const version of versions.filter((entry) => entry.song_id === song.id)) { await addStored(version.tagged_storage_path ?? version.storage_path, `${folder}/MP3/${safe(version.original_file_name)}`); zip.file(`${folder}/MP3/${safe(version.label)}-metadata.json`, JSON.stringify(version, null, 2)); } }
    const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
    if (archive.byteLength <= 0 || archive.byteLength > MAX_ARCHIVE_BYTES) return json({ error: "Export překročil limit 300 MB. Exportuj menší album." }, 413);
    const fileName = selectedAlbum ? `SongCraft-Studio-album-${safe(selectedAlbum.name)}-${createdAt.slice(0, 10)}.zip` : `SongCraft-Studio-kompletni-knihovna-${createdAt.slice(0, 10)}.zip`;
    const path = `${user.id}/exports/${fileName}`;
    const { error: uploadError } = await supabase.storage.from("songcraft").upload(path, archive, { contentType: "application/zip", upsert: true });
    if (uploadError) return json({ error: uploadError.message }, 400);
    const { data: signed, error: signError } = await supabase.storage.from("songcraft").createSignedUrl(path, 60 * 30);
    return signError ? json({ error: signError.message }, 400) : json({ url: signed.signedUrl, fileName, byteSize: archive.byteLength });
  }

  if (input.action === "export_lyrics_txt") {
    const [albumsResult, songsResult, versionsResult, draftsResult] = await Promise.all([
      supabase.from("sc_albums").select("*").eq("user_id", user.id).order("sort_order").order("name").limit(MAX_LIBRARY_ITEMS),
      supabase.from("sc_songs").select("*").eq("user_id", user.id).order("completed_at", { ascending: false }).limit(MAX_LIBRARY_ITEMS),
      supabase.from("sc_audio_versions").select("*").eq("user_id", user.id).order("is_final", { ascending: false }).order("is_primary", { ascending: false }).limit(MAX_LIBRARY_ITEMS),
      supabase.from("sc_lyrics").select("*").eq("user_id", user.id).eq("status", "draft").order("updated_at", { ascending: false }).limit(MAX_LIBRARY_ITEMS),
    ]);
    const anyError = albumsResult.error || songsResult.error || versionsResult.error || draftsResult.error;
    if (anyError) return json({ error: anyError.message }, 400);
    const formatSize = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`);
    const rule = "─".repeat(58);
    const songs = songsResult.data ?? [];
    const albums = albumsResult.data ?? [];
    const versions = versionsResult.data ?? [];
    const parts: string[] = [`SONGCRAFT STUDIO — SEZNAM SKLADEB`, `Interpret: Temney · Export: ${new Date().toLocaleDateString("cs-CZ")}`, ""];
    let counter = 0;
    const renderSong = (song: any) => {
      const chunk: string[] = [`♪ ${++counter}. ${song.title}`];
      const prompts = Array.isArray(song.style_prompts) && song.style_prompts.length ? song.style_prompts : song.style_prompt ? [song.style_prompt] : [];
      if (prompts.length) chunk.push(`   Styl/prompt: ${prompts.join(" | ")}`);
      chunk.push(`   ${"–".repeat(50)}`);
      chunk.push((song.lyrics ?? "(text není vyplněn)").replace(/\r\n?/g, "\n").split("\n").map((line: string) => `   ${line}`).join("\n"));
      if ((song.notes ?? "").trim()) chunk.push(`   Poznámky: ${song.notes.trim()}`);
      const list = versions.filter((entry) => entry.song_id === song.id);
      if (list.length) {
        chunk.push(`   MP3 verze (${list.length}):`);
        for (const version of list) chunk.push(`     • ${version.label} — ${version.original_file_name} — ${formatSize(version.byte_size)}${version.is_final ? " — FINÁLNÍ" : ""}${version.is_primary ? " — HLAVNÍ" : ""}${version.id3_comment ? ` — „${truncate(version.id3_comment, 80)}“` : ""}`);
      }
      return chunk.join("\n");
    };
    for (const album of albums) {
      const inside = songs.filter((entry) => entry.album_id === album.id);
      if (!inside.length) continue;
      parts.push(`${rule}\nALBUM: ${album.name}${album.release_year ? ` (${album.release_year})` : ""}\n${rule}\n`);
      for (const song of inside) { parts.push(renderSong(song)); parts.push(""); }
    }
    const loose = songs.filter((entry) => !entry.album_id);
    if (loose.length) {
      parts.push(`${rule}\nBEZ ALBA\n${rule}\n`);
      for (const song of loose) { parts.push(renderSong(song)); parts.push(""); }
    }
    const drafts = draftsResult.data ?? [];
    if (drafts.length) {
      parts.push(`${rule}\nKONCEPTY (rozpracované texty bez MP3)\n${rule}\n`);
      for (const draft of drafts) {
        parts.push(`✎ ${draft.title}${draft.style_prompt ? `\n   Styl: ${truncate(draft.style_prompt, 300)}` : ""}\n   ${"–".repeat(50)}\n${(draft.lyrics ?? "(bez textu)").replace(/\r\n?/g, "\n").split("\n").map((line: string) => `   ${line}`).join("\n")}\n`);
      }
    }
    const content = `\ufeff${parts.join("\n")}`;
    if (content.length > 20 * 1024 * 1024) return json({ error: "Textový export je příliš velký." }, 413);
    const fileName = `Temney-seznam-skladeb-${new Date().toISOString().slice(0, 10)}.txt`;
    const path = `${user.id}/exports/${fileName}`;
    const { error: uploadError } = await supabase.storage.from("songcraft").upload(path, new TextEncoder().encode(content), { contentType: "text/plain; charset=utf-8", upsert: true });
    if (uploadError) return json({ error: uploadError.message }, 400);
    const { data: signed, error: signError } = await supabase.storage.from("songcraft").createSignedUrl(path, 60 * 30);
    return signError ? json({ error: signError.message }, 400) : json({ url: signed.signedUrl, fileName, byteSize: content.length });
  }

  return json({ error: "Neznámá akce." }, 400);
});