// Every date a server component prints reads in the viewer's time zone
// (#3337). It takes its formatter from src/ui/formatter.ts, which writes the
// viewer's zone into a per-request slot and formats in it; a server module that
// reaches for next-intl's `useFormatter` directly gets the request config
// instead, which is read while the static shell prerenders and so carries only
// the default zone. The wrapper is the one server module that may import
// next-intl's formatter — it is what it wraps. A "use client" module is exempt:
// it takes its zone from the nearest provider, and the shell puts the viewer's
// there.
//
// This exists because the guard was missing once: the Spend page's figures and
// pricing table were written before #3337 landed and kept next-intl's formatter
// through the merge, which printed those dates in the default zone with nothing
// failing.
import { describe, expect, it } from "vitest";
import {
  directiveOf,
  importEdges,
  parse,
  productionFiles,
  readSource,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

/** The wrapper: the one server module that may reach next-intl's formatter. */
const WRAPPER = "src/ui/formatter.ts";

/** Each server-module import of next-intl's `useFormatter` outside the wrapper. */
function violations(): string[] {
  const out: string[] = [];
  for (const file of productionFiles()) {
    if (file === WRAPPER) continue;
    const sf = parse(readSource(file));
    if (directiveOf(sf) === "use client") continue;
    for (const edge of importEdges(sf)) {
      if (edge.specifier !== "next-intl") continue;
      if (!edge.names.includes("useFormatter")) continue;
      out.push(`${file}:${String(edge.line)} useFormatter from next-intl`);
    }
  }
  return out;
}

describe("viewer time zone", () => {
  it(
    "every server module takes useFormatter from the wrapper",
    () => {
      expect(productionFiles()).toContain(WRAPPER);
      expect(violations()).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );
});
