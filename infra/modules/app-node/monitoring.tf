/**
 * Disk and memory metrics for this node.
 *
 * EC2 reports CPU, network and status checks from outside the instance. It
 * cannot see how full a disk is. On 2026-09-09 the root volume reached 87%
 * an hour after a replacement and deploys began refusing to unpack, while
 * every metric AWS offers on its own read healthy. The CloudWatch agent is
 * the only thing that can report the number, so it is installed and
 * configured here, and stacks-new/oxagen/alarms.tf alarms on it.
 *
 * Installed by SSM State Manager rather than by user data. A user-data change
 * replaces the instance, and adding a metric must not cost an outage. The
 * association below targets the node by its Name tag, runs when it is
 * created, once a day after that, and again on any new instance that carries
 * the tag — so a replaced node gets the agent without anyone remembering to
 * add it.
 *
 * Install and configure are one command on purpose. As two associations they
 * race: State Manager runs both at once on a new instance, the configure
 * step fails because the package is not there yet, and the retry is a day
 * away. One command orders them.
 */

resource "aws_ssm_parameter" "cloudwatch_agent_config" {
  name        = "AmazonCloudWatch-${var.name}"
  description = "CloudWatch agent configuration for ${var.name}: disk and memory use."
  type        = "String"
  tags        = local.tags

  # `drop_device` leaves the metric keyed by InstanceId, path and fstype, which
  # is what the alarm names. With the device kept, an alarm would have to know
  # the NVMe device name, which changes between instance types.
  value = jsonencode({
    agent = { metrics_collection_interval = 60 }
    metrics = {
      namespace         = "CWAgent"
      append_dimensions = { InstanceId = "$${aws:InstanceId}" }
      metrics_collected = {
        disk = {
          measurement                 = ["used_percent"]
          resources                   = ["/", "/data"]
          drop_device                 = true
          metrics_collection_interval = 60
        }
        mem = {
          measurement                 = ["used_percent"]
          metrics_collection_interval = 60
        }
      }
    }
  })
}

resource "aws_ssm_association" "cloudwatch_agent" {
  name             = "AWS-RunShellScript"
  association_name = "${var.name}-cloudwatch-agent"

  # Amazon Linux 2023 carries the agent in its own package repository, so the
  # install is a dnf call rather than a download. Both halves are safe to run
  # again: dnf does nothing when the package is present, and fetch-config
  # re-reads the parameter above and restarts the agent.
  parameters = {
    commands = "dnf -y -q install amazon-cloudwatch-agent && /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c ssm:${aws_ssm_parameter.cloudwatch_agent_config.name}"
  }

  targets {
    key    = "tag:Name"
    values = [var.name]
  }

  schedule_expression = "rate(1 day)"
  compliance_severity = "MEDIUM"
}
