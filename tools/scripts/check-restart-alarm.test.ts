/**
 * What these tests would still pass on, stated per test, because "the test
 * fails when I break the code" only shows the test is sensitive to the change
 * — not that it measures the thing that matters.
 *
 * The thing that matters for #2813 is that a container restarting in a loop
 * reaches a person. Every assertion below is written against a specific way
 * that stops being true while every file involved stays valid Terraform.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateAlarm,
  FULL_ESTATE_DEPLOY_STARTS,
  INCIDENT_STARTS_PER_MINUTE,
  inspect,
  matchesFilterPattern,
  renderEventLine,
  resourceBlock,
  run,
  stringAttr,
  stringListAttr,
} from "./check-restart-alarm.mjs";

describe("matchesFilterPattern", () => {
  it("matches a bare term as a case-sensitive substring", () => {
    expect(
      matchesFilterPattern("container_start", "container_start container=x"),
    ).toBe(true);
    expect(
      matchesFilterPattern("container_start", "Container_Start container=x"),
    ).toBe(false);
  });

  it("unwraps a quoted term", () => {
    expect(
      matchesFilterPattern('"container_start"', "a container_start b"),
    ).toBe(true);
  });

  // The load-bearing one. A matcher that shrugged and returned true for a
  // pattern it does not model would turn this whole check into a pass that
  // proves nothing: CloudWatch would evaluate the real pattern, get a different
  // answer, and the alarm would sit at OK with the check green. Refusing is the
  // only safe direction for a fake — the real service is stricter than this, so
  // the fake must never be more permissive than the real one.
  it("refuses a pattern shape it does not model rather than guessing", () => {
    expect(() => matchesFilterPattern("?ERROR ?WARN", "x")).toThrow(
      /single-term/,
    );
    expect(() => matchesFilterPattern('{ $.event = "start" }', "x")).toThrow(
      /single-term/,
    );
    expect(() => matchesFilterPattern("", "x")).toThrow(/empty/);
  });
});

describe("renderEventLine", () => {
  it("substitutes every docker template placeholder", () => {
    expect(
      renderEventLine("container_start container={{.Actor.Attributes.name}}"),
    ).toBe("container_start container=oxagen-example");
  });

  // Would still pass on: a format that carries the token only inside a
  // placeholder's default. The stand-in deliberately does not contain
  // "container_start", so a format whose literal text lost the token cannot
  // match by accident through the substituted value.
  it("does not smuggle the matched token in through the stand-in value", () => {
    expect(renderEventLine("{{.Actor.Attributes.name}}")).not.toContain(
      "container_start",
    );
  });
});

describe("evaluateAlarm", () => {
  const spec = {
    threshold: 5,
    comparisonOperator: "GreaterThanThreshold" as const,
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
  };

  it("fires on a sustained level", () => {
    expect(evaluateAlarm(spec, [70, 70, 70])).toBe("ALARM");
  });

  // Would still pass on: an alarm with evaluation_periods 1. This is the pair
  // that pins the burst-versus-level distinction, which is the entire reason
  // the threshold is 5 and not 70.
  it("does not fire on a burst, however large", () => {
    expect(evaluateAlarm(spec, [0, 0, 900, 0, 0])).toBe("OK");
  });

  it("requires datapointsToAlarm of evaluationPeriods, not any one", () => {
    expect(evaluateAlarm(spec, [70, 0, 70, 0, 70])).toBe("OK");
    expect(evaluateAlarm({ ...spec, datapointsToAlarm: 2 }, [70, 0, 70])).toBe(
      "ALARM",
    );
  });

  // Would still pass on: an operator check inside the per-datapoint loop — but
  // only if the window were long enough to reach it. One datapoint against
  // evaluationPeriods 3 is the case that exposed it: the loop never ran and the
  // function answered "OK" for an operator it does not understand.
  it("refuses a comparison operator it does not model, before looking at data", () => {
    expect(() =>
      evaluateAlarm(
        { ...spec, comparisonOperator: "LessThanLowerThreshold" },
        [1],
      ),
    ).toThrow(/unmodelled/);
    expect(() =>
      evaluateAlarm(
        { ...spec, comparisonOperator: "LessThanLowerThreshold" },
        [],
      ),
    ).toThrow(/unmodelled/);
  });
});

describe("resourceBlock / attribute readers", () => {
  const hcl = `
resource "aws_cloudwatch_metric_alarm" "x" {
  alarm_name = "a"
  nested { threshold = 1 }
  threshold = 5
}
resource "aws_cloudwatch_metric_alarm" "y" {
  threshold = 9
}
`;

  // Would still pass on: an indexOf-to-next-"}" reader, if the block had no
  // nested braces. The nested block is there on purpose — the metric filter's
  // metric_transformation is nested, so a reader that stops at the first close
  // brace silently reads half a resource.
  it("balances braces rather than stopping at the first close", () => {
    const block = resourceBlock(hcl, "aws_cloudwatch_metric_alarm", "x");
    expect(block).toContain("threshold = 5");
    expect(block).not.toContain("threshold = 9");
  });

  it("returns null for a resource that is not there", () => {
    expect(
      resourceBlock(hcl, "aws_cloudwatch_metric_alarm", "nope"),
    ).toBeNull();
  });

  // Would still pass on: a reader anchored to the start of a line — HCL puts an
  // attribute after `{` on the same line as readily as on its own, and an
  // anchored reader answers "absent", which every caller here reads as a broken
  // link rather than as its own bug.
  it("reads an attribute wherever HCL is entitled to put it", () => {
    expect(stringAttr(hcl, "alarm_name")).toBe("a");
    expect(stringListAttr('locals { xs = ["a", "b"] }', "xs")).toEqual([
      "a",
      "b",
    ]);
    expect(stringListAttr('locals {\n  xs = ["a"]\n}', "xs")).toEqual(["a"]);
  });

  // Would still pass on: a bare substring match. `log_group_services` must not
  // be found by a reader asked for `group_services`.
  it("does not match a key that is a suffix of another key", () => {
    expect(
      stringListAttr('locals { log_group_services = ["a"] }', "group_services"),
    ).toBeNull();
  });
});

describe("inspect", () => {
  const good = {
    monitoring: `
locals {
  docker_event_format = "container_start container={{.Actor.Attributes.name}}"
}
resource "aws_ssm_parameter" "cloudwatch_agent_config" {
  value = jsonencode({
    logs = { logs_collected = { files = { collect_list = [{
      log_group_name  = "/oxagen-app/docker-events"
    }] } } }
  })
}
`,
    alarms: `
resource "aws_cloudwatch_log_metric_filter" "container_starts" {
  name           = "oxagen-container-starts"
  log_group_name = aws_cloudwatch_log_group.service["docker-events"].name
  pattern = "container_start"
  metric_transformation {
    name      = "ContainerStarts"
    namespace = "Oxagen/Node"
  }
}
resource "aws_cloudwatch_metric_alarm" "container_restart_loop" {
  alarm_description   = "more than 5 container starts in each of three consecutive 5-minute periods"
  namespace           = "Oxagen/Node"
  metric_name         = "ContainerStarts"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
}
`,
    observability: `locals { log_group_services = ["app", "worker", "docker-events"] }`,
  };

  it("passes when every link agrees", () => {
    expect(inspect(good)).toEqual([]);
  });

  it("resolves the module log prefix and catches a production node rename", () => {
    const parameterized = {
      ...good,
      monitoring: good.monitoring.replace(
        "/oxagen-app/docker-events",
        "/${var.name}/docker-events",
      ),
    };
    expect(inspect({ ...parameterized, appName: "oxagen-app" })).toEqual([]);
    expect(
      inspect({ ...parameterized, appName: "renamed-app" }).join("\n"),
    ).toMatch(/watches a group nothing writes to/);
  });

  // Each case below is a real, plausible edit that leaves valid Terraform and a
  // plan with no diff worth questioning, and silently stops the alarm counting.
  it("catches the collector format losing the token the filter matches", () => {
    const broken = {
      ...good,
      monitoring: good.monitoring.replace(
        "container_start container=",
        "started container=",
      ),
    };
    expect(inspect(broken).join("\n")).toMatch(/no longer agree/);
  });

  it("catches the agent and the filter drifting onto different log groups", () => {
    const broken = {
      ...good,
      monitoring: good.monitoring.replace(
        "/oxagen-app/docker-events",
        "/oxagen-app/events",
      ),
    };
    expect(inspect(broken).join("\n")).toMatch(
      /watches a group nothing writes to/,
    );
  });

  it("catches the log group dropping out of the stack's own list", () => {
    const broken = {
      ...good,
      observability: `locals { log_group_services = ["app", "worker"] }`,
    };
    expect(inspect(broken).join("\n")).toMatch(
      /no retention policy, no tags and no archive/,
    );
  });

  it("catches the alarm reading a metric the filter does not publish", () => {
    const broken = {
      ...good,
      alarms: good.alarms.replace(
        'metric_name         = "ContainerStarts"',
        'metric_name         = "ContainerRestarts"',
      ),
    };
    expect(inspect(broken).join("\n")).toMatch(/a metric nobody publishes/);
  });

  it("catches either resource being deleted outright", () => {
    expect(inspect({ ...good, alarms: "" }).join("\n")).toMatch(
      /container_starts is gone/,
    );
    expect(inspect({ ...good, alarms: "" }).join("\n")).toMatch(
      /container_restart_loop is gone/,
    );
  });

  // Would still pass on: an alarm whose threshold is 5 but whose
  // evaluation_periods is 1 — hence the deploy case below as well. These two
  // are the pair; either alone is satisfiable by a useless alarm.
  it("catches a threshold raised past the incident it was written for", () => {
    const broken = {
      ...good,
      alarms: good.alarms.replace(
        "threshold           = 5",
        "threshold           = 200",
      ),
    };
    expect(inspect(broken).join("\n")).toMatch(
      /would NOT have fired during #2813/,
    );
  });

  it("catches a threshold lowered until an ordinary deploy pages", () => {
    const broken = {
      ...good,
      alarms: good.alarms
        .replace("threshold           = 5", "threshold           = 1")
        .replace("evaluation_periods  = 3", "evaluation_periods  = 1")
        .replace("datapoints_to_alarm = 3", "datapoints_to_alarm = 1"),
    };
    expect(inspect(broken).join("\n")).toMatch(/fires on an ordinary deploy/);
  });

  it("catches datapoints_to_alarm being dropped, which changes the alarm silently", () => {
    const broken = {
      ...good,
      alarms: good.alarms.replace("datapoints_to_alarm = 3\n", ""),
    };
    expect(inspect(broken).join("\n")).toMatch(/missing datapointsToAlarm/);
  });

  // The DoD for #2813 asks for the threshold to be stated in the alarm's own
  // description, because that is the text a person is woken up by.
  // Would still pass on: a bare `description.includes("5")` — the surviving
  // text is "too many container starts in each of three consecutive 5-minute
  // periods", which contains the digit 5 as part of the PERIOD. That is the
  // exact way a description can stop stating its threshold while a naive check
  // stays green, so the replacement deliberately leaves the 5-minute in place.
  it("catches a description that no longer states the threshold", () => {
    const broken = {
      ...good,
      alarms: good.alarms.replace(
        "more than 5 container starts",
        "too many container starts",
      ),
    };
    expect(broken.alarms).toContain("5-minute");
    expect(inspect(broken).join("\n")).toMatch(/does not state its threshold/);
  });

  it("reports every broken link at once rather than the first", () => {
    const broken = {
      monitoring: "",
      alarms: "",
      observability: "",
    };
    expect(inspect(broken).length).toBeGreaterThan(3);
  });
});

describe("the repository's own infrastructure", () => {
  // Would still pass on: nothing. This is the assertion the check exists for —
  // the other tests prove the checker can tell good from bad, this one asks it
  // about the files that are actually deployed.
  it("has an intact collector -> log group -> metric filter -> alarm chain", () => {
    expect(run()).toEqual([]);
  });

  it("agrees with the incident's recorded rate and the estate's size", () => {
    expect(INCIDENT_STARTS_PER_MINUTE).toBe(14);
    expect(FULL_ESTATE_DEPLOY_STARTS).toBe(9);
  });
});
