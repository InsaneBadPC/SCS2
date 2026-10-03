import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../dist-web/index.html", import.meta.url);
const html = await readFile(file, "utf8");
const repaired = html
  .replaceAll('href="/_expo/', 'href="./_expo/')
  .replaceAll('src="/_expo/', 'src="./_expo/')
  .replaceAll('href="/favicon.ico"', 'href="./favicon.ico"');

if (repaired === html) throw new Error("Statický vstup neobsahuje očekávané absolutní odkazy na assety.");
await writeFile(file, repaired, "utf8");
console.log("Odkazy na assety externího webu byly opraveny.");
