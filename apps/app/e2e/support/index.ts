// What the three specs and the config share: the seeded identities
// (ARCHITECTURE.md §5) and the runtime files the harness writes under
// `e2e/.auth/` (INV-20 admits that dot-entry). This module imports no
// platform package, so the config and the specs load it without a database.
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
const E2E_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Runtime output of the harness; gitignored (`e2e/.gitignore`). */
export const AUTH_DIR = path.join(E2E_DIR, ".auth");

/** The owner's storage state: written by login.spec.ts, read by the dependent projects. */
export const OWNER_STATE = path.join(AUTH_DIR, "owner.json");

/**
 * What `seed:e2e` minted that a spec cannot know ahead of time: the seeded
 * run's `arun_…` public id and the seeded mandate's `mnd_…` public id, as
 * `{ runPublicId, mandatePublicId }`. Written by the seed; `routes.ts` reads
 * the mandate id for the two Mandate rows.
 */
export const SEED_RECORD = path.join(AUTH_DIR, "seed.json");

/** `/{org}/{ws}` — the Fleet page of the seeded workspace. */
export const FLEET_PATH = `/${SEED.orgSlug}/${SEED.workspaceSlug}`;
