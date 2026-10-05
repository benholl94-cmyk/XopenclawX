#!/usr/bin/env node
/**
 * wrap-guard.mjs — autonomous line-wrap corruption self-healing.
 *
 * Detects a specific corruption class: a newline injected at a byte offset
 * that is a multiple of ~2000 in the middle of a word/token. This artifact
 * pattern is produced by length-capping fetch/push pipelines and splits
 * identifiers across lines (e.g. "codeql-actio\nn/autobuild").
 *
 * Detection is deliberately conservative: a newline is only treated as an
 * injected artifact when ALL of the following hold:
 *   1. its byte offset in the file is within WRAP_MODULO_TOLERANCE of a
 *      multiple of WRAP_MODULO (default 2000),
 *   2. the character before the newline is a word character,
 *   3. the character after the newline is a word character,
 *   4. the line after the newline is not indented (real code lines in the
 *      wrapped region are always indented in the affected file types).
 *
 * When artifacts are found, the file is rewritten with them joined and the
 * repair is reported on stdout as a machine-readable list.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const WRAP_MODULO = 2000;
const WRAP_MODULO_TOLERANCE = 2;
const WORD = /[A-Za-z0-9_/.-]/;

function changedFiles(baseRef) {
  const out = execSync(`git diff --name-only --diff-filter=ACM ${baseRef}..HEAD`, {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function findWrapArtifacts(content) {
  const artifacts = [];
  let offset = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    offset += lines[i].length + 1; // +1 for the newline we are inspecting
    const prev = lines[i].at(-1) ?? "";
    const next = lines[i + 1].at(0) ?? "";
    const nearBoundary =
      Math.abs(offset % WRAP_MODULO) <= WRAP_MODULO_TOLERANCE ||
      Math.abs((offset % WRAP_MODULO) - WRAP_MODULO) <= WRAP_MODULO_TOLERANCE;
    const nextLineIndented = /^\s/.test(lines[i + 1]);
    if (nearBoundary && WORD.test(prev) && WORD.test(next) && !nextLineIndented) {
      artifacts.push({ lineIndex: i, offset });
    }
  }
  return artifacts;
}

function repair(content, artifacts) {
  const lines = content.split("\n");
  // join from the last artifact backwards so indices stay valid
  for (const a of [...artifacts].toReversed()) {
    lines[a.lineIndex] = lines[a.lineIndex] + lines[a.lineIndex + 1];
    lines.splice(a.lineIndex + 1, 1);
  }
  return lines.join("\n");
}

function main() {
  const baseRef = process.argv[2] || "HEAD~1";
  const files = changedFiles(baseRef);
  const repaired = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) {
      continue; // skip binary files
    }
    const artifacts = findWrapArtifacts(content);
    if (artifacts.length === 0) {
      continue;
    }
    const fixed = repair(content, artifacts);
    writeFileSync(file, fixed, "utf8");
    repaired.push({ file, count: artifacts.length });
  }
  console.log(JSON.stringify({ repaired }, null, 2));
  process.exit(repaired.length > 0 ? 3 : 0); // exit 3 = repairs written
}

main();
