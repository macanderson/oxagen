import { describe, expect, it } from "vitest";
import { githubRecordIdentity } from "./record-identity";

describe("GitHub record identity", () => {
  it("distinguishes repositories with the same issue number", () => {
    expect(githubRecordIdentity("issue", { id: 101, number: 7 })).toEqual({
      externalId: "issue:id:101",
      legacyExternalId: "7",
    });
    expect(
      githubRecordIdentity("issue", { id: 202, number: 7 }).externalId,
    ).not.toBe("issue:id:101");
  });
  it("keeps database IDs stable across repository renames and optional node IDs", () => {
    expect(
      githubRecordIdentity("issue", {
        id: 101,
        node_id: "I_1",
        html_url: "https://github.com/acme/old/issues/7",
      }).externalId,
    ).toBe(
      githubRecordIdentity("issue", {
        id: 101,
        html_url: "https://github.com/acme/new/issues/7",
      }).externalId,
    );
  });
  it("separates issue and pull-request ID namespaces", () => {
    expect(githubRecordIdentity("issue", { id: 1 }).externalId).not.toBe(
      githubRecordIdentity("pull_request", { id: 1 }).externalId,
    );
  });
  it("uses node ID then repository-qualified URL when database ID is absent", () => {
    expect(githubRecordIdentity("issue", { node_id: "I_1" }).externalId).toBe(
      "issue:node:I_1",
    );
    expect(
      githubRecordIdentity("issue", {
        number: 7,
        html_url: "https://github.com/acme/one/issues/7?x=1#body",
      }).externalId,
    ).toBe("issue:url:https://github.com/acme/one/issues/7");
  });
  it.each([
    {},
    { number: 7 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { html_url: "not a URL" },
  ])("refuses ambiguous provider records: %j", (raw) => {
    expect(() => githubRecordIdentity("issue", raw)).toThrow(
      expect.objectContaining({ code: "github_record_identity_missing" }),
    );
  });
});
