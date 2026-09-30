import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { BudgetExceededError, GauExhaustedError } from "@oxagen/billing";
import { ApprovalPendingError } from "../approval-pending";
import {
  UnknownToolError,
  executeToolRequest,
  renderToolResult,
  schemaOnlyTools,
  toToolContracts,
} from "./tools";

describe("toToolContracts", () => {
  it("declares each tool with its schema and its governance facts", async () => {
    const contracts = await toToolContracts(
      {
        list_nodes: tool({
          description: "List nodes",
          inputSchema: z.object({ limit: z.number() }),
          execute: async () => [],
        }),
        raw_json: {
          description: "Raw",
          inputSchema: jsonSchema({
            type: "object",
            properties: { q: { type: "string" } },
          }),
        } as never,
      },
      {
        list_nodes: {
          riskLevel: "low",
          requiresApproval: false,
          readOnly: true,
        },
        raw_json: {
          riskLevel: "high",
          requiresApproval: true,
          readOnly: false,
        },
      },
    );
    expect(contracts).toHaveLength(2);
    expect(contracts[0]).toMatchObject({
      version: 1,
      risk: "low",
      requires_approval: false,
      provenance: "declared",
      schema: {
        name: "list_nodes",
        description: "List nodes",
        read_only: true,
      },
    });
    expect(
      (contracts[0]!.schema.input_schema as { properties: object }).properties,
    ).toHaveProperty("limit");
    expect(contracts[1]).toMatchObject({
      risk: "high",
      requires_approval: true,
      schema: {
        name: "raw_json",
        read_only: false,
        input_schema: { type: "object" },
      },
    });
  });

  it("declares a tool with no governance entry as high risk and mutating", async () => {
    const [c] = await toToolContracts(
      { x: { description: "d", inputSchema: { type: "object" } } as never },
      {},
    );
    expect(c).toMatchObject({
      risk: "high",
      requires_approval: false,
      schema: { read_only: false },
    });
  });
});

describe("schemaOnlyTools", () => {
  it("strips execute and keeps everything else", () => {
    const set = {
      t: {
        description: "d",
        inputSchema: { type: "object" },
        execute: async () => 1,
      },
    } as never;
    const stripped = schemaOnlyTools(set) as Record<
      string,
      Record<string, unknown>
    >;
    expect(stripped.t).toEqual({
      description: "d",
      inputSchema: { type: "object" },
    });
  });
});

describe("executeToolRequest", () => {
  it("runs the tool's execute with the engine's request id and returns its text and raw value", async () => {
    const execute = vi.fn(async () => ({ rows: 3 }));
    const result = await executeToolRequest(
      { t: { execute } as never },
      "t",
      { a: 1 },
      { toolCallId: "tool-1-0" },
    );
    expect(execute).toHaveBeenCalledWith(
      { a: 1 },
      expect.objectContaining({ toolCallId: "tool-1-0", messages: [] }),
    );
    expect(result).toEqual({
      output: { ok: { content: '{"rows":3}' } },
      raw: { rows: 3 },
      failed: false,
    });
  });

  it("turns a policy refusal into the refused_by_policy class and any other throw into a plain error", async () => {
    const refused = await executeToolRequest(
      {
        t: {
          execute: async () => {
            throw new Error("Tool blocked by workspace policy: nope");
          },
        } as never,
      },
      "t",
      {},
      { toolCallId: "r" },
    );
    expect(refused.output).toEqual({
      error: {
        message: "Tool blocked by workspace policy: nope",
        class: "refused_by_policy",
      },
    });
    expect(refused.failed).toBe(true);
    const failed = await executeToolRequest(
      {
        t: {
          execute: async () => {
            throw new Error("upstream 500");
          },
        } as never,
      },
      "t",
      {},
      { toolCallId: "r" },
    );
    expect(failed.output).toEqual({ error: { message: "upstream 500" } });
  });

  it("answers a parked call as a refusal and marks it parked for the host", async () => {
    const parked = await executeToolRequest(
      {
        t: {
          execute: async () => {
            throw new ApprovalPendingError(
              "create_workspace",
              "0192f0c4-0000-7000-8000-000000000001",
              "2026-09-25T12:05:00.000Z",
              "apr_0a1b2c3d4e5f6g7h8j9k0m",
            );
          },
        } as never,
      },
      "t",
      {},
      { toolCallId: "p" },
    );
    // The engine's closed vocabulary has no wait: it is told a refusal.
    expect(parked.output).toEqual({
      error: {
        message: expect.stringContaining("is waiting for approval"),
        class: "refused_by_policy",
      },
    });
    expect(parked.failed).toBe(true);
    expect(parked.parked).toEqual({
      approvalPublicId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
    });
    // A refusal that is not a park carries no marker.
    const refused = await executeToolRequest(
      {
        t: {
          execute: async () => {
            throw new Error("approval denied for create_workspace");
          },
        } as never,
      },
      "t",
      {},
      { toolCallId: "r" },
    );
    expect(refused.parked).toBeUndefined();
  });

  describe("a gate's refusal is read by its code (#4245)", () => {
    /** A tool whose call throws `error`, as a kernel gate's refusal does. */
    const throwing = (error: unknown) => ({
      t: {
        execute: async () => {
          throw error;
        },
      } as never,
    });
    /**
     * The kernel's `CapabilityError` in miniature: its class lives in
     * `@oxagen/oxagen/kernel`, and the replay set (fixture 11) already runs
     * the real one through this path.
     */
    const capabilityError = (code: string, message: string) =>
      Object.assign(new Error(message), { name: "CapabilityError", code });

    it.each([
      [
        "authz_denied",
        capabilityError(
          "authz_denied",
          'IAM denied "get_run" for principal: no matching grant',
        ),
      ],
      [
        "gau_exhausted",
        new GauExhaustedError({
          reason: null,
          remainingGau: 0,
          periodEnd: new Date("2026-10-01T00:00:00.000Z"),
        }),
      ],
      [
        "budget_exceeded",
        new BudgetExceededError({
          scope: "workspace",
          orgId: "org-1",
          workspaceId: "ws-1",
          period: "monthly",
          limitMicros: 50_000_000n,
          spentMicros: 50_000_000n,
          capability: "search_graph",
        }),
      ],
      [
        "pending_approval",
        capabilityError(
          "pending_approval",
          'IAM requires approval for "get_run", and the action is denied until an approver grants it.',
        ),
      ],
    ])(
      "answers a %s refusal refused_by_policy, though its message reads as a fault",
      async (_code, error) => {
        const refused = await executeToolRequest(
          throwing(error),
          "t",
          {},
          { toolCallId: "r" },
        );
        expect(refused.output).toEqual({
          error: { message: error.message, class: "refused_by_policy" },
        });
        expect(refused.failed).toBe(true);
        // A JIT access request is not the approval park: no card waits on it.
        expect(refused.parked).toBeUndefined();

        // The same message with no code is a plain error, so the code alone
        // made the refusal. On main, before #4245, both answers were this.
        const uncoded = await executeToolRequest(
          throwing(new Error(error.message)),
          "t",
          {},
          { toolCallId: "r" },
        );
        expect(uncoded.output).toEqual({ error: { message: error.message } });
      },
    );

    it("reads a kill switch by its code, whatever its message says", async () => {
      const refused = await executeToolRequest(
        throwing(
          Object.assign(new Error("get_run_cost is switched off"), {
            code: "kill_switch",
          }),
        ),
        "t",
        {},
        { toolCallId: "r" },
      );
      expect(refused.output).toEqual({
        error: {
          message: "get_run_cost is switched off",
          class: "refused_by_policy",
        },
      });
    });

    it("answers a plain error for a code no gate refuses with (negative)", async () => {
      for (const code of ["invalid_input", "no_handler", 403, undefined]) {
        const failed = await executeToolRequest(
          throwing(Object.assign(new Error("upstream said no"), { code })),
          "t",
          {},
          { toolCallId: "r" },
        );
        expect(failed.output).toEqual({
          error: { message: "upstream said no" },
        });
      }
      // A thrown non-object carries no code to read.
      const thrownString = await executeToolRequest(
        throwing("authz_denied"),
        "t",
        {},
        { toolCallId: "r" },
      );
      expect(thrownString.output).toEqual({
        error: { message: "authz_denied" },
      });
    });
  });

  it("throws UnknownToolError for a tool the turn did not advertise", async () => {
    await expect(
      executeToolRequest({}, "ghost", {}, { toolCallId: "x" }),
    ).rejects.toBeInstanceOf(UnknownToolError);
    await expect(
      executeToolRequest({ t: {} as never }, "t", {}, { toolCallId: "x" }),
    ).rejects.toBeInstanceOf(UnknownToolError);
  });
});

describe("renderToolResult", () => {
  it("passes strings through and renders everything else as JSON", () => {
    expect(renderToolResult("plain")).toBe("plain");
    expect(renderToolResult(undefined)).toBe("");
    expect(renderToolResult({ a: [1] })).toBe('{"a":[1]}');
  });
});
