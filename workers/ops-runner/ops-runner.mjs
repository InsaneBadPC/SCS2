#!/usr/bin/env node
/**
 * SongCraft ops runner – vykonává operace, které si uživatel nechal schválit
 * v chatu SongCraft Studia.
 *
 * Bezpečnostní hranice (viz supabase/migrations/20260929010000_agent_ops_queue.sql):
 *   1) Bere VÝHRADNĚ řádky ve stavu `approved`. Nikdy `pending_confirmation` –
 *      to znamená, že uživatel ještě neřekl ano, a spustit ho by bylo obcházení
 *      potvrzení.
 *   2) Běží jako neprivilegovaný účet, `sudo` v cestě není, timeout je tvrdý.
 *   3) Každý běh zapíše do append-only `agent_action_log` a do `agent_ops`,
 *      takže se to nedá potichu přepsat.
 *   4) Schválení má časový limit; expirované `approved` řádky se zneplatní.
 *   5) Výstup je oříznutý, aby se do DB nevešlo 40 MB logu.
 *
 * Proměnné: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPS_POLL_MS (5000),
 * OPS_TIMEOUT_MS (300000), OPS_MAX_OUTPUT (20000).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pollMs = Number(process.env.OPS_POLL_MS || 5000);
const timeoutMs = Number(process.env.OPS_TIMEOUT_MS || 300000);
const maxOutput = Number(process.env.OPS_MAX_OUTPUT || 20000);
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
const api = (table, query = "") => `${url}/rest/v1/${table}${query}`;

async function request(endpoint, options = {}) {
  // Bez timeoutu by se zavěšený fetch zastavil celá smyčka, protože chyby se
  // vypisují jen jednou za cyklus a ticho by působilo jako "fronta je prázdná".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(endpoint, {
      ...options,
      signal: controller.signal,
      headers: { ...headers, ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`timeout po 30 s: ${endpoint}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const clip = (text) => (text.length > maxOutput ? `${text.slice(0, maxOutput)}\n… zkráceno` : text);

/** Bez `sudo`, pevný timeout, žádné tty. */
async function runCommand(command) {
  try {
    const { stdout, stderr } = await exec("/bin/bash", ["-lc", command], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.OPS_HOME || "/tmp",
        // bezpečné: žádné credentials v prostředí dědice
      },
    });
    return { output: clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`), exitCode: 0 };
  } catch (error) {
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";
    const code = typeof error.code === "number" ? error.code : 1;
    return { output: clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`), exitCode: code, error: error.message };
  }
}

async function runGitPush({ branch, path: repoDir }) {
  const dir = repoDir || process.env.OPS_REPO_DIR;
  if (!dir) return { output: "chybí OPS_REPO_DIR", exitCode: 1 };
  const branchName = String(branch || "dev/ai-manager-studio");
  if (!/^[\w./-]+$/.test(branchName)) return { output: "neplatný název větve", exitCode: 1 };
  const result = await runCommand(`cd ${dir} && git push origin HEAD:refs/heads/${branchName}`);
  return result;
}

async function runDeployWorker({ repoDir, service = "songcraft-renderer.service" }) {
  const dir = repoDir || process.env.OPS_REPO_DIR;
  if (!dir) return { output: "chybí OPS_REPO_DIR", exitCode: 1 };
  // Instaluje jen dva známé soubory a restartuje službu. Nic jiného.
  const result = await runCommand(
    `set -e; cd ${dir}; `
    + `test -f workers/video-renderer/worker.mjs; test -f workers/video-renderer/loop-engine.mjs; `
    + `install -m 644 workers/video-renderer/worker.mjs /tmp/w.mjs; `
    + `install -m 644 workers/video-renderer/loop-engine.mjs /tmp/le.mjs; `
    + `echo "souborů připraveno"`,
  );
  if (result.exitCode !== 0) return result;
  return {
    ...result,
    output: `${result.output}\n[sudno-free] zápis do /opt a restart služby vyžadují právo uživatele songcraft-renderer nebo sudo; `
      + `runner běží bez sudo, takže tady končí. Nasadit ručně:\n`
      + `sudo install -o root -g root -m 644 workers/video-renderer/worker.mjs /opt/songcraft-studio/workers/video-renderer/worker.mjs\n`
      + `sudo install -o root -g root -m 644 workers/video-renderer/loop-engine.mjs /opt/songcraft-studio/workers/video-renderer/loop-engine.mjs\n`
      + `sudo systemctl restart ${service}`,
    exitCode: 0,
  };
}

async function runReadFile({ path: filePath, repo = "InsaneBadPC/SCS2", ref = "main" }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { output: "chybí GITHUB_TOKEN na VM", exitCode: 1 };
  const clean = String(filePath || "").replace(/^\/+/, "");
  if (clean.includes("..")) return { output: "cesta smí obsahovat jen soubory repa", exitCode: 1 };
  const url_ = `https://api.github.com/repos/${repo}/contents/${clean}?ref=${encodeURIComponent(ref)}`;
  try {
    const response = await fetch(url_, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
    if (!response.ok) return { output: `${response.status}: ${await response.text()}`, exitCode: 1 };
    const data = await response.json();
    if (data.encoding === "base64") return { output: clip(Buffer.from(data.content, "base64").toString("utf8")), exitCode: 0 };
    return { output: clip(JSON.stringify(data, null, 1)), exitCode: 0 };
  } catch (error) {
    return { output: error.message, exitCode: 1 };
  }
}

async function runReadSkills({ path: file = "songcraftskills.md" } = {}) {
  const local = process.env.OPS_SKILLS_DIR
    ? path.join(process.env.OPS_SKILLS_DIR, path.basename(file))
    : null;
  if (local) {
    try {
      return { output: clip(await readFile(local, "utf8")), exitCode: 0 };
    } catch (error) {
      return { output: error.message, exitCode: 1 };
    }
  }
  return runReadFile({ path: file });
}

const HANDLERS = {
  shell: (args) => runCommand(args.command),
  git_push: (args) => runGitPush(args),
  deploy_worker: (args) => runDeployWorker(args),
  read_file: (args) => runReadFile(args),
  read_skills: (args) => runReadSkills(args),
};

async function expireStale() {
  const now = new Date().toISOString();
  await request(api("agent_ops", "?status=eq.pending_confirmation&expires_at=lt." + now), {
    method: "PATCH",
    body: JSON.stringify({ status: "expired" }),
  }).catch(() => {});
  // schválené, ale nevykonané po expiraci, se taky zneplatní
  await request(api("agent_ops", "?status=eq.approved&expires_at=lt." + now), {
    method: "PATCH",
    body: JSON.stringify({ status: "expired" }),
  }).catch(() => {});
}

async function claimNext() {
  // atomický claim: dvě podmínky v jednom requestu, aby si dva rungery neukradly
  // stejný řádek
  // PostgREST přes surový fetch vrací JSON pole, ne objekt s klíčem data.
  // Dřívější `const { data } = ...` tedy vždy dalo undefined a runner nikdy nic
  // nevzal, přestože fronta plná byla.
  const candidates = await request(
    api("agent_ops", "?status=eq.approved&select=id,user_id,kind,command,args,summary&order=created_at.asc&limit=1"),
  );
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const row = candidates[0];
  // PostgREST má u PATCH ve výchozím stavu Prefer: return=minimal, tedy 204
  // bez těla. Bez return=representation by update proběhl, ale runner by neměl
  // co vracet, řádek by zůstal viset ve stavu running a nikdo by ho dokončil.
  const claimed = await request(
    api("agent_ops", `?id=eq.${row.id}&status=eq.approved`),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "running", started_at: new Date().toISOString() }),
    },
  );
  if (!Array.isArray(claimed) || !claimed.length) return null;
  return claimed[0];
}

async function processOne() {
  const job = await claimNext();
  if (!job) return false;
  const handler = HANDLERS[job.kind];
  console.log(`[start] ${job.id} ${job.kind} — ${job.summary}`);
  let result;
  if (!handler) result = { output: `neznámý druh operace: ${job.kind}`, exitCode: 1 };
  else if (job.kind === "shell" && typeof job.command !== "string") {
    result = { output: "chybí command", exitCode: 1 };
  } else {
    result = await handler({ ...(job.args || {}), command: job.command });
  }
  await request(api("agent_ops", `?id=eq.${job.id}`), {
    method: "PATCH",
    body: JSON.stringify({
      status: result.exitCode === 0 ? "done" : "failed",
      output: result.output ?? null,
      exit_code: result.exitCode,
      error_message: result.exitCode === 0 ? null : clip(result.error || "operace skončila chybou"),
      finished_at: new Date().toISOString(),
    }),
  }).catch((error) => console.error("[write-back]", error.message));
  // audit: append-only tabulka, smazat se to nedá
  await request(api("agent_action_log"), {
    method: "POST",
    body: JSON.stringify({
      user_id: job.user_id, agent_name: "ops_runner", tool_name: job.kind,
      status: result.exitCode === 0 ? "success" : "error",
      payload: { opId: job.id, summary: job.summary, exitCode: result.exitCode },
    }),
  }).catch(() => {});
  console.log(`[${result.exitCode === 0 ? "done" : "failed"}] ${job.id} (exit ${result.exitCode})`);
  return true;
}

console.log(`Temney ops runner ready; poll ${pollMs} ms, timeout ${timeoutMs} ms, max výstup ${maxOutput} znaků`);
for (;;) {
  try {
    await expireStale();
    const worked = await processOne();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, pollMs));
  } catch (error) {
    console.error("[loop]", error.message);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
