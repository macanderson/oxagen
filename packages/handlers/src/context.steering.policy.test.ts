import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOVERNANCE_MODE,
  mergeRefusal,
  parseGovernanceMode,
} from "./context.steering.policy";

describe("governance mode", () => {
  it("defaults to team when no governance.toml exists, and reads the file when it does", () => {
    expect(parseGovernanceMode(null)).toBe("team");
    expect(DEFAULT_GOVERNANCE_MODE).toBe("team");
    expect(parseGovernanceMode('mode = "regulated"\nseparation = true\n')).toBe(
      "regulated",
    );
    expect(parseGovernanceMode('mode = "solo"')).toBe("solo");
  });

  it("refuses a file it cannot read rather than falling to the default", () => {
    expect(parseGovernanceMode("mode = [")).toMatchObject({
      error: expect.stringContaining("not TOML"),
    });
    expect(parseGovernanceMode('mode = "anarchy"')).toMatchObject({
      error: expect.stringContaining('"anarchy"'),
    });
    expect(parseGovernanceMode("separation = true")).toMatchObject({
      error: expect.stringContaining("undefined"),
    });
  });
});

describe("who may merge", () => {
  const author = "u_author";
  const member = { userId: "u_m", orgRole: null, workspaceRole: "Member" };
  const wsOwner = { userId: "u_o", orgRole: null, workspaceRole: "Owner" };
  const orgAdmin = { userId: "u_a", orgRole: "Admin", workspaceRole: null };
  const viewer = { userId: "u_v", orgRole: null, workspaceRole: "Viewer" };

  it("solo: any workspace member, the author included", () => {
    expect(mergeRefusal("solo", member, author)).toBeNull();
    expect(
      mergeRefusal("solo", { ...member, userId: author }, author),
    ).toBeNull();
    expect(mergeRefusal("solo", viewer, author)).toBe("org_role_required");
  });

  it("team: an org Owner/Admin or workspace Owner other than the author", () => {
    expect(mergeRefusal("team", wsOwner, author)).toBeNull();
    expect(mergeRefusal("team", orgAdmin, author)).toBeNull();
    expect(mergeRefusal("team", member, author)).toBe("org_role_required");
    expect(mergeRefusal("team", { ...wsOwner, userId: author }, author)).toBe(
      "separation_of_duties",
    );
  });

  it("regulated: an org Owner/Admin other than the author, and nobody without a principal", () => {
    expect(mergeRefusal("regulated", orgAdmin, author)).toBeNull();
    expect(mergeRefusal("regulated", wsOwner, author)).toBe(
      "org_role_required",
    );
    expect(
      mergeRefusal("regulated", { ...orgAdmin, userId: author }, author),
    ).toBe("separation_of_duties");
    expect(
      mergeRefusal(
        "regulated",
        { userId: null, orgRole: null, workspaceRole: null },
        author,
      ),
    ).toBe("no_principal");
  });
});
