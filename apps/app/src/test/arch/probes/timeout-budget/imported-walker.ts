// A sibling module, not a test. Its body reaches the tree, so anything that
// names `scan` can run a whole-tree walk -- across the file boundary.
import { productionFiles, readSource } from "@/test/arch/parse";

export function scan(): readonly { readonly file: string }[] {
  return productionFiles().map(readSource);
}

/** Reaches nothing: the control for "imported" not meaning "suspect". */
export function readOne(): number {
  return readSource("src/data/ports.ts").text.length;
}
