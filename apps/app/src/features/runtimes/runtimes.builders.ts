// Typed Runtimes values for the Runtimes component tests (ARCHITECTURE.md §5):
// host enrollments, agents, and a DataSource that answers the runtimes reads
// with what a test hands it. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type {
  RuntimeAgent,
  RuntimeAgents,
  RuntimeEnrollment,
  RuntimeList,
} from "@/data/contracts/runtimes";
import type { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

export function enrollment(
  overrides: Partial<RuntimeEnrollment> = {},
): RuntimeEnrollment {
  return {
    id: "tch_mbellmbp16aaaaaaaaaaaaa",
    hostname: "mbell-mbp-16",
    platform: "darwin",
    osUser: "mbell",
    status: "active",
    mode: "enforce",
    harnesses: ["claude-code"],
    claudeVersionAtEnroll: "2.1.4",
    collectorVersion: "1.6.2",
    modelRoute: "loopback",
    shadowedBy: null,
    hooksOk: true,
    lastSeenAt: "2026-09-23T09:12:44.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2099-09-01T10:00:00.000Z",
    revokedAt: null,
    agentKey: "acme.core.release-manager",
    ...overrides,
  };
}

export function runtimeAgent(
  overrides: Partial<RuntimeAgent> = {},
): RuntimeAgent {
  return {
    id: "agt_releasemanager",
    slug: "release-manager",
    name: "Release manager",
    agentKey: "acme.core.release-manager",
    harness: "claude-code",
    operatorId: "usr_marcusbell",
    principalId: "prn_01JQ8W3F2M6XKD7A9RZT4BVCNE",
    runs30d: 212,
    ...overrides,
  };
}

export function runtimeList(
  enrollments: RuntimeEnrollment[],
  more = false,
): Read<RuntimeList> {
  return readOk({ enrollments, more });
}

/** The organization's roster, holding the operator `runtimeAgent()` names. */
export function memberList(
  members: MemberList["members"] = [
    {
      id: "usr_marcusbell",
      name: "Marcus Bell",
      email: "marcus@acme.test",
      role: "owner",
      joinedAt: "2026-01-05T09:00:00.000Z",
    },
  ],
): Read<MemberList> {
  return readOk({ members, invitations: [] });
}

/**
 * A DataSource whose runtimes port answers with the reads given, recording
 * each call, and whose org port answers the roster the detail page names an
 * operator from.
 */
export function runtimesSource(reads: {
  list: Read<RuntimeList>;
  agents?: Read<RuntimeAgents>;
  members?: Read<MemberList>;
}): {
  source: DataSource;
  calls: { agents: (readonly string[])[]; members: number };
} {
  const calls = { agents: [] as (readonly string[])[], members: 0 };
  const runtimes: DataSource["runtimes"] = {
    list: () => Promise.resolve(reads.list),
    agents: (_ctx, keys) => {
      calls.agents.push(keys);
      return Promise.resolve(
        reads.agents ?? readOk({ agents: [runtimeAgent()] }),
      );
    },
  };
  const org = {
    members: () => {
      calls.members += 1;
      return Promise.resolve(reads.members ?? memberList());
    },
  } as unknown as DataSource["org"];
  // Only the runtimes port and the roster are read by these pages; any other
  // access is a test bug.
  const source = new Proxy({ runtimes, org } as DataSource, {
    get(target, key) {
      if (key === "runtimes") return target.runtimes;
      if (key === "org") return target.org;
      throw new Error(`unexpected port ${String(key)}`);
    },
  });
  return { source, calls };
}
