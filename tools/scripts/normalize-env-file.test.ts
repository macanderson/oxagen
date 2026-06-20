/**
 * Unit tests for lib/normalize-env-file.ts (collapseRedundantQuotes).
 *
 * Guards the env-pull invariant that doubly-quoted Vercel values
 * (`KEY=""value""`, which dotenv reads as an empty string) are healed to a
 * single quote layer — the failure mode being the api crashing on boot because
 * BETTER_AUTH_SECRET / BETTER_AUTH_URL / NODE_ENV all load as "".
 */

import { describe, it, expect } from "vitest";
import { collapseRedundantQuotes } from "./lib/normalize-env-file";

describe("collapseRedundantQuotes", () => {
  it("collapses one redundant outer quote layer", () => {
    const { content, collapsed } = collapseRedundantQuotes(
      'NODE_ENV=""development""\nBETTER_AUTH_URL=""http://localhost:3000""\n',
    );
    expect(content).toBe(
      'NODE_ENV="development"\nBETTER_AUTH_URL="http://localhost:3000"\n',
    );
    expect(collapsed).toBe(2);
  });

  it("leaves correctly single-quoted values untouched", () => {
    const input = 'NODE_ENV="development"\nFOO="bar"\n';
    const { content, collapsed } = collapseRedundantQuotes(input);
    expect(content).toBe(input);
    expect(collapsed).toBe(0);
  });

  it("leaves unquoted values untouched", () => {
    const input = "PORT=4000\nHOST=localhost\n";
    const { content, collapsed } = collapseRedundantQuotes(input);
    expect(content).toBe(input);
    expect(collapsed).toBe(0);
  });

  it("leaves a genuinely empty value untouched", () => {
    const input = 'OPTIONAL_FLAG=""\n';
    const { content, collapsed } = collapseRedundantQuotes(input);
    expect(content).toBe(input);
    expect(collapsed).toBe(0);
  });

  it("heals only the doubled entries in a mixed file", () => {
    const { content, collapsed } = collapseRedundantQuotes(
      'A="ok"\nB=""double""\nC=plain\nD=""x""\n',
    );
    expect(content).toBe('A="ok"\nB="double"\nC=plain\nD="x"\n');
    expect(collapsed).toBe(2);
  });

  it("handles multi-line quoted values without splitting them", () => {
    // A PEM-style value spanning physical lines; the redundant outer layer is
    // collapsed while the embedded newlines are preserved.
    const input =
      'PRIVATE_KEY=""-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----""\nNEXT=plain\n';
    const { content, collapsed } = collapseRedundantQuotes(input);
    expect(content).toBe(
      'PRIVATE_KEY="-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----"\nNEXT=plain\n',
    );
    expect(collapsed).toBe(1);
  });

  it("preserves a missing trailing newline", () => {
    const { content } = collapseRedundantQuotes('NODE_ENV=""development""');
    expect(content).toBe('NODE_ENV="development"');
  });

  it("passes through leading comments and blank lines verbatim", () => {
    const input = '# header\n\nNODE_ENV=""development""\n';
    const { content, collapsed } = collapseRedundantQuotes(input);
    expect(content).toBe('# header\n\nNODE_ENV="development"\n');
    expect(collapsed).toBe(1);
  });
});
