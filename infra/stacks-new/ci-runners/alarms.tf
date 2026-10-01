/**
 * Alarms, the budget, and cost tagging (ADR-246, decision 9).
 *
 * Every alarm names one failure and goes to one SNS topic that emails
 * var.alarm_email. The runbook (docs/runbooks/ci-runners.md) says what each
 * alarm means and what to do.
 *
 * - Queue age: a pool's queue holds a job older than two minutes for five
 *   minutes. Jobs are waiting and no runner is starting for them.
 * - Dead letters: a job event failed scale-up three times and left the queue.
 *   That job will not get a runner from this pool.
 * - Scale-up errors: the scale-up Lambda threw. Usually EC2 capacity, a quota,
 *   or the GitHub App's credentials.
 * - Webhook errors: GitHub's events are not reaching the queues. Every pool
 *   stops scaling.
 * - Image build failed: an EventBridge rule, because Image Builder reports a
 *   failed build as an event. Runners keep the previous image.
 */

resource "aws_sns_topic" "alarms" {
  name = "oxagen-ci-runners-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  all_pools = concat(keys(local.pools), ["oxagen-deploy"])
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = toset(local.all_pools)

  alarm_name          = "ci-runners-${each.key}-queue-age"
  alarm_description   = "Jobs for ${each.key} have waited over 2 minutes for 5 minutes. See docs/runbooks/ci-runners.md."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = "ci-${each.key}-queued-builds" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 120
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  depends_on = [module.runners]
}

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  for_each = toset(local.all_pools)

  alarm_name          = "ci-runners-${each.key}-dead-letters"
  alarm_description   = "A ${each.key} job failed scale-up 3 times and was dropped. See docs/runbooks/ci-runners.md."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = "ci-${each.key}-queued-builds_dead_letter" }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  depends_on = [module.runners]
}

resource "aws_cloudwatch_metric_alarm" "scale_up_errors" {
  for_each = toset(local.all_pools)

  alarm_name          = "ci-runners-${each.key}-scale-up-errors"
  alarm_description   = "The ${each.key} scale-up Lambda failed 3 or more times in 5 minutes. See docs/runbooks/ci-runners.md."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = module.runners.runners_map[each.key].lambda_up.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "webhook_errors" {
  alarm_name          = "ci-runners-webhook-errors"
  alarm_description   = "The webhook Lambda failed 3 or more times in 5 minutes, so no pool is scaling. See docs/runbooks/ci-runners.md."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = module.runners.webhook.lambda.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "webhook_5xx" {
  alarm_name          = "ci-runners-webhook-5xx"
  alarm_description   = "The webhook answered GitHub with 5xx 3 or more times in 5 minutes. See docs/runbooks/ci-runners.md."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = module.runners.webhook.gateway.id, Stage = "$default" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# Image Builder reports a failed build as an event, not a metric, so a rule
# forwards the event to the alarm topic.
resource "aws_cloudwatch_event_rule" "image_build_failed" {
  name        = "ci-runners-image-build-failed"
  description = "A CI runner image failed to build, so runners stay on the previous image. See docs/runbooks/ci-runners.md."

  event_pattern = jsonencode({
    source        = ["aws.imagebuilder"]
    "detail-type" = ["EC2 Image Builder Image State Change"]
    detail        = { state = { status = ["FAILED"] } }
    resources     = [{ prefix = "arn:aws:imagebuilder:${var.region}:${var.account_id}:image/oxagen-ci-runner-" }]
  })
}

resource "aws_cloudwatch_event_target" "image_build_failed" {
  rule = aws_cloudwatch_event_rule.image_build_failed.name
  arn  = aws_sns_topic.alarms.arn
}

data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid       = "CloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }

  statement {
    sid       = "ImageBuildEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.image_build_failed.arn]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------

# Cost Explorer filters by a tag only once the tag is activated for cost
# allocation. The Stack tag was in use and inactive on 2026-10-01.
resource "aws_ce_cost_allocation_tag" "stack" {
  tag_key = "Stack"
  status  = "Active"
}

resource "aws_budgets_budget" "ci_runners" {
  name         = "ci-runners-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Stack$platform/ci-runners"]
  }

  dynamic "notification" {
    for_each = {
      actual-80    = { type = "ACTUAL", threshold = 80 }
      actual-100   = { type = "ACTUAL", threshold = 100 }
      forecast-100 = { type = "FORECASTED", threshold = 100 }
    }

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = [var.alarm_email]
    }
  }

  depends_on = [aws_ce_cost_allocation_tag.stack]
}
