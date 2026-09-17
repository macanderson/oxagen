// The enumerator handed directly as the callback, under a named budget. It is
// recognised and acquitted: seeding the carrier set must not mean reporting
// every direct hand-off.
import { it } from "vitest";
import { productionFiles, WHOLE_TREE_TIMEOUT_MS } from "@/test/arch/parse";

it(
  "walks the tree as the callback itself",
  productionFiles,
  WHOLE_TREE_TIMEOUT_MS,
);
