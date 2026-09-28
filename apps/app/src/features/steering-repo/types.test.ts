// The app keeps its own copies of the provisioning steps, the health states,
// and the re-authorize code, because it may import platform code only through
// `@oxagen/oxagen/contracts/*` (INV-03). These tests read the platform sources
// as text and fail when a copy drifts from the list the job and the health
// read use.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPO_HEALTH_STATES,
  STEERING_REAUTHORIZE,
  STEERING_REPO_STEPS,
} from "./types";

// Vitest runs from apps/app, as messages/ is read in src/i18n/request.ts.
function platformSource(relative: string): string {
  return readFileSync(path.join(process.cwd(), "../..", relative), "utf8");
}

/** The string members of `export const <name> = [ ... ] as const;`. */
function constList(source: string, name: string): string[] {
  const match = new RegExp(
    `export const ${name} = \\[([^\\]]*)\\] as const;`,
  ).exec(source);
  if (match === null) throw new Error(`no ${name} list in the source`);
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

const PROVISION = "packages/handlers/src/steering_repo.provision.ts";
const HEALTH = "packages/oxagen/src/steering-repo/health.ts";

describe("the steering repo copies", () => {
  it("lists the provisioning steps in the order the job runs them", () => {
    expect(constList(platformSource(PROVISION), "STEERING_REPO_STEPS")).toEqual(
      [...STEERING_REPO_STEPS],
    );
  });

  it("lists the health states the health read answers", () => {
    expect(constList(platformSource(HEALTH), "REPO_HEALTH_STATES")).toEqual([
      ...REPO_HEALTH_STATES,
    ]);
  });

  it("asks for re-authorization with the code the job records", () => {
    expect(platformSource(PROVISION)).toContain(
      `export const REAUTHORIZE = "${STEERING_REAUTHORIZE}";`,
    );
  });
});
