import { describe, expect, it } from "vitest";
import { connectionMappingsGet } from "./connection.mappings.get";
import { getCapability } from "../registry";

describe("connection.mappings.get capability", () => {
  it("parses valid input", () => {
    const parsed = connectionMappingsGet.input.parse({
      connectionId: "con_ABC",
    });
    expect(parsed.connectionId).toBe("con_ABC");
  });

  it("rejects empty connectionId", () => {
    expect(() =>
      connectionMappingsGet.input.parse({ connectionId: "" }),
    ).toThrow();
  });

  it("parses valid output with mappings", () => {
    const parsed = connectionMappingsGet.output.parse({
      mappings: [
        {
          id: "uuid-1",
          sourceRecordType: "pull_request",
          oxagenEntityType: "code_change",
          propertyMappings: { "user.login": "author", title: "title" },
          isActive: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(parsed.mappings).toHaveLength(1);
    expect(parsed.mappings[0]?.oxagenEntityType).toBe("code_change");
    expect(parsed.mappings[0]?.isActive).toBe(true);
  });

  it("parses empty mappings array", () => {
    const parsed = connectionMappingsGet.output.parse({ mappings: [] });
    expect(parsed.mappings).toHaveLength(0);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_connection_mappings")).toBe(
      connectionMappingsGet,
    );
  });

  it("is a read operation, no approval needed", () => {
    expect(connectionMappingsGet.agent?.requiresApproval).toBe(false);
    expect(connectionMappingsGet.agent?.category).toBe("read");
  });
});
