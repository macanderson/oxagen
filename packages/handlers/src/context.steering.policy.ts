// context.steering.policy.ts — the governance mode and who may merge under it
// (ADR-061; MC spec §10.2 governance.toml, §10.3 step 3). Pure: the handler
// reads the file and the caller's roles, this decides.
import { parse } from "smol-toml";
import type { GovernanceMode } from "@oxagen/oxagen/contracts/context.steering.shared";
import { LEGACY_GOVERNANCE_PATH } from "@oxagen/oxagen/steering-repo/paths";

export const GOVERNANCE_PATH = LEGACY_GOVERNANCE_PATH;

/** The mode a new workspace runs under when no governance.toml exists (ADR-061 decision 1). */
export const DEFAULT_GOVERNANCE_MODE: GovernanceMode = "team";

/**
 * The mode declared by `.oxagen/rules/governance.toml`, or the default when
 * the file is absent. A file that exists but declares no mode, or an unknown
 * one, is refused: a governance file that cannot be read must not silently
 * fall to the default.
 */
export function parseGovernanceMode(
  text: string | null,
): GovernanceMode | { error: string } {
  if (text === null) return DEFAULT_GOVERNANCE_MODE;
  let tree: unknown;
  try {
    tree = parse(text);
  } catch (err) {
    return {
      error: `governance.toml is not TOML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const mode =
    typeof tree === "object" && tree !== null
      ? (tree as Record<string, unknown>).mode
      : undefined;
  if (mode === "solo" || mode === "team" || mode === "regulated") return mode;
  return {
    error: `governance.toml declares mode ${JSON.stringify(mode)}; expected solo, team or regulated`,
  };
}

interface MergeActor {
  userId: string | null;
  orgRole: string | null;
  workspaceRole: string | null;
}

/** What each mode asks of the merger, for the page's "What merge will do". */
export const REVIEW_BY_MODE: Record<GovernanceMode, string> = {
  solo: "solo: any workspace member merges, the author included",
  team: "team: an org Owner or Admin, or a workspace Owner, other than the author merges",
  regulated:
    "regulated: an org Owner or Admin other than the author merges, recorded as the accountable approver",
};

/**
 * The merge gate per mode. Returns null when the actor may merge, else the
 * reason code the handler refuses with.
 */
export function mergeRefusal(
  mode: GovernanceMode,
  actor: MergeActor,
  authorUserId: string | null,
): "no_principal" | "org_role_required" | "separation_of_duties" | null {
  if (!actor.userId) return "no_principal";
  const orgAdmin = actor.orgRole === "Owner" || actor.orgRole === "Admin";
  const wsOwner = actor.workspaceRole === "Owner";
  const wsMember = wsOwner || actor.workspaceRole === "Member";
  const isAuthor = authorUserId !== null && authorUserId === actor.userId;
  switch (mode) {
    case "solo":
      return orgAdmin || wsMember ? null : "org_role_required";
    case "team":
      if (!(orgAdmin || wsOwner)) return "org_role_required";
      return isAuthor ? "separation_of_duties" : null;
    case "regulated":
      if (!orgAdmin) return "org_role_required";
      return isAuthor ? "separation_of_duties" : null;
  }
}
