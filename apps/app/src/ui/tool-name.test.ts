import { describe, expect, it } from "vitest";
import { classifyToolName, humanizeToolName, parseToolId } from "./tool-name";

describe("parseToolId", () => {
  it("splits the version at the last @", () => {
    expect(parseToolId("github__create_pull_request@2.3.0")).toEqual({
      name: "github__create_pull_request",
      version: "2.3.0",
    });
  });

  it("has no version without an @ or with a leading @", () => {
    expect(parseToolId("search_graph")).toEqual({
      name: "search_graph",
      version: null,
    });
    expect(parseToolId("@scope")).toEqual({ name: "@scope", version: null });
    expect(parseToolId("bash__run@")).toEqual({
      name: "bash__run",
      version: null,
    });
  });
});

describe("humanizeToolName", () => {
  it("drops the server prefix and sentence-cases the local name", () => {
    expect(humanizeToolName("github__create_pull_request")).toBe(
      "Create pull request",
    );
    expect(humanizeToolName("search_graph")).toBe("Search graph");
  });
});

describe("classifyToolName", () => {
  it.each([
    ["github__get_file_contents", "read"],
    ["snowflake__query_warehouse", "query"],
    ["drive__trash_file", "file"],
    ["bash__run", "exec"],
    ["slack__post_message", "message"],
    ["stripe__refund_charge", "finance"],
    ["vercel__deploy_to_vercel", "infra"],
    ["drive__share_file", "access"],
    ["github__merge_pull_request", "vcs"],
    ["linear__update_issue", "record"],
    ["GITHUB__GET_REPO", "read"],
  ] as const)("%s → %s", (name, category) => {
    expect(classifyToolName(name)).toBe(category);
  });

  it("does not match a verb that only starts with a known one", () => {
    expect(classifyToolName("x__getaway_plan")).toBe("record");
  });
});
