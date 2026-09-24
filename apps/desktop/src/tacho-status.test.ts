import { describe, expect, it } from "vitest";
import {
  gatewayText,
  parseTachoStatus,
  serviceStatusText,
} from "./tacho-status";

/** What `tacho status --json` prints for an enrolled host with both wrappers. */
const ENROLLED = {
  enrolled: true,
  host: {
    host_enrollment_id: "tch_x",
    port: 47001,
    harnesses: ["claude-code", "codex"],
  },
  bundle: { version: 3, etag: "e", fetched_at: "2026-09-14T00:00:00.000Z" },
  service: {
    kind: "launchd",
    installed: true,
    running: true,
    detail: "pid 12",
  },
  daemon: { uptime_s: 5 },
  hooks: {
    complete: false,
    present: ["PreToolUse", "SessionStart"],
    missing: ["Stop"],
  },
  codexHooks: { complete: true, present: ["PreToolUse"], missing: [] },
  cursorHooks: [
    { complete: false, present: ["stop"], missing: ["preToolUse"] },
  ],
  stellaHooks: { complete: false, present: [], missing: ["PreToolUse"] },
  wal: {
    sessions: 2,
    unshipped: 7,
    oldest_unshipped_at: "2026-09-13T00:00:00.000Z",
  },
};

describe("parseTachoStatus", () => {
  it("shows unknown process state and its inspection failure", () => {
    const status = parseTachoStatus(
      JSON.stringify({
        ...ENROLLED,
        service: {
          kind: "windows-startup",
          installed: true,
          running: null,
          detail: "tasklist denied",
        },
      }),
    );
    expect(status?.service?.running).toBeNull();
    expect(serviceStatusText(status!.service!)).toBe(
      "windows-startup state unknown: tasklist denied",
    );
  });

  it("keeps the members the panels show and drops the rest", () => {
    expect(parseTachoStatus(JSON.stringify(ENROLLED, null, 2))).toEqual({
      enrolled: true,
      hooks: {
        complete: false,
        present: ["PreToolUse", "SessionStart"],
        missing: ["Stop"],
      },
      codexHooks: { complete: true, present: ["PreToolUse"], missing: [] },
      cursorHooks: {
        complete: false,
        present: ["stop"],
        missing: ["preToolUse"],
      },
      stellaHooks: { complete: false, present: [], missing: ["PreToolUse"] },
      service: {
        kind: "launchd",
        installed: true,
        running: true,
        detail: "pid 12",
      },
      wal: { sessions: 2, unshipped: 7 },
    });
    // The CLI appends a newline; an unenrolled machine has nothing else.
    expect(parseTachoStatus('{\n  "enrolled": false\n}\n')).toEqual({
      enrolled: false,
    });
  });

  it("answers null for anything that is not a status document", () => {
    expect(parseTachoStatus("")).toBeNull();
    expect(parseTachoStatus("tacho: command not found\n")).toBeNull();
    expect(parseTachoStatus("null")).toBeNull();
    expect(parseTachoStatus("[]")).toBeNull();
    expect(parseTachoStatus('"enrolled"')).toBeNull();
    expect(parseTachoStatus("{}")).toBeNull();
    expect(parseTachoStatus('{"enrolled":"yes"}')).toBeNull();
    // A document cut short mid-stream is not "not enrolled".
    expect(parseTachoStatus('{"enrolled": true, "hooks": {')).toBeNull();
  });

  it("ignores malformed optional members instead of failing the read", () => {
    expect(
      parseTachoStatus(
        JSON.stringify({
          enrolled: true,
          hooks: { complete: "no" },
          codexHooks: {
            complete: true,
            present: "PreToolUse",
            missing: [1, "Stop"],
          },
          service: { kind: "systemd", installed: true },
          wal: { sessions: "2", unshipped: 0 },
        }),
      ),
    ).toEqual({
      enrolled: true,
      codexHooks: { complete: true, present: [], missing: ["Stop"] },
    });
  });
});

/**
 * The connected-app presence (ADR-078). Declaring the field was not enough:
 * until it was parsed, `connectedRow()` always saw `presence === undefined`,
 * so a deleted or stale MCP entry rendered as idle instead of degraded and
 * the servers Oxagen cannot see were never disclosed.
 */
describe("connected-app presence", () => {
  const doc = (claudeDesktop: unknown) =>
    JSON.stringify({ enrolled: true, claudeDesktop });

  it("parses a present entry with the servers it cannot see", () => {
    const status = parseTachoStatus(
      doc({
        present: true,
        foreignEnrollment: false,
        otherServers: 2,
        otherServerNames: ["filesystem", "slack"],
      }),
    );
    expect(status?.claudeDesktop).toEqual({
      present: true,
      foreignEnrollment: false,
      otherServers: 2,
      otherServerNames: ["filesystem", "slack"],
    });
  });

  it("parses an absent entry, which is what makes the row degraded", () => {
    const status = parseTachoStatus(doc({ present: false }));
    expect(status?.claudeDesktop?.present).toBe(false);
    expect(status?.claudeDesktop?.foreignEnrollment).toBe(false);
  });

  it("carries a stale entry from an earlier enrollment", () => {
    const status = parseTachoStatus(
      doc({ present: false, foreignEnrollment: true }),
    );
    expect(status?.claudeDesktop?.foreignEnrollment).toBe(true);
  });

  it("trusts the names over a count that disagrees with them", () => {
    // The count is what a surface prints; a count that does not match the
    // list it came from is a number nobody can check.
    const status = parseTachoStatus(
      doc({ present: true, otherServerNames: ["a", "b", "c"] }),
    );
    expect(status?.claudeDesktop?.otherServers).toBe(3);
  });

  it("drops junk rather than inventing a shape", () => {
    for (const junk of [undefined, null, 7, "x", {}, { present: "yes" }]) {
      expect(parseTachoStatus(doc(junk))?.claudeDesktop).toBeUndefined();
    }
  });

  it("keeps non-string names out of the disclosure", () => {
    const status = parseTachoStatus(
      doc({ present: true, otherServerNames: ["ok", 3, null] }),
    );
    expect(status?.claudeDesktop?.otherServerNames).toEqual(["ok"]);
  });
});

/**
 * The gateway block, the model base URL state and the tier ladder (ADR-094,
 * ADR-095). The desktop app used to have no way to show any of this: the
 * CLI's `tacho status --json` carried it, but nothing here parsed it, so the
 * masthead could never say more than "wrapped" for a host actually routed
 * through the proxy.
 */
describe("the gateway, model base URLs and tiers", () => {
  it("parses a well-formed gateway block", () => {
    const status = parseTachoStatus(
      JSON.stringify({
        enrolled: true,
        gateway: {
          listening: true,
          port: 47124,
          routes: [],
          calls_observed: 0,
        },
      }),
    );
    expect(status?.gateway).toEqual({ listening: true, port: 47124 });
  });

  it("is absent for a daemon that is down or predates the proxy", () => {
    expect(
      parseTachoStatus(JSON.stringify({ enrolled: true }))?.gateway,
    ).toBeUndefined();
    expect(
      parseTachoStatus(
        JSON.stringify({ enrolled: true, gateway: { listening: "true" } }),
      )?.gateway,
    ).toBeUndefined();
  });

  it("parses model base URL state per harness, including a shadowed one", () => {
    const status = parseTachoStatus(
      JSON.stringify({
        enrolled: true,
        modelBaseUrls: [
          { harness: "claude-code", ours: true },
          {
            harness: "codex",
            ours: true,
            shadowedBy: {
              file: "/managed-settings.json",
              key: "openai_base_url",
            },
          },
          { harness: "stella", ours: false },
          { notAHarness: true },
        ],
      }),
    );
    expect(status?.modelBaseUrls).toEqual([
      { harness: "claude-code", ours: true, shadowed: false },
      { harness: "codex", ours: true, shadowed: true },
      { harness: "stella", ours: false, shadowed: false },
    ]);
  });

  it("parses the credential basis per harness, with the reason when there is one", () => {
    const status = parseTachoStatus(
      JSON.stringify({
        enrolled: true,
        modelCredentials: [
          { harness: "claude-code", brokered: true, file: "/x" },
          { harness: "codex", brokered: false, reason: "subscription_login" },
          { notAHarness: true },
        ],
      }),
    );
    expect(status?.modelCredentials).toEqual([
      { harness: "claude-code", brokered: true },
      { harness: "codex", brokered: false, reason: "subscription_login" },
    ]);
  });

  it("parses only the recognised tier words, keyed by harness", () => {
    const status = parseTachoStatus(
      JSON.stringify({
        enrolled: true,
        tiers: {
          "claude-code": "gateway",
          codex: "observe",
          junk: "contained",
        },
      }),
    );
    expect(status?.tiers).toEqual({
      "claude-code": "gateway",
      codex: "observe",
    });
  });

  it("drops junk rather than inventing a shape", () => {
    for (const junk of [undefined, null, 7, "x", []]) {
      expect(
        parseTachoStatus(JSON.stringify({ enrolled: true, gateway: junk }))
          ?.gateway,
      ).toBeUndefined();
      expect(
        parseTachoStatus(JSON.stringify({ enrolled: true, tiers: junk }))
          ?.tiers,
      ).toBeUndefined();
    }
    for (const junk of [undefined, null, 7, "x", {}]) {
      expect(
        parseTachoStatus(
          JSON.stringify({ enrolled: true, modelBaseUrls: junk }),
        )?.modelBaseUrls,
      ).toBeUndefined();
    }
  });
});

/**
 * `tacho status` reports Cursor as one entry per hooks file, because a moved
 * config directory means Oxagen writes two. The app shows one row per
 * harness, so the list is folded here.
 */
describe("Cursor's hooks fold to one row", () => {
  const parse = (cursorHooks: unknown) =>
    parseTachoStatus(JSON.stringify({ enrolled: true, cursorHooks }))
      ?.cursorHooks;

  it("is complete only when every file is complete", () => {
    expect(
      parse([
        {
          complete: true,
          present: ["preToolUse", "stop"],
          missing: [],
          failOpenEnforcement: [],
        },
        {
          complete: true,
          present: ["preToolUse", "stop"],
          missing: [],
          failOpenEnforcement: [],
        },
      ]),
    ).toEqual({ complete: true, present: ["preToolUse", "stop"], missing: [] });
    expect(
      parse([
        {
          complete: true,
          present: ["preToolUse", "stop"],
          missing: [],
          failOpenEnforcement: [],
        },
        { complete: false, present: ["stop"], missing: ["preToolUse"] },
      ]),
    ).toEqual({ complete: false, present: ["stop"], missing: ["preToolUse"] });
  });

  it("counts a veto hook that fails open as missing, not present", () => {
    // Cursor allows the action when a fail-open hook cannot answer, so a
    // hook in that state is not the hook Oxagen wrote.
    expect(
      parse([
        {
          complete: false,
          present: ["preToolUse", "stop"],
          missing: [],
          failOpenEnforcement: ["preToolUse"],
        },
      ]),
    ).toEqual({ complete: false, present: ["stop"], missing: ["preToolUse"] });
  });

  it("is absent when the CLI reported none", () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse([])).toBeUndefined();
    expect(parse("nope")).toBeUndefined();
  });
});

describe("the Gateway line", () => {
  it("says unknown when tacho status has not answered, not that the build lacks it", () => {
    expect(gatewayText(null, true, ["claude-code", "codex"])).toBe(
      "model proxy unknown; claude-code: unknown, codex: unknown",
    );
    expect(gatewayText(null, true, [])).toBe("model proxy unknown");
  });

  it("says unknown while the collector is not answering", () => {
    expect(gatewayText({ enrolled: true }, false, ["claude-code"])).toBe(
      "model proxy unknown; claude-code: unknown",
    );
  });

  it("names the proxy and each harness's tier once the collector reports them", () => {
    expect(
      gatewayText(
        {
          enrolled: true,
          gateway: { listening: true, port: 47002 },
          tiers: { "claude-code": "gateway" },
        },
        true,
        ["claude-code", "codex"],
      ),
    ).toBe(
      "model proxy listening on 127.0.0.1:47002; claude-code: gateway, codex: no run yet",
    );
    expect(
      gatewayText(
        { enrolled: true, gateway: { listening: false, port: 47002 } },
        true,
        [],
      ),
    ).toBe("model proxy not listening");
  });

  it("says not available only when a collector that answered reported no proxy", () => {
    expect(gatewayText({ enrolled: true }, true, [])).toBe(
      "not available on this build",
    );
  });
});
