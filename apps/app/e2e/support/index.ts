// What the three specs and the config share: the seeded identities
// (ARCHITECTURE.md §5) and the runtime files the harness writes under
// `e2e/.auth/` (INV-20 admits that dot-entry). This module imports no
// platform package, so the config and the specs load it without a database.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The one account, organization and workspace the suite reads. */
export const SEED = {
  email: "owner@e2e.oxagen.test",
  password: "e2e-owner-password-1",
  name: "E2E Owner",
  orgSlug: "e2e-org",
  orgName: "E2E Org",
  workspaceSlug: "core",
  workspaceName: "Core",
} as const;

/** `apps/app/e2e`, resolved from this file so cwd never matters. */
export const E2E_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Runtime output of the harness; gitignored (`e2e/.gitignore`). */
export const AUTH_DIR = path.join(E2E_DIR, ".auth");

/** The owner's storage state: written by login.spec.ts, read by the dependent projects. */
export const OWNER_STATE = path.join(AUTH_DIR, "owner.json");

/** What `seed:e2e` minted that a spec cannot know ahead of time. */
export const SEED_RECORD = path.join(AUTH_DIR, "seed.json");

export type SeedRecord = {
  /** `arun_…` public id of the seeded ledger run (the Run route). */
  runPublicId: string;
};

/** The seed record, or a thrown error naming the script that writes it. */
export function readSeedRecord(): SeedRecord {
  let text: string;
  try {
    text = readFileSync(SEED_RECORD, "utf8");
  } catch (error) {
    throw new Error(
      `${SEED_RECORD} is missing: run \`pnpm --filter @oxagen/app seed:e2e\` before the suite`,
      { cause: error },
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { runPublicId?: unknown }).runPublicId !== "string"
  ) {
    throw new Error(`${SEED_RECORD} does not carry runPublicId`);
  }
  return { runPublicId: (parsed as { runPublicId: string }).runPublicId };
}

/** `/{org}/{ws}` — the Fleet page of the seeded workspace. */
export const FLEET_PATH = `/${SEED.orgSlug}/${SEED.workspaceSlug}`;
