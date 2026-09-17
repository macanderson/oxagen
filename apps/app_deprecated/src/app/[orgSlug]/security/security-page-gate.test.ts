/**
 * The gate on the Security overview and on the audit viewer beside it.
 *
 * Both pages read org-wide `security.security_events` — the posture counts
 * here, the rows there — and both gated on membership while Postgres was
 * keeping the read narrow. `security.security_events` is `workspace_nullable`,
 * so under the org-only workspace sentinel RLS answered only the rows carrying
 * no workspace. Correcting the read without correcting the gate would have
 * handed every org member every workspace's security record.
 *
 * The governed capability is the specification: `query_audit_log` answers
 * organization-wide only for an org Owner or Admin (ORG_AUDIT_ROLES), and the
 * signed export at security/audit/export/route.ts has checked
 * SECURITY_MANAGER_ROLES since it was written. These assert the two pages now
 * agree with both.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = join(process.cwd(), "src/app/[orgSlug]/security");

function source(file: string): string {
  return readFileSync(join(here, file), "utf8");
}

describe("the Security overview", () => {
  const src = source("page.tsx");

  it("gates on the security-manager role, not membership", () => {
    expect(src).toMatch(/await assertSecurityManager\(/);
    expect(src).not.toMatch(/await assertOrgMember\(/);
  });

  it("gates before it loads the posture it would otherwise disclose", () => {
    expect(src.indexOf("await assertSecurityManager(")).toBeLessThan(
      src.indexOf("loadPosture("),
    );
  });
});

describe("the audit viewer", () => {
  const src = source("audit/page.tsx");

  it("gates on the security-manager role, not membership", () => {
    expect(src).toMatch(/await assertSecurityManager\(/);
    expect(src).not.toMatch(/await assertOrgMember\(/);
  });

  it("gates before it reads a single audit row", () => {
    expect(src.indexOf("await assertSecurityManager(")).toBeLessThan(
      src.indexOf("queryAuditPage("),
    );
  });

  it("agrees with the signed export it shares a read path with", () => {
    // Same data, same module (@/lib/audit-query), so the same role. The export
    // was already right; the viewer is what this change fixed.
    expect(source("audit/export/route.ts")).toMatch(/SECURITY_MANAGER_ROLES/);
  });
});
