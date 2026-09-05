/**
 * The application node for the new account: Caddy, the platform's Node
 * processes, and Neo4j — on one small ARM instance, behind an ALB rather than
 * a public IP.
 *
 * This replaces the old account's `data-node` for two of its three engines.
 * Postgres moves to Aurora Serverless v2 and ClickHouse's role moves to
 * Redshift Serverless — both scale to near-zero cost when idle, so both are
 * genuinely cheaper managed than self-hosted at this traffic level. Neo4j
 * stays here: Amazon's only graph product with native vector search
 * (Neptune Analytics) has a real floor cost that does not reach zero even
 * paused, and Neo4j 5.11+ already gives this app vector indexes today. The
 * node therefore still carries one engine's worth of state, which is why it
 * is not fully disposable the way a pure web-tier instance would be — see
 * the EBS volume and its `prevent_destroy` below.
 *
 * ## Why a private subnet plus an ALB, where the old account used a public IP
 *
 * The old design put the node's own public IP on the internet and let Caddy
 * terminate TLS with a Let's Encrypt certificate over HTTP-01 — cheap, and
 * safe only because the security group opened nothing else. Putting the node
 * behind an ALB moves TLS termination to ACM (DNS-validated, auto-renewing,
 * no certbot cron) and removes the instance's public IP entirely: the ALB is
 * the only thing on the internet, the node's security group admits only the
 * ALB's, and there is no port 80 challenge listener to keep exposed.
 *
 * ## Access
 *
 * No SSH key. Administration is via SSM Session Manager. Neo4j's ports never
 * leave loopback, exactly as in the old account's data-node — reached by
 * SSM port-forward, never by a security group rule.
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
  tags = merge(var.tags, { Service = var.name })
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ---------------------------------------------------------------------------
# Neo4j credential
# ---------------------------------------------------------------------------

resource "random_password" "neo4j" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "neo4j" {
  name        = "/${var.name}/neo4j/password"
  description = "Neo4j password for ${var.name}"
  type        = "SecureString"
  value       = random_password.neo4j.result
  tags        = local.tags
}

# ---------------------------------------------------------------------------
# Identity
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

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The instance reads its own Neo4j password at boot. Scoped to this service's
# own parameter prefix, so a compromise of the box does not enumerate every
# secret in the account — the application config the node also reads lives
# under a different prefix, granted separately by stacks-new/ci-deploy.
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

# Every container on this node runs with `--log-driver=awslogs` (Caddy,
# Neo4j, and — via deploy-service.sh — every deployed service), so the
# instance role needs to create and write its own log streams. Scoped to
# `/oxagen-app/*` log groups specifically, the same prefix as its own SSM
# parameters, rather than `*`.
data "aws_iam_policy_document" "logs" {
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:/oxagen-app/*"]
  }
}

resource "aws_iam_role_policy" "logs" {
  name   = "${var.name}-write-own-logs"
  role   = aws_iam_role.node.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_instance_profile" "node" {
  name = "${var.name}-node"
  role = aws_iam_role.node.name
  tags = local.tags
}

# Inbound only from the ALB, on the port Caddy listens on. Nothing else can
# reach this instance, and this instance has no public IP to be reached at
# regardless.
resource "aws_security_group" "node" {
  name        = "${var.name}-node"
  description = "${var.name} app node - inbound from the ALB only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "HTTP from the ALB; the ALB terminates TLS"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  egress {
    description      = "Container images, package updates, Aurora/Redshift, the SSM channel"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = local.tags
}

# ---------------------------------------------------------------------------
# Neo4j's data volume
# ---------------------------------------------------------------------------

# Separate from the root disk so the instance stays disposable: replacing it
# (a new AMI, a different instance type) never touches the graph. See
# backup.tf for the daily snapshot this buys.
resource "aws_ebs_volume" "neo4j_data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_size
  type              = "gp3"
  encrypted         = true

  tags = merge(local.tags, { Name = "${var.name}-neo4j-data" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "neo4j_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.neo4j_data.id
  instance_id = aws_instance.node.id

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

  vpc_security_group_ids      = [aws_security_group.node.id]
  associate_public_ip_address = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    name          = var.name
    region        = var.region
    neo4j_version = var.neo4j_version
  })
  user_data_replace_on_change = true

  tags = merge(local.tags, { Name = var.name })
}
