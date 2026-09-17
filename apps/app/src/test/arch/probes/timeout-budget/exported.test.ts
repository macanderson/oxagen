// The walker's name leaves the file, so this file cannot see who calls it.
import { productionFiles, readSource } from "@/test/arch/parse";

export function scan(): readonly { readonly file: string }[] {
  return productionFiles().map(readSource);
}
