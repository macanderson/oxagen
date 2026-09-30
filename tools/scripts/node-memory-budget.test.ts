import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const regression = fileURLToPath(new URL(
  "../../infra/tools/tests/node-memory-budget.test.py", import.meta.url,
));

it("refuses unsafe node budgets and serializes concurrent service replacements", () => {
  expect(() => execFileSync("python3", [regression], {
    encoding: "utf8",
    timeout: 30_000,
  })).not.toThrow();
});
