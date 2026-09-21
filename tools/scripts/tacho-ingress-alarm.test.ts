import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateAlarm,
  resourceBlock,
  nestedBlock,
  numberAttr,
  stringAttr,
} from "./check-restart-alarm.mjs";

const source = readFileSync(
  new URL("../../infra/stacks-new/oxagen/alarms.tf", import.meta.url),
  "utf8",
);
const filter = resourceBlock(
  source,
  "aws_cloudwatch_log_metric_filter",
  "tacho_ingress_5xx",
);
const alarm = resourceBlock(
  source,
  "aws_cloudwatch_metric_alarm",
  "tacho_ingress_5xx",
);

describe("Tacho intake alert", () => {
  it("binds the API request stream to the alarm's metric", () => {
    expect(filter).toBeTruthy();
    expect(alarm).toBeTruthy();
    expect(filter).toContain('aws_cloudwatch_log_group.service["api"].name');
    // AWS logs test-metric-filter accepted this pattern and matched only the
    // Tacho 500/503 cases, excluding Tacho 200/429 and unrelated API 503s.
    expect(JSON.parse(`"${stringAttr(filter!, "pattern")}"`)).toBe(
      '{ $.msg = "request" && $.path = "/v1/tacho/*" && $.status >= 500 && $.status < 600 }',
    );
    const metric = nestedBlock(filter!, "metric_transformation")!;
    expect(stringAttr(metric, "name")).toBe(stringAttr(alarm!, "metric_name"));
    expect(stringAttr(metric, "namespace")).toBe(
      stringAttr(alarm!, "namespace"),
    );
    expect(stringAttr(metric, "default_value")).toBe("0");
    expect(stringAttr(alarm!, "treat_missing_data")).toBe("notBreaching");
    expect(alarm).toContain("alarm_actions = [aws_sns_topic.alerts.arn]");
  });

  it("detects a sustained outage while ignoring a deploy burst", () => {
    const spec = {
      threshold: numberAttr(alarm!, "threshold")!,
      comparisonOperator: stringAttr(alarm!, "comparison_operator")!,
      evaluationPeriods: numberAttr(alarm!, "evaluation_periods")!,
      datapointsToAlarm: numberAttr(alarm!, "datapoints_to_alarm")!,
    };
    expect(numberAttr(alarm!, "period")).toBe(300);
    expect(evaluateAlarm(spec, [1, 1, 1])).toBe("ALARM");
    expect(evaluateAlarm(spec, [300, 0, 0])).toBe("OK");
    expect(evaluateAlarm(spec, [0, 0, 0])).toBe("OK");
  });
});
