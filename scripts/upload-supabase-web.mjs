import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("../dist-web/", import.meta.url).pathname;
const supabaseUrl = process.env.SONGCRAFT_SUPABASE_URL || "https://hfykngbhcxmnpxvjagoj.supabase.co";
const webBucket = "songcraft-web";
// Deploy token se NESMÍ držet v repu. Bere se z prostředí a bez něj skript
// fail-closed skončí, místo aby vypisoval nějaký výchozí hodnotný token.
const deployToken = process.env.SONGCRAFT_WEB_DEPLOY_TOKEN;
if (!deployToken) {
  throw new Error(
    "Chybí SONGCRAFT_WEB_DEPLOY_TOKEN. Token patří do prostředí / GitHub Secrets, ne do repozitáře.",
  );
}

const contentType = (path) => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
};

async function listFiles(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name !== ".git" && !entry.name.includes("[") && !entry.name.includes("]"));
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

const files = await listFiles(root);
const reset = await fetch(`${supabaseUrl}/functions/v1/songcraft-web-deployer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deployToken, action: "reset" }),
});
if (!reset.ok) throw new Error(`Vyčištění webového bucketu selhalo: ${reset.status} ${await reset.text()}`);
for (const file of files) {
  const path = relative(root, file).replaceAll("\\", "/");
  const body = await readFile(file);
  const response = await fetch(`${supabaseUrl}/functions/v1/songcraft-web-deployer`, {
    method: "POST",
    headers: {
      "content-type": contentType(path),
    },
    body: JSON.stringify({ deployToken, action: "upload", path, base64: body.toString("base64"), contentType: contentType(path) }),
  });
  if (!response.ok) throw new Error(`Nahrání ${path} selhalo: ${response.status} ${await response.text()}`);
  console.log(`Nahráno: ${path}`);
}

console.log(`Web je dostupný na ${supabaseUrl}/storage/v1/object/public/${webBucket}/index.html`);
