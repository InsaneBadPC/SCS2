import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orchestrator = readFileSync("supabase/functions/agent-orchestrator/index.ts", "utf8");
const publish = readFileSync("supabase/functions/youtube-publish/index.ts", "utf8");
const oauth = readFileSync("supabase/functions/youtube-oauth-start/index.ts", "utf8");

describe("agent and publication boundaries", () => {
  it("validates pending confirmation payloads before rendering them", () => {
    expect(readFileSync("lib/agent-api.ts", "utf8")).toContain("candidate.confirmationToken.length >= 32");
  });

  it("does not send a confirmation nonce back to the model", () => {
    expect(orchestrator).toContain('confirmationToken: "[withheld]"');
  });

  it("requires a one-time confirmation before YouTube upload", () => {
    expect(publish).toContain('eq("action", "publish_to_youtube")');
    expect(publish).toContain('eq("status", "pending")');
    expect(publish).toContain('candidate.expires_at');
    expect(publish).toContain("nonce_hash");
  });

  it("uses PKCE and does not put the provider key in the URL", () => {
    expect(oauth).toContain("code_challenge_method: \"S256\"");
    expect(oauth).toContain("code_verifier");
  });

  it("never references an undefined identifier in the uploaded-video branch", () => {
    // Regrese: hasSourceVideo bylo použité, ale nikdy nedefinované, takže
    // make_music_video i make_short končily ReferenceError (chyba CI TS2304).
    // Definice musí existovat (původní stav: 0 definic, 1 použití → TS2304) a
    // každý handler, který proměnnou zavádí, ji musí také použít.
    const defines = orchestrator.match(/const hasSourceVideo =/g) ?? [];
    const uses = orchestrator.match(/hasSourceVideo/g) ?? [];
    expect(defines.length).toBeGreaterThan(0);
    expect(uses.length).toBeGreaterThan(defines.length);
    for (const segment of orchestrator.split("if (name ===")) {
      if (!segment.includes("hasSourceVideo")) continue;
      expect(segment, "větev používá hasSourceVideo, ale nedefinuje ho").toContain("const hasSourceVideo =");
    }
  });

  it("selects the source video column the loop branch depends on", () => {
    expect(orchestrator).toContain("source_video_path");
    expect(orchestrator).toContain("id,title,lyrics,style_prompt,cover_path,source_video_path");
  });

  it("only queues render types the worker and the DB constraint accept", () => {
    // type smí být jen to, co worker umí a co povoluje agent_videos_type_check
    // ('static_cover' | 'image_animation' | 'full_scenes' | 'video_loop')
    for (const forbidden of [
      'type: isShort ? "short"',
      '"lyric_video"',
      'mode: "living_motion"',
      'mode: "loop_video"',
      'backend: "vm_living"',
      'backend: "vm_loop"',
    ]) {
      expect(orchestrator, forbidden).not.toContain(forbidden);
    }
    expect(orchestrator).toContain('type: "video_loop"');
    expect(orchestrator).toContain('type: "image_animation"');
    expect(orchestrator).toContain('backend: "vm_image_animation"');
  });

  it("declares the tool the system prompt tells the model to use", () => {
    // Regrese: prompt volal check_video_status, ale tool neexistoval, takže si ho
    // model musel vymyslet.
    expect(orchestrator).toContain("check_video_status");
    const declared = orchestrator.match(/name: "check_video_status"/g) ?? [];
    const dispatched = orchestrator.match(/name === "check_video_status"/g) ?? [];
    expect(declared.length).toBe(1);
    expect(dispatched.length).toBe(1);
  });

  it("offers both video kinds to the agent through the loop engine", () => {
    for (const tool of ["make_long_video", "make_short_video"]) {
      expect(orchestrator, tool).toContain(`name: "${tool}"`);
      expect(orchestrator, tool).toContain('type: "source_loop"');
      expect(orchestrator, tool).toContain('backend: "ffmpeg"');
    }
    // 16:9 pro celé video, 9:16 pro short
    expect(orchestrator).toContain('const aspect = isShort ? "9:16" : "16:9";');
    // oba nástroje v jednom handleru, jinak by se logika rozdvojila
    expect(orchestrator).toContain('if (name === "make_long_video" || name === "make_short_video")');
    // finální MP3 i vlastnictví cesty zůstávají povinné
    expect(orchestrator).toContain("Pro render musí být vybraná finální MP3 verze.");
    expect(orchestrator).toContain("Finální MP3 nemá platnou cestu vlastníka.");
  });

  it("tells the model that video needs no invented motion prompt", () => {
    const prompt = orchestrator.slice(orchestrator.indexOf("VIDEO — pravidla"));
    expect(prompt).toContain("make_long_video");
    expect(prompt).toContain("make_short_video");
    expect(prompt).toContain("NEPIŠ motionPrompt");
  });

  it("reads PostgREST responses as arrays, not as a supabase-js envelope", () => {
    const ops = readFileSync("workers/ops-runner/ops-runner.mjs", "utf8");
    // Runner používá surový fetch, takže vrací JSON pole. Rozbalení { data } by
    // vždy dalo undefined a fronta by se nikdy nezpracovala.
    expect(ops).not.toMatch(/const \{ data[^}]*\} = await request\(/);
    expect(ops).toContain("Array.isArray(candidates)");
    expect(ops).toContain("Array.isArray(claimed)");
    // visící fetch nesmí zmrazit smyčku potichu
    // PATCH musí žádat tělo zpět, jinak přijde 204 a řádek zůstane viset
    expect(ops).toContain('Prefer: "return=representation"');
    expect(ops).toContain("AbortController");
    expect(ops).toContain("AbortError");
  });

  it("nasazuje youtube-status, jinak aplikace spadne na staré tlačítko", () => {
    // Seznam funkcí je ruční. Když nová funkce není v workflow, zůstane
    // nenasazená, appka ji nemůže volat a vrátí se k nefungujícímu tlačítku,
    // které hází redirect_uri_mismatch.
    const wf = readFileSync(".github/workflows/deploy-agent-orchestrator.yml", "utf8");
    const deployed = [...wf.matchAll(/functions deploy --use-api ([a-z0-9-]+)/g)].map((m) => m[1]);
    expect(deployed).toContain("youtube-status");
    expect(new Set(deployed).size, "duplicitní nasazování").toBe(deployed.length);
  });

  it("nasazuje legal stránky veřejně, ať na ně Googlebot dosáhne", () => {
    const wf = readFileSync(".github/workflows/deploy-agent-orchestrator.yml", "utf8");
    const legal = readFileSync("supabase/functions/legal/index.ts", "utf8");
    expect(wf).toMatch(/functions deploy --use-api legal .*--no-verify-jwt/);
    // veřejná stránka nesmí vracet nic osobního
    expect(legal).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(legal).not.toContain("youtube_credentials");
    expect(legal).toContain("page=privacy");
    expect(legal).toContain("page=terms");
  });

  it("keeps the system prompt template literal closed", () => {
    // Past na tuhle chybu: při patchi promptu se jednou přepsal řádek, který
    // template literal uzavíral, a orchestrator měl syntaktickou chybu, kterou
    // tsc přehlédl a build těžko chytil.
    const backticks = (orchestrator.match(/(?<!\\)`/g) || []).length;
    expect(backticks % 2, "nepárový počet zpětných uvozovek v orchestrátoru").toBe(0);
    expect(orchestrator).toMatch(/publish_to_youtube vždy vyžaduje potvrzení\.`;/);
    expect(orchestrator).toMatch(/Čeká na potvrzení/);
  });

  it("gates every VM operation behind the user's confirmation", () => {
    const confirm = readFileSync("supabase/functions/agent-confirm/index.ts", "utf8");
    const ops = readFileSync("workers/ops-runner/ops-runner.mjs", "utf8");
    for (const tool of ["run_vm_command", "push_git_branch", "deploy_worker", "read_repo_file", "read_skills"]) {
      expect(orchestrator, tool).toContain(`name: "${tool}"`);
      expect(confirm, tool).toContain(`"${tool}"`);
    }
    // fronta vzniká vždy jako pending_confirmation, nikdy rovnou approved
    expect(orchestrator).toContain('status: "pending_confirmation"');
    // runner smí brát výhradně approved
    expect(ops).toContain('?status=eq.approved&select=');
    expect(ops).toContain('?id=eq.${row.id}&status=eq.approved');
    // tvrdý timeout, čisté prostředí, žádné vykonávání sudo
    expect(ops).toContain("OPS_TIMEOUT_MS");
    expect(ops).toContain("HOME: process.env.OPS_HOME");
    expect(ops).not.toMatch(/exec\(\s*"sudo/);
    expect(ops).not.toMatch(/bash\s*,\s*\[[^\]]*"sudo/);
    // potvrzení přepíná stav na approved a audit je append-only
    expect(confirm).toContain('"pending_confirmation"');
    expect(confirm).toContain('"approved"');
    expect(ops).toContain("agent_action_log");
  });

  it("blocks the destructive commands the agent must never run", () => {
    const block = orchestrator.slice(orchestrator.indexOf("OPS_ACTIONS.has(name)"));
    expect(block).toContain("sudo|rm");
    expect(block).toContain("Bezpečnostní pravidlo");
    expect(block).toContain("4_000");
  });

  it("blocks the destructive commands the agent must never run", () => {
    const block = orchestrator.slice(orchestrator.indexOf('OPS_ACTIONS.has(name)'));
    expect(block).toContain("sudo|rm\\s+-rf");
    expect(block).toContain("Bezpečnostní pravidlo");
    expect(block).toContain("4_000");
  });

  it("keeps the web deploy token out of the repository", () => {
    const deployer = readFileSync("scripts/upload-supabase-web.mjs", "utf8");
    const entry = readFileSync("scripts/upload-external-web-entry.mjs", "utf8");
    for (const [name, source] of [["upload-supabase-web", deployer], ["upload-external-web-entry", entry]] as const) {
      expect(source, name).toContain("SONGCRAFT_WEB_DEPLOY_TOKEN");
      expect(source, name).not.toMatch(/scweb-[0-9a-f]/);
      expect(source, name).toContain("if (!deployToken)");
    }
  });
});
