/**
 * Hourly snapshots of Neo4j's data volume. Same mechanism as the old
 * account's data-node — Data Lifecycle Manager rather than a cron job on the
 * instance, because a backup that runs on the machine it is backing up stops
 * running at exactly the moment it is needed — but a tighter schedule.
 *
 * This is the one store in the new account that cannot cheaply approach the
 * "restore within a minute of a crash" target: Aurora and Redshift both do
 * that natively as a byproduct of being managed services, but Neo4j here is
 * self-hosted with no built-in continuous-backup path, and building one
 * (streaming its transaction log to S3) is disproportionate effort for a
 * pre-launch graph store. Hourly EBS snapshots are the accepted fallback —
 * up to an hour of graph writes lost on a worst-case crash, not a day.
 */

data "aws_iam_policy_document" "dlm_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["dlm.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dlm" {
  name               = "${var.name}-dlm"
  assume_role_policy = data.aws_iam_policy_document.dlm_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "neo4j_data" {
  description        = "${var.name} hourly neo4j data volume snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    target_tags = {
      Name = "${var.name}-neo4j-data"
    }

    schedule {
      name = "hourly"

      # `times` (a specific time of day) only applies to a 24-hour interval;
      # an hourly schedule fires on the hour without one.
      create_rule {
        interval      = 1
        interval_unit = "HOURS"
      }

      # backup_retention_days is in calendar days; DLM counts snapshots, so
      # an hourly schedule needs 24x the count to cover the same window.
      retain_rule {
        count = var.backup_retention_days * 24
      }

      tags_to_add = merge(local.tags, {
        SnapshotOf = "${var.name}-neo4j-data"
      })

      copy_tags = true
    }
  }

  tags = local.tags
}
