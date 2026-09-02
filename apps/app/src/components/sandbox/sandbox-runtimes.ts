/**
 * sandbox-runtimes.ts — the truthful runtime + package-manager catalog per base
 * image, shared by the warm form (compose install steps into setupCmd) and the
 * detail-page environment panel (install packages on a live sandbox).
 *
 * Source of truth for what a base image actually ships is
 * `warm-up-templates.ts` `contents` (which itself mirrors the real Modal image
 * build in `ops/modal-sandbox/runner.py`). This module maps a base image to the
 * package managers a person can drive from the UI and how to build a safe
 * install command for each.
 *
 * IMPORTANT: the base language RUNTIME versions are baked into the Modal
 * image and are chosen at warm time by picking a template — they are not
 * swappable on a live sandbox. This module exposes the runtimes as read-only
 * info and only offers PACKAGE installation (npm / pip / apt), which is
 * fully wired through `run_sandbox_command`.
 */

import type { SandboxImage } from "./warm-up-templates";

/** A language runtime present in an image, with its baked-in version. */
export interface RuntimeInfo {
  name: string;
  version: string;
}

export type PackageManagerId = "npm" | "pip" | "apt";

export interface PackageManager {
  id: PackageManagerId;
  /** Short label shown on the segmented control (npm / pip / apt). */
  label: string;
  /** The language/ecosystem this manager installs for. */
  language: string;
  /** Placeholder illustrating the expected package tokens. */
  placeholder: string;
  /** One-line note about where the packages land. */
  hint: string;
  /**
   * Build the install command for a list of ALREADY-VALIDATED package names.
   * Runs in the workspace root (`/work`), where the terminal and file browser
   * both operate, so installed deps (package.json, node_modules) are visible.
   */
  install: (packages: string[]) => string;
}

export const PACKAGE_MANAGERS: Record<PackageManagerId, PackageManager> = {
  npm: {
    id: "npm",
    label: "npm",
    language: "Node.js",
    placeholder: "express  zod  @tanstack/react-query",
    hint: "Added to package.json + node_modules in /work.",
    install: (packages) => `npm install ${packages.join(" ")}`,
  },
  pip: {
    id: "pip",
    label: "pip",
    language: "Python",
    placeholder: "requests  pydantic  fastapi",
    hint: "Installed into the sandbox's Python environment.",
    install: (packages) => `pip install ${packages.join(" ")}`,
  },
  apt: {
    id: "apt",
    label: "apt",
    language: "System",
    placeholder: "jq  postgresql-client  ffmpeg",
    hint: "Debian system packages (installed as root).",
    install: (packages) =>
      `apt-get update && apt-get install -y ${packages.join(" ")}`,
  },
};

interface ImageRuntimeSpec {
  runtimes: RuntimeInfo[];
  managers: PackageManagerId[];
}

/**
 * Per-image runtimes + installable package managers. Mirrors the `contents`
 * manifests in warm-up-templates.ts. `apt` is available on every Debian-based
 * durable image; npm/pip track the language toolchain actually baked in.
 */
const IMAGE_SPECS: Record<SandboxImage, ImageRuntimeSpec> = {
  node: {
    runtimes: [{ name: "Node.js", version: "20" }],
    managers: ["npm", "apt"],
  },
  python: {
    runtimes: [{ name: "Python", version: "3.12" }],
    managers: ["pip", "apt"],
  },
  agent: {
    runtimes: [{ name: "Python", version: "3.12" }],
    managers: ["pip", "apt"],
  },
  shell: {
    runtimes: [{ name: "Python", version: "3.12 (system)" }],
    managers: ["apt"],
  },
};

/** Fall back to the leanest (apt-only) profile for an unknown image string. */
function specFor(image: string): ImageRuntimeSpec {
  return IMAGE_SPECS[image as SandboxImage] ?? IMAGE_SPECS.shell;
}

export function runtimesForImage(image: string): RuntimeInfo[] {
  return specFor(image).runtimes;
}

export function managersForImage(image: string): PackageManager[] {
  return specFor(image).managers.map((id) => PACKAGE_MANAGERS[id]);
}

/**
 * Package-token validity. A package name may include letters, digits, and the
 * limited punctuation real ecosystem names use (`. _ - + @ /` for scoped npm
 * packages, and pip version pins like `fastapi==0.110`).
 *
 * What this charset actually guarantees is that no command SEPARATOR reaches
 * the composed string: no whitespace, `;`, `|`, `&`, `$`, backtick, or `'`, so
 * a token can never start a second command. It is not a full shell-safety
 * guarantee — it deliberately admits the comparison operators version pins need
 * (`< > = ~ !`), and `< > ~ *` still carry shell meaning. Consequence today:
 * `install()` interpolates tokens unquoted, so `pip install requests>=2` is read
 * by the shell as a redirect into a file named `=2` and installs bare
 * `requests` — the pin is silently dropped. Fixing that means single-quoting
 * each token inside every `install()` (tokens can never contain `'`), and
 * updating the two call-site expectations in
 * apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/sandboxes/actions.test.ts.
 */
const PACKAGE_TOKEN = /^[A-Za-z0-9._+@/=<>~!*-]+$/;

export function isValidPackageToken(token: string): boolean {
  return token.length > 0 && token.length <= 214 && PACKAGE_TOKEN.test(token);
}

/** Split a free-text field into de-duplicated package tokens (space/comma/newline). */
export function parsePackageTokens(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,]+/)) {
    const token = raw.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
