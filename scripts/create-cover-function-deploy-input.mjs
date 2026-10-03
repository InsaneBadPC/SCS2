import { readFile, writeFile } from "node:fs/promises";

const source = await readFile(new URL("../supabase/functions/songcraft-cover-ai/index.ts", import.meta.url), "utf8");
const input = {
  project_id: "hfykngbhcxmnpxvjagoj",
  name: "songcraft-cover-ai",
  verify_jwt: true,
  entrypoint_path: "index.ts",
  files: [{ name: "index.ts", content: source }],
};

await writeFile(new URL("../.tmp-cover-function-deploy.json", import.meta.url), JSON.stringify(input));
