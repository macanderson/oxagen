// A sibling module, not a test: the enumeration runs in its MODULE INITIALIZER,
// so importing this file walks the tree during collection, in a file `judge`
// never opens.
import { productionFiles } from "@/test/arch/parse";

export const files = productionFiles();
