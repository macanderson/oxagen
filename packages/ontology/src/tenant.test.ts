import { describe, expect, it, vi } from "vitest";

const run = vi.fn(async () => ({ records: [] }));
const close = vi.fn(async () => undefined);
vi.mock("./client", () => ({ session: () => ({ run, close }) }));

import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("scopedSession", () => {
  it("requires a scope", () => {
    expect(() => scopedSession()).toThrow(/tenant scope/);
  });

  it("injects $orgId/$workspaceId into scoped Cypher", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n", { extra: 1 });
    });
    expect(run).toHaveBeenCalledWith(
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
      { extra: 1, orgId: ORG, workspaceId: WS },
    );
  });

  it("rejects Cypher that does not reference the scope", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await expect(s.run("MATCH (n) RETURN n")).rejects.toThrow(/must filter by \$orgId/);
    });
  });
});
