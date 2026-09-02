import { describe, expect, it } from "vitest";
import { workspaceInviteSend } from "./workspace.invite.send";
import { getCapability } from "../registry";

describe("workspace.invite.send capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("parses a minimal valid input (email only, defaults applied)", () => {
    const parsed = workspaceInviteSend.input.parse({
      email: "alice@example.com",
    });
    expect(parsed.email).toBe("alice@example.com");
    expect(parsed.role).toBe("member");
    expect(parsed.message).toBeUndefined();
  });

  it("rejects missing email", () => {
    expect(() => workspaceInviteSend.input.parse({ role: "member" })).toThrow();
  });

  it("rejects an invalid email format", () => {
    expect(() =>
      workspaceInviteSend.input.parse({ email: "not-an-email" }),
    ).toThrow();
  });

  it("rejects email missing @", () => {
    expect(() =>
      workspaceInviteSend.input.parse({ email: "nodomain" }),
    ).toThrow();
  });

  // ── input: role enum ──────────────────────────────────────────────────────

  it("defaults role to 'member'", () => {
    const parsed = workspaceInviteSend.input.parse({
      email: "bob@example.com",
    });
    expect(parsed.role).toBe("member");
  });

  it("accepts role='admin'", () => {
    const parsed = workspaceInviteSend.input.parse({
      email: "bob@example.com",
      role: "admin",
    });
    expect(parsed.role).toBe("admin");
  });

  it("accepts role='owner'", () => {
    const parsed = workspaceInviteSend.input.parse({
      email: "bob@example.com",
      role: "owner",
    });
    expect(parsed.role).toBe("owner");
  });

  it("rejects an unknown role value", () => {
    expect(() =>
      workspaceInviteSend.input.parse({
        email: "bob@example.com",
        role: "superadmin",
      }),
    ).toThrow();
  });

  // ── input: optional message ───────────────────────────────────────────────

  it("accepts an optional message", () => {
    const parsed = workspaceInviteSend.input.parse({
      email: "carol@example.com",
      message: "Welcome to the team!",
    });
    expect(parsed.message).toBe("Welcome to the team!");
  });

  it("message is undefined when omitted", () => {
    const parsed = workspaceInviteSend.input.parse({
      email: "carol@example.com",
    });
    expect(parsed.message).toBeUndefined();
  });

  // ── input: type validation ────────────────────────────────────────────────

  it("rejects non-string email", () => {
    expect(() => workspaceInviteSend.input.parse({ email: 12345 })).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = workspaceInviteSend.output.parse({
      id: "invite-abc-123",
      status: "pending",
      expires_at: "2024-07-01T00:00:00.000Z",
    });
    expect(parsed.id).toBe("invite-abc-123");
    expect(parsed.status).toBe("pending");
    expect(parsed.expires_at).toBe("2024-07-01T00:00:00.000Z");
  });

  it("parses output with any status string", () => {
    const parsed = workspaceInviteSend.output.parse({
      id: "invite-xyz-999",
      status: "accepted",
      expires_at: "2024-12-31T23:59:59.000Z",
    });
    expect(parsed.status).toBe("accepted");
  });

  it("rejects output missing id", () => {
    expect(() =>
      workspaceInviteSend.output.parse({
        status: "pending",
        expires_at: "2024-07-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing status", () => {
    expect(() =>
      workspaceInviteSend.output.parse({
        id: "invite-abc-123",
        expires_at: "2024-07-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing expires_at", () => {
    expect(() =>
      workspaceInviteSend.output.parse({
        id: "invite-abc-123",
        status: "pending",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("send_workspace_invite")).toBe(workspaceInviteSend);
  });
});
