/**
 * The one place Tacho learns its own version. Every manifest in the monorepo
 * carries the same number (`pnpm release:*` writes it, `pnpm check:versions`
 * enforces it), and this module reads that number rather than repeating it:
 * `scripts/bundle.mjs` stamps `__TACHO_VERSION__` into every bundle, and a
 * run from source falls back to `package.json`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Stamped by `scripts/bundle.mjs`; undefined when running from source. */
declare const __TACHO_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __TACHO_VERSION__ === "string") return __TACHO_VERSION__;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The version `tacho --version` prints and the MCP gateway reports. */
export const TACHO_VERSION: string = readVersion();
