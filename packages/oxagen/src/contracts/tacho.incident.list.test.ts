import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  TAMPER_INCIDENT_KINDS,
  incidentItemSchema,
  incidentKindSchema,
  tachoIncidentList,
} from "./tacho.incident.list";

const item = {
  id: "tin_0123456789abcdefghjkmn",
  kind: "hooks_removed",
  severity: 10,
  detectedAt: "2026-09-14T10:00:00.000Z",
  detectedBy: "collector",
  hostEnrollmentId: "tch_0123456789abcdefghjkmn",
  sessionId: null,
  agentKey: "acme.core.release-bot",
  evidence: { hook: "PreToolUse", path: "~/.claude/settings.json" },
  resolvedAt: null,
  resolutionNote: null,
};

describe("list_incidents contract", () => {
  it("is a console read: non-mutating, unmetered, Owner/Admin/Member", () => {
    expect(getCapability("list_incidents")).toBe(tachoIncidentList);
    expect(tachoIncidentList.mutates).toBe(false);
    expect(tachoIncidentList.noBillingGate).toBe(true);
    expect(tachoIncidentList.surfaces).toEqual(["api", "mcp"]);
    expect(tachoIncidentList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Member: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
  });

  it("defaults the page size, narrows by agent and open, and refuses the rest", () => {
    expect(tachoIncidentList.input.parse({})).toEqual({ limit: 50 });
    expect(
      tachoIncidentList.input.parse({
        agentId: "release-bot",
        open: true,
        limit: 5,
      }),
    ).toEqual({ agentId: "release-bot", open: true, limit: 5 });
    expect(tachoIncidentList.input.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(
      tachoIncidentList.input.safeParse({ kind: "chain_break" }).success,
    ).toBe(false);
  });

  it("every tamper kind is an incident kind", () => {
    for (const kind of TAMPER_INCIDENT_KINDS) {
      expect(incidentKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(TAMPER_INCIDENT_KINDS).not.toContain("unobserved_session");
  });

  it("carries the three severities the CHECK admits and refuses another", () => {
    for (const severity of [1, 3, 10]) {
      expect(incidentItemSchema.safeParse({ ...item, severity }).success).toBe(
        true,
      );
    }
    expect(incidentItemSchema.safeParse({ ...item, severity: 5 }).success).toBe(
      false,
    );
  });

  it("a control-plane finding may carry no host, no session and no agent key", () => {
    const parsed = incidentItemSchema.parse({
      ...item,
      detectedBy: "control_plane",
      kind: "telemetry_gap",
      severity: 3,
      hostEnrollmentId: null,
      agentKey: null,
    });
    expect(parsed.hostEnrollmentId).toBeNull();
    expect(
      tachoIncidentList.output.parse({ items: [parsed], nextCursor: "n" })
        .nextCursor,
    ).toBe("n");
  });
});
