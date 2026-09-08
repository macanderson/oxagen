import { describe, expect, it } from "vitest";
import { tachoHostList } from "./tacho.host.list";

describe("tachoHostList", () => {
  it("defaults the page size and accepts a status filter", () => {
    expect(tachoHostList.input.parse({}).limit).toBe(50);
    expect(
      tachoHostList.input.parse({ status: "revoked", limit: 5, cursor: "c" })
        .status,
    ).toBe("revoked");
    expect(tachoHostList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(tachoHostList.input.safeParse({ status: "lost" }).success).toBe(
      false,
    );
  });

  it("answers with host summaries and a cursor", () => {
    const output = tachoHostList.output.parse({
      hosts: [
        {
          hostEnrollmentId: "tch_0123456789abcdefghjkmn",
          agentKey: "acme.core.cc-laptop",
          hostname: "laptop",
          platform: "darwin",
          osUser: "dev",
          status: "active",
          mode: "observe",
          harnesses: ["claude-code"],
          claudeVersionAtEnroll: "2.1.263",
          wrapperVersion: "2.1.1",
          managed: false,
          lastSeenAt: null,
          lastIngestAt: null,
          hooksOk: null,
          otelOk: null,
          spoolDepth: 0,
          sessionsCount: 0,
          unobservedSessionsCount: 0,
          incidentsOpen: 0,
          expiresAt: "2027-03-07T00:00:00.000Z",
          revokedAt: null,
          createdAt: "2026-09-08T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(output.hosts).toHaveLength(1);
    expect(tachoHostList.name).toBe("list_tacho_hosts");
    expect(tachoHostList.mutates).toBe(false);
  });
});
