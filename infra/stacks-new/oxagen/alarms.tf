/**
 * Alarms — the half of observability that reaches a person.
 *
 * Before this file the account had none. Not "too few": `describe-alarms`
 * returned an empty list, and nothing in this stack created one. Logs were
 * archived to S3, parsed by a Lambda, and published to an EventBridge bus
 * that had no rule and no target on it, so every incident event was
 * discarded on arrival.
 *
 * What that cost, concretely. On 2026-09-08 an app-node replacement brought
 * the box back without the platform's six services on it. Five hostnames
 * served 503 for two hours. `HTTPCode_Target_5XX_Count` was climbing the
 * whole time, and it was already drawn on the dashboard in dashboard.tf —
 * the signal existed, on a panel nobody was looking at, with nothing behind
 * it that could interrupt anyone.
 *
 * So the alarms here are chosen by what has actually failed, not by what is
 * conventional to alarm on:
 *
 *   - the target returns 5xx while passing its health check  (2026-09-08)
 *   - the ALB has no healthy target at all
 *   - the instance itself fails its status checks
 *   - Aurora saturates
 *
 * Each one names the failure it is for. An alarm nobody can act on is a page
 * that teaches people to ignore pages.
 */

# ---------------------------------------------------------------------------
# Where an alarm goes
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "oxagen-alerts"
  tags = { Brand = local.brand }
}

# Deliberately optional, and deliberately not defaulted to anybody's address.
# An estate with alarms and no subscriber is still better than one with
# neither — the alarms show state in the console, drive the dashboard, and
# start recording history the moment they exist. But nothing pages until this
# is set, so `alert_email` in terraform.tfvars is the line that turns this
# from a record into a notification.
resource "aws_sns_topic_subscription" "alerts_email" {
  count = var.alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# The incidents bus had no consumer, so the Lambda parsing error lines out of
# CloudWatch was publishing into nothing. This is the missing target.
resource "aws_cloudwatch_event_rule" "incidents_to_alerts" {
  name           = "oxagen-incidents-to-alerts"
  event_bus_name = aws_cloudwatch_event_bus.incidents.name
  description    = "Everything on the incidents bus, forwarded to the alert topic."

  # Matches every event on this bus rather than filtering by detail-type. The
  # bus exists only for incidents, so a filter here would be a second place to
  # keep a list of what counts as one — and the Lambda already made that
  # decision when it chose to publish.
  event_pattern = jsonencode({
    account = [var.account_id]
  })

  tags = { Brand = local.brand }
}

resource "aws_cloudwatch_event_target" "incidents_to_alerts" {
  rule           = aws_cloudwatch_event_rule.incidents_to_alerts.name
  event_bus_name = aws_cloudwatch_event_bus.incidents.name
  arn            = aws_sns_topic.alerts.arn
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid     = "AlarmsPublish"
    actions = ["SNS:Publish"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }
    resources = [aws_sns_topic.alerts.arn]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceOwner"
      values   = [var.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

# ---------------------------------------------------------------------------
# The alarms
# ---------------------------------------------------------------------------

# THE 2026-09-08 ALARM. The target group was healthy the whole outage,
# because user data brings up a placeholder Caddy that answers /healthz 200
# and 503s everything else. A health check cannot see that; this can, because
# it counts what the target actually returned to real requests.
#
# #2782 also stops the placeholder answering /healthz, so that failure is
# caught twice now — once at the health check and once here. Two independent
# detections of one failure is the point, not duplication: the health check
# knows what one path returns, this knows what users got.
resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name        = "oxagen-target-5xx"
  alarm_description = "The app node is answering requests with 5xx. On 2026-09-08 this shape was the node coming back from a replacement with no services on it, passing its health check the whole time."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  statistic   = "Sum"
  dimensions  = { LoadBalancer = aws_lb.app.arn_suffix }

  period              = 60
  evaluation_periods  = 3
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # Three minutes of sustained errors, not one bad minute: a deploy restarts
  # containers and a handful of 5xx during the swap is normal. Two hours is
  # the thing being prevented, so minutes of delay cost nothing and a page on
  # every deploy would get this muted within a week.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = { Brand = local.brand }
}

# The ALB answering 5xx itself, which is a different failure: it means no
# healthy target was available to route to at all, so nothing downstream even
# saw the request.
resource "aws_cloudwatch_metric_alarm" "elb_5xx" {
  alarm_name        = "oxagen-elb-5xx"
  alarm_description = "The load balancer is answering 5xx without reaching a target — no healthy target to route to."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_ELB_5XX_Count"
  statistic   = "Sum"
  dimensions  = { LoadBalancer = aws_lb.app.arn_suffix }

  period              = 60
  evaluation_periods  = 2
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = { Brand = local.brand }
}

# One node, so "fewer than one healthy host" is the whole story. Missing data
# is BREACHING here, unlike the counters above: the ALB reports this metric
# continuously, so its absence means the load balancer has stopped answering
# for the target group, and reading that as "fine" is how a monitoring gap
# looks from the inside.
resource "aws_cloudwatch_metric_alarm" "no_healthy_host" {
  alarm_name        = "oxagen-no-healthy-host"
  alarm_description = "The target group has no healthy node. Every hostname behind the ALB is down."

  namespace   = "AWS/ApplicationELB"
  metric_name = "HealthyHostCount"
  statistic   = "Minimum"
  dimensions = {
    LoadBalancer = aws_lb.app.arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }

  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = { Brand = local.brand }
}

# Below the ALB: the instance is gone or wedged, which the two above would
# also catch but later and less clearly. This one says which layer to look at.
resource "aws_cloudwatch_metric_alarm" "node_status_check" {
  alarm_name        = "oxagen-node-status-check"
  alarm_description = "The app node is failing EC2 status checks — the instance or its host, not the application."

  namespace   = "AWS/EC2"
  metric_name = "StatusCheckFailed"
  statistic   = "Maximum"
  dimensions  = { InstanceId = module.app.instance_id }

  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = { Brand = local.brand }
}

# Aurora scales to zero ACUs when idle, so CPU is measured against whatever
# capacity it has scaled to rather than against a fixed box. Sustained
# saturation at the ceiling means the max_capacity of 2 is the binding
# constraint, which is a decision to revisit rather than an incident.
resource "aws_cloudwatch_metric_alarm" "aurora_cpu" {
  alarm_name        = "oxagen-aurora-cpu"
  alarm_description = "Aurora is saturated at its scaling ceiling. Not an outage on its own — read it as max_capacity being the limit."

  namespace   = "AWS/RDS"
  metric_name = "CPUUtilization"
  statistic   = "Average"
  dimensions  = { DBClusterIdentifier = aws_rds_cluster.postgres.cluster_identifier }

  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  tags          = { Brand = local.brand }
}

# A full disk is the failure none of the alarms above can see. EC2 measures
# the instance from outside; a root volume at 100% passes every status check
# and keeps serving, and the only thing that breaks is the next deploy, which
# fails on the node with no output at all. That is how deploys died for days
# in August and how the node refilled to 87% within an hour of its 2026-09-09
# replacement. The CloudWatch agent (modules/app-node/monitoring.tf) reports
# the number; this reads it.
#
# 80% is chosen against what needs the room: deploy-service.sh refuses to
# unpack with under 3 GB free, and on the 40 GB root disk 80% leaves 8 GB.
# Missing data is BREACHING because the agent is the only source, so no
# metric means no agent, and that is the state a replacement leaves the node
# in until State Manager has run.
resource "aws_cloudwatch_metric_alarm" "node_disk" {
  for_each = {
    root = "/"
    data = "/data"
  }

  alarm_name        = "oxagen-node-disk-${each.key}"
  alarm_description = "The app node's ${each.value} filesystem is over 80% full. Under 3 GB free and deploys refuse to unpack; at 100% SSM stops executing and the box cannot be reached to fix it."

  namespace   = "CWAgent"
  metric_name = "disk_used_percent"
  statistic   = "Maximum"
  dimensions = {
    InstanceId = module.app.instance_id
    path       = each.value
    fstype     = "xfs"
  }

  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
  tags          = { Brand = local.brand }
}
