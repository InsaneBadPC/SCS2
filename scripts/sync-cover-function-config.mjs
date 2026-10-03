import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../supabase/functions/songcraft-cover-ai/index.ts", import.meta.url), "utf8");
const definition = {
  project_id: "hfykngbhcxmnpxvjagoj",
  name: "songcraft-cover-ai",
  verify_jwt: true,
  entrypoint_path: "index.ts",
  files: [{ name: "index.ts", content: source }],
};

await writeFile(new URL("../supabase_songcraft_cover_ai_function.json", import.meta.url), `${JSON.stringify(definition, null, 2)}\n`);
