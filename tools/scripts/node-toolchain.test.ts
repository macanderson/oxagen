import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

it("validates immutable bundles and dispatches without holding the worker lock", () => {
  expect(() => execFileSync("python3", [fileURLToPath(new URL("infra/tools/tests/node-toolchain.test.py", root))],
    { timeout: 30_000, encoding: "utf8" })).not.toThrow();
}, 35_000);

it("requires infrastructure-published source tools before publishing an application artifact", () => {
  const action = read(".github/actions/ship-to-node/action.yml");
  const verify = action.indexOf("invoke_node verify");
  const publish = action.indexOf('"s3://$BUCKET/_deploy/$SERVICE-standalone.tgz"');
  expect(verify).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThanOrEqual(0);
  expect(verify).toBeLessThan(publish);
  expect(action).toContain("toolchainDigest=$toolchain_digest,operation=$operation");
  for (const name of ["infra/stacks-new/ci-deploy/ssm.tf", "infra/modules/isolated-environment/runtime.tf"]) {
    const document = read(name);
    expect(document).toContain("toolchainDigest");
    expect(document).toContain("deploy-dispatch.py");
    expect(document).toContain("--digest '{{ toolchainDigest }}'");
    expect(document).not.toContain("aws s3 sync s3://${local.bucket}/_bin/");
  }
  const roles = read("infra/stacks-new/ci-deploy/roles.tf");
  expect(roles).not.toContain("_node-tools/");
  const publisher = read("infra/tools/publish-node-tools.sh");
  expect(publisher.indexOf("_node-tools/releases/")).toBeLessThan(publisher.indexOf("_node-tools/current.json"));
});

it("runs both deployment guard regressions before infrastructure discovery and apply", () => {
  const workflow = read(".github/workflows/infra.yml");
  const guards = workflow.indexOf("- name: Verify node deployment guards");
  const discovery = workflow.indexOf("- id: pick");
  expect(guards).toBeGreaterThanOrEqual(0);
  expect(discovery).toBeGreaterThan(guards);
  expect(workflow).toContain("python3 infra/tools/tests/node-toolchain.test.py");
  expect(workflow).toContain("python3 infra/tools/tests/node-memory-budget.test.py");
});
