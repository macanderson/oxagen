import { describe, expect, it } from "vitest";
import { RELAY_NAME_REGEX, toolRelayCreate } from "./tool.relay.create";

const PUBLIC_ID = "rly_0123456789abcdefghjkmn";
const TOKEN = `oxr_${"A".repeat(43)}`;

describe("toolRelayCreate", () => {
  it("registers create_relay on the API alone", () => {
    expect(toolRelayCreate.name).toBe("create_relay");
    // An MCP tool would put the plaintext token in an agent's transcript.
    expect(toolRelayCreate.surfaces).toEqual(["api"]);
    expect(toolRelayCreate.layers).not.toContain("mcp");
    expect(toolRelayCreate.mutates).toBe(true);
    expect(toolRelayCreate.sensitivity).toBe("high");
    expect(toolRelayCreate.defaultEffect).toBe("deny");
    expect(toolRelayCreate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(toolRelayCreate.audit).toEqual({
      targetKind: "relay",
      targetIdField: "name",
    });
  });

  it("accepts a relay name and refuses anything else", () => {
    expect(toolRelayCreate.input.parse({ name: "office-lan" }).name).toBe(
      "office-lan",
    );
    expect(toolRelayCreate.input.safeParse({ name: "a".repeat(63) }).success).toBe(
      true,
    );
    for (const name of [
      "",
      "-office",
      "Office",
      "office_lan",
      "office.lan",
      "a".repeat(64),
    ]) {
      expect(toolRelayCreate.input.safeParse({ name }).success).toBe(false);
    }
    expect(
      toolRelayCreate.input.safeParse({ name: "office", token: TOKEN }).success,
    ).toBe(false);
  });

  it("keeps the exported pattern equal to the schema's", () => {
    expect(RELAY_NAME_REGEX.source).toBe("^[a-z0-9][a-z0-9-]{0,62}$");
  });

  it("answers a public id, the name, and a token that starts with oxr_", () => {
    const out = toolRelayCreate.output.parse({
      publicId: PUBLIC_ID,
      name: "office-lan",
      createdAt: "2026-09-28T18:00:00.000Z",
      token: TOKEN,
    });
    expect(out.token.startsWith("oxr_")).toBe(true);
    expect(
      toolRelayCreate.output.safeParse({
        publicId: PUBLIC_ID,
        name: "office-lan",
        createdAt: "2026-09-28T18:00:00.000Z",
        token: "ox_nope",
      }).success,
    ).toBe(false);
    expect(
      toolRelayCreate.output.safeParse({
        publicId: "wrk_0123456789abcdefghjkmn",
        name: "office-lan",
        createdAt: "2026-09-28T18:00:00.000Z",
        token: TOKEN,
      }).success,
    ).toBe(false);
  });
});
