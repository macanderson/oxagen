import { describe, expect, it } from "vitest";
import { computeAgentRows, HEALTH_LABEL, summarizeAgents } from "./agents";
import type { DaemonAgentSummary, DesktopState, HostView } from "./bridge";
import type { TachoStatus } from "./tacho-status";

const NOW = Date.parse("2026-09-15T12:00:00Z");

function host(overrides: Partial<HostView> = {}): HostView {
  return {
    host_enrollment_id: "tch_1",
    agent_key: "agt_1",
    organization_id: "org_1",
    workspace_id: "ws_1",
    org_slug: "acme",
    workspace_slug: "core",
    api_url: "https://api.oxagen.sh",
    host_status: "active",
    port: 47001,
    hostname: "mac",
    os_user: "mac",
    platform: "darwin",
    harnesses: ["claude-code"],
    managed: false,
    claude_version: "1.2.3",
    claude_execpath: "/usr/local/bin/claude",
    wrapper_version: "2.1.1",
    hook_command: "tacho hook",
    daemon_command: ["tacho", "daemon"],
    enrolled_at: "2026-09-01T00:00:00Z",
    expires_at: "2027-09-01T00:00:00Z",
    revoked_at: null,
    bundle_fetched_at: "2026-09-15T00:00:00Z",
    device_key_fingerprint: "ed25519:abc",
    bundle: { version: 3, mode: "enforce", expires_at: "2027-09-01T00:00:00Z" },
    ...overrides,
  };
}

function state(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    platform: "macos",
    arch: "aarch64",
    app_version: "2.1.1",
    config: {
      path: "/Users/a/.config/oxagen/config.json",
      logged_in: true,
      org_slug: "acme",
      workspace_slug: "core",
      api_url: "https://api.oxagen.sh",
      app_url: "https://app.oxagen.sh",
    },
    host: host(),
    host_path: "/Users/a/.config/oxagen/tacho/host.json",
    daemon: {
      uptime_s: 100,
      spool_depth: 0,
      last_ingest_at: null,
      last_error: null,
    },
    log_path: "/Users/a/.config/oxagen/tacho/tachod.log",
    sidecar_dir: "/Applications/Oxagen.app/Contents/MacOS",
    sidecar_transient: false,
    bin_dir: "/Users/a/.local/bin",
    oxagen_on_path: "/Users/a/.local/bin/oxagen",
    tacho_on_path: "/Users/a/.local/bin/tacho",
    cli_install_dir: "/Users/a/.local/bin",
    ...overrides,
  };
}

function agent(
  overrides: Partial<DaemonAgentSummary> = {},
): DaemonAgentSummary {
  return {
    key: "claude-code",
    runtime: "claude-code",
    harness: "claude-code",
    label: "Claude Code",
    first_seen_at: "2026-09-10T00:00:00Z",
    last_seen_at: "2026-09-15T11:57:00Z",
    sessions_total: 4,
    sessions_live: 0,
    ...overrides,
  };
}

describe("computeAgentRows: not wrapped", () => {
  it("marks a never-seen, unenrolled harness not_wrapped", () => {
    const s = state({ host: null, daemon: null });
    const rows = computeAgentRows(s, null, NOW);
    const codex = rows.find((r) => r.key === "codex")!;
    expect(codex.wrapped).toBe(false);
    expect(codex.health).toBe("not_wrapped");
    expect(codex.summary).toBe("not wrapped");
    expect(codex.lastSeenAt).toBeNull();
  });

  it("still says not_wrapped for a de-registered harness the daemon once saw", () => {
    const s = state({
      host: host({ harnesses: [] }),
      daemon: {
        uptime_s: 1,
        agents: [agent({ last_seen_at: "2026-09-15T11:50:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("not_wrapped");
    expect(cc.summary).toBe("not wrapped · last seen 10m ago");
  });

  it("lists every harness even with no machine enrollment at all", () => {
    const s = state({ host: null, daemon: null });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.map((r) => r.key)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-desktop",
    ]);
    expect(rows.every((r) => !r.wrapped)).toBe(true);
    // Every row carries its tier even when nothing is covered, so no surface
    // has to infer one (ADR-078).
    expect(rows.map((r) => r.tier)).toEqual([
      "harness",
      "harness",
      "harness",
      "harness",
      "gateway",
    ]);
  });
});

describe("computeAgentRows: collector down", () => {
  it("marks every wrapped harness down when the daemon does not answer", () => {
    const s = state({ daemon: null });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.wrapped).toBe(true);
    expect(cc.health).toBe("down");
    expect(cc.summary).toBe("collector not answering");
  });
});

describe("computeAgentRows: hook presence", () => {
  it("reports missing hooks, singular and plural", () => {
    const one: TachoStatus = {
      enrolled: true,
      hooks: { complete: false, present: [], missing: ["Stop"] },
    };
    const rowsOne = computeAgentRows(state(), one, NOW);
    expect(rowsOne.find((r) => r.key === "claude-code")!.health).toBe(
      "degraded",
    );
    expect(rowsOne.find((r) => r.key === "claude-code")!.summary).toBe(
      "1 hook missing",
    );

    const many: TachoStatus = {
      enrolled: true,
      hooks: { complete: false, present: [], missing: ["Stop", "PreToolUse"] },
    };
    const rowsMany = computeAgentRows(state(), many, NOW);
    expect(rowsMany.find((r) => r.key === "claude-code")!.summary).toBe(
      "2 hooks missing",
    );
    expect(rowsMany.find((r) => r.key === "claude-code")!.details).toContain(
      "hooks missing: Stop, PreToolUse",
    );
  });

  it("carries hook completeness and version into details for codex and stella", () => {
    const tacho: TachoStatus = {
      enrolled: true,
      hooks: { complete: true, present: ["Stop"], missing: [] },
      codexHooks: { complete: true, present: ["Stop"], missing: [] },
      stellaHooks: { complete: true, present: ["Stop"], missing: [] },
    };
    const s = state({
      host: host({
        harnesses: ["claude-code", "codex", "stella"],
        codex_version: "0.9.0",
        stella_version: "1.0.0",
      }),
    });
    const rows = computeAgentRows(s, tacho, NOW);
    const codex = rows.find((r) => r.key === "codex")!;
    const stella = rows.find((r) => r.key === "stella")!;
    expect(codex.details).toEqual(["Codex 0.9.0", "hooks complete"]);
    expect(stella.details).toEqual(["Stella 1.0.0", "hooks complete"]);
  });

  it("says how each harness gets its model credential (ADR-138)", () => {
    const tacho: TachoStatus = {
      enrolled: true,
      hooks: { complete: true, present: ["Stop"], missing: [] },
      codexHooks: { complete: true, present: ["Stop"], missing: [] },
      modelCredentials: [
        { harness: "claude-code", brokered: true },
        { harness: "codex", brokered: false, reason: "subscription_login" },
      ],
    };
    const rows = computeAgentRows(
      state({ host: host({ harnesses: ["claude-code", "codex"] }) }),
      tacho,
      NOW,
    );
    expect(rows.find((r) => r.key === "claude-code")!.details).toContain(
      "credential brokered by the gateway",
    );
    expect(rows.find((r) => r.key === "codex")!.details).toContain(
      "own login crosses the proxy (subscription, nothing to broker)",
    );
    // A status that predates the seam says nothing about credentials.
    const silent = computeAgentRows(
      state({ host: host({ harnesses: ["claude-code"] }) }),
      { enrolled: true },
      NOW,
    );
    expect(
      silent
        .find((r) => r.key === "claude-code")!
        .details.some((d) => d.includes("credential")),
    ).toBe(false);
  });

  it("reads cursor's hook presence and version from its own fields", () => {
    const tacho: TachoStatus = {
      enrolled: true,
      codexHooks: { complete: true, present: ["Stop"], missing: [] },
      cursorHooks: {
        complete: false,
        present: ["Stop"],
        missing: ["PreToolUse"],
      },
    };
    const s = state({
      host: host({
        harnesses: ["cursor"],
        codex_version: "0.9.0",
        cursor_version: "2026.09.10",
      }),
    });
    const rows = computeAgentRows(s, tacho, NOW);
    const cursor = rows.find((r) => r.key === "cursor")!;
    expect(cursor.kind).toBe("harness");
    expect(cursor.tier).toBe("harness");
    expect(cursor.wrapped).toBe(true);
    expect(cursor.details).toEqual([
      "Cursor 2026.09.10",
      "hooks missing: PreToolUse",
    ]);
  });

  it("omits version and presence details when neither is known", () => {
    const rows = computeAgentRows(
      state({ host: host({ claude_version: null }) }),
      null,
      NOW,
    );
    expect(rows.find((r) => r.key === "claude-code")!.details).toEqual([]);
  });
});

describe("computeAgentRows: error and pending", () => {
  it("degrades on a standing error while the spool has not drained", () => {
    const s = state({
      daemon: { uptime_s: 1, spool_depth: 3, last_error: "ECONNREFUSED" },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("degraded");
    expect(cc.summary).toBe("Oxagen refused or unreachable: ECONNREFUSED");
  });

  it("is pending shortly after being seen with an undrained spool", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 2,
        last_ingest_at: "2026-09-15T11:00:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:58:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("pending");
    expect(cc.summary).toBe("recorded, waiting to send");
  });

  it("reports refused events rather than calling an empty spool delivery", () => {
    // Quarantining takes the event off the spool and clears the error, so
    // everything else about this state reads exactly like a clean delivery.
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_error: null,
        last_ingest_at: "2026-09-15T11:59:00Z",
        quarantined: 2,
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("degraded");
    expect(cc.summary).toBe("2 events refused by Oxagen");
  });

  it("says 'event' for a single refused event", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        quarantined: 1,
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.find((r) => r.key === "claude-code")!.summary).toBe(
      "1 event refused by Oxagen",
    );
  });

  it("does not call a backlogged agent delivered on another agent's ship", () => {
    // `last_ingest_at` is daemon-global: with a backlog deeper than one
    // batch, a batch for some other agent can land after this agent's last
    // run while this agent's own events are still queued.
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 40,
        last_error: null,
        last_ingest_at: "2026-09-15T11:58:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("pending");
    expect(cc.summary).toBe("recorded, waiting to send");
  });

  it("degrades a pending state stuck for more than ten minutes", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 2,
        last_ingest_at: "2026-09-15T11:00:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:40:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.find((r) => r.key === "claude-code")!.health).toBe("degraded");
  });
});

describe("computeAgentRows: healthy and idle", () => {
  it("is healthy when the last ship is at or after the last-seen time", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("healthy");
    expect(cc.summary).toBe("last run 3m ago · delivered to Oxagen");
  });

  it("is healthy on a drained spool with no error even if last_ingest_at is stale", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: null,
        last_error: null,
        agents: [agent({ last_seen_at: "2026-09-15T11:57:00Z" })],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.find((r) => r.key === "claude-code")!.health).toBe("healthy");
  });

  it("is idle when wrapped but never seen", () => {
    const rows = computeAgentRows(state(), null, NOW);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.health).toBe("idle");
    expect(cc.summary).toBe("wrapped · no runs recorded yet");
  });
});

describe("computeAgentRows: custom agents", () => {
  it("adds a row per custom agent and per unrecognized runtime, skipping known harnesses", () => {
    const s = state({
      host: host({ harnesses: ["claude-code"] }),
      daemon: {
        uptime_s: 1,
        // No spool_depth reported at all: the "?? 0" fallback, not the "0"
        // spool_depth explicitly seen elsewhere.
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [
          agent({ last_seen_at: "2026-09-15T11:57:00Z" }),
          agent({
            key: "my-script",
            runtime: "custom",
            harness: "my-script",
            label: "My script",
            last_seen_at: "2026-09-15T11:55:00Z",
            sessions_total: 1,
            sessions_live: 1,
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.map((r) => r.key)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-desktop",
      "my-script",
    ]);
    const custom = rows.find((r) => r.key === "my-script")!;
    expect(custom.kind).toBe("custom");
    expect(custom.wrapped).toBe(true);
    expect(custom.details).toEqual(["reports through tacho hook"]);
    expect(custom.sessionsLive).toBe(1);
    expect(custom.health).toBe("healthy");
  });

  it("lists a custom agent quiet for a week as idle, not degraded or down", () => {
    const weekAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_error: null,
        agents: [
          agent({
            key: "old-script",
            runtime: "custom",
            harness: "old-script",
            label: "Old script",
            last_seen_at: weekAgo,
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const old = rows.find((r) => r.key === "old-script")!;
    expect(old.health).toBe("idle");
    expect(old.summary).toBe("last run 8d ago");
  });

  it("keeps a custom agent named after a built-in harness separate from it", () => {
    // tacho hook --agent codex: runtime "custom", harness "codex". Matching
    // on harness instead of runtime would fold this into the built-in
    // Codex row and hide it entirely.
    const s = state({
      host: host({ harnesses: ["claude-code"] }),
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [
          agent({
            key: "custom:codex",
            runtime: "custom",
            harness: "codex",
            label: "codex (custom script)",
            last_seen_at: "2026-09-15T11:57:00Z",
            sessions_total: 2,
            sessions_live: 0,
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    expect(rows.map((r) => r.key)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-desktop",
      "custom:codex",
    ]);
    const builtinCodex = rows.find((r) => r.key === "codex")!;
    expect(builtinCodex.kind).toBe("harness");
    expect(builtinCodex.wrapped).toBe(false);
    expect(builtinCodex.health).toBe("not_wrapped");
    expect(builtinCodex.lastSeenAt).toBeNull();
    const customCodex = rows.find((r) => r.key === "custom:codex")!;
    expect(customCodex.kind).toBe("custom");
    expect(customCodex.label).toBe("codex (custom script)");
    expect(customCodex.health).toBe("healthy");
  });

  it("degrades a custom row too when the shared collector has a standing error", () => {
    const s = state({
      daemon: {
        uptime_s: 1,
        spool_depth: 4,
        last_error: "ECONNREFUSED",
        agents: [
          agent({
            key: "my-script",
            runtime: "custom",
            harness: "my-script",
            label: "My script",
            last_seen_at: "2026-09-15T11:55:00Z",
          }),
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    const custom = rows.find((r) => r.key === "my-script")!;
    expect(custom.health).toBe("degraded");
    expect(custom.summary).toBe("Oxagen refused or unreachable: ECONNREFUSED");
  });

  it("produces no custom rows when the daemon has none", () => {
    const rows = computeAgentRows(state(), null, NOW);
    expect(rows.every((r) => r.kind !== "custom")).toBe(true);
  });
});

describe("summarizeAgents", () => {
  it("says nothing is wrapped yet when no row is wrapped", () => {
    const rows = computeAgentRows(
      state({ host: null, daemon: null }),
      null,
      NOW,
    );
    expect(summarizeAgents(rows)).toBe("no agents wrapped yet");
  });

  it("counts each health bucket present, in a fixed order, singular for one", () => {
    const s = state({
      host: host({ harnesses: ["claude-code", "codex", "stella"] }),
      daemon: {
        uptime_s: 1,
        spool_depth: 0,
        last_ingest_at: "2026-09-15T11:59:00Z",
        agents: [
          agent({ last_seen_at: "2026-09-15T11:57:00Z" }), // claude-code: healthy
        ],
      },
    });
    const rows = computeAgentRows(s, null, NOW);
    // codex and stella wrapped but never seen: idle. claude-code: healthy.
    expect(summarizeAgents(rows)).toBe("3 agents wrapped · 1 healthy · 2 idle");
  });

  it("uses singular phrasing for exactly one wrapped agent", () => {
    const rows = computeAgentRows(
      state({ host: host({ harnesses: ["claude-code"] }) }),
      null,
      NOW,
    );
    expect(summarizeAgents(rows)).toBe("1 agent wrapped · 1 idle");
  });

  it("every health label is a non-empty accessible string", () => {
    for (const label of Object.values(HEALTH_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The connected tier (ADR-078). What matters here is that a connected row is
 * never rendered as if it were wrapped: it has no hooks, no sessions, and no
 * step record, and it carries its own health path so none of the wrapped
 * cascade's readings can leak into it.
 */
describe("computeAgentRows: connected apps", () => {
  const connectedOf = (s: DesktopState, tacho: TachoStatus | null = null) =>
    computeAgentRows(s, tacho, NOW).find((r) => r.key === "claude-desktop")!;

  const presence = (
    over: Partial<NonNullable<TachoStatus["claudeDesktop"]>> = {},
  ) =>
    ({
      claudeDesktop: {
        present: true,
        foreignEnrollment: false,
        otherServers: 0,
        otherServerNames: [],
        ...over,
      },
    }) as TachoStatus;

  it("shows the app even when it is not connected, so it can be found", () => {
    const row = connectedOf(
      state({ host: host({ harnesses: ["claude-code"] }) }),
    );
    expect(row.kind).toBe("connected");
    expect(row.wrapped).toBe(false);
    expect(row.health).toBe("not_wrapped");
    expect(row.summary).toBe("not connected");
  });

  it("is a gateway row, never a harness one", () => {
    const row = connectedOf(state());
    expect(row.tier).toBe("gateway");
    expect(row.tierLabel).toBe("Connected");
    expect(row.kind).not.toBe("harness");
  });

  it("always says what it does not record", () => {
    const row = connectedOf(state());
    expect(row.records).toContain("Oxagen tools this app calls");
    expect(row.omits).toContain("Not your prompts");
    expect(row.omits).not.toHaveLength(0);
  });

  it("reports no sessions, because it has none", () => {
    // Not a placeholder: a connected app opens no session, so any non-zero
    // number here would be a session nobody ran.
    const row = connectedOf(state());
    expect(row.sessionsLive).toBe(0);
    expect(row.sessionsTotal).toBe(0);
  });

  it("is down when the collector is, because the gateway lives in it", () => {
    const row = connectedOf(
      state({
        host: host({ harnesses: ["claude-code", "claude-desktop"] }),
        daemon: null,
      }),
      presence(),
    );
    expect(row.health).toBe("down");
    expect(row.summary).toContain("no Oxagen tools");
  });

  it("is degraded when the entry has gone missing from the app's config", () => {
    const row = connectedOf(
      state({ host: host({ harnesses: ["claude-desktop"] }) }),
      presence({ present: false }),
    );
    expect(row.health).toBe("degraded");
    expect(row.summary).toContain("missing from this app's config");
  });

  it("names a stale entry from an earlier enrollment", () => {
    const row = connectedOf(
      state({ host: host({ harnesses: ["claude-desktop"] }) }),
      presence({ present: false, foreignEnrollment: true }),
    );
    expect(row.health).toBe("degraded");
    expect(row.summary).toContain("reconnect");
  });

  it("is idle until a call arrives, and says a restart may be needed", () => {
    const row = connectedOf(
      state({ host: host({ harnesses: ["claude-desktop"] }) }),
      presence(),
    );
    expect(row.health).toBe("idle");
    expect(row.summary).toContain("Restart the app");
  });

  it("is healthy once the gateway has served it", () => {
    const row = connectedOf(
      state({
        host: host({ harnesses: ["claude-desktop"] }),
        daemon: {
          spool_depth: 0,
          connected: [
            {
              client: "claude-desktop",
              enforcement_tier: "gateway",
              calls: 4,
              refused: 0,
              last_seen_at: "2026-09-15T11:58:00Z",
            },
          ],
        },
      }),
      presence(),
    );
    expect(row.health).toBe("healthy");
    expect(row.summary).toContain("2m ago");
    expect(row.details).toContain("4 tool calls through Oxagen");
  });

  it("reports refusals as the control working, not as ill health", () => {
    const row = connectedOf(
      state({
        host: host({ harnesses: ["claude-desktop"] }),
        daemon: {
          spool_depth: 0,
          connected: [
            {
              client: "claude-desktop",
              enforcement_tier: "gateway",
              calls: 9,
              refused: 3,
              last_seen_at: "2026-09-15T11:59:00Z",
            },
          ],
        },
      }),
      presence(),
    );
    // A refused call is the mandate being enforced. Nothing to clear.
    expect(row.health).toBe("healthy");
    expect(row.details).toContain("3 refused by its mandate");
  });

  it("shows how much of the app Oxagen cannot see", () => {
    // ADR-078 §3: nothing in this repo can stop a user adding another MCP
    // server, so the honest thing is to show the size of the gap.
    const row = connectedOf(
      state({ host: host({ harnesses: ["claude-desktop"] }) }),
      presence({ otherServers: 2, otherServerNames: ["filesystem", "slack"] }),
    );
    expect(row.unseenServers).toEqual(["filesystem", "slack"]);
    expect(row.details.join(" ")).toContain(
      "2 other MCP servers in this app that Oxagen does not see",
    );
  });

  it("has no unseen servers to report on a wrapped row", () => {
    const rows = computeAgentRows(state(), null, NOW);
    for (const row of rows.filter((r) => r.tier === "harness")) {
      expect(row.unseenServers).toEqual([]);
    }
  });

  it("gives every row a tier, records line and omits line", () => {
    const rows = computeAgentRows(
      state({ host: host({ harnesses: ["claude-code", "claude-desktop"] }) }),
      presence(),
      NOW,
    );
    for (const row of rows) {
      expect(row.tier).toMatch(/^(harness|gateway)$/);
      expect(row.tierLabel.length).toBeGreaterThan(0);
      expect(row.records.length).toBeGreaterThan(0);
      expect(row.omits.length).toBeGreaterThan(0);
    }
  });
});
