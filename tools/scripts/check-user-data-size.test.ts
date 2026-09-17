/**
 * What these tests would still pass on.
 *
 * Not "the template is under 16 KiB today" — that is one number on one day, and
 * asserting it would make every legitimate edit to the bootstrap a test failure
 * with no information in it. What matters is that the budget is MEASURED
 * correctly: that the renderer produces the string Terraform produces, that the
 * mode is read from the module rather than assumed, and that going over fails.
 *
 * The one assertion about the real repository is the last describe block, and it
 * is deliberately the weakest form — "the repo is currently inside its budget" —
 * because that is the claim `check:contracts` makes on every run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodedLength,
  inspect,
  MODULE,
  renderTemplate,
  run,
  SAFETY_MARGIN,
  TEMPLATE,
  TEMPLATE_VARS,
  USER_DATA_LIMIT,
  userDataMode,
} from "./check-user-data-size.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RAW_MODULE = `resource "aws_instance" "node" {
  user_data = templatefile("\${path.module}/user-data.sh.tftpl", {
    name = var.name
  })
}`;

const GZIP_MODULE = `resource "aws_instance" "node" {
  user_data_base64 = base64gzip(templatefile("\${path.module}/user-data.sh.tftpl", {
    name = var.name
  }))
}`;

describe("renderTemplate", () => {
  it("substitutes the variables Terraform would", () => {
    expect(renderTemplate("a=${name} b=${region}", TEMPLATE_VARS)).toBe(
      `a=${TEMPLATE_VARS.name} b=${TEMPLATE_VARS.region}`,
    );
  });

  it("leaves an escaped $${...} as a literal shell variable", () => {
    // This is the one that decides whether the measurement is of the right
    // string: the bootstrap's shell variables are written `$${NEO4J_PASSWORD}`
    // precisely so templatefile does not interpolate them, and a renderer that
    // missed the escape would throw on a variable that is not Terraform's.
    expect(renderTemplate("NEO4J_AUTH: neo4j/$${NEO4J_PASSWORD}", {})).toBe(
      "NEO4J_AUTH: neo4j/${NEO4J_PASSWORD}",
    );
  });

  it("throws on an interpolation it has no value for, rather than measuring a string Terraform would never produce", () => {
    expect(() => renderTemplate("x=${brand_new_var}", TEMPLATE_VARS)).toThrow(
      /brand_new_var/,
    );
  });

  it("throws on a %{...} directive rather than guessing what it expands to", () => {
    expect(() => renderTemplate("%{ if x }a%{ endif }", TEMPLATE_VARS)).toThrow(
      /directive/,
    );
  });
});

describe("userDataMode", () => {
  it("reads the raw form", () => {
    expect(userDataMode(RAW_MODULE)).toBe("raw");
  });

  it("reads the compressed form", () => {
    expect(userDataMode(GZIP_MODULE)).toBe("base64gzip");
  });

  it("does not mistake user_data_base64 for user_data", () => {
    // `user_data` is a prefix of `user_data_base64`, so a loose match reports
    // both and the check refuses to measure anything.
    expect(userDataMode(GZIP_MODULE)).not.toBe("both");
  });

  it("says so when neither is set", () => {
    expect(userDataMode('resource "aws_instance" "node" {}')).toBe("none");
  });
});

describe("encodedLength", () => {
  it("counts raw bytes for the raw mode", () => {
    expect(encodedLength("hello", "raw")).toBe(5);
  });

  it("counts the base64 of the gzip for the compressed mode", () => {
    const body = "x".repeat(20_000);
    expect(encodedLength(body, "base64gzip")).toBe(
      gzipSync(Buffer.from(body, "utf8")).toString("base64").length,
    );
  });

  it("is what makes an over-budget template fit", () => {
    // The substance of the fix, as a property rather than as today's numbers:
    // prose compresses, and this template is mostly prose.
    const prose = readFileSync(join(repoRoot, TEMPLATE), "utf8");
    expect(encodedLength(prose, "base64gzip")).toBeLessThan(
      encodedLength(prose, "raw") / 2,
    );
  });

  it("counts multi-byte characters as bytes, not as characters", () => {
    // The bootstrap's comments use em dashes throughout. Measuring `.length`
    // would under-count every one of them by two bytes.
    expect(encodedLength("—", "raw")).toBe(3);
  });
});

describe("inspect", () => {
  const over = "#".repeat(USER_DATA_LIMIT * 2);
  const under = "#!/bin/sh\necho hi\n";

  it("passes a template inside the budget", () => {
    expect(inspect({ template: under, module: RAW_MODULE }).problems).toEqual(
      [],
    );
  });

  it("fails a raw template over the budget, and says by how much", () => {
    const { problems } = inspect({ template: over, module: RAW_MODULE });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("over the");
    // Thousands-separated, and deliberately not via `toLocaleString` — this
    // assertion is what caught that the message would have read differently
    // under a non-en locale.
    expect(problems[0]).toContain("16,384");
  });

  it("names compression as the remedy while the mode is still raw", () => {
    // The failure has to carry the way out, because the alternative an author
    // reaches for under time pressure is deleting comments — which is what the
    // template's own header exists to argue against.
    const { problems } = inspect({ template: over, module: RAW_MODULE });
    expect(problems[0]).toContain("base64gzip");
    expect(problems[0]).toContain("no comment has to be deleted");
  });

  it("does NOT offer compression once compression is already on", () => {
    // Same overage, different advice. Repeating "try gzip" at a module that
    // already gzips is how a check trains people to ignore it.
    //
    // The fixture has to be INCOMPRESSIBLE, and getting there took two goes —
    // both worth recording, because each produced a green case that asserted
    // nothing:
    //
    //   - a long run of `#` gzips to 88 bytes, so it never reached the budget;
    //   - a textbook LCG (`seed * 1103515245 + 12345`) taken modulo 94 has
    //     cycling low bits, so the output still compressed 7:1.
    //
    // A SHA-256 chain has the entropy the case needs and is still deterministic,
    // so the run is repeatable. The assertion below is the guard: it fails if
    // the fixture ever becomes compressible again, rather than letting the real
    // assertions pass vacuously.
    let block = createHash("sha256").update("user-data-size").digest("base64");
    let huge = "";
    while (huge.length < USER_DATA_LIMIT * 4) {
      block = createHash("sha256").update(block).digest("base64");
      huge += block;
    }
    expect(encodedLength(huge, "base64gzip")).toBeGreaterThan(
      USER_DATA_LIMIT - SAFETY_MARGIN,
    );
    const { problems } = inspect({ template: huge, module: GZIP_MODULE });
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toContain("would send");
    expect(problems[0]).toContain("real growth");
  });

  it("holds the margin back from the headroom rather than adding it to the limit", () => {
    // A template between the budget and the hard limit must FAIL. Adding the
    // margin to the limit instead would pass it and hand EC2 something it
    // refuses.
    const betweenBudgetAndLimit = "#".repeat(USER_DATA_LIMIT - 1);
    expect(betweenBudgetAndLimit.length).toBeLessThan(USER_DATA_LIMIT);
    expect(betweenBudgetAndLimit.length).toBeGreaterThan(
      USER_DATA_LIMIT - SAFETY_MARGIN,
    );
    expect(
      inspect({ template: betweenBudgetAndLimit, module: RAW_MODULE }).problems,
    ).toHaveLength(1);
  });

  it("refuses to measure when the module sets neither attribute", () => {
    const { problems } = inspect({
      template: under,
      module: 'resource "aws_instance" "node" {}',
    });
    expect(problems.join("\n")).toContain("cannot tell what the instance");
  });

  it("refuses to measure when the module sets both", () => {
    const { problems } = inspect({
      template: under,
      module: `${RAW_MODULE}\n${GZIP_MODULE}`,
    });
    expect(problems.join("\n")).toContain("sets both");
  });

  it("reports the mode it measured, so a passing run says what it checked", () => {
    expect(inspect({ template: under, module: GZIP_MODULE }).mode).toBe(
      "base64gzip",
    );
  });
});

describe("the repository as it stands", () => {
  it("renders the real bootstrap without an unresolved interpolation", () => {
    // Guards the check itself: if the renderer silently passed `${...}` through,
    // every size assertion here would measure a string Terraform never builds.
    const rendered = renderTemplate(
      readFileSync(join(repoRoot, TEMPLATE), "utf8"),
      TEMPLATE_VARS,
    );
    expect(rendered).not.toContain("${name}");
    expect(rendered).toContain(TEMPLATE_VARS.deploy_bucket);
    // The shell variables survived as shell variables.
    expect(rendered).toContain("${NEO4J_PASSWORD}");
  });

  it("is inside its user-data budget", () => {
    expect(run().problems).toEqual([]);
  });

  it("compresses, because the rendered bootstrap does not fit uncompressed", () => {
    // The reason the module uses base64gzip, stated as the condition that makes
    // it necessary rather than as a preference. If the template ever shrinks
    // below the limit this still passes — it only asserts the mode matches the
    // need, not that the need is permanent.
    const { mode, rawBytes } = run();
    if (rawBytes > USER_DATA_LIMIT - SAFETY_MARGIN) {
      expect(mode).toBe("base64gzip");
    }
  });

  it("reads the real module, not a stale path", () => {
    expect(MODULE).toBe("infra/modules/app-node/main.tf");
    expect(TEMPLATE).toBe("infra/modules/app-node/user-data.sh.tftpl");
    expect(readFileSync(join(repoRoot, MODULE), "utf8")).toContain(
      "aws_instance",
    );
  });
});
