import { describe, expect, it } from "vitest";
import { connectionMappingsSet } from "./connection.mappings.set";
import { getCapability } from "../registry";

describe("connection.mappings.set capability", () => {
  it("parses minimal valid input", () => {
    const parsed = connectionMappingsSet.input.parse({
      connectionId: "con_ABC",
      mappings: [
        { sourceRecordType: "pull_request", oxagenEntityType: "code_change" },
      ],
    });
    expect(parsed.connectionId).toBe("con_ABC");
    expect(parsed.mappings).toHaveLength(1);
    expect(parsed.mappings[0]?.propertyMappings).toEqual({});
    expect(parsed.activateConnection).toBe(true);
  });

  it("parses input with activateConnection=false", () => {
    const parsed = connectionMappingsSet.input.parse({
      connectionId: "con_ABC",
      mappings: [
        {
          sourceRecordType: "issue",
          oxagenEntityType: "task",
          propertyMappings: { title: "title", body: "description" },
        },
      ],
      activateConnection: false,
    });
    expect(parsed.activateConnection).toBe(false);
    expect(parsed.mappings[0]?.propertyMappings).toEqual({
      title: "title",
      body: "description",
    });
  });

  it("rejects empty mappings array", () => {
    expect(() =>
      connectionMappingsSet.input.parse({
        connectionId: "con_ABC",
        mappings: [],
      }),
    ).toThrow();
  });

  it("rejects empty oxagenEntityType", () => {
    expect(() =>
      connectionMappingsSet.input.parse({
        connectionId: "con_ABC",
        mappings: [{ sourceRecordType: "pr", oxagenEntityType: "" }],
      }),
    ).toThrow();
  });

  it("parses valid output", () => {
    const parsed = connectionMappingsSet.output.parse({
      mappingsCreated: 3,
      mappingsUpdated: 1,
      connectionStatus: "active",
    });
    expect(parsed.mappingsCreated).toBe(3);
    expect(parsed.mappingsUpdated).toBe(1);
    expect(parsed.connectionStatus).toBe("active");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("set_connection_mappings")).toBe(
      connectionMappingsSet,
    );
  });

  it("requires approval and is write category", () => {
    expect(connectionMappingsSet.agent?.requiresApproval).toBe(true);
    expect(connectionMappingsSet.agent?.category).toBe("write");
  });

  it("has medium sensitivity", () => {
    expect(connectionMappingsSet.sensitivity).toBe("medium");
  });
});
