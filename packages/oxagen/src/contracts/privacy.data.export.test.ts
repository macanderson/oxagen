import { describe, it, expect } from "vitest";
import { privacyDataExport } from "./privacy.data.export";
import { getCapability } from "../registry";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("privacy.data.export capability", () => {
  it("is registered", () => {
    expect(getCapability("export_data")).toBeDefined();
  });

  it("parses user-scope input without orgId", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "user" }),
    ).not.toThrow();
  });

  it("parses org-scope input with valid orgId", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "org", orgId: VALID_UUID }),
    ).not.toThrow();
  });

  // The kernel runs `input.safeParse` on every surface, so this is where an
  // org-scope request missing its orgId is refused -- as invalid input (400),
  // not as a bare throw inside the handler (500). The MCP tool's flat xmcp
  // schema cannot express a cross-field rule, so it has to live here.
  it("rejects org-scope input with no orgId", () => {
    const result = privacyDataExport.input.safeParse({ scope: "org" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["orgId"]);
    }
  });

  it("rejects unknown scope", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "workspace" }),
    ).toThrow();
  });

  it("rejects org-scope with invalid orgId UUID", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "org", orgId: "not-a-uuid" }),
    ).toThrow();
  });

  it("parses queued output without downloadUrl", () => {
    expect(() =>
      privacyDataExport.output.parse({
        exportId: VALID_UUID,
        status: "queued",
      }),
    ).not.toThrow();
  });

  it("parses ready output with downloadUrl", () => {
    expect(() =>
      privacyDataExport.output.parse({
        exportId: VALID_UUID,
        status: "ready",
        downloadUrl: "https://blob.example.com/export.zip",
      }),
    ).not.toThrow();
  });

  it("rejects output with invalid downloadUrl", () => {
    expect(() =>
      privacyDataExport.output.parse({
        exportId: VALID_UUID,
        status: "ready",
        downloadUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects output missing exportId", () => {
    expect(() =>
      privacyDataExport.output.parse({ status: "queued" }),
    ).toThrow();
  });

  // A person is never the wrong person to export their own data, and on an
  // enterprise org the resolver is the only thing between a member and their
  // own record. An invited member holds no org role at all -- iam-provision
  // seeds Owner, Admin, Compliance and Billing, and nothing else -- so a role
  // map cannot admit them; rule 8 has to.
  it("defaults to allow, so a member holding no org role is not refused", () => {
    expect(privacyDataExport.defaultEffect).toBe("allow");
  });

  // The map is read BY NAME by iam-provision, which iterates the real role
  // list, so a name that is not a real role seeds no grant. It is also what
  // list_capabilities shows an operator, and a map naming roles that do not
  // exist is a lie on an admin screen whatever the resolver does with it.
  it("names exactly the four system org roles", () => {
    expect(privacyDataExport.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    });
  });

  // Assembling the ZIP spends no AI credits, and the billing gate runs before
  // the handler. Without this, an organisation that has exhausted its credits
  // could not export its data -- the thing a customer needs most when their
  // account is in trouble would be the first to stop working.
  it("is exempt from the billing gate", () => {
    expect(privacyDataExport.noBillingGate).toBe(true);
  });

  // The org-scope restriction cannot live here: it turns on an input field,
  // which defaultRoles cannot read. privacy.data.export.ts's handler re-reads
  // the caller's membership on the TARGET org, which is also the only check
  // that holds when a body-supplied orgId differs from the context org.
  it("grants no workspace role, so the gate is the org one", () => {
    expect(privacyDataExport.defaultRoles.workspace).toEqual({});
  });

  it("is available on api, mcp, and agent surfaces", () => {
    expect(privacyDataExport.surfaces).toContain("api");
    expect(privacyDataExport.surfaces).toContain("mcp");
    expect(privacyDataExport.surfaces).toContain("agent");
  });

  it("is in the privacy domain", () => {
    expect(privacyDataExport.domain).toBe("privacy");
  });

  it("is async mode", () => {
    expect(privacyDataExport.mode).toBe("async");
  });
});
