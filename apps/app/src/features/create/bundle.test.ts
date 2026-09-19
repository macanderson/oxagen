// A skill bundle read the way the wizard reads one: a bare SKILL.md, and a
// zip archive with stored and deflated entries, built here byte by byte so the
// reader is tested against the format rather than against a library.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BundleReadError, readBundle } from "./bundle";

const SKILL = "---\nname: release-notes\nversion: 2.2.0\n---\n\n# Notes\n";

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type ZipEntry = { path: string; text: string; method?: 0 | 8 };

/** A zip archive: local headers, the central directory, and its end record. */
async function zip(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: number[] = [];
  const central: number[] = [];
  const u16 = (out: number[], v: number) => {
    out.push(v & 0xff, (v >> 8) & 0xff);
  };
  const u32 = (out: number[], v: number) => {
    u16(out, v & 0xffff);
    u16(out, (v >>> 16) & 0xffff);
  };
  for (const e of entries) {
    const name = enc.encode(e.path);
    const raw = enc.encode(e.text);
    const method = e.method ?? 0;
    const data = method === 8 ? await deflate(raw) : raw;
    const offset = locals.length;
    u32(locals, 0x04034b50);
    u16(locals, 20);
    u16(locals, 0);
    u16(locals, method);
    u32(locals, 0);
    u32(locals, 0);
    u32(locals, data.length);
    u32(locals, raw.length);
    u16(locals, name.length);
    u16(locals, 0);
    locals.push(...name, ...data);
    u32(central, 0x02014b50);
    u16(central, 20);
    u16(central, 20);
    u16(central, 0);
    u16(central, method);
    u32(central, 0);
    u32(central, 0);
    u32(central, data.length);
    u32(central, raw.length);
    u16(central, name.length);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u16(central, 0);
    u32(central, 0);
    u32(central, offset);
    central.push(...name);
  }
  const end: number[] = [];
  u32(end, 0x06054b50);
  u16(end, 0);
  u16(end, 0);
  u16(end, entries.length);
  u16(end, entries.length);
  u32(end, central.length);
  u32(end, locals.length);
  u16(end, 0);
  return new Uint8Array([...locals, ...central, ...end]);
}

function file(name: string, bytes: Uint8Array | string): File {
  return new File([typeof bytes === "string" ? bytes : bytes.slice()], name);
}

async function refusal(f: File): Promise<string> {
  try {
    await readBundle(f);
  } catch (err) {
    if (err instanceof BundleReadError) return err.code;
    throw err;
  }
  throw new Error("read");
}

describe("readBundle", () => {
  it("reads a bare SKILL.md and digests it with LF line ends", async () => {
    const bundle = await readBundle(
      file("SKILL.md", SKILL.replace(/\n/g, "\r\n")),
    );
    expect(bundle.body).toBe(SKILL.replace(/\n/g, "\r\n"));
    expect(bundle.files).toEqual([]);
    expect(bundle.digest).toBe(sha256(SKILL));
  });

  it("reads a .skill archive: SKILL.md, the files beside it, stored and deflated", async () => {
    const archive = await zip([
      { path: "release-notes/SKILL.md", text: SKILL, method: 8 },
      { path: "release-notes/examples/before.md", text: "before" },
      { path: "release-notes/", text: "" },
      { path: "__MACOSX/release-notes/._SKILL.md", text: "junk" },
      { path: "release-notes/.DS_Store", text: "junk" },
    ]);
    const bundle = await readBundle(
      file("release-notes-2.2.0.skill", archive),
    );
    expect(bundle.fileName).toBe("release-notes-2.2.0.skill");
    expect(bundle.body).toBe(SKILL);
    expect(bundle.files).toEqual([
      { path: "examples/before.md", content: "before" },
    ]);
    expect(bundle.digest).toBe(sha256(SKILL));
  });

  it.each([
    ["a file of another type", file("skill.pdf", "x"), "wrong_type"],
    ["an archive that is not a zip", file("x.zip", "not a zip"), "not_a_zip"],
    [
      "a SKILL.md over 64 KB",
      file("SKILL.md", "x".repeat(65_537)),
      "too_large",
    ],
  ])("refuses %s (negative)", async (_case, f, code) => {
    expect(await refusal(f)).toBe(code);
  });

  it("refuses an archive with no SKILL.md (negative)", async () => {
    const archive = await zip([{ path: "README.md", text: "hi" }]);
    expect(await refusal(file("x.zip", archive))).toBe("no_skill_md");
  });

  it("refuses a binary file in the bundle (negative)", async () => {
    const archive = await zip([
      { path: "SKILL.md", text: SKILL },
      { path: "logo.png", text: "\u0000PNG" },
    ]);
    expect(await refusal(file("x.zip", archive))).toBe("binary_file");
  });

  it("refuses more than 16 files beside SKILL.md (negative)", async () => {
    const archive = await zip([
      { path: "SKILL.md", text: SKILL },
      ...Array.from({ length: 17 }, (_, i) => ({
        path: `examples/${i}.md`,
        text: "x",
      })),
    ]);
    expect(await refusal(file("x.zip", archive))).toBe("too_many_files");
  });
});
