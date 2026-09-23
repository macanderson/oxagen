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
  description = "CloudWatch agent configuration for ${var.name}: disk and memory use, and the container start log the crash-loop alarm counts."
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
    # The docker-events collector below writes container start lines to this
    # file; the agent is what carries them off the box. No `timestamp_format`
    # on purpose — with none set the agent stamps each line at ingestion, which
    # is what the alarm's five-minute periods are counting anyway, and a
    # timestamp_format that did not match the line would silently backdate every
    # datapoint into a period the alarm has already evaluated.
    logs = {
      logs_collected = {
        files = {
          collect_list = [{
            file_path       = local.docker_events_log_path
            log_group_name  = "/${var.name}/docker-events"
            log_stream_name = "docker-events"
          }]
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

/**
 * Container restarts, so that a crash loop is something a person hears about.
 *
 * The incident (#2813): a leftover `oxagen-worker` container, a survivor of the
 * architecture ADR-043 removed, ran under `--restart unless-stopped` against a
 * query for a column the schema no longer has. It died and was restarted about
 * fourteen times a minute, continuously, for two days. Every alarm in
 * stacks-new/oxagen/alarms.tf stayed OK throughout, because none of them watch
 * containers: the ALB saw healthy targets, the node's CPU, memory and disk were
 * ordinary, and the container listened on loopback only, so no health check
 * touched it. It was found by hand, while investigating something unrelated.
 *
 * Nothing on this node publishes a restart count, and the obvious filter is the
 * wrong one. A restart-policy restart is NOT `docker events --filter
 * event=restart` — that event is emitted only for an explicit `docker restart`.
 * A policy restart emits `die` then `start`. So `start` is the event that
 * counts, and a healthy container emits exactly one of them per deploy.
 *
 * Installed by SSM State Manager rather than user data, for the same reason the
 * agent above is: a user-data change replaces the instance, and adding a metric
 * must not cost an outage. Same shape — targeted by Name tag, run on create,
 * once a day after that, and again on any replacement node that carries the tag.
 *
 * The unit is rewritten only when its content changed, so the daily re-run is a
 * no-op rather than a restart that drops events into the gap it leaves.
 */

locals {
  docker_events_log_path = "/var/log/oxagen-docker-events.log"

  # The line the collector appends per container start. `container_start` is the
  # token `aws_cloudwatch_log_metric_filter.container_starts` matches on; the
  # rest is for whoever reads the group after the alarm fires and needs to know
  # WHICH container is looping. The two are checked against each other by
  # tools/scripts/check-restart-alarm.mjs, because a change to this format that
  # dropped the token would leave the alarm permanently OK with nothing to say
  # it had stopped counting.
  docker_event_format = "container_start container={{.Actor.Attributes.name}} image={{.Actor.Attributes.image}}"

  docker_events_unit = <<-UNIT
    [Unit]
    Description=Record Docker container start events for the crash-loop alarm (#2813)
    After=docker.service
    Requires=docker.service

    [Service]
    ExecStart=/bin/sh -c 'exec docker events --filter type=container --filter event=start --format "${local.docker_event_format}" >> ${local.docker_events_log_path}'
    Restart=always
    RestartSec=10

    [Install]
    WantedBy=multi-user.target
  UNIT

  # copytruncate, not create: the collector and the CloudWatch agent both hold
  # this file open, and a rename would leave one writing to, and the other
  # tailing, an unlinked inode until something restarted them.
  docker_events_logrotate = <<-ROTATE
    ${local.docker_events_log_path} {
      daily
      rotate 3
      maxsize 20M
      missingok
      notifempty
      copytruncate
    }
  ROTATE
}

# Both files travel as base64 rather than as heredocs inside the command. The
# command is already a Terraform heredoc, and nesting a shell heredoc inside one
# makes the file's content depend on Terraform's dedent rule agreeing with the
# shell's terminator rule — two whitespace-sensitive parsers over the same
# bytes, where a wrong guess produces a systemd unit that is subtly malformed
# rather than an error anyone sees. base64 has no such interaction.
resource "aws_ssm_association" "docker_events" {
  name             = "AWS-RunShellScript"
  association_name = "${var.name}-docker-events"

  parameters = {
    commands = <<-SCRIPT
      set -eu
      unit=$(mktemp)
      printf '%s' '${base64encode(local.docker_events_unit)}' | base64 -d > "$unit"
      if cmp -s "$unit" /etc/systemd/system/oxagen-docker-events.service; then
        rm -f "$unit"
      else
        mv "$unit" /etc/systemd/system/oxagen-docker-events.service
        systemctl daemon-reload
        systemctl restart oxagen-docker-events.service || true
      fi
      printf '%s' '${base64encode(local.docker_events_logrotate)}' | base64 -d > /etc/logrotate.d/oxagen-docker-events
      systemctl enable --now oxagen-docker-events.service
    SCRIPT
  }

  targets {
    key    = "tag:Name"
    values = [var.name]
  }

  schedule_expression = "rate(1 day)"
  compliance_severity = "MEDIUM"
}
