import { describe, expect, it } from "vitest";
import { screenResult } from "./screen";

const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

describe("screenResult", () => {
  it("redacts each credential in the content and counts the markers it adds", () => {
    const screened = screenResult({
      content: [{ type: "text", text: `key=${AWS_KEY} token=${GITHUB_TOKEN}` }],
    });
    expect(screened).toEqual({
      result: { content: [{ type: "text", text: "key=[redacted:aws_access_key] token=[redacted:github_token]" }] },
      redactions: 2,
    });
  });

  it("walks nested arrays and objects in structuredContent and leaves other values as they are", () => {
    const screened = screenResult({
      content: [{ type: "text", text: "two files" }],
      structuredContent: {
        files: [{ path: "a.env", body: AWS_KEY }, { nested: { deep: [GITHUB_TOKEN, 3, true, null] } }],
        count: 2,
      },
      isError: false,
    });
    expect(screened).toEqual({
      result: {
        content: [{ type: "text", text: "two files" }],
        structuredContent: {
          files: [
            { path: "a.env", body: "[redacted:aws_access_key]" },
            { nested: { deep: ["[redacted:github_token]", 3, true, null] } },
          ],
          count: 2,
        },
        isError: false,
      },
      redactions: 2,
    });
  });

  it("does not count a marker the server wrote itself", () => {
    const screened = screenResult({ content: [{ type: "text", text: "[redacted:aws_access_key] was already cut" }] });
    expect(screened.redactions).toBe(0);
    expect(screened.result.content).toEqual([{ type: "text", text: "[redacted:aws_access_key] was already cut" }]);
  });

  it("adds no structuredContent to a result that has none and leaves the input unchanged", () => {
    const input = { content: [{ type: "text", text: AWS_KEY }], isError: true };
    const screened = screenResult(input);
    expect("structuredContent" in screened.result).toBe(false);
    expect(screened.result.isError).toBe(true);
    expect(input.content).toEqual([{ type: "text", text: AWS_KEY }]);
  });
});
