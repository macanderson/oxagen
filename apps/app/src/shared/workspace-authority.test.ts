// The app's copy of the workspace Owner and Admin rule (#5228): a workspace's
// Owner or Admin may act in it, whatever their org role, and nobody else
// gains anything from a workspace role.
import { describe, expect, it } from "vitest";
import {
  holdsWorkspaceAuthority,
  mayActInWorkspace,
} from "./workspace-authority";

describe("holdsWorkspaceAuthority", () => {
  it("is true for the workspace Owner and Admin", () => {
    expect(holdsWorkspaceAuthority("owner")).toBe(true);
    expect(holdsWorkspaceAuthority("admin")).toBe(true);
  });

  it("ignores case, because the membership column holds both casings", () => {
    expect(holdsWorkspaceAuthority("Owner")).toBe(true);
    expect(holdsWorkspaceAuthority("ADMIN")).toBe(true);
  });

  it("is false for every other workspace role (negative)", () => {
    for (const wsRole of ["member", "billing", "compliance", "viewer"]) {
      expect(holdsWorkspaceAuthority(wsRole)).toBe(false);
    }
  });

  it("is false for no role at all (negative)", () => {
    expect(holdsWorkspaceAuthority(null)).toBe(false);
    expect(holdsWorkspaceAuthority(undefined)).toBe(false);
    expect(holdsWorkspaceAuthority("")).toBe(false);
    expect(holdsWorkspaceAuthority("owners")).toBe(false);
  });
});

describe("mayActInWorkspace", () => {
  const ORG_MANAGERS = ["owner", "admin"] as const;

  it("admits an org role the capability names, whatever the workspace role", () => {
    expect(mayActInWorkspace("owner", "viewer", ORG_MANAGERS)).toBe(true);
    expect(mayActInWorkspace("admin", null, ORG_MANAGERS)).toBe(true);
  });

  it("admits the workspace Owner or Admin whose org role is only Member", () => {
    expect(mayActInWorkspace("member", "owner", ORG_MANAGERS)).toBe(true);
    expect(mayActInWorkspace("member", "admin", ORG_MANAGERS)).toBe(true);
    expect(mayActInWorkspace("viewer", "admin", ["owner"])).toBe(true);
  });

  it("refuses an org role the capability does not name, with no workspace authority (negative)", () => {
    for (const orgRole of ["member", "billing", "compliance", "viewer"]) {
      for (const wsRole of ["member", "billing", "compliance", "viewer"]) {
        expect(mayActInWorkspace(orgRole, wsRole, ORG_MANAGERS)).toBe(false);
      }
    }
  });

  it("reads the org role exactly as the viewer seam spells it (negative)", () => {
    expect(mayActInWorkspace("Owner", "member", ORG_MANAGERS)).toBe(false);
    expect(mayActInWorkspace("owner", "member", [])).toBe(false);
  });
});
