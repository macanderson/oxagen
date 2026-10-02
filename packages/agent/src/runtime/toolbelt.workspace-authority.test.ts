/**
 * The workspace Owner and Admin rule in the tools Stella offers a person,
 * walked over every registered capability (#5228).
 *
 * `contractGrantsCaller` decides whether a person's turn is offered a tool.
 * It reads the person's roles on the turn's own workspace, so a workspace
 * Owner or Admin is offered every capability that acts inside it, as the
 * handler's gate admits them. On an org-level capability they are offered
 * exactly what the contract's own grants gave before, and a Member or Viewer
 * is offered exactly what they were before. `offeredBefore` is the function's
 * logic as it stood before #5228, copied from it.
 */
import { describe, expect, it } from "vitest";
import {
  listCapabilities,
  type CapabilityDeclaration,
} from "@oxagen/oxagen";
import { actsInWorkspace } from "@oxagen/oxagen/iam";
import type { RegistryCapability } from "../registry-loader";
import { contractGrantsCaller, type CallerRoles } from "./toolbelt";

const view = (cap: CapabilityDeclaration) =>
  cap as unknown as RegistryCapability;

/** The decision before #5228, copied from `contractGrantsCaller`. */
function offeredBefore(cap: CapabilityDeclaration, roles: CallerRoles) {
  const grants = cap.defaultRoles as {
    org: Record<string, string | undefined>;
    workspace: Record<string, string | undefined>;
  };
  return (
    roles.org.some((role) => grants.org[role] === "allow") ||
    roles.workspace.some((role) => grants.workspace[role] === "allow")
  );
}

const every = listCapabilities();
const workspaceCapabilities = every.filter((cap) => actsInWorkspace(cap));
const orgCapabilities = every.filter((cap) => !actsInWorkspace(cap));

describe("the walk covers the registry", () => {
  it("walks both workspace and org-level capabilities", () => {
    expect(workspaceCapabilities.length).toBeGreaterThan(200);
    expect(orgCapabilities.length).toBeGreaterThan(20);
  });
});

describe.each(["Owner", "Admin"])(
  "a workspace %s with no org role",
  (role) => {
    const roles: CallerRoles = { org: [], workspace: [role] };

    it("is offered every workspace capability", () => {
      const withheld = workspaceCapabilities
        .filter((cap) => !contractGrantsCaller(view(cap), roles))
        .map((cap) => cap.name);
      expect(withheld).toEqual([]);
    });

    it("gains nothing on an org-level capability (negative)", () => {
      const changed = orgCapabilities
        .filter(
          (cap) =>
            contractGrantsCaller(view(cap), roles) !==
            offeredBefore(cap, roles),
        )
        .map((cap) => cap.name);
      expect(changed).toEqual([]);
    });
  },
);

describe("everyone else is offered what they were before", () => {
  const holdings: Record<string, CallerRoles> = {
    "workspace Member": { org: [], workspace: ["Member"] },
    "workspace Viewer": { org: [], workspace: ["Viewer"] },
    "an org-only turn": { org: ["Admin"], workspace: [] },
    "no role": { org: [], workspace: [] },
  };

  it.each(Object.keys(holdings))("%s", (label) => {
    const roles = holdings[label]!;
    const changed = every
      .filter(
        (cap) =>
          contractGrantsCaller(view(cap), roles) !== offeredBefore(cap, roles),
      )
      .map((cap) => cap.name);
    expect(changed).toEqual([]);
  });
});
