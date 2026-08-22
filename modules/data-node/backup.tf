/**
 * Daily snapshots of the data volume.
 *
 * This is the whole disaster-recovery story for a single-instance database,
 * and it is deliberately the cheapest thing that actually recovers: EBS
 * snapshots are incremental, so after the first one only changed blocks are
 * stored, and a week of dailies on a mostly-idle 50 GB volume costs a couple
 * of dollars a month.
 *
 * Data Lifecycle Manager rather than a cron job on the instance: a backup that
 * runs on the machine it is backing up stops running at exactly the moment it
 * is needed.
 *
 * What this does not give you is point-in-time recovery — a snapshot is a
 * crash-consistent image of the volume, so restoring loses up to a day and the
 * engines replay their write-ahead logs on start. That is the trade a managed
 * database would remove, at the price floor documented in main.tf.
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

resource "aws_dlm_lifecycle_policy" "data" {
  # Plain ASCII, no punctuation beyond spaces and hyphens: DLM validates this
  # field against a narrow character class and rejects anything else, including
  # the em dash the rest of this repository's descriptions use.
  description        = "${var.name} daily data volume snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]

    # Targets the volume by tag rather than by id, so a replaced volume of the
    # same name is picked up without editing this policy — the case where
    # someone restores from a snapshot and forgets to re-point the backups.
    target_tags = {
      Name = "${var.name}-data"
    }

    schedule {
      name = "daily"

      create_rule {
        # 07:00 UTC — outside US working hours, so the brief I/O pause of
        # snapshot initiation lands when nothing is querying.
        interval      = 24
        interval_unit = "HOURS"
        times         = ["07:00"]
      }

      retain_rule {
        count = var.backup_retention_days
      }

      # Tags on the snapshot itself, so a snapshot is attributable to its brand
      # in the bill and findable in the console alongside everything else the
      # brand owns.
      tags_to_add = merge(local.tags, {
        SnapshotOf = "${var.name}-data"
      })

      copy_tags = true
    }
  }

  tags = local.tags
}
