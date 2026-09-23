import { describe, expect, it } from "vitest";
import { redactionMarker } from "../evidence/redaction";
import { normalizeOtlp } from "./otel";
import { SessionRecorder } from "./recorder";

const TS = "1788861970750000000";

function kv(key: string, value: unknown) {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (Number.isInteger(value))
    return { key, value: { intValue: String(value) } };
  if (typeof value === "number") return { key, value: { doubleValue: value } };
  if (Array.isArray(value))
    return {
      key,
      value: {
        arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) },
      },
    };
  return {
    key,
    value: {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map(
          ([k, v]) => ({ key: k, value: { stringValue: String(v) } }),
        ),
      },
    },
  };
}

function log(name: string, attrs: Record<string, unknown>) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv("service.version", "2.1.263")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: TS,
                body: { stringValue: `claude_code.${name}` },
                attributes: Object.entries(attrs).map(([k, v]) => kv(k, v)),
              },
            ],
          },
        ],
      },
    ],
  };
}

function span(name: string, attrs: Record<string, unknown>) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv("service.version", "2.1.263")] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "t1",
                spanId: "s1",
                name: `claude_code.${name}`,
                startTimeUnixNano: TS,
                endTimeUnixNano: TS,
                attributes: Object.entries(attrs).map(([k, v]) => kv(k, v)),
              },
            ],
          },
        ],
      },
    ],
  };
}

const GITHUB = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const OX_KEY = "ox_CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY";

describe("OTel attribute redaction", () => {
  it("redacts a credential in an unknown event's attribute", () => {
    const [draft] = normalizeOtlp(
      log("brand_new_event", {
        "session.id": "sess-otel",
        "upstream.command": `git push https://x:${GITHUB}@github.com/o/r`,
        "upstream.header": `Authorization: bearer abcdefghijklmnopqrstuvwxyz012345`,
      }),
    ).drafts;
    expect(draft?.attrs).toEqual({
      "upstream.command": `git push https://x:${redactionMarker("github_token")}@github.com/o/r`,
      "upstream.header": `Authorization: bearer ${redactionMarker("bearer_token")}`,
    });
  });

  it("redacts a credential in an unknown span's attribute", () => {
    const [draft] = normalizeOtlp(
      span("brand_new_span", { "upstream.env": `OXAGEN_API_KEY=${OX_KEY}` }),
    ).drafts;
    expect(draft?.attrs["upstream.env"]).toBe(
      `OXAGEN_API_KEY=${redactionMarker("oxagen_api_key")}`,
    );
  });

  it("redacts inside a structured attribute and a claimed reserved one", () => {
    const [draft] = normalizeOtlp(
      log("brand_new_event", {
        "upstream.args": ["--token", GITHUB],
        "oxagen.note": GITHUB,
      }),
    ).drafts;
    expect(draft?.attrs["upstream.args"]).toBe(
      JSON.stringify(["--token", redactionMarker("github_token")]),
    );
    expect(draft?.attrs["client_claimed.oxagen.note"]).toBe(
      redactionMarker("github_token"),
    );
  });

  it("keeps numbers, booleans and ordinary strings as they were", () => {
    const [draft] = normalizeOtlp(
      log("brand_new_event", {
        "upstream.count": 42,
        "upstream.ratio": 0.5,
        "upstream.enabled": false,
        "upstream.mode": "acceptEdits",
        "upstream.event_id": `evt_${"0123456789abcdef".repeat(4)}`,
      }),
    ).drafts;
    expect(draft?.attrs).toEqual({
      "upstream.count": "42",
      "upstream.ratio": "0.5",
      "upstream.enabled": "false",
      "upstream.mode": "acceptEdits",
      "upstream.event_id": `evt_${"0123456789abcdef".repeat(4)}`,
    });
  });
});

describe("OTel attribute length bound", () => {
  it("cuts a long attribute to the envelope's 4096", () => {
    const [draft] = normalizeOtlp(
      log("brand_new_event", { "upstream.blob": "a".repeat(10_000) }),
    ).drafts;
    const value = draft?.attrs["upstream.blob"] ?? "";
    expect(value).toHaveLength(4096);
    expect(value.endsWith("…")).toBe(true);
  });

  it("keeps a value of exactly 4096 whole", () => {
    const [draft] = normalizeOtlp(
      log("brand_new_event", { "upstream.blob": "b".repeat(4096) }),
    ).drafts;
    expect(draft?.attrs["upstream.blob"]).toBe("b".repeat(4096));
  });

  it("does not split a surrogate pair at the cut", () => {
    // 4094 code units put an emoji's high half at index 4094, the last one
    // kept before the marker.
    const text = `${"c".repeat(4094)}😀${"d".repeat(100)}`;
    const [draft] = normalizeOtlp(
      log("brand_new_event", { "upstream.blob": text }),
    ).drafts;
    const value = draft?.attrs["upstream.blob"] ?? "";
    expect(value).toBe(`${"c".repeat(4094)}…`);
    expect(value.length).toBeLessThanOrEqual(4096);
  });

  it("redacts before it cuts, so a secret across the bound is not left half", () => {
    // The token runs from 4070 to 4114, across the bound.
    const text = `${"e".repeat(4069)} ${GITHUB} tail`;
    const [draft] = normalizeOtlp(
      log("brand_new_event", { "upstream.blob": text }),
    ).drafts;
    const value = draft?.attrs["upstream.blob"] ?? "";
    expect(value).toHaveLength(4096);
    expect(value).not.toContain("ghp_");
    expect(
      value.startsWith(
        `${"e".repeat(4069)} ${redactionMarker("github_token")}`,
      ),
    ).toBe(true);
  });

  it("seals a record whose unpromoted attribute is past the bound", () => {
    const recorder = new SessionRecorder({
      context: {
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_test",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: "tch_test",
        },
        now: () => Date.parse("2026-09-08T10:07:00.000Z"),
      },
      harnessSessionId: "sess-otel",
      scope: "tch_test",
    });
    const events = recorder.ingestOtlp(
      log("brand_new_event", {
        "session.id": "sess-otel",
        "upstream.blob": "f".repeat(20_000),
        "upstream.secret": GITHUB,
      }),
    );
    expect(recorder.takeOtelRefusals()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.attrs["upstream.blob"]).toHaveLength(4096);
    expect(events[0]?.attrs["upstream.secret"]).toBe(
      redactionMarker("github_token"),
    );
  });
});
