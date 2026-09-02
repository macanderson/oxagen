// @vitest-environment jsdom
/**
 * csv.test.ts — RFC-4180 escaping edge cases, formula-injection guard, and
 * the client-side download trigger for csv.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { toCsv, downloadCsv, type CsvColumn } from "./csv";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const COLUMNS: CsvColumn[] = [
  { key: "name", header: "Name" },
  { key: "email", header: "Email" },
  { key: "note", header: "Note" },
];

describe("toCsv", () => {
  it("emits the header row followed by CRLF-terminated data rows", () => {
    const csv = toCsv(COLUMNS, [
      { name: "Ada", email: "ada@example.com", note: "ok" },
    ]);
    expect(csv).toBe("Name,Email,Note\r\nAda,ada@example.com,ok\r\n");
  });

  it("returns just the header (+ trailing CRLF) for an empty row set", () => {
    expect(toCsv(COLUMNS, [])).toBe("Name,Email,Note\r\n");
  });

  it("quotes fields containing a comma", () => {
    const csv = toCsv(COLUMNS, [
      { name: "Doe, Jane", email: "j@x.com", note: "" },
    ]);
    expect(csv).toContain('"Doe, Jane"');
  });

  it("quotes fields containing a double quote and doubles the embedded quote", () => {
    const csv = toCsv(COLUMNS, [
      { name: 'The "Boss"', email: "b@x.com", note: "" },
    ]);
    expect(csv).toContain('"The ""Boss"""');
  });

  it("quotes fields containing an embedded newline", () => {
    const csv = toCsv(COLUMNS, [
      { name: "Line1\nLine2", email: "a@x.com", note: "" },
    ]);
    expect(csv).toContain('"Line1\nLine2"');
  });

  it("quotes fields containing an embedded carriage return + newline", () => {
    const csv = toCsv(COLUMNS, [
      { name: "Line1\r\nLine2", email: "a@x.com", note: "" },
    ]);
    expect(csv).toContain('"Line1\r\nLine2"');
  });

  it("renders null and undefined values as an empty field", () => {
    const csv = toCsv(COLUMNS, [{ name: "Ada", email: null, note: undefined }]);
    expect(csv).toBe("Name,Email,Note\r\nAda,,\r\n");
  });

  it("stringifies numbers and booleans", () => {
    const csv = toCsv(
      [
        { key: "count", header: "Count" },
        { key: "active", header: "Active" },
      ],
      [{ count: 42, active: true }],
    );
    expect(csv).toBe("Count,Active\r\n42,true\r\n");
  });

  describe("formula-injection guard", () => {
    it.each([
      ["=SUM(A1:A9)", "'=SUM(A1:A9)"],
      ["+1+1", "'+1+1"],
      ["-1+1", "'-1+1"],
      ["@cmd", "'@cmd"],
    ])("prefixes a leading %s with a quote", (input, expected) => {
      const csv = toCsv([{ key: "v", header: "V" }], [{ v: input }]);
      expect(csv).toBe(`V\r\n${expected}\r\n`);
    });

    it("does not alter a value with no dangerous leading character", () => {
      const csv = toCsv([{ key: "v", header: "V" }], [{ v: "safe value" }]);
      expect(csv).toBe("V\r\nsafe value\r\n");
    });

    it("still quotes a formula-guarded value that also contains a comma", () => {
      const csv = toCsv([{ key: "v", header: "V" }], [{ v: "=A1,B1" }]);
      expect(csv).toBe('V\r\n"\'=A1,B1"\r\n');
    });
  });
});

describe("downloadCsv", () => {
  it("no-ops when document is unavailable (SSR)", () => {
    const original = globalThis.document;
    // @ts-expect-error - simulate an environment with no DOM
    delete globalThis.document;
    expect(() => downloadCsv("f.csv", "a,b\r\n1,2\r\n")).not.toThrow();
    globalThis.document = original;
  });

  it("creates a UTF-8-BOM-prefixed text/csv Blob and revokes the object URL", () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadCsv("report.csv", "a,b\r\n1,2\r\n");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blobArg = (createObjectURL.mock.calls as unknown as [[Blob]])[0][0];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg?.type).toBe("text/csv;charset=utf-8;");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("sets the anchor's download filename and href, then clicks it", () => {
    let capturedAnchor: HTMLAnchorElement | undefined;
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "a") capturedAnchor = el as HTMLAnchorElement;
      return el;
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock-url"),
      revokeObjectURL: vi.fn(),
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadCsv("report.csv", "a,b\r\n1,2\r\n");

    expect(capturedAnchor?.download).toBe("report.csv");
    expect(capturedAnchor?.href).toContain("blob:mock-url");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
