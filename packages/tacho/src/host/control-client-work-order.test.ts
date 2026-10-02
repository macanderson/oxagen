/**
 * The host's two work order calls (P1-04, ADR-250): `claimWorkOrder` and
 * `rejectWorkOrder`, against a fake control plane.
 */
import { describe, expect, it } from "vitest";
import {
  ControlError,
  controlErrorMessage,
  createControlClient,
  type FetchLike,
  workOrderEndpointsFor,
} from "./control-client";

const HOST = "tch_0123456789abcdefghjkmn";

const CLAIM = {
  repeat: false,
  work_order: {
    id: "wo_01j9k2m3n4",
    key: "wi_7f3a:r2:s1",
    send: 1,
    item_id: "wi_7f3a",
    item_number: "acme/platform#612",
    brief_revision: 2,
    repository: "acme/platform",
    agent_id: "agt_1",
    harness: "claude-code",
  },
  prompt: "Work order wo_01j9k2m3n4 for acme/platform#612, brief revision 2.",
};

function rig(answer: { status: number; body: unknown }) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () =>
        typeof answer.body === "string"
          ? answer.body
          : JSON.stringify(answer.body),
    };
  };
  const client = createControlClient({
    endpoints: {
      ingest: "https://api.example.test/v1/tacho/events",
      bundle: "https://api.example.test/v1/tacho/bundle",
      commands: "https://api.example.test/v1/tacho/commands",
      ...workOrderEndpointsFor("https://api.example.test/"),
    },
    apiKey: "oxk_test_secret",
    hostEnrollmentId: HOST,
    fetch,
  });
  return { client, calls };
}

describe("workOrderEndpointsFor", () => {
  it("joins the two paths to the API URL, with or without a trailing slash", () => {
    const expected = {
      workOrderClaim: "https://api.example.test/v1/tacho/work-orders/claim",
      workOrderReject: "https://api.example.test/v1/tacho/work-orders/reject",
    };
    expect(workOrderEndpointsFor("https://api.example.test")).toEqual(
      expected,
    );
    expect(workOrderEndpointsFor("https://api.example.test//")).toEqual(
      expected,
    );
  });
});

describe("claimWorkOrder", () => {
  it("posts the host and the order with the host key and reads the claim", async () => {
    const { client, calls } = rig({ status: 200, body: CLAIM });
    const claim = await client.claimWorkOrder("wo_01j9k2m3n4");
    expect(claim.prompt).toBe(CLAIM.prompt);
    expect(claim.work_order.harness).toBe("claude-code");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://api.example.test/v1/tacho/work-orders/claim",
    );
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer oxk_test_secret");
    expect(calls[0]?.body).toEqual({
      host_enrollment_id: HOST,
      work_order_id: "wo_01j9k2m3n4",
    });
  });

  it("reads an answer that carries a field this build does not know", async () => {
    const { client } = rig({
      status: 200,
      body: {
        ...CLAIM,
        added_later: true,
        work_order: { ...CLAIM.work_order, also_new: 1 },
      },
    });
    await expect(client.claimWorkOrder("wo_01j9k2m3n4")).resolves.toMatchObject(
      { repeat: false },
    );
  });

  it("throws the server's refusal as a ControlError with its message (negative)", async () => {
    const { client } = rig({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "This work order was withdrawn. Do not start it.",
        },
      },
    });
    const error = await client.claimWorkOrder("wo_01j9k2m3n4").catch((e) => e);
    expect(error).toBeInstanceOf(ControlError);
    expect(controlErrorMessage(error as ControlError)).toBe(
      "This work order was withdrawn. Do not start it.",
    );
  });

  it("refuses an answer with no prompt (negative)", async () => {
    const { client } = rig({ status: 200, body: { ...CLAIM, prompt: "" } });
    await expect(client.claimWorkOrder("wo_01j9k2m3n4")).rejects.toThrow();
  });

  it("throws when the client has no claim endpoint (negative)", async () => {
    const client = createControlClient({
      endpoints: {
        ingest: "https://api.example.test/v1/tacho/events",
        bundle: "https://api.example.test/v1/tacho/bundle",
        commands: "https://api.example.test/v1/tacho/commands",
      },
      apiKey: "k",
      hostEnrollmentId: HOST,
      fetch: async () => {
        throw new Error("no request should be sent");
      },
    });
    await expect(client.claimWorkOrder("wo_01j9k2m3n4")).rejects.toThrow(
      /no work order claim endpoint/,
    );
  });
});

describe("rejectWorkOrder", () => {
  it("posts the host, the order, and the reason", async () => {
    const { client, calls } = rig({ status: 200, body: { repeat: false } });
    await expect(
      client.rejectWorkOrder(
        "wo_01j9k2m3n4",
        "The claude command is not installed on this machine.",
      ),
    ).resolves.toEqual({ repeat: false });
    expect(calls[0]?.url).toBe(
      "https://api.example.test/v1/tacho/work-orders/reject",
    );
    expect(calls[0]?.body).toEqual({
      host_enrollment_id: HOST,
      work_order_id: "wo_01j9k2m3n4",
      reason: "The claude command is not installed on this machine.",
    });
  });
});

describe("controlErrorMessage", () => {
  it("falls back to the status when the body names no message (negative)", () => {
    expect(controlErrorMessage(new ControlError(502, "<html>bad gateway"))).toBe(
      "Oxagen answered 502.",
    );
    expect(controlErrorMessage(new ControlError(400, "{}"))).toBe(
      "Oxagen answered 400.",
    );
  });

  it("reads a top-level message too", () => {
    expect(
      controlErrorMessage(
        new ControlError(403, JSON.stringify({ message: "API key required" })),
      ),
    ).toBe("API key required");
  });
});
