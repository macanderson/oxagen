/**
 * Oxagen's three data engines on one small ARM instance: PostgreSQL with
 * pgvector, Neo4j for Cypher and graph-native vector indexes, and ClickHouse
 * for analytics.
 *
 * ## Why one box rather than three managed services
 *
 * The managed equivalents have a floor that does not move with usage, and at
 * this stage — no live customers — that floor is the entire bill:
 *
 *   Aurora Serverless v2      ~$0 idle at 0 ACU, but storage and I/O still bill
 *   Neptune Serverless        ~$117/month minimum; 1 NCU is the floor and it
 *                             does not scale to zero, so an idle graph costs
 *                             the same as a busy one
 *   ClickHouse Cloud          ~$25/month minimum
 *                             ------
 *                             ~$150/month before a single query
 *
 * One `t4g.medium` with a 50 GB volume is roughly $29/month for all three,
 * and Neptune's price floor alone is four times that. The tradeoff is real and
 * is not hidden: this is a single instance in a single AZ with no automatic
 * failover, so it trades availability for an order of magnitude in cost. That
 * is the correct trade for a pre-customer platform and the wrong one the day
 * real traffic depends on it — at which point Postgres moves to Aurora and
 * this file's job is to have kept the schema portable until then.
 *
 * ## Sizing
 *
 * 4 GiB is the honest minimum for these three together: ClickHouse alone wants
 * that much on its own, and Neo4j's page cache plus heap is another gigabyte
 * before any data. `t4g.small` at half the price is offered as a variable, but
 * it OOM-kills ClickHouse under load, and a database that dies is not cheaper
 * than one that runs.
 *
 * ## Access
 *
 * Nothing is reachable from the internet. The security group opens no inbound
 * port at all and there is no SSH key; administration is via SSM Session
 * Manager, and a client reaches a database by port-forwarding through it.
 * That removes the whole class of "exposed database" incidents, and costs
 * nothing — where a private subnet would have needed a NAT gateway at
 * ~$32/month, more than the instance it served.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  tags = merge(var.tags, {
    Service = var.name
  })
}

# Amazon Linux 2023 on ARM: the SSM agent is preinstalled, which is what makes
# the no-inbound-ports design work without any bootstrap of its own.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

# Generated here and never printed. They land in SSM Parameter Store, which is
# free at the standard tier, rather than Secrets Manager, which bills $0.40 per
# secret per month — three secrets there would cost more than a tenth of the
# instance they protect.
resource "random_password" "postgres" {
  length  = 32
  special = false # avoids quoting hazards in connection URLs and compose files
}

resource "random_password" "neo4j" {
  length  = 32
  special = false
}

resource "random_password" "clickhouse" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "postgres" {
  name        = "/${var.name}/postgres/password"
  description = "PostgreSQL superuser password for ${var.name}"
  type        = "SecureString"
  value       = random_password.postgres.result
  tags        = local.tags
}

resource "aws_ssm_parameter" "neo4j" {
  name        = "/${var.name}/neo4j/password"
  description = "Neo4j password for ${var.name}"
  type        = "SecureString"
  value       = random_password.neo4j.result
  tags        = local.tags
}

resource "aws_ssm_parameter" "clickhouse" {
  name        = "/${var.name}/clickhouse/password"
  description = "ClickHouse default-user password for ${var.name}"
  type        = "SecureString"
  value       = random_password.clickhouse.result
  tags        = local.tags
}

# ---------------------------------------------------------------------------
# Identity and network
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

# Session Manager, which is what replaces SSH here.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The instance reads its own passwords at boot to compose the containers. It is
# scoped to this service's own parameter prefix, so a compromise of the box
# does not enumerate every secret in the account.
data "aws_iam_policy_document" "secrets" {
  statement {
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter/${var.name}/*"]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${var.name}-read-own-secrets"
  role   = aws_iam_role.node.id
  policy = data.aws_iam_policy_document.secrets.json
}

resource "aws_iam_instance_profile" "node" {
  name = "${var.name}-node"
  role = aws_iam_role.node.name
  tags = local.tags
}

# No ingress rules at all — deliberately. Every database port is reached by
# port-forwarding over SSM, which runs outbound over the agent's existing
# channel. An empty ingress block is the security control, not an oversight.
resource "aws_security_group" "node" {
  name = "${var.name}-node"
  # ASCII only: EC2 rejects a group description containing anything else, so
  # the em dash used elsewhere in this repository cannot appear here.
  description = "${var.name} data node - egress only, all access via SSM"
  vpc_id      = var.vpc_id

  egress {
    description      = "Container images, package updates, and the SSM channel"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

# Data lives on its own volume so the instance stays disposable: the AMI can be
# replaced, the instance type changed, or the box rebuilt, without the
# databases being part of that blast radius.
#
# Left at gp3's baseline 3,000 IOPS and 125 MB/s, which are included in the
# per-GB price. Provisioning beyond the baseline is billed separately and was
# already costing this account ~$91/month on volumes attached to stopped
# instances — worth remembering before raising either number here.
resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_size
  type              = "gp3"
  encrypted         = true

  tags = merge(local.tags, { Name = "${var.name}-data" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.node.id

  # Without this, destroying the instance forcibly detaches a mounted
  # filesystem, which is how a volume comes back needing repair.
  stop_instance_before_detaching = true
}

# ---------------------------------------------------------------------------
# Instance
# ---------------------------------------------------------------------------

resource "aws_instance" "node" {
  ami                  = data.aws_ssm_parameter.al2023.value
  instance_type        = var.instance_type
  subnet_id            = var.subnet_id
  iam_instance_profile = aws_iam_instance_profile.node.name

  vpc_security_group_ids = [aws_security_group.node.id]

  # A public address, not a NAT gateway. The instance needs outbound reach for
  # container images and updates; a NAT gateway would provide that at ~$32 a
  # month plus data processing, against ~$3.60 for the address. Nothing can
  # connect inbound regardless, because the security group permits nothing.
  associate_public_ip_address = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  # IMDSv2 required: the v1 endpoint is reachable by anything that can make the
  # instance issue an HTTP request, which is how SSRF becomes credential theft.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    name             = var.name
    region           = var.region
    postgres_version = var.postgres_version
    neo4j_version    = var.neo4j_version
    clickhouse_image = var.clickhouse_image
  })

  # The bootstrap is keyed on user_data, so editing it rebuilds the instance.
  # That is safe precisely because the data lives on a separate volume.
  user_data_replace_on_change = true

  tags = merge(local.tags, { Name = var.name })
}
