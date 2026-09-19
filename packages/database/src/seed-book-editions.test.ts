/**
 * Unit tests for seedBookEditions() (seed-book-editions.ts).
 *
 * No live DB and no real book assets are read — `withSystemDb` is mocked to
 * call the provided callback with a chainable mock transaction object, and
 * `node:fs`'s `readFileSync` is mocked to return small fixture HTML instead
 * of the real (large) book sources under seed-assets/books/. Asserts:
 *
 *  1. Both editions are upserted (insert → values → onConflictDoUpdate) on slug.
 *  2. The field-manual edition's legacy client-side unlock script is stripped
 *     before the HTML is stored.
 *  3. The page-flip edition's `/field-manual` href is rewritten to the gated
 *     `/read?e=field-manual` URL (AWS has no `/field-manual` object).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi
    .fn()
    .mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  const mockTx = { insert: insertMock };

  const withSystemDbMock = vi.fn(
    async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
  );
  const closeDatabaseMock = vi.fn().mockResolvedValue(undefined);
  const readFileSyncMock = vi.fn();

  return {
    onConflictDoUpdateMock,
    valuesMock,
    insertMock,
    mockTx,
    withSystemDbMock,
    closeDatabaseMock,
    readFileSyncMock,
  };
});

vi.mock("./tenant", () => ({ withSystemDb: mocks.withSystemDbMock }));
vi.mock("./client", () => ({ closeDatabase: mocks.closeDatabaseMock }));
vi.mock("node:fs", () => ({ readFileSync: mocks.readFileSyncMock }));

import { seedBookEditions } from "./seed-book-editions";

const FIELD_MANUAL_FIXTURE = `<html><head>
<script>if (!localStorage.getItem('ox_fm_unlocked')) { location.href = '/#field-manual'; }</script>
</head><body>Field manual body</body></html>`;

const PAGE_FLIP_FIXTURE =
  '<html><body>See <a href="/field-manual">the field manual</a>.</body></html>';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertMock.mockReturnValue({ values: mocks.valuesMock });
  mocks.valuesMock.mockReturnValue({
    onConflictDoUpdate: mocks.onConflictDoUpdateMock,
  });
  mocks.onConflictDoUpdateMock.mockResolvedValue(undefined);
  mocks.withSystemDbMock.mockImplementation(
    async (cb: (tx: typeof mocks.mockTx) => Promise<unknown>) =>
      cb(mocks.mockTx),
  );
  mocks.readFileSyncMock.mockImplementation((path: string) =>
    path.includes("field-manual") ? FIELD_MANUAL_FIXTURE : PAGE_FLIP_FIXTURE,
  );
});

describe("seedBookEditions()", () => {
  it("upserts both editions by slug", async () => {
    await seedBookEditions();

    expect(mocks.withSystemDbMock).toHaveBeenCalledTimes(2);
    expect(mocks.valuesMock).toHaveBeenCalledTimes(2);
    const slugs = mocks.valuesMock.mock.calls.map(
      (call) => (call[0] as { slug: string }).slug,
    );
    expect(slugs).toEqual(["field-manual", "page-flip-reader"]);

    const targets = mocks.onConflictDoUpdateMock.mock.calls.map(
      (call) => (call[0] as { target: unknown }).target,
    );
    expect(targets).toHaveLength(2);
  });

  it("strips the legacy client-side unlock gate from the field-manual HTML", async () => {
    await seedBookEditions();

    const fieldManualValues = mocks.valuesMock.mock.calls[0]?.[0] as {
      html: string;
    };
    expect(fieldManualValues.html).not.toContain("ox_fm_unlocked");
    expect(fieldManualValues.html).toContain("Field manual body");
  });

  it("rewrites the page-flip footer /field-manual link for the AWS reader URL", async () => {
    await seedBookEditions();

    const pageFlipValues = mocks.valuesMock.mock.calls[1]?.[0] as {
      html: string;
    };
    expect(pageFlipValues.html).toContain('href="/read?e=field-manual"');
    expect(pageFlipValues.html).not.toContain('href="/field-manual"');
  });
});
