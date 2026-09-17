// `{ scan }` carries the walker as a property value. The mention is at module
// scope, so the walk is unbudgeted however the registrar later reaches it.
import { expect, it } from "vitest";
import { productionFiles } from "@/test/arch/parse";

function scan(): void {
  expect(productionFiles().length).toBeGreaterThan(0);
}

const registry = { scan };

it("walks via an object property", registry.scan);
