// A DataSource answering the mandate page's one read (ARCHITECTURE.md §5), and
// nothing else: the page reads `get_mandate` alone, so every other port refuses
// and a test that accidentally reaches for one fails rather than passing on a
// stub. The mandate values themselves come from `@/test/mandate-views`, which
// four features share because no feature may reach into another's folder.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import { refusingSource } from "@/test/refusing-source";
import type { MandateDetail } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function mandateSource(read: Read<MandateDetail> | undefined) {
  const calls: unknown[][] = [];

  const source: DataSource = refusingSource("Mandate", {
    mandates: {
      get: (...args: unknown[]) => {
        calls.push(args);
        return read === undefined
          ? Promise.reject(new Error("mandates.get was not expected"))
          : Promise.resolve(read);
      },
    },
  });
  return { source, calls };
}
