// The organization and workspace choice mappers over real contract outputs: each sample is parsed by the
// contract's own output schema first, so a sample the contract would reject
// cannot make a mapper test pass.
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { describe, expect, it } from "vitest";
import { OrgChoice, WorkspaceChoice } from "@/data/contracts/shell";
import { toOrgChoices, toWorkspaceChoices } from "./pretenant";

const orgs = orgList.output.parse({
  organizations: [
    {
      id: "7a000000-0000-4000-8000-0000000000a1",
      publicId: "org_acme",
      slug: "acme",
      namespace: "acme",
      name: "Acme Robotics",
      role: "owner",
      avatarUrl: null,
    },
    {
      id: "7a000000-0000-4000-8000-0000000000a2",
      publicId: "org_globex",
      slug: "globex",
      namespace: "globex",
      name: "Globex",
      role: "viewer",
      avatarUrl: "https://example.test/globex.png",
    },
  ],
});

const workspace = (slug: string, name: string, role: string | null) => ({
  id: `7b000000-0000-4000-8000-${slug.padStart(12, "0").slice(-12)}`,
  publicId: `ws_${slug}`,
  slug,
  namespace: slug,
  name,
  avatarUrl: null,
  role,
  // list_workspaces answers archivedAt on every row: null while active.
  archivedAt: null,
  costCenter: null,
});

const workspaces = workspaceList.output.parse({
  organization: {
    id: "7a000000-0000-4000-8000-0000000000a1",
    publicId: "org_acme",
    slug: "acme",
    namespace: "acme",
    name: "Acme Robotics",
    avatarUrl: null,
  },
  workspaces: [
    workspace("core", "Core platform", "owner"),
    workspace("finance", "Finance", null),
    workspace("research", "Research", "viewer"),
  ],
});

describe("toOrgChoices", () => {
  it("lists every organization the viewer belongs to by slug, name and avatar", () => {
    expect(toOrgChoices(orgs)).toEqual([
      { slug: "acme", name: "Acme Robotics", avatarUrl: null },
      {
        slug: "globex",
        name: "Globex",
        avatarUrl: "https://example.test/globex.png",
      },
    ]);
  });

  it("reads a blank avatar as none, so the view model does not refuse the list (negative)", () => {
    const blank = orgList.output.parse({
      organizations: [{ ...orgs.organizations[0], avatarUrl: "" }],
    });
    expect(toOrgChoices(blank)).toEqual([
      { slug: "acme", name: "Acme Robotics", avatarUrl: null },
    ]);
    expect(OrgChoice.safeParse(toOrgChoices(blank)[0]).success).toBe(true);
  });
});

describe("toWorkspaceChoices", () => {
  it("lists the workspaces the viewer is a member of", () => {
    expect(toWorkspaceChoices(workspaces)).toEqual([
      { slug: "core", name: "Core platform", avatarUrl: null },
      { slug: "research", name: "Research", avatarUrl: null },
    ]);
  });

  it("carries a workspace's avatar and reads a blank one as none", () => {
    const set = workspaceList.output.parse({
      organization: workspaces.organization,
      workspaces: [
        {
          ...workspace("core", "Core platform", "owner"),
          avatarUrl: "https://example.test/core.png",
        },
        { ...workspace("research", "Research", "viewer"), avatarUrl: "" },
      ],
    });
    const choices = toWorkspaceChoices(set);
    expect(choices).toEqual([
      {
        slug: "core",
        name: "Core platform",
        avatarUrl: "https://example.test/core.png",
      },
      { slug: "research", name: "Research", avatarUrl: null },
    ]);
    for (const choice of choices)
      expect(WorkspaceChoice.safeParse(choice).success).toBe(true);
  });

  it("leaves out a workspace the viewer is not a member of (negative)", () => {
    const slugs = toWorkspaceChoices(workspaces).map((ws) => ws.slug);
    expect(slugs).not.toContain("finance");
  });
});
