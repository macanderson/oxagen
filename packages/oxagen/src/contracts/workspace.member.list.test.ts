import { describe, expect, it } from "vitest";
import { workspaceMemberList } from "./workspace.member.list";
import { getCapability } from "../registry";

describe("workspace.member.list capability", () => {
  // ── input: optional workspace_id ─────────────────────────────────────────

  it("parses empty input (workspace_id is optional)", () => {
    const parsed = workspaceMemberList.input.parse({});
    expect(parsed.workspace_id).toBeUndefined();
  });

  it("accepts a workspace_id string", () => {
    const parsed = workspaceMemberList.input.parse({
      workspace_id: "ws-001",
    });
    expect(parsed.workspace_id).toBe("ws-001");
  });

  it("rejects non-string workspace_id", () => {
    expect(() =>
      workspaceMemberList.input.parse({ workspace_id: 42 }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output array with one member", () => {
    const parsed = workspaceMemberList.output.parse([
      {
        id: "user-001",
        email: "alice@example.com",
        role: "admin",
        joined_at: "2024-01-15T08:00:00.000Z",
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("user-001");
    expect(parsed[0]?.email).toBe("alice@example.com");
    expect(parsed[0]?.role).toBe("admin");
    expect(parsed[0]?.joined_at).toBe("2024-01-15T08:00:00.000Z");
  });

  it("parses a valid empty array", () => {
    const parsed = workspaceMemberList.output.parse([]);
    expect(parsed).toHaveLength(0);
  });

  it("parses an array with multiple members", () => {
    const parsed = workspaceMemberList.output.parse([
      {
        id: "user-001",
        email: "alice@example.com",
        role: "owner",
        joined_at: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "user-002",
        email: "bob@example.com",
        role: "member",
        joined_at: "2024-02-01T00:00:00.000Z",
      },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.role).toBe("member");
  });

  it("rejects a member missing the email field", () => {
    expect(() =>
      workspaceMemberList.output.parse([
        {
          id: "user-001",
          role: "member",
          joined_at: "2024-01-01T00:00:00.000Z",
        },
      ]),
    ).toThrow();
  });

  it("rejects a member missing joined_at", () => {
    expect(() =>
      workspaceMemberList.output.parse([
        {
          id: "user-001",
          email: "alice@example.com",
          role: "member",
        },
      ]),
    ).toThrow();
  });

  it("rejects a member with non-string id", () => {
    expect(() =>
      workspaceMemberList.output.parse([
        {
          id: 42,
          email: "alice@example.com",
          role: "member",
          joined_at: "2024-01-01T00:00:00.000Z",
        },
      ]),
    ).toThrow();
  });

  it("rejects a non-array output", () => {
    expect(() =>
      workspaceMemberList.output.parse({
        id: "user-001",
        email: "alice@example.com",
        role: "member",
        joined_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_workspace_members")).toBe(workspaceMemberList);
  });
});
