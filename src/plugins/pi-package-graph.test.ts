import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
};

const PI_PACKAGE_NAMES = [
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
] as const;

function readRootManifest(): RootPackageManifest {
  const manifestPath = path.resolve(process.cwd(), "package.json");
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RootPackageManifest;
}

function isExactPinnedVersion(spec: string): boolean {
  return !spec.startsWith("^") && !spec.startsWith("~");
}

const LOCAL_REFERENCE_PREFIXES = ["file:", "link:", "portal:", "workspace:"] as const;

function isLocalSpec(spec: string): boolean {
  return LOCAL_REFERENCE_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

function readNamedPackageVersion(dir: string, packageName: string): string | undefined {
  const manifestPath = path.join(dir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name?: string;
    version?: string;
  };
  if (manifest.name !== packageName || typeof manifest.version !== "string") {
    return undefined;
  }
  return manifest.version;
}

function resolvePiVersion(packageName: string, spec: string): string | undefined {
  // pnpm-audit-prod skips file:/link:/portal:/workspace: refs. Those pins stay
  // aligned when the local package.json version matches the other exact pins.
  if (spec.startsWith("file:") || spec.startsWith("link:")) {
    const relativePath = spec.slice(spec.indexOf(":") + 1);
    return readNamedPackageVersion(path.resolve(process.cwd(), relativePath), packageName);
  }
  if (!isLocalSpec(spec)) {
    return spec;
  }
  const vendorDir = path.resolve(process.cwd(), "vendor");
  if (!fs.existsSync(vendorDir)) {
    return undefined;
  }
  for (const entry of fs.readdirSync(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const version = readNamedPackageVersion(path.join(vendorDir, entry.name), packageName);
    if (version) {
      return version;
    }
  }
  return undefined;
}

function isPiOverrideKey(key: string): boolean {
  return key.startsWith("@mariozechner/pi-") || key.includes("@mariozechner/pi-");
}

function readPiDependencySpecs() {
  const dependencies = readRootManifest().dependencies ?? {};
  return PI_PACKAGE_NAMES.map((name) => ({
    name,
    spec: dependencies[name],
  }));
}

function expectNoGraphViolations(violations: string[], message: string) {
  expect(violations, message).toEqual([]);
}

describe("pi package graph guardrails", () => {
  it("keeps root Pi packages aligned to the same exact version", () => {
    const specs = readPiDependencySpecs();

    const missing = specs.filter((entry) => !entry.spec).map((entry) => entry.name);
    expectNoGraphViolations(
      missing,
      `Missing required root Pi dependencies: ${missing.join(", ") || "<none>"}. Mixed or incomplete Pi root dependencies create an unsupported package graph.`,
    );

    const resolved = specs.map((entry) => ({
      ...entry,
      version: resolvePiVersion(entry.name, entry.spec ?? ""),
    }));
    const unresolved = resolved
      .filter((entry) => !entry.version)
      .map((entry) => `${entry.name}=${entry.spec}`);
    expectNoGraphViolations(
      unresolved,
      `Root Pi dependencies must resolve to one package version. Found: ${unresolved.join(", ") || "<none>"}.`,
    );
    const uniqueVersions = [...new Set(resolved.map((entry) => entry.version))];
    expect(
      uniqueVersions,
      `Root Pi dependencies must stay aligned to one exact version. Found: ${resolved.map((entry) => `${entry.name}=${entry.spec} -> ${entry.version}`).join(", ")}. Mixed Pi versions create an unsupported package graph.`,
    ).toHaveLength(1);

    const inexact = specs.filter((entry) => !isExactPinnedVersion(entry.spec));
    expectNoGraphViolations(
      inexact.map((entry) => `${entry.name}=${entry.spec}`),
      `Root Pi dependencies must use exact pins, not ranges. Found: ${inexact.map((entry) => `${entry.name}=${entry.spec}`).join(", ") || "<none>"}. Range-based Pi specs can silently create an unsupported package graph.`,
    );
  });

  it("forbids pnpm overrides that target Pi packages", () => {
    const manifest = readRootManifest();
    const overrides = manifest.pnpm?.overrides ?? {};
    const piOverrides = Object.keys(overrides).filter(isPiOverrideKey);

    expectNoGraphViolations(
      piOverrides,
      `pnpm.overrides must not target Pi packages. Found: ${piOverrides.join(", ") || "<none>"}. Pi-specific overrides can silently create an unsupported package graph.`,
    );
  });
});
