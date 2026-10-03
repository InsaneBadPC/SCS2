import { readFile } from "node:fs/promises";

const supabaseUrl = process.env.SONGCRAFT_SUPABASE_URL || "https://gpgbgjxeybfncrexrpbr.supabase.co";
// Token patří do prostředí / GitHub Secrets. V repu nesmí být žádná hodnota.
const deployToken = process.env.SONGCRAFT_WEB_DEPLOY_TOKEN;
if (!deployToken) {
  throw new Error(
    "Chybí SONGCRAFT_WEB_DEPLOY_TOKEN. Token patří do prostředí / GitHub Secrets, ne do repozitáře.",
  );
}
const body = await readFile(new URL("../dist-web/index.html", import.meta.url));
const response = await fetch(`${supabaseUrl}/functions/v1/songcraft-web-deployer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deployToken, action: "upload", path: "index.html", base64: body.toString("base64"), contentType: "text/html; charset=utf-8" }),
});
if (!response.ok) throw new Error(`Aktualizace vstupu webu selhala: ${response.status} ${await response.text()}`);
console.log("Externí vstup webu byl aktualizován.");
