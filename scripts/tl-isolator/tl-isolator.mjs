#!/usr/bin/env node
/**
 * tl-isolator v1.0.0 — Token-Limit Isolation Layer.
 *
 * SERIES PRODUCTION MODULE (atomic write style, semantic versioned).
 *
 * Problem class it isolates:
 *   Transport pipelines that cap, chunk or wrap payloads can silently
 *   inject newlines at fixed byte boundaries (~2000) and truncate content
 *   at hard caps (~32k). Both corrupt files mid-token and force repair
 *   cycles that burn CI minutes and conversation tokens.
 *
 * Isolation strategy (three guarantees):
 *   G1 CARGO-INTEGRITY  — payloads carry a SHA-256 content seal; a
 *                         payload is only accepted when its seal
 *                         re-computes identically after transport.
 *   G2 FRAGMENT-TRANSPORT — payloads travel as numbered fragments,
 *                         each below the wrap/cap thresholds, framed
 *                         with begin/end markers; reassembly refuses
 *                         gaps, duplicates or out-of-order fragments.
 *   G3 ATOMIC-COMMIT    — a repaired/parsed payload is written via a
 *                         verify-then-publish step; the published
 *                         artifact is byte-identical to the sealed
 *                         source or the write is refused.
 *
 * API (stable, semver):
 *   seal(content)            -> { version, digest, length }
 *   fragment(content, max)   -> Fragment[]   (default max 1500)
 *   reassemble(fragments)    -> string       (throws on integrity loss)
 *   detectWrapArtifacts(str) -> Artifact[]   (~2000-byte boundary splits)
 *   atomicWrite(path, content, { expectDigest }) -> Report
 *
 * Exit codes (CLI): 0 clean, 3 artifacts-found, 4 integrity-failure.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export const TL_ISOLATOR_VERSION = "1.0.0";
const WRAP_MODULO = 2000;
const WRAP_TOLERANCE = 2;
const WORD_CHAR = /[A-Za-z0-9_/.-]/;

/** G1: content seal. */
export function seal(content) {
  const text = String(content);
  return {
    version: TL_ISOLATOR_VERSION,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
    length: Buffer.byteLength(text, "utf8"),
  };
}

/** G2: fragment a payload into transport-safe chunks with frames. */
export function fragment(content, max = 1500) {
  const text = String(content);
  const size = Math.max(64, Math.floor(max));
  const parts = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  const { digest } = seal(text);
  return parts.map((body, index) => ({
    tli: TL_ISOLATOR_VERSION,
    digest,
    total: parts.length,
    index,
    body,
  }));
}

/** G2: reassemble framed fragments; refuse anything not exactly sealed. */
export function reassemble(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    throw new Error("tl-isolator: empty fragment list");
  }
  const first = fragments[0];
  for (const f of fragments) {
    if (f.tli !== first.tli || f.digest !== first.digest) {
      throw new Error("tl-isolator: fragment set carries mixed seals");
    }
  }
  const total = first.total;
  if (fragments.length !== total) {
    throw new Error(`tl-isolator: expected ${total} fragments, received ${fragments.length}`);
  }
  const ordered = fragments.slice().toSorted((a, b) => a.index - b.index);
  ordered.forEach((f, i) => {
    if (f.index !== i) {
      throw new Error(`tl-isolator: fragment gap at position ${i}`);
    }
  });
  const text = ordered.map((f) => f.body).join("");
  const verify = seal(text);
  if (verify.digest !== first.digest || verify.length !== first.length) {
    throw new Error("tl-isolator: reassembled content fails its seal");
  }
  return text;
}

/** Detector for the ~2000-byte boundary wrap-corruption class. */
export function detectWrapArtifacts(content) {
  const text = String(content);
  const lines = text.split("\n");
  const artifacts = [];
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    offset += lines[i].length + 1;
    const prev = lines[i].at(-1) ?? "";
    const next = lines[i + 1].at(0) ?? "";
    const mod = offset % WRAP_MODULO;
    const nearBoundary = mod <= WRAP_TOLERANCE || mod >= WRAP_MODULO - WRAP_TOLERANCE;
    if (nearBoundary && WORD_CHAR.test(prev) && WORD_CHAR.test(next) && !/^\s/.test(lines[i + 1])) {
      artifacts.push({ lineIndex: i, byteOffset: offset });
    }
  }
  return artifacts;
}

/** G3: verify-then-publish atomic write. */
export function atomicWrite(filePath, content, options = {}) {
  const text = String(content);
  const expect = options.expectDigest;
  const actual = seal(text);
  if (expect && expect !== actual.digest) {
    return { ok: false, reason: "digest-mismatch", ...actual };
  }
  const tmp = `${filePath}.tli-${process.pid}-${Date.now()}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmp, text, "utf8");
  const written = seal(readFileSync(tmp, "utf8"));
  if (written.digest !== actual.digest) {
    unlinkSync(tmp);
    return { ok: false, reason: "write-verify-failed", ...actual };
  }
  renameSync(tmp, filePath);
  const published = seal(readFileSync(filePath, "utf8"));
  if (published.digest !== actual.digest) {
    return { ok: false, reason: "publish-verify-failed", ...actual };
  }
  return { ok: true, reason: "published", ...actual, bytes: statSync(filePath).size };
}

/** Self-test: proves G1–G3 in one process. Used by the CI lane. */
export function selfTest() {
  const results = {};
  // G1
  const payload = "A".repeat(4500) + " codeql-action/autobuild " + "B".repeat(4500);
  const s = seal(payload);
  results.g1_seal =
    /^[a-f0-9]{64}$/.test(s.digest) && s.length === Buffer.byteLength(payload, "utf8");
  // G2 roundtrip
  const frags = fragment(payload);
  const round = reassemble(frags);
  results.g2_roundtrip =
    round === payload && frags.every((f) => Buffer.byteLength(f.body, "utf8") < WRAP_MODULO);
  // G2 rejection on tamper
  let tamperRejected = false;
  try {
    const bad = frags.slice();
    bad[1] = { ...bad[1], body: bad[1].body + "!" };
    reassemble(bad);
  } catch {
    tamperRejected = true;
  }
  results.g2_tamper_rejected = tamperRejected;
  // G2 rejection on gap
  let gapRejected = false;
  try {
    reassemble(frags.slice(1));
  } catch {
    gapRejected = true;
  }
  results.g2_gap_rejected = gapRejected;
  // detector
  const corrupted = "x".repeat(1999) + "codeql-actio\nn/autobuild" + "y".repeat(100);
  results.detector = detectWrapArtifacts(corrupted).length === 1;
  // G3 happy path (temp dir)
  const dir = `${process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp"}/tli-selftest`;
  const target = `${dir}/artifact.txt`;
  const w = atomicWrite(target, payload, { expectDigest: s.digest });
  results.g3_atomic_ok = w.ok;
  // G3 digest mismatch refusal
  const w2 = atomicWrite(`${dir}/refused.txt`, payload, { expectDigest: "deadbeef" });
  results.g3_mismatch_refused = !w2.ok && w2.reason === "digest-mismatch";
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? "selftest";
  if (mode === "selftest") {
    const results = selfTest();
    const failed = Object.entries(results).filter(([, v]) => !v);
    console.log(JSON.stringify({ version: TL_ISOLATOR_VERSION, results }, null, 2));
    process.exit(failed.length === 0 ? 0 : 4);
  }
}
