#!/usr/bin/env node
/**
 * EC2 user-data is capped at 16 KiB, and nothing in this repo could see the
 * budget until it was already spent.
 *
 * The limit is the EC2 API's, not the provider's: `RunInstances` refuses user
 * data whose DECODED length exceeds 16,384 bytes. The AWS provider front-runs it
 * with a length validation on `aws_instance.user_data`, which is where this
 * surfaced — as a `plan` failure on the `oxagen` stack, with the entire rendered
 * bootstrap dumped into the CI log as the body of the error message. The stack
 * could not be planned or applied at all, and the only signal was 19 KB of bash
 * in a job log.
 *
 * ## Why a check rather than a smaller file
 *
 * `main` sat at 12,586 of 16,384 — 3,798 bytes free — before the change that
 * broke it. At that headroom any sufficiently-argued comment in
 * `user-data.sh.tftpl` hits the ceiling, and `user-data.sh.tftpl` is a file whose
 * own header argues that the reasoning belongs beside the code it defends. Those
 * two facts are in tension for as long as the budget is invisible, and the way
 * they get resolved when nobody is looking is by deleting the reasoning, which
 * is the outcome that file exists to prevent.
 *
 * So the budget is measured here, on every `check:contracts`, and the failure
 * names the number rather than printing the script.
 *
 * ## What is measured
 *
 * Whatever the module actually sets, read out of `main.tf` rather than assumed —
 * a guard that measures the raw template while Terraform sends something else is
 * worse than no guard, because it reports a budget nobody is spending:
 *
 *   - `user_data = templatefile(...)`                     -> the rendered bytes
 *   - `user_data_base64 = base64gzip(templatefile(...))`  -> the base64 of the
 *     gzip, which is both what the provider validates and, once decoded, what
 *     EC2 counts. cloud-init decompresses gzipped user-data before dispatching
 *     on the shebang, so the compression is transparent to the script.
 *
 * Node's gzip and Go's are both DEFLATE at level 6 with a zeroed mtime, so the
 * two differ by a few bytes at most; `SAFETY_MARGIN` covers that and then some,
 * and is deducted from the headroom rather than from the limit so the number the
 * failure prints is the real one.
 *
 * Run by `pnpm check:contracts`.
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TEMPLATE = "infra/modules/app-node/user-data.sh.tftpl";
export const MODULE = "infra/modules/app-node/main.tf";

/** EC2's cap on decoded user-data. Not ours to raise. */
export const USER_DATA_LIMIT = 16_384;

/**
 * Bytes held back from the headroom, not added to the limit.
 *
 * Two things move under us: Node's gzip output can differ from Go's by a few
 * bytes, and the interpolated variable values below are this deployment's rather
 * than every deployment's. A guard that passes at 16,383 is a guard that fails in
 * CI on someone else's account id.
 */
export const SAFETY_MARGIN = 512;

/**
 * The values `infra/stacks-new/oxagen/main.tf` passes, so the measurement is of
 * the string that deployment actually renders. They are short and only four of
 * them reach the template, so the difference between these and any other
 * plausible values is tens of bytes — which is what `SAFETY_MARGIN` is for.
 */
export const TEMPLATE_VARS = Object.freeze({
  name: "oxagen-app",
  region: "us-east-1",
  neo4j_version: "5-community",
  clickhouse_image: "clickhouse/clickhouse-server:24.8-alpine",
  deploy_bucket: "oxagen-deploy-916294258235",
});

/**
 * Render a `templatefile` template the way Terraform does, for the subset this
 * template uses.
 *
 * `$${` is Terraform's escape for a literal `${`, which is how the shell
 * variables in this bootstrap survive interpolation. It has to be taken out
 * BEFORE substitution and put back after, or `$${NEO4J_PASSWORD}` is read as an
 * interpolation of a variable that does not exist.
 *
 * Anything this cannot resolve throws rather than being left in place. A
 * renderer that silently passes an unknown `${...}` through measures a string
 * Terraform would never produce, and would do it most readily on the day someone
 * adds a variable.
 */
export function renderTemplate(template, vars) {
  // A printable sentinel, not a control byte: `check-control-bytes.mjs` rejects
  // raw control characters in tracked source, and it is right to — a NUL in a
  // checked-in script is invisible in every diff that matters.
  const ESCAPE = "@@TF_ESCAPED_DOLLAR@@";
  if (template.includes(ESCAPE)) {
    throw new Error(
      `${TEMPLATE}: contains the literal escape sentinel ${ESCAPE}, so the rendered size would be wrong. Change the sentinel.`,
    );
  }
  let out = template.replaceAll("$${", ESCAPE);

  if (out.includes("%{")) {
    throw new Error(
      `${TEMPLATE}: uses a %{...} template directive, which this renderer does not implement. Extend it rather than letting the size check measure the wrong string.`,
    );
  }

  out = out.replace(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (_match, name) => {
    if (!(name in vars)) {
      throw new Error(
        `${TEMPLATE}: interpolates \`${name}\`, which is not in TEMPLATE_VARS. Add it there with the value the stack passes, so the measured size is the rendered one.`,
      );
    }
    return vars[name];
  });

  const stray = /\$\{/.exec(out);
  if (stray) {
    throw new Error(
      `${TEMPLATE}: an unresolved \${...} interpolation survived rendering at offset ${stray.index}.`,
    );
  }

  return out.replaceAll(ESCAPE, "${");
}

/** Which attribute the module sets, and therefore what EC2 will be handed. */
export function userDataMode(moduleSource) {
  const base64 =
    /user_data_base64\s*=\s*base64gzip\s*\(\s*templatefile\s*\(/.test(
      moduleSource,
    );
  const raw = /^\s*user_data\s*=\s*templatefile\s*\(/m.test(moduleSource);
  if (base64 && raw) return "both";
  if (base64) return "base64gzip";
  if (raw) return "raw";
  return "none";
}

/** The bytes Terraform hands the provider, for a given mode. */
export function encodedLength(rendered, mode) {
  if (mode === "base64gzip") {
    // Terraform's base64gzip is gzip-then-base64. Node's gzip defaults match
    // Go's closely enough for a budget with this much margin.
    return gzipSync(Buffer.from(rendered, "utf8")).toString("base64").length;
  }
  return Buffer.byteLength(rendered, "utf8");
}

/**
 * Thousands separators without `toLocaleString`, whose output depends on the
 * runner's locale. The failure message is asserted in this script's tests, and a
 * check that reads differently on a French CI box is a check with a flaky test
 * and an author who learns to distrust it.
 */
function commas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function inspect({ template, module: moduleSource }) {
  const problems = [];
  const rendered = renderTemplate(template, TEMPLATE_VARS);
  const rawBytes = Buffer.byteLength(rendered, "utf8");
  const mode = userDataMode(moduleSource);

  if (mode === "none") {
    problems.push(
      `${MODULE}: sets neither \`user_data = templatefile(...)\` nor \`user_data_base64 = base64gzip(templatefile(...))\`, so this check cannot tell what the instance is handed at boot. If the bootstrap moved, move this check with it.`,
    );
    return { problems, rawBytes, mode, sentBytes: rawBytes };
  }
  if (mode === "both") {
    problems.push(
      `${MODULE}: sets both \`user_data\` and \`user_data_base64\`. The provider rejects that, and this check cannot say which budget applies.`,
    );
    return { problems, rawBytes, mode, sentBytes: rawBytes };
  }

  const sentBytes = encodedLength(rendered, mode);
  const budget = USER_DATA_LIMIT - SAFETY_MARGIN;

  if (sentBytes > budget) {
    const over = sentBytes - budget;
    problems.push(
      `${MODULE}: the rendered ${TEMPLATE} is ${commas(sentBytes)} bytes as \`${mode}\`, which is ${commas(over)} over the ${commas(budget)}-byte budget (EC2's hard limit is ${commas(USER_DATA_LIMIT)}; ${SAFETY_MARGIN} bytes are held back for gzip and interpolation variance). ` +
        (mode === "raw"
          ? `The template itself is ${commas(rawBytes)} bytes. Switching the module to \`user_data_base64 = base64gzip(templatefile(...))\` would send ${commas(encodedLength(rendered, "base64gzip"))} bytes instead — cloud-init decompresses gzipped user-data before reading the shebang, so nothing in the script has to change and no comment has to be deleted.`
          : `Compression is already on, so this is real growth. Move content out of the bootstrap rather than deleting the reasoning in it — a stub that fetches and execs the script from the deploy bucket is the next step, and the one that retires this ceiling.`),
    );
  }

  return { problems, rawBytes, mode, sentBytes };
}

export function run() {
  return inspect({
    template: readFileSync(join(repoRoot, TEMPLATE), "utf8"),
    module: readFileSync(join(repoRoot, MODULE), "utf8"),
  });
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { problems, rawBytes, mode, sentBytes } = run();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const budget = USER_DATA_LIMIT - SAFETY_MARGIN;
  const headroom = budget - sentBytes;
  const pct = Math.round((sentBytes / budget) * 100);
  console.log(
    `check-user-data-size: ${commas(sentBytes)} bytes sent as \`${mode}\`` +
      (mode === "base64gzip"
        ? ` (${commas(rawBytes)} rendered, ${Math.round((1 - sentBytes / rawBytes) * 100)}% smaller compressed)`
        : "") +
      `, ${commas(headroom)} free of ${commas(budget)} (${pct}%).`,
  );
}
