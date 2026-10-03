import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import mammoth from "npm:mammoth";
import { Buffer } from "node:buffer";
import { getDocument } from "npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sections: Record<string, string> = { verse: "Sloka", sloka: "Sloka", chorus: "Refrén", refrain: "Refrén", "refrén": "Refrén", refren: "Refrén", bridge: "Bridge", intro: "Intro", outro: "Outro", "pre-chorus": "Pre-refrén", "pre-refrén": "Pre-refrén", interlude: "Mezihra", mezihra: "Mezihra", hook: "Hook" };
const annotate = (content: string) => content.replace(/\r\n?/g, "\n").split("\n").map((line) => { const match = line.trim().match(/^\[?\s*(verse|sloka|chorus|refrain|refr[ée]n|bridge|intro|outro|pre-chorus|pre-refr[ée]n|interlude|mezihra|hook)\s*(\d+)?\s*\]?[:\-]?\s*$/i); if (!match) return line; const key = match[1].toLocaleLowerCase("cs-CZ"); return `[${sections[key] ?? match[1]}${match[2] ? ` ${match[2]}` : ""}]`; }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
const split = (content: string) => { const paragraphs = content.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean); if (paragraphs.length < 2) return { stylePrompt: null, lyrics: annotate(content) }; const first = paragraphs.shift() ?? ""; const stylePrompt = first.replace(/^(?:styl(?:ový)?\s*prompt|style\s*prompt|styl)\s*[:\-]\s*/i, "").trim() || null; return { stylePrompt, lyrics: annotate(paragraphs.join("\n\n")) }; };
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
Deno.serve(async (request) => { if (request.method === "OPTIONS") return new Response("ok", { headers: cors }); if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405); const authorization = request.headers.get("Authorization"); const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL"); const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY"); if (!authorization || !url || !key) return json({ error: "Chybí bezpečné připojení k externímu cloudu." }, 401); const supabase = createClient(url, key, { global: { headers: { Authorization: authorization } } }); const { data: { user }, error: authError } = await supabase.auth.getUser(); if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401); if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403); const input = await request.json().catch(() => null) as { action?: string; fileName?: string; base64?: string; url?: string; title?: string } | null; if (!input?.action) return json({ error: "Chybí akce." }, 400); let title = input.title?.trim() || "Importovaný text"; let source = ""; let note = ""; if (input.action === "import_docx") { if (!input.base64) return json({ error: "DOCX soubor chybí." }, 400); if (input.base64.length > Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 16) return json({ error: "DOCX soubor je větší než povolený limit." }, 413); const extracted = await mammoth.extractRawText({ buffer: Buffer.from(input.base64, "base64") }); source = extracted.value; if (source.length > MAX_TEXT_LENGTH) return json({ error: "Importovaný text je větší než povolený limit." }, 413); title = (input.fileName ?? "Importovaný text.docx").replace(/\.docx$/i, "") || title; note = `Importováno z DOCX ${input.fileName ?? ""}`; } else if (input.action === "import_pdf") {
          if (!input.base64) return json({ error: "PDF soubor chybí." }, 400); if (input.base64.length > Math.ceil(MAX_IMPORT_BYTES * 4 / 3) + 16) return json({ error: "PDF soubor je větší než povolený limit." }, 413);
          const pdf = await getDocument({ data: new Uint8Array(Buffer.from(input.base64, "base64")), useSystemFonts: false }).promise;
          if (pdf.numPages > MAX_PDF_PAGES) { await pdf.destroy(); return json({ error: `PDF má více než ${MAX_PDF_PAGES} stran.` }, 413); }
          const pages: string[] = [];
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            let lastY: number | null = null;
            let pageText = "";
            for (const item of content.items as Array<{ str?: string; transform?: number[] }>) {
              if (typeof item.str !== "string") continue;
              const y = item.transform?.[5] ?? null;
              if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) pageText += "\n";
              pageText += item.str;
              if (item.str && !item.str.endsWith(" ")) pageText += "";
              lastY = y;
            }
            if (pageText.trim()) pages.push(pageText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
          }
          await pdf.destroy();
          source = pages.join("\n\n"); if (source.length > MAX_TEXT_LENGTH) return json({ error: "Importovaný PDF text je větší než povolený limit." }, 413);
          if (!source.trim()) return json({ error: "V PDF nebyl nalezen žádný text — pravděpodobně jde o naskenované obrázky." }, 400);
          title = (input.fileName ?? "Importovaný text.pdf").replace(/\.pdf$/i, "") || title;
          note = `Importováno z PDF ${input.fileName ?? ""}`;
        } else if (input.action === "import_google_document") { const match = input.url?.match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/); if (!match) return json({ error: "Vlož platný odkaz na Google Dokument." }, 400); const response = await fetch(`https://docs.google.com/document/d/${match[1]}/export?format=txt`, { signal: AbortSignal.timeout(30_000) }); if (!response.ok) return json({ error: "Dokument se nepodařilo načíst. Nastav sdílení pro každého s odkazem." }, 400); if (Number(response.headers.get("content-length") || 0) > MAX_IMPORT_BYTES) return json({ error: "Importovaný dokument je větší než povolený limit." }, 413); source = await response.text(); if (source.length > MAX_TEXT_LENGTH) return json({ error: "Importovaný dokument text je větší než povolený limit." }, 413); note = "Importováno z Google Dokumentu"; if (!input.title?.trim()) { const nameMatch = /<title>([^<]+)<\/title>/i.exec(source) ?? /\n([^\n]{1,120})$/.exec(source.trim()); input.title = (nameMatch?.[1] ?? "").replace(/\s+/g, " ").trim() || `Google Dokument ${match[1].slice(0, 8)}`; } } else return json({ error: "Neznámá importní akce." }, 400); const content = split(source); if (!content.lyrics) return json({ error: "Dokument neobsahuje importovatelný text." }, 400); const { data, error } = await supabase.from("sc_lyrics").insert({ user_id: user.id, title, style_prompt: content.stylePrompt, lyrics: content.lyrics, notes: note }).select("id").single(); return error ? json({ error: error.message }, 400) : json({ id: data.id }); });