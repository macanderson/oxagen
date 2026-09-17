// A local `it` that is not vitest's. The registrar is recognised by name, so
// this is accepted as a budgeted registration -- while the walk actually runs
// during collection, unbudgeted, the moment the module is imported.
import { productionFiles, WHOLE_TREE_TIMEOUT_MS } from "@/test/arch/parse";

function it(_name: string, body: () => void, _timeout?: number): void {
  body();
}

it(
  "looks budgeted and runs at collection time",
  () => {
    void productionFiles().length;
  },
  WHOLE_TREE_TIMEOUT_MS,
);
