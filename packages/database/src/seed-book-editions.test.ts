/**
 * Unit tests for seedBookEditions().
 *
 * Reads are mocked (no seed-assets I/O). withSystemDb is mocked so the upsert
 * chain can be asserted without a live Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn().mockReturnValue({
    onConflictDoUpdate: onConflictDoUpdateMock,
  });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  const mockTx = { insert: insertMock };
  const withSystemDbMock = vi.fn(
    async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
  );
  return {
    onConflictDoUpdateMock,
    valuesMock,
    insertMock,
    mockTx,
    withSystemDbMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

vi.mock("./tenant", () => ({ withSystemDb: mocks.withSystemDbMock }));
vi.mock("./client", () => ({ closeDatabase: vi.fn() }));
vi.mock("@oxagen/telemetry", () => ({
  isDirectRunEntry: () => false,
}));

import { seedBookEditions } from "./seed-book-editions";
import { BOOK_SLUG } from "./schema/cms";

const readFileSyncMock = vi.mocked(readFileSync);

describe("seedBookEditions()", () => {
  beforeEach(() => {
    mocks.onConflictDoUpdateMock.mockReset().mockResolvedValue(undefined);
    mocks.valuesMock.mockReset().mockReturnValue({
      onConflictDoUpdate: mocks.onConflictDoUpdateMock,
    });
    mocks.insertMock.mockReset().mockReturnValue({ values: mocks.valuesMock });
    mocks.withSystemDbMock
      .mockReset()
      .mockImplementation(
        async (cb: (tx: typeof mocks.mockTx) => Promise<unknown>) =>
          cb(mocks.mockTx),
      );
    readFileSyncMock.mockReset();
  });

  it("upserts both editions through withSystemDb", async () => {
    readFileSyncMock.mockReturnValue("<html>body</html>");

    await seedBookEditions();

    expect(mocks.withSystemDbMock).toHaveBeenCalledTimes(2);
    expect(mocks.insertMock).toHaveBeenCalledTimes(2);
    expect(mocks.valuesMock).toHaveBeenCalledTimes(2);
    expect(mocks.onConflictDoUpdateMock).toHaveBeenCalledTimes(2);

    const first = mocks.valuesMock.mock.calls[0]?.[0] as {
      slug: string;
      bookSlug: string;
      format: string;
      published: boolean;
    };
    const second = mocks.valuesMock.mock.calls[1]?.[0] as {
      slug: string;
      format: string;
    };
    expect(first).toMatchObject({
      slug: "field-manual",
      bookSlug: BOOK_SLUG,
      format: "linear",
      published: true,
    });
    expect(second).toMatchObject({
      slug: "page-flip-reader",
      format: "page-flip",
    });
  });

  it("strips the legacy field-manual gate script before storing", async () => {
    readFileSyncMock.mockImplementation((path) => {
      const p = String(path);
      if (p.endsWith("field-manual.html")) {
        return `<html><head><script>localStorage.setItem("ox_fm_unlocked","1");location.replace("/#field-manual");</script></head><body>manual</body></html>`;
      }
      return "<html>reader</html>";
    });

    await seedBookEditions();

    const fieldManual = mocks.valuesMock.mock.calls[0]?.[0] as { html: string };
    expect(fieldManual.html).not.toContain("ox_fm_unlocked");
    expect(fieldManual.html).toContain("<body>manual</body>");
  });
});
