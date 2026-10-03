import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("workers/video-renderer/worker.mjs", "utf8");
const engine = readFileSync("workers/video-renderer/loop-engine.mjs", "utf8");


describe("Oracle video worker contract", () => {
  it("reads the persisted prompt_used column and all three modes", () => {
    expect(worker).toContain("prompt_used");
    expect(worker).not.toContain("select=id,user_id,song_id,type,mode,backend,prompt,");
    expect(worker).toContain("static_cover");
    expect(worker).toContain("image_animation");
    expect(worker).toContain("full_scenes");
  });

  it("uses final/tagged audio and private owner paths", () => {
    expect(worker).toContain("is_final=eq.true");
    expect(worker).toContain("tagged_storage_path || version.original_storage_path || version.storage_path");
    expect(worker).toContain("ownedPath(job.user_id");
  });

  it("renders the uploaded-video loop locally and never trusts a foreign path", () => {
    expect(worker).toContain("video_loop");
    expect(worker).toContain("renderSeamlessVideoLoop");
    // vlastnictví cesty se musí ověřit přes ownedPath, ne ručně
    expect(worker).toContain('ownedPath(job.user_id, job.source_video_path)');
    // plynulost: crossfade jednotka + opakování na délku audia
    expect(worker).toContain("xfade=transition=fade");
    expect(worker).toContain("-stream_loop");
    // 9:16 pro short, 16:9 jinak
    expect(worker).toContain('aspect === "9:16" ? { w: 1080, h: 1920 }');
  });

  it("has a fail-closed duration probe instead of guessing", () => {
    expect(worker).toContain("ffprobe");
    expect(worker).toContain("ffprobe returned no usable duration");
  });

  it("makes the stored aspect match the real output", () => {
    // dashboard vrací 16:9; pro 9:16 se musí výstup převést, jinak short v DB
    // tvrdí svislé a soubor je vodorovný
    expect(worker).toContain("fitToAspect");
    expect(worker).toContain("pad=1080:1920");
  });

  it("renders both video kinds with the loop engine", () => {
    expect(worker).toContain('from "./loop-engine.mjs"');
    expect(worker).toContain("buildLoopVideo");
    // 16:9 i 9:16 z jednoho průchodu
    expect(worker).toContain('aspect: job.aspect === "9:16" ? "9:16" : "16:9"');
    // video skladby, jinak obal
    expect(worker).toContain("job.source_video_path");
    expect(worker).toContain("sourceImage");
    // engine nesmí potřebovat dashboard
    expect(worker.slice(worker.indexOf('type === "source_loop"'), worker.indexOf('type === "static_cover"')))
      .not.toContain("dashGenerate");
  });

  it("probes the output with field names so the check can actually match", () => {
    // nk=1 vyhazuje názvy polí a validace hledající width= padla vždy
    expect(worker).toContain('"default=nw=1"');
    // konkrétní argument ffprobe, ne zmínka v komentáři
    expect(worker).not.toContain('"default=nw=1:nk=1"');
    expect(worker).not.toMatch(/"-of",\s*"default=[^"]*nk=1/);
    expect(worker).toContain("/width=\\d+/i");
  });

  it("keeps finished passes on retry so the engine can resume", () => {
    // smazání pracovního adresáře při retry znamenalo restart od prvního průchodu
    expect(worker).toContain("se ponechává, engine naváže");
    expect(worker).toContain("pruneOldWork");
    expect(worker).toContain("LEASE_MS = 6 * 60 * 60 * 1000");
  });

  it("only reuses passes when the plan is unchanged", () => {
    const engine = readFileSync("workers/video-renderer/loop-engine.mjs", "utf8");
    expect(engine).toContain("plan.sha");
    expect(engine).toContain("createHash");
    expect(engine).toContain("pokračuji, plán beze změny");
    // čištění smí být jen uvnitř větve "plán se změnil"
    const cleanup = engine.slice(engine.indexOf("if (previous === fingerprint)"));
    expect(cleanup).toContain("plán se změnil");
    expect(cleanup).toContain("rm(path.join(workDir, file)");
  });

  it("nezavádí funkci, která by vracela tokeny", () => {
    const fn = readFileSync("supabase/functions/youtube-status/index.ts", "utf8");
    const api = readFileSync("lib/external-studio.ts", "utf8");
    // youtube_credentials má záměrně žádnou policy pro klienta; funkce smí
    // číst jen se service role a vrátit smí příznak a titul
    expect(fn).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // refresh token se smí použít na serveru, nesmí se nikdy vrátit v odpovědi
    const bodies = [...fn.matchAll(/json\(\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
    expect(bodies.length, "funkce nic nevrací").toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, `odpověď vrací refresh_token: ${body.slice(0, 80)}`).not.toContain("refresh_token");
      expect(body, `odpověď vrací access_token: ${body.slice(0, 80)}`).not.toContain("access_token");
    }
    expect(fn).toContain("channel_id,updated_at");
    expect(api).toContain("getYoutubeChannelStatus");
    const client = api.slice(api.indexOf("export async function getYoutubeChannelStatus"));
    expect(client.slice(0, client.indexOf("export"))).not.toContain("refresh_token");
  });

  it("bere GET i POST, protoze klient posila POST", () => {
    const fn = readFileSync("supabase/functions/youtube-status/index.ts", "utf8");
    expect(fn).toContain('request.method !== "GET" && request.method !== "POST"');
    expect(fn).not.toContain('if (request.method !== "GET") return json({ error: "Použij GET." }');
    expect(readFileSync("lib/external-studio.ts", "utf8")).toContain('invoke("youtube-status", { method: "GET" })');
  });

  it("only knows render types the DB constraint allows", () => {
    const known = ['"static_cover"', '"image_animation"', '"full_scenes"', '"video_loop"'];
    for (const type of known) expect(worker).toContain(`type === ${type}`);
    expect(worker).toContain("Unknown video type");
  });

  it("runs every pass over a seamless source", () => {
    // Regrese: zdrojové video neni smycka, takze linearni pruchod delsii nez
    // zbytek zdroje se zasekl o tvrdy skok (po 121 snimcich).
    expect(engine).toContain("buildSeamlessBase");
    expect(engine).toContain("smooth.mp4");
    expect(engine).toContain("xfade=transition=fade");
    // prichody nesmi kreslit primo ze zdroje
    expect(engine).toContain("source = smooth;");
  });

  it("supports both aspect ratios from the same pass render", () => {
    expect(engine).toContain('aspect !== "16:9" && aspect !== "9:16"');
    expect(engine).toContain("{ w: 1080, h: 1920 }");
    expect(engine).toContain("pad=");
    // 16:9 nesmí jít přes filtr, jinak by se zbytečně překódoval
    expect(engine).toContain("null[v]");
  });

  it("declares a plan the join logic can satisfy", () => {
    // kazdy prechod spotrebuje T snimku, takze plan musi mit rezervu
    expect(engine).toContain("deficit");
    expect(engine).toContain("joinFrames");
    // 'cut' musi pokracovat presne od konce predchoziho pruchodu
    expect(engine).toContain("endFrame");
  });
});
