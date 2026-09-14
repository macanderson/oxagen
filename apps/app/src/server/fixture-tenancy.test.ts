import { describe, expect, it } from "vitest";
import { FIXTURE_USER } from "./fixture-session";
import {
  FIXTURE_ORG,
  FIXTURE_WORKSPACES,
  fixtureTenancyLookups as l,
} from "./fixture-tenancy";
import { resolveViewerWith } from "./viewer-resolution";

const session = {
  source: "fixture" as const,
  user: { ...FIXTURE_USER, image: null },
};
const resolve = (o: string, w?: string) =>
  resolveViewerWith({ session, lookups: l, now: new Date() }, o, w);
const [core, finops] = FIXTURE_WORKSPACES;

describe("fixture tenancy", () => {
  it("uses UUID ids, so runInTenantScope accepts a fixture scope", () => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const id of [FIXTURE_ORG.id, ...FIXTURE_WORKSPACES.map((w) => w.id)])
      expect(id).toMatch(uuid);
  });

  it("signs the fixture operator into acme / core-platform", async () => {
    const result = await resolve("acme", "core-platform");
    expect(result).toMatchObject({
      kind: "ok",
      viewer: {
        userId: FIXTURE_USER.id,
        orgRole: "member",
        scope: { orgId: FIXTURE_ORG.id, workspaceId: core?.id },
      },
    });
  });

  it("404s the workspace the fixture operator does not belong to", async () => {
    await expect(resolve("acme", "finops")).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("404s an unknown organization and a stranger", async () => {
    await expect(resolve("globex")).resolves.toEqual({ kind: "not_found" });
    await expect(l.orgRole(FIXTURE_ORG.id, "usr_stranger")).resolves.toBeNull();
    await expect(
      l.orgRole("99999999-9999-4999-8999-999999999999", FIXTURE_USER.id),
    ).resolves.toBeNull();
    await expect(
      l.isWorkspaceMember(
        "99999999-9999-4999-8999-999999999999",
        FIXTURE_USER.id,
      ),
    ).resolves.toBe(false);
  });

  it("redirects the historical organization and workspace slugs", async () => {
    await expect(resolve("acme-robotics", "platform")).resolves.toEqual({
      kind: "redirect",
      org: "acme",
      ws: "core-platform",
    });
    await expect(
      l.workspaceBySlugHistory(FIXTURE_ORG.id, "nope"),
    ).resolves.toBeNull();
  });

  it("has no MFA policy and no enrollment", async () => {
    await expect(l.mfaPolicy(FIXTURE_ORG.id)).resolves.toBeNull();
    await expect(l.twoFactorEnabled(FIXTURE_USER.id)).resolves.toBe(false);
    expect(finops?.slug).toBe("finops");
  });
});
