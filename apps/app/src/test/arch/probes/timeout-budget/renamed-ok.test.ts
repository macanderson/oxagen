// The renamed import again, this time under a named budget. Resolving the
// binding finds the walk; the walk is charged where it runs and acquitted.
// Recognising more walks must not mean reporting more violations.
import { expect, it } from "vitest";
import {
  productionFiles as files,
  WHOLE_TREE_TIMEOUT_MS,
} from "@/test/arch/parse";

it(
  "walks the tree under a renamed import, budgeted",
  () => {
    expect(files().length).toBeGreaterThan(0);
  },
  WHOLE_TREE_TIMEOUT_MS,
);
