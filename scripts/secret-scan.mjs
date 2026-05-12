#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([".git", "node_modules", "test-results", "playwright-report"]);
const ignoredFiles = new Set(["package-lock.json"]);
const privateLocalPathPattern = new RegExp([
  "\\/Users\\/" + "soroush",
  "\\.codex\\/" + "voice-codex",
  "Open" + "Claw",
  "Mac " + "mini",
].join("|"), "g");
const patterns = [
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{20,}\b/g],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["private local path", privateLocalPathPattern],
];

const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(entry.name)) continue;
    const stat = statSync(path);
    if (stat.size > 1024 * 1024) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const before = text.slice(0, match.index);
        const line = before.split("\n").length;
        findings.push(`${rel}:${line}: ${label}`);
      }
    }
  }
}

walk(root);

if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("secret scan ok");
