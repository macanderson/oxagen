// The enumerator IS the callback. No call expression names it and no local
// wrapper carries it, so a fixpoint seeded only with local functions finds
// nothing here.
import { it } from "vitest";
import { productionFiles } from "@/test/arch/parse";

it("walks the tree as the callback itself", productionFiles);
