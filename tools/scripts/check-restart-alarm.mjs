#!/usr/bin/env node
/**
 * The crash-loop alarm has four parts and no error if they stop agreeing.
 *
 * `oxagen-container-restart-loop` (#2813) exists because a leftover container
 * restarted about fourteen times a minute for two days and every alarm in the
 * account stayed OK. The replacement signal is a chain: a `docker events`
 * collector on the node writes a line per container start, the CloudWatch agent
 * ships that file to a log group, a metric filter counts the lines, and an
 * alarm reads the metric.
 *
 * Every link is joined by a string literal in a different file. Change the
 * collector's `--format` and the filter matches nothing; rename the log group
 * on one side and the filter watches an empty one; rename the metric and the
 * alarm reads a metric nobody publishes. In each case the alarm does not fail —
 * it sits at OK forever, which is indistinguishable from a healthy node and is
 * the precise failure mode the alarm was added to end. `tofu plan` cannot catch
 * any of them: every reference is well-formed Terraform.
 *
 * So the chain is checked here as text, the same way check-main-concurrency and
 * check-infra-plan-verdict hold a workflow expression still. Four assertions:
 *
 *   1. A line the collector's format produces is matched by the filter pattern.
 *   2. The group the agent writes to is the group the filter reads, and it is
 *      registered in `local.log_group_services` so it gets retention and
 *      archival rather than being created ad hoc by its first writer.
 *   3. The alarm reads the namespace and metric the filter writes.
 *   4. The alarm's own arithmetic still separates a deploy from a crash loop,
 *      replayed against both: the incident's recorded rate must reach ALARM and
 *      a full-estate deploy must not.
 *
 * Run by `pnpm check:contracts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MONITORING_TF = "infra/modules/app-node/monitoring.tf";
export const ALARMS_TF = "infra/stacks-new/oxagen/alarms.tf";
export const OBSERVABILITY_TF = "infra/stacks-new/oxagen/observability.tf";

/** The rate the incident actually ran at, in container starts per minute. */
export const INCIDENT_STARTS_PER_MINUTE = 14;

/**
 * The largest honest deploy burst: one start per service log group, which is
 * the whole estate coming up after a node replacement, inside a single period.
 */
export const FULL_ESTATE_DEPLOY_STARTS = 9;

// ---------------------------------------------------------------------------
// CloudWatch Logs filter patterns, as much of them as is safe to model
// ---------------------------------------------------------------------------

/**
 * Match a log line against a CloudWatch Logs filter pattern.
 *
 * Deliberately supports only the one shape this alarm uses — a single
 * unquoted or double-quoted term, which CloudWatch matches as a case-sensitive
 * substring — and throws on anything else. A matcher that quietly returned
 * `true` for a pattern it did not understand would be a check that passes on
 * patterns nobody has verified, which is worse than no check: the real service
 * would reject or mis-match it and this would say the chain was intact.
 */
export function matchesFilterPattern(pattern, line) {
  const trimmed = pattern.trim();
  if (trimmed === "") {
    throw new Error("empty filter pattern");
  }
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  const term = quoted ? quoted[1].replace(/\\(.)/g, "$1") : trimmed;
  if (/[\s?{}[\]()$=<>!,|&*]/.test(term)) {
    throw new Error(
      `check-restart-alarm only models a single-term filter pattern; got ${JSON.stringify(pattern)}. ` +
        "Extend matchesFilterPattern to cover the new shape rather than loosening this guard.",
    );
  }
  return line.includes(term);
}

/**
 * Render one line of the collector's `docker events --format` template, by
 * substituting a plausible value for each `{{...}}` placeholder.
 *
 * The substituted values are irrelevant to what is being checked: the question
 * is whether the LITERAL text of the format still carries whatever the filter
 * pattern looks for. A container named `container_start` would make a line
 * match for the wrong reason, so the stand-ins are chosen not to contain the
 * token themselves.
 */
export function renderEventLine(format) {
  return format.replace(/\{\{[^}]*\}\}/g, "oxagen-example");
}

// ---------------------------------------------------------------------------
// CloudWatch alarm evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a CloudWatch metric alarm over a series of per-period datapoints,
 * returning "ALARM" or "OK".
 *
 * M-out-of-N: the alarm fires when `datapointsToAlarm` of the most recent
 * `evaluationPeriods` datapoints breach. Missing datapoints are not modelled —
 * every caller here supplies a full window on purpose, because the thing under
 * test is the threshold's ability to separate two shapes of real traffic, not
 * CloudWatch's missing-data handling.
 */
export function evaluateAlarm(
  { threshold, comparisonOperator, evaluationPeriods, datapointsToAlarm },
  datapoints,
) {
  // Resolved before any datapoint is looked at. Deciding it per datapoint means
  // a window shorter than evaluationPeriods never reaches the switch, and an
  // unmodelled operator returns "OK" — a checker that passes because it did no
  // work, which is the shape of failure this whole file is about.
  const comparisons = {
    GreaterThanThreshold: (value) => value > threshold,
    GreaterThanOrEqualToThreshold: (value) => value >= threshold,
    LessThanThreshold: (value) => value < threshold,
    LessThanOrEqualToThreshold: (value) => value <= threshold,
  };
  const breaches = comparisons[comparisonOperator];
  if (!breaches) {
    throw new Error(`unmodelled comparison operator ${comparisonOperator}`);
  }
  for (let end = evaluationPeriods; end <= datapoints.length; end += 1) {
    const window = datapoints.slice(end - evaluationPeriods, end);
    if (window.filter(breaches).length >= datapointsToAlarm) {
      return "ALARM";
    }
  }
  return "OK";
}

// ---------------------------------------------------------------------------
// Reading the four literals out of the Terraform
// ---------------------------------------------------------------------------

/** The body of the named `resource "<type>" "<name>"` block, brace-balanced. */
export function resourceBlock(hcl, type, name) {
  const header = `resource "${type}" "${name}" {`;
  const start = hcl.indexOf(header);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let i = start + header.length - 1; i < hcl.length; i += 1) {
    if (hcl[i] === "{") depth += 1;
    else if (hcl[i] === "}") {
      depth -= 1;
      if (depth === 0) return hcl.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The body of a nested `<label> { ... }` block, brace-balanced.
 *
 * Needed because `aws_cloudwatch_log_metric_filter` has a `name` at the top
 * level (the filter's own name) AND a `name` inside `metric_transformation`
 * (the metric's). Reading the first `name` in the resource gets the filter's,
 * which is not what the alarm reads, and the mismatch looks exactly like a
 * genuinely broken chain.
 */
export function nestedBlock(block, label) {
  const header = `${label} {`;
  const start = block.indexOf(header);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let i = start + header.length - 1; i < block.length; i += 1) {
    if (block[i] === "{") depth += 1;
    else if (block[i] === "}") {
      depth -= 1;
      if (depth === 0) return block.slice(start, i + 1);
    }
  }
  return null;
}

/** The value of `<key> = "<string>"`, or null. */
export function stringAttr(block, key) {
  const m = new RegExp(
    `(?:^|[^\\w.-])${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`,
  ).exec(block);
  return m ? m[1] : null;
}

/** The value of `<key> = <number>`, or null. */
export function numberAttr(block, key) {
  const m = new RegExp(`(?:^|[^\\w.-])${key}\\s*=\\s*(-?\\d+)`).exec(block);
  return m ? Number(m[1]) : null;
}

/** The string elements of `<key> = [ ... ]` on one line. */
export function stringListAttr(hcl, key) {
  const m = new RegExp(`(?:^|[^\\w.-])${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(
    hcl,
  );
  if (!m) return null;
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
}

/**
 * Pull everything the four assertions need out of the three files.
 *
 * Returns problems rather than throwing so a run reports every broken link at
 * once — a chain of four is exactly the case where fixing one at a time and
 * re-running is the slow way to find out about the other three.
 */
export function inspect({
  monitoring,
  alarms,
  observability,
  appName = "oxagen-app",
}) {
  const problems = [];

  const format = stringAttr(monitoring, "docker_event_format");
  if (!format) {
    problems.push(
      `${MONITORING_TF}: no local.docker_event_format. The collector's \`docker events --format\` string is what the metric filter matches on; without it there is nothing to check the filter against.`,
    );
  }

  const agentGroup = stringAttr(monitoring, "log_group_name")?.replaceAll(
    "${var.name}",
    appName,
  );
  if (!agentGroup) {
    problems.push(
      `${MONITORING_TF}: the CloudWatch agent config declares no log_group_name for the docker-events file, so the collector's lines never leave the node.`,
    );
  }

  const filter = resourceBlock(
    alarms,
    "aws_cloudwatch_log_metric_filter",
    "container_starts",
  );
  if (!filter) {
    problems.push(
      `${ALARMS_TF}: aws_cloudwatch_log_metric_filter.container_starts is gone. Nothing turns container start lines into a metric, so oxagen-container-restart-loop reads a metric with no publisher and stays OK forever.`,
    );
  }

  const alarm = resourceBlock(
    alarms,
    "aws_cloudwatch_metric_alarm",
    "container_restart_loop",
  );
  if (!alarm) {
    problems.push(
      `${ALARMS_TF}: aws_cloudwatch_metric_alarm.container_restart_loop is gone. #2813 is the incident it exists for.`,
    );
  }

  if (format && filter) {
    const pattern = stringAttr(filter, "pattern");
    if (!pattern) {
      problems.push(`${ALARMS_TF}: container_starts has no pattern.`);
    } else {
      const line = renderEventLine(format);
      if (!matchesFilterPattern(pattern, line)) {
        problems.push(
          `the collector's format and the metric filter no longer agree. The collector writes ${JSON.stringify(line)}; the filter matches ${JSON.stringify(pattern)}. The filter counts nothing and the alarm sits at OK. Change both or neither.`,
        );
      }
    }
  }

  if (filter) {
    const groupRef = /log_group_name\s*=\s*([^\n]+)/.exec(filter)?.[1]?.trim();
    const wantsRef = 'aws_cloudwatch_log_group.service["docker-events"].name';
    if (groupRef !== wantsRef) {
      problems.push(
        `${ALARMS_TF}: container_starts reads ${groupRef}, not ${wantsRef}. It must read the group the stack owns, so the filter cannot end up watching a group that retention, tags and the S3 archive never reach.`,
      );
    }
    if (agentGroup && agentGroup !== "/oxagen-app/docker-events") {
      problems.push(
        `${MONITORING_TF}: the agent ships to ${agentGroup}, but the metric filter reads /oxagen-app/docker-events. The filter watches a group nothing writes to.`,
      );
    }
  }

  const groups = stringListAttr(observability, "log_group_services");
  if (!groups) {
    problems.push(`${OBSERVABILITY_TF}: no local.log_group_services.`);
  } else if (!groups.includes("docker-events")) {
    problems.push(
      `${OBSERVABILITY_TF}: local.log_group_services does not include "docker-events", so /oxagen-app/docker-events is created by whatever writes to it first — with no retention policy, no tags and no archive subscription. That is exactly how the worker's own log group ended up unwatched.`,
    );
  }

  if (filter && alarm) {
    const transformation = nestedBlock(filter, "metric_transformation");
    if (!transformation) {
      problems.push(
        `${ALARMS_TF}: container_starts has no metric_transformation, so it publishes no metric at all.`,
      );
    } else {
      for (const [key, filterKey] of [
        ["namespace", "namespace"],
        ["metric_name", "name"],
      ]) {
        const onFilter = stringAttr(transformation, filterKey);
        const onAlarm = stringAttr(alarm, key);
        if (onFilter !== onAlarm) {
          problems.push(
            `the filter publishes ${key} ${JSON.stringify(onFilter)} and the alarm reads ${JSON.stringify(onAlarm)}. The alarm reads a metric nobody publishes.`,
          );
        }
      }
    }
  }

  if (alarm) {
    const spec = {
      threshold: numberAttr(alarm, "threshold"),
      comparisonOperator: stringAttr(alarm, "comparison_operator"),
      evaluationPeriods: numberAttr(alarm, "evaluation_periods"),
      datapointsToAlarm: numberAttr(alarm, "datapoints_to_alarm"),
      period: numberAttr(alarm, "period"),
    };
    const missing = Object.entries(spec)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.length > 0) {
      problems.push(
        `${ALARMS_TF}: container_restart_loop is missing ${missing.join(", ")}. Without datapoints_to_alarm CloudWatch requires every period to breach, which changes the alarm silently.`,
      );
    } else {
      const perPeriod = (INCIDENT_STARTS_PER_MINUTE * spec.period) / 60;
      const window = spec.evaluationPeriods + 2;
      const incident = evaluateAlarm(spec, Array(window).fill(perPeriod));
      if (incident !== "ALARM") {
        problems.push(
          `container_restart_loop would NOT have fired during #2813. The incident ran at ${INCIDENT_STARTS_PER_MINUTE} starts a minute, which is ${perPeriod} per ${spec.period}s period, and the alarm stays ${incident}. An alarm that would not fire during the incident it was written for is decoration.`,
        );
      }
      const deploy = evaluateAlarm(spec, [
        0,
        0,
        FULL_ESTATE_DEPLOY_STARTS,
        0,
        0,
        FULL_ESTATE_DEPLOY_STARTS,
        0,
        0,
      ]);
      if (deploy !== "OK") {
        problems.push(
          `container_restart_loop fires on an ordinary deploy: ${FULL_ESTATE_DEPLOY_STARTS} starts in one period, twice, reads ${deploy}. An alarm that pages on every deploy teaches people to ignore it.`,
        );
      }
      const description = stringAttr(alarm, "alarm_description") ?? "";
      // Standalone, not a substring: `5` in "5-minute periods" is the period,
      // not the threshold, and a description that had lost the threshold
      // entirely still contained the digit.
      const statesThreshold = new RegExp(
        `(?:^|[^\\w.-])${spec.threshold}(?![\\w.-])`,
      ).test(description);
      if (!statesThreshold) {
        problems.push(
          `${ALARMS_TF}: container_restart_loop's description does not state its threshold (${spec.threshold}). Whoever is woken by it reads the description, not the Terraform.`,
        );
      }
    }
  }

  return problems;
}

export function run(root = repoRoot) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const appModule = /module "app" \{([\s\S]*?)^\}/m.exec(
    read("infra/stacks-new/oxagen/main.tf"),
  )?.[1];
  const appName = appModule && stringAttr(appModule, "name");
  if (!appName)
    return [
      "Production app module has no literal name; resolve its log prefix before checking the alarm chain.",
    ];
  return inspect({
    appName,
    monitoring: read(MONITORING_TF),
    alarms: read(ALARMS_TF),
    observability: read(OBSERVABILITY_TF),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = run();
  if (problems.length > 0) {
    console.error(
      "check-restart-alarm: the crash-loop alarm chain is broken (#2813)\n",
    );
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    "check-restart-alarm: collector, log group, metric filter and alarm agree",
  );
}
