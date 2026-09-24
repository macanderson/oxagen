/**
 * The SCIM wire rules (#3734) on their own: paging, the one filter shape,
 * booleans, PatchOp bodies and member values. service.test.ts drives these
 * through recorded Okta and Entra ID payloads; this file pins the refusals
 * and edge values those payloads never send, because each one is what a
 * misbehaving or hostile client gets back instead of a 500.
 */
import { describe, expect, it } from "vitest";
import {
  isScimId,
  listResponse,
  memberFilterValue,
  memberIds,
  pageOf,
  parseEqFilter,
  readPatch,
  SCIM_DEFAULT_COUNT,
  SCIM_MAX_RESULTS,
  scimBoolean,
  ScimError,
  scimErrorBody,
} from "./protocol";

function refusal(fn: () => unknown): ScimError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ScimError);
    return err as ScimError;
  }
  throw new Error("expected a ScimError");
}

describe("scimErrorBody", () => {
  it("answers the status as a string, with scimType only when there is one", () => {
    expect(scimErrorBody(new ScimError(409, "taken", "uniqueness"))).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "409",
      scimType: "uniqueness",
      detail: "taken",
    });
    expect(scimErrorBody(new ScimError(404, "gone"))).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "gone",
    });
  });
});

describe("listResponse", () => {
  it("reports the page size separately from the total", () => {
    expect(listResponse([{ id: "a" }], 7, 3)).toMatchObject({
      totalResults: 7,
      startIndex: 3,
      itemsPerPage: 1,
    });
  });
});

describe("pageOf", () => {
  it("defaults to the first page of the default size", () => {
    expect(pageOf({})).toEqual({ startIndex: 1, count: SCIM_DEFAULT_COUNT });
  });

  it("treats a startIndex below 1 or unreadable as 1 (RFC 7644 §3.4.2.4)", () => {
    expect(pageOf({ startIndex: "0" }).startIndex).toBe(1);
    expect(pageOf({ startIndex: "-5" }).startIndex).toBe(1);
    expect(pageOf({ startIndex: "abc" }).startIndex).toBe(1);
    expect(pageOf({ startIndex: "51" }).startIndex).toBe(51);
  });

  it("clamps count to between 0 and the maximum, and reads garbage as the default", () => {
    expect(pageOf({ count: "-1" }).count).toBe(0);
    expect(pageOf({ count: "0" }).count).toBe(0);
    expect(pageOf({ count: "100000" }).count).toBe(SCIM_MAX_RESULTS);
    expect(pageOf({ count: "many" }).count).toBe(SCIM_DEFAULT_COUNT);
  });
});

describe("parseEqFilter", () => {
  const allowed = ["username", "externalid", "emails.value", "id"];

  it("answers null for no filter or a blank one", () => {
    expect(parseEqFilter(undefined, allowed)).toBeNull();
    expect(parseEqFilter("   ", allowed)).toBeNull();
  });

  it("lowercases the attribute and keeps the value exactly", () => {
    expect(parseEqFilter('userName eq "Ada@Acme.com"', allowed)).toEqual({
      attribute: "username",
      value: "Ada@Acme.com",
    });
    expect(parseEqFilter('emails.value EQ "ada@acme.com"', allowed)).toEqual({
      attribute: "emails.value",
      value: "ada@acme.com",
    });
  });

  it("unescapes quotes and backslashes in the value", () => {
    expect(parseEqFilter('externalId eq "a\\"b\\\\c"', allowed)).toEqual({
      attribute: "externalid",
      value: 'a"b\\c',
    });
  });

  it.each([
    'userName sw "ada"',
    'userName eq "ada" and active eq "true"',
    "userName eq ada",
    'userName eq "unterminated',
    "active pr",
  ])("refuses %s as invalidFilter", (filter) => {
    const err = refusal(() => parseEqFilter(filter, allowed));
    expect(err).toMatchObject({ status: 400, scimType: "invalidFilter" });
  });

  it("refuses an attribute outside the allowed list, naming it as sent", () => {
    const err = refusal(() => parseEqFilter('displayName eq "Ada"', allowed));
    expect(err).toMatchObject({ status: 400, scimType: "invalidFilter" });
    expect(err.detail).toContain("displayName");
  });
});

describe("scimBoolean", () => {
  it("accepts a boolean and the string spellings Entra ID sends, in any case", () => {
    expect(scimBoolean(true, "active")).toBe(true);
    expect(scimBoolean(false, "active")).toBe(false);
    expect(scimBoolean("True", "active")).toBe(true);
    expect(scimBoolean(" FALSE ", "active")).toBe(false);
  });

  it.each([["yes"], [1], [0], [null], [undefined], [{}]])(
    "refuses %j as invalidValue naming the attribute",
    (value) => {
      const err = refusal(() => scimBoolean(value, "active"));
      expect(err).toMatchObject({ status: 400, scimType: "invalidValue" });
      expect(err.detail).toBe("active must be a boolean");
    },
  );
});

describe("readPatch", () => {
  it("lowercases op, and reads a lowercase `operations` key too", () => {
    expect(
      readPatch({ Operations: [{ op: "Replace", path: "active", value: "False" }] }),
    ).toEqual([{ op: "replace", path: "active", value: "False" }]);
    expect(readPatch({ operations: [{ op: "remove", path: "externalId" }] })).toEqual([
      { op: "remove", path: "externalId" },
    ]);
  });

  it.each([null, "Operations", 7])("refuses a body that is not an object: %j", (body) => {
    expect(refusal(() => readPatch(body))).toMatchObject({
      status: 400,
      scimType: "invalidSyntax",
    });
  });

  it("refuses a body with no Operations array", () => {
    const err = refusal(() => readPatch({ Operations: { op: "add" } }));
    expect(err).toMatchObject({ status: 400, scimType: "invalidSyntax" });
    expect(err.detail).toContain("Operations array");
  });

  it("refuses an operation that is not an object", () => {
    expect(refusal(() => readPatch({ Operations: ["add"] }))).toMatchObject({
      scimType: "invalidSyntax",
      detail: "Each operation must be an object",
    });
  });

  it.each([["move"], ["copy"], [undefined], [3]])("refuses the op %j", (op) => {
    expect(refusal(() => readPatch({ Operations: [{ op, path: "active" }] }))).toMatchObject({
      status: 400,
      scimType: "invalidSyntax",
    });
  });

  it("refuses a path that is not a string", () => {
    expect(
      refusal(() => readPatch({ Operations: [{ op: "add", path: ["members"] }] })),
    ).toMatchObject({ status: 400, scimType: "invalidPath" });
  });
});

describe("memberFilterValue", () => {
  it("reads the member id from a value filter path, in any case and spacing", () => {
    expect(memberFilterValue('members[value eq "u-1"]')).toBe("u-1");
    expect(memberFilterValue(' Members [ Value EQ "u-2" ] ')).toBe("u-2");
  });

  it("answers null for any other path", () => {
    expect(memberFilterValue("members")).toBeNull();
    expect(memberFilterValue('members[display eq "Ada"]')).toBeNull();
    expect(memberFilterValue('members[value eq ""]')).toBeNull();
  });
});

describe("memberIds", () => {
  it("reads an array, a single object, a bare string, and nothing", () => {
    expect(memberIds([{ value: "a" }, { value: "b" }])).toEqual(["a", "b"]);
    expect(memberIds({ value: "a" })).toEqual(["a"]);
    expect(memberIds("a")).toEqual(["a"]);
    expect(memberIds(undefined)).toEqual([]);
  });

  it.each([[[{ value: "" }]], [[{}]], [[{ value: 7 }]], [[null]]])(
    "refuses a member with no usable value: %j",
    (value) => {
      expect(refusal(() => memberIds(value))).toMatchObject({
        status: 400,
        scimType: "invalidValue",
      });
    },
  );
});

describe("isScimId", () => {
  it("accepts a uuid in either case and nothing else", () => {
    expect(isScimId("00000000-0000-4000-8000-0000000000AA")).toBe(true);
    expect(isScimId("00000000-0000-4000-8000-0000000000a")).toBe(false);
    expect(isScimId("------------------------------------")).toBe(false);
    expect(isScimId("00u1abcdEFGH2345")).toBe(false);
  });
});
