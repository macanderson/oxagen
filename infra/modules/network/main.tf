/**
 * A small VPC for one private app node, Aurora, and Redshift Serverless,
 * behind one public ALB.
 *
 * Two public subnets and two private subnets — the ALB's minimum and, not
 * coincidentally, also the minimum a DB subnet group needs for Aurora and
 * Redshift Serverless, both of which refuse to provision across only one AZ.
 * The app node itself still lives in exactly one of the two; the second
 * exists for the data services' subnet groups, not for a second copy of the
 * node.
 *
 * A self-managed NAT instance instead of a NAT Gateway — see
 * `nat_instance_type` in variables.tf for the cost argument. The instance
 * runs one job: forward both private subnets' outbound traffic. It carries
 * no application state, so losing it is a `tofu apply` away from a
 * replacement, not an incident.
 *
 * VPC endpoints for S3/SSM were considered and left out: they trade ~$7/month
 * each for taking SSM and S3 traffic off the NAT path, and at this traffic
 * level the NAT instance is nowhere near its own limit. Revisit if the node's
 * outbound bill ever shows up as a real number.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  tags = merge(var.tags, { Component = "${var.name}-network" })

  public_cidrs = [
    cidrsubnet(var.vpc_cidr, 4, 0),
    cidrsubnet(var.vpc_cidr, 4, 1),
  ]
  private_cidrs = [
    cidrsubnet(var.vpc_cidr, 4, 8),
    cidrsubnet(var.vpc_cidr, 4, 9),
    cidrsubnet(var.vpc_cidr, 4, 10),
  ]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

# ---------------------------------------------------------------------------
# Subnets
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.tags, { Name = "${var.name}-public-${count.index}" })
}

resource "aws_subnet" "private" {
  count = 3

  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(local.tags, { Name = "${var.name}-private-${count.index}" })
}

# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-private" })
}

# Points at the NAT instance's primary ENI rather than an instance id: routing
# through the instance id works too, but the ENI is what survives if the
# instance is ever replaced by an ASG-managed self-healing setup later.
resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat.primary_network_interface_id
}

resource "aws_route_table_association" "private" {
  count = 3

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# NAT instance
# ---------------------------------------------------------------------------

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "nat" {
  name        = "${var.name}-nat"
  description = "${var.name} NAT instance - forwards the private subnet, nothing else"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "All traffic from either private subnet, to be forwarded"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = local.private_cidrs
  }

  egress {
    description      = "Forwarded traffic out to the internet"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = local.tags
}

data "aws_iam_policy_document" "nat_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "nat" {
  name               = "${var.name}-nat"
  assume_role_policy = data.aws_iam_policy_document.nat_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "nat_ssm" {
  role       = aws_iam_role.nat.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "nat" {
  name = "${var.name}-nat"
  role = aws_iam_role.nat.name
  tags = local.tags
}

resource "aws_instance" "nat" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.nat_instance_type
  subnet_id              = aws_subnet.public[0].id
  iam_instance_profile   = aws_iam_instance_profile.nat.name
  vpc_security_group_ids = [aws_security_group.nat.id]

  # The whole reason this instance can NAT at all: EC2 drops any packet whose
  # source doesn't match the instance's own address unless this is disabled.
  source_dest_check = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = <<-EOT
    #!/usr/bin/env bash
    set -euxo pipefail
    sysctl -w net.ipv4.ip_forward=1
    echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/90-nat.conf
    IFACE=$(ip route show default | awk '{print $5; exit}')
    dnf -y install iptables-services
    iptables -t nat -A POSTROUTING -o "$IFACE" -j MASQUERADE
    iptables-save > /etc/sysconfig/iptables
    systemctl enable --now iptables
  EOT

  root_block_device {
    volume_size = 8
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(local.tags, { Name = "${var.name}-nat" })
}

resource "aws_eip" "nat" {
  domain   = "vpc"
  instance = aws_instance.nat.id
  tags     = merge(local.tags, { Name = "${var.name}-nat" })

  depends_on = [aws_internet_gateway.this]
}
