import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  capabilityContext: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../../lib/context", () => ({
  capabilityContext: mocks.capabilityContext,
}));

import { documentReadRoute } from "./document.read";

const fakeCtx = {
  orgId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "00000000-0000-0000-0000-000000000000",
  userId: "user_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

const OUTPUT = { document_id: "doc_1", content: "..." };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capabilityContext.mockReturnValue(fakeCtx);
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("GET document", () => {
  it("forwards the document_id query param to invoke and returns the output", async () => {
    const res = await documentReadRoute.fetch(
      new Request("http://localhost/?document_id=doc_1"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "read_document",
      { document_id: "doc_1" },
      fakeCtx,
      { surface: "api" },
    );
  });

  it("falls back to an empty string when document_id is absent", async () => {
    await documentReadRoute.fetch(new Request("http://localhost/"));

    const input = mocks.invoke.mock.calls[0]![1] as { document_id: string };
    expect(input.document_id).toBe("");
  });
});
