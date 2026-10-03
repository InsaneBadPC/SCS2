#!/usr/bin/env node

/**
 * Lightweight repository guard for the production security boundary.
 * It intentionally prints paths and line numbers only—never matched values.
 * Run with --report in local review; CI runs the default strict mode.
 */
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const reportOnly = process.argv.includes("--report");
const ignoredDirectories = new Set([".git", "node_modules", ".expo", "dist", "dist-web", ".csweb-test", "backups"]);
const ignoredFiles = new Set([".env", ".env.local", ".env.production", ".env.development"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql", ".yml", ".yaml", ".sh", ".md"]);

const rules = [
  { id: "supabase-secret", pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g },
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { id: "third-party-api-key", pattern: /\b(?:ffmpeg_site_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{24,})\b/g },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: "jwt-literal", pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "hardcoded-secret-assignment", pattern: /\b(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|YOUTUBE_CLIENT_SECRET|GOOGLE_AI_STUDIO_KEY|GEMINI_API_KEY)\s*[:=]\s*["'][^"']{20,}["']/gi },
];

const findings = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      if (ignoredDirectories.has(entry.name) || entry.name === ".env") continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      await walk(absolute);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name)) || ignoredFiles.has(entry.name)) continue;
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    const content = await readFile(absolute, "utf8");
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of content.matchAll(rule.pattern)) {
        const line = content.slice(0, match.index).split("\n").length;
        findings.push({ file: relative, line, rule: rule.id });
      }
    }
  }
}

function scanPublicReleaseBoundary() {
  const activeFiles = [
    "workers/video-renderer/worker.mjs",
    "supabase/functions/video-renderer-dispatch/index.ts",
  ];
  for (const relative of activeFiles) {
    try {
      const content = readFileSync(relative, "utf8");
      if (/github\.com\/[^\s]+\/releases|api\.github\.com\/repos\/[^\s]+\/releases/i.test(content)) {
        findings.push({ file: relative, line: 1, rule: "public-release-pipeline" });
      }
    } catch {
      // The file may be absent in a partial checkout; normal repo validation handles it.
    }
  }
}

await walk(root);
scanPublicReleaseBoundary();

if (!findings.length) {
  console.log("security-boundary-check: OK");
  process.exit(0);
}

console.error(`security-boundary-check: ${findings.length} finding(s)`);
for (const finding of findings) console.error(`- ${finding.file}:${finding.line} [${finding.rule}]`);
if (!reportOnly) {
  console.error("Secret values are intentionally not printed. Remove the finding or update the reviewed baseline before release.");
  process.exit(1);
}
