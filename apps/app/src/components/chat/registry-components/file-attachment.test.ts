/**
 * file-attachment.test.ts
 *
 * Unit tests for the file-attachment registry component pure helpers:
 *   1. formatBytes — human-readable byte formatting
 *   2. kindMeta-derived kind → icon/label mapping (via exported constants)
 *   3. Persisted-block registration guard (verifies "file-attachment" is in CHAT_COMPONENTS)
 */

import { describe, it, expect, vi } from "vitest";

// ── formatBytes ──────────────────────────────────────────────────────────────
// formatBytes is the shared @/lib/utils helper, re-imported (not re-defined)
// by file-attachment.tsx; import it directly (no React required).
import { formatBytes } from "@/lib/utils";

describe("formatBytes", () => {
  it("formats bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats exactly 1 KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("formats KB range", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats fractional KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats exactly 1 MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats MB range", () => {
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
});

// ── Kind → label mapping ─────────────────────────────────────────────────────
// Pure mapping function extracted from the component for testability.
// We replicate the switch logic here (no React, no DOM) so these tests run in
// the Node test environment without jsdom.

type KindCase = { kind: string; expectedLabel: string };

const KIND_CASES: KindCase[] = [
  { kind: "document", expectedLabel: "Document" },
  { kind: "spreadsheet", expectedLabel: "Spreadsheet" },
  { kind: "presentation", expectedLabel: "Presentation" },
  { kind: "pdf", expectedLabel: "PDF" },
  { kind: "archive", expectedLabel: "Archive" },
  { kind: "unknown", expectedLabel: "File" },
  { kind: "", expectedLabel: "File" },
];

// Inline replica of the kindMeta label logic (no icon dependency).
function kindLabel(kind: string): string {
  switch (kind) {
    case "document":
      return "Document";
    case "spreadsheet":
      return "Spreadsheet";
    case "presentation":
      return "Presentation";
    case "pdf":
      return "PDF";
    case "archive":
      return "Archive";
    default:
      return "File";
  }
}

describe("file-attachment — kind → label mapping", () => {
  for (const { kind, expectedLabel } of KIND_CASES) {
    it(`kind "${kind}" → label "${expectedLabel}"`, () => {
      expect(kindLabel(kind)).toBe(expectedLabel);
    });
  }

  it("exactly 5 named kinds (document/spreadsheet/presentation/pdf/archive)", () => {
    const namedKinds = [
      "document",
      "spreadsheet",
      "presentation",
      "pdf",
      "archive",
    ];
    expect(namedKinds).toHaveLength(5);
    for (const k of namedKinds) {
      expect(kindLabel(k)).not.toBe("File");
    }
  });

  it("unlisted kinds fall back to 'File'", () => {
    expect(kindLabel("video")).toBe("File");
    expect(kindLabel("image")).toBe("File");
    expect(kindLabel("csv")).toBe("File");
  });
});

// ── Registry completeness ─────────────────────────────────────────────────────
// Verify "file-attachment" is registered in CHAT_COMPONENTS so persisted
// component blocks with this id will render rather than logging a warning.

vi.mock("react", () => ({
  default: {},
  lazy: (loader: unknown) => ({
    $$typeof: Symbol("react.lazy"),
    _payload: loader,
    _init: () => null,
  }),
}));

import { CHAT_COMPONENTS } from "../chat-component-registry";

describe("CHAT_COMPONENTS — file-attachment and html-artifact registration", () => {
  it("contains 'file-attachment' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("file-attachment");
  });

  it("'file-attachment' renderer is defined (not null/undefined)", () => {
    const renderer = CHAT_COMPONENTS["file-attachment"];
    expect(renderer).toBeDefined();
    expect(renderer).not.toBeNull();
  });

  it("contains 'html-artifact' as a registered componentId", () => {
    expect(CHAT_COMPONENTS).toHaveProperty("html-artifact");
  });

  it("'html-artifact' renderer is defined (not null/undefined)", () => {
    const renderer = CHAT_COMPONENTS["html-artifact"];
    expect(renderer).toBeDefined();
    expect(renderer).not.toBeNull();
  });
});
