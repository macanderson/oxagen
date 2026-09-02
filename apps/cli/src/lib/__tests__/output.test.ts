/**
 * Tests for the universal command-output layer (ADR-023 §4): mode selection
 * (flag / autoJson+TTY), stdout purity in json mode, quiet semantics, and the
 * uniform error contract including exit-code behavior.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createOutput, errorMessage } from "../output.js";
import type { CommandWriter } from "../capture-writer.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const savedExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("createOutput mode selection", () => {
  it("defaults to pretty on a TTY", () => {
    const { writer } = memoryWriter();
    expect(createOutput({ stdoutIsTTY: true }, writer).mode).toBe("pretty");
  });

  it("--json wins regardless of TTY", () => {
    const { writer } = memoryWriter();
    expect(createOutput({ json: true, stdoutIsTTY: true }, writer).isJson).toBe(
      true,
    );
  });

  it("autoJson selects json only when stdout is not a TTY", () => {
    const { writer } = memoryWriter();
    expect(
      createOutput({ autoJson: true, stdoutIsTTY: false }, writer).isJson,
    ).toBe(true);
    expect(
      createOutput({ autoJson: true, stdoutIsTTY: true }, writer).isJson,
    ).toBe(false);
    expect(createOutput({ stdoutIsTTY: false }, writer).isJson).toBe(false);
  });
});

describe("data / event / info discipline", () => {
  it("json mode: data is one machine line on stdout, info stays on stderr", () => {
    const { writer, out, err } = memoryWriter();
    const output = createOutput({ json: true }, writer);
    output.info("working…");
    output.data({ ok: true, n: 2 });
    expect(out).toEqual(['{"ok":true,"n":2}']);
    expect(err).toEqual(["working…"]);
  });

  it("pretty mode: data uses the pretty renderer when given, indented JSON otherwise", () => {
    const { writer, out } = memoryWriter();
    const output = createOutput({ stdoutIsTTY: true }, writer);
    output.data({ a: 1 }, () => "one");
    output.data({ a: 1 });
    expect(out[0]).toBe("one");
    expect(out[1]).toContain('\n  "a": 1');
  });

  it("event emits NDJSON in json mode and nothing in pretty mode", () => {
    const { writer, out } = memoryWriter();
    createOutput({ json: true }, writer).event({ type: "x" });
    expect(out).toEqual(['{"type":"x"}']);
    const second = memoryWriter();
    createOutput({ stdoutIsTTY: true }, second.writer).event({ type: "x" });
    expect(second.out).toEqual([]);
  });

  it("--quiet suppresses info but never warn or data", () => {
    const { writer, out, err } = memoryWriter();
    const output = createOutput({ quiet: true, stdoutIsTTY: true }, writer);
    output.info("chrome");
    output.warn("careful");
    output.data({ ok: 1 }, () => "ok");
    expect(err).toEqual(["careful"]);
    expect(out).toEqual(["ok"]);
  });
});

describe("error contract", () => {
  it("json mode: single typed error line on stderr, stdout untouched, exit code 1", () => {
    const { writer, out, err } = memoryWriter();
    process.exitCode = 0;
    createOutput({ json: true }, writer).error(
      new Error("boom"),
      "store_missing",
    );
    expect(out).toEqual([]);
    expect(JSON.parse(err[0] as string)).toEqual({
      type: "error",
      code: "store_missing",
      message: "boom",
    });
    expect(process.exitCode).toBe(1);
  });

  it("pretty mode: ✗-prefixed message; a caller-chosen non-zero exit code is preserved", () => {
    const { writer, err } = memoryWriter();
    process.exitCode = 2;
    createOutput({ stdoutIsTTY: true }, writer).error("bad flag");
    expect(err).toEqual(["✗ bad flag"]);
    expect(process.exitCode).toBe(2);
  });

  it("errorMessage extracts from Error, string, and object", () => {
    expect(errorMessage(new Error("e"))).toBe("e");
    expect(errorMessage("s")).toBe("s");
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
  });
});
