/**
 * Seed cms.book_editions from the book HTML sources.
 *
 * The two editions of "Engineering Deterministic AI Coding Agents" live in
 * packages/database/seed-assets/books/, outside any public tree, and are
 * served ONLY through the code-gated /v1/cms/book/redeem route — so this seed
 * loads their HTML into Postgres, where the redeem route reads it.
 *
 * Idempotent: upserts on the edition slug, so re-running refreshes content
 * (e.g. after editing a source file) without creating duplicates.
 *
 * Direct-run entrypoint: `tsx packages/database/src/seed-book-editions.ts`
 * (wired as `pnpm --filter @oxagen/database db:seed-books`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { isDirectRunEntry } from "@oxagen/telemetry";
import { closeDatabase } from "./client";
import { withSystemDb } from "./tenant";
import { bookEditions } from "./schema/cms";
import { BOOK_SLUG } from "./schema/cms";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOKS_DIR = join(HERE, "..", "seed-assets", "books");

interface EditionSeed {
  slug: string;
  file: string;
  format: "linear" | "page-flip";
  title: string;
  /** Optional transform applied to the raw HTML before storing. */
  transform?: (html: string) => string;
}

/**
 * The field-manual edition ships with a small client-side script at the top
 * of <head> that redirects to /#field-manual. Access is enforced server-side,
 * so that script would redirect the reader away the instant we inject the
 * HTML — strip it. Matches the single <script> block that references the
 * ox_fm_unlocked localStorage key.
 */
function stripLegacyGate(html: string): string {
  return html.replace(
    /<script>[\s\S]*?ox_fm_unlocked[\s\S]*?<\/script>\s*/i,
    "",
  );
}

const EDITIONS: EditionSeed[] = [
  {
    slug: "field-manual",
    file: "field-manual.html",
    format: "linear",
    title: "Engineering Deterministic AI Coding Agents — Field Manual",
    transform: stripLegacyGate,
  },
  {
    slug: "page-flip-reader",
    file: "page-flip-reader.html",
    format: "page-flip",
    title: "Engineering Deterministic AI Coding Agents — Reader",
  },
];

export async function seedBookEditions(): Promise<void> {
  for (const ed of EDITIONS) {
    const raw = readFileSync(join(BOOKS_DIR, ed.file), "utf8");
    const html = ed.transform ? ed.transform(raw) : raw;
    await withSystemDb((tx) =>
      tx
        .insert(bookEditions)
        .values({
          slug: ed.slug,
          bookSlug: BOOK_SLUG,
          format: ed.format,
          title: ed.title,
          html,
          published: true,
        })
        .onConflictDoUpdate({
          target: bookEditions.slug,
          set: {
            bookSlug: BOOK_SLUG,
            format: ed.format,
            title: ed.title,
            html,
            published: true,
            updatedAt: sql`now()`,
          },
        }),
    );
    process.stdout.write(
      `Seeded edition "${ed.slug}" (${html.length} bytes)\n`,
    );
  }
}

if (isDirectRunEntry(import.meta.url, process.argv[1], "seed-book-editions")) {
  seedBookEditions()
    .then(() => closeDatabase())
    .then(() => {
      process.stdout.write("Book editions seed complete\n");
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(
        `Book editions seed failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
