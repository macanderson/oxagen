import { describe, expect, it } from "vitest";
import {
  agentInterjectionAnswer,
  INTERJECTION_ANSWER_MAX,
  isInterjectionPublicId,
} from "./agent.interjection.answer";

describe("answer_interjection contract", () => {
  it("is a person's write that never bills and never reaches the agent surface (ADR-175)", () => {
    expect(agentInterjectionAnswer.mutates).toBe(true);
    expect(agentInterjectionAnswer.noBillingGate).toBe(true);
    expect(agentInterjectionAnswer.scoped).toBe(true);
    expect(agentInterjectionAnswer.surfaces).toEqual(["api", "mcp", "cli"]);
    // The Run page answers a repository question (#3941), bound in
    // apps/app/capability-ui-map.json.
    expect(agentInterjectionAnswer.layers).toContain("app");
  });

  it("accepts a public id or a row uuid, and trims the answer", () => {
    expect(
      agentInterjectionAnswer.input.parse({
        interjectionId: "inj_0123456789abcdefghjkmn",
        answer: "  Push to fix/billing.  ",
      }),
    ).toEqual({
      interjectionId: "inj_0123456789abcdefghjkmn",
      answer: "Push to fix/billing.",
    });
    expect(
      agentInterjectionAnswer.input.safeParse({
        interjectionId: "0199a3f1-6c2e-7b3a-9f10-2d4c5e6f7a8b",
        answer: "yes",
      }).success,
    ).toBe(true);
    expect(isInterjectionPublicId("inj_0123")).toBe(true);
    expect(isInterjectionPublicId("0199a3f1-6c2e-7b3a-9f10-2d4c5e6f7a8b")).toBe(
      false,
    );
  });

  it("refuses another record's id, a blank answer and one past the limit (negative)", () => {
    const bad = [
      { interjectionId: "apr_0123", answer: "yes" },
      { interjectionId: "inj_0123", answer: "   " },
      {
        interjectionId: "inj_0123",
        answer: "x".repeat(INTERJECTION_ANSWER_MAX + 1),
      },
      { interjectionId: "inj_0123", answer: "yes", runId: "tse_1" },
    ];
    for (const input of bad) {
      expect(agentInterjectionAnswer.input.safeParse(input).success).toBe(
        false,
      );
    }
  });

  it("answers the queued message command, or none for a run no host can reach", () => {
    const queued = {
      interjectionId: "inj_0123",
      runId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
      answeredAt: "2026-09-25T10:05:00.000Z",
      commandIds: ["tcm_0123"],
      receiptId: "rcp_0123",
      path: null,
      repository: null,
      workspace: null,
    };
    expect(agentInterjectionAnswer.output.parse(queued)).toEqual(queued);
    const ledger = { ...queued, runId: "arun_7k2", commandIds: [] };
    expect(agentInterjectionAnswer.output.parse(ledger)).toEqual(ledger);
  });
});

describe("answer_interjection contract: a repository question (#3941)", () => {
  const ID = "inj_0123456789abcdefghjkmn";

  it("still parses the free-text input a client sent before paths existed", () => {
    expect(
      agentInterjectionAnswer.input.parse({ interjectionId: ID, answer: "yes" }),
    ).toEqual({ interjectionId: ID, answer: "yes" });
  });

  it("parses a link, and a create with the new workspace's name and slug", () => {
    expect(
      agentInterjectionAnswer.input.parse({ interjectionId: ID, path: "link" }),
    ).toEqual({ interjectionId: ID, path: "link" });
    expect(
      agentInterjectionAnswer.input.parse({
        interjectionId: ID,
        path: "create",
        create: { name: "API", slug: "api" },
      }),
    ).toEqual({
      interjectionId: ID,
      path: "create",
      create: { name: "API", slug: "api" },
    });
  });

  it("leaves the kind-dependent combination to the handler: a create without its workspace still parses", () => {
    expect(
      agentInterjectionAnswer.input.safeParse({
        interjectionId: ID,
        path: "create",
      }).success,
    ).toBe(true);
  });

  it("refuses deny, a reserved or malformed slug, and an unknown create field (negative)", () => {
    for (const input of [
      { interjectionId: ID, path: "deny" },
      {
        interjectionId: ID,
        path: "create",
        create: { name: "API", slug: "billing" },
      },
      {
        interjectionId: ID,
        path: "create",
        create: { name: "API", slug: "Not A Slug" },
      },
      {
        interjectionId: ID,
        path: "create",
        create: { name: "API", slug: "api", skills: true },
      },
      { interjectionId: ID, path: "create", create: { name: "", slug: "api" } },
    ])
      expect(
        agentInterjectionAnswer.input.safeParse(input).success,
        JSON.stringify(input),
      ).toBe(false);
  });

  const created = {
    interjectionId: ID,
    runId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
    answeredAt: "2026-09-25T10:05:00.000Z",
    commandIds: ["tcm_0123"],
    receiptId: "rcp_0123",
    path: "create",
    repository: { bindingId: "rpb_0123", fullName: "acme/api" },
    workspace: { publicId: "ws_0123", slug: "api" },
  };

  it("returns the path, the repository and the workspace a create made", () => {
    expect(agentInterjectionAnswer.output.parse(created)).toEqual(created);
  });

  it("requires the receipt, in its rcp_ form, on every answer (negative)", () => {
    const { receiptId: _receiptId, ...noReceipt } = created;
    expect(agentInterjectionAnswer.output.safeParse(noReceipt).success).toBe(
      false,
    );
    expect(
      agentInterjectionAnswer.output.safeParse({
        ...created,
        receiptId: "receipt-1",
      }).success,
    ).toBe(false);
    expect(
      agentInterjectionAnswer.output.safeParse({ ...created, path: "deny" })
        .success,
    ).toBe(false);
  });
});
