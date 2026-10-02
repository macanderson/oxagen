/**
 * The CI VPC (ADR-246, decision 4).
 *
 * CI runs code from any branch, so its runners live outside the production
 * VPC. A rule written for production cannot admit a pull request's job by
 * accident when the job is in another network.
 *
 * Every subnet is public and every runner gets its own public IPv4 address,
 * with a security group that admits nothing inbound. There is no NAT gateway.
 * A NAT gateway charges $0.045 for each GB it carries, and hundreds of
 * concurrent jobs cloning, installing, and pulling images would move hundreds
 * of GB a day through it. A public address costs $0.005 an hour. The free S3
 * gateway endpoint carries the S3 traffic: the turbo cache, the pnpm store,
 * and the image build's files.
 *
 * Five /19 subnets give 8,187 addresses per zone, far more than the 554
 * runners the pools can reach together. Subnets cost nothing, and a larger
 * ceiling later needs no renumbering.
 */

data "aws_availability_zone" "ci" {
  for_each = toset(var.availability_zone_ids)
  zone_id  = each.value
}

resource "aws_vpc" "ci" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "oxagen-ci" }
}

resource "aws_internet_gateway" "ci" {
  vpc_id = aws_vpc.ci.id
  tags   = { Name = "oxagen-ci" }
}

resource "aws_subnet" "ci" {
  for_each = { for i, id in var.availability_zone_ids : id => i }

  vpc_id                  = aws_vpc.ci.id
  availability_zone_id    = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 3, each.value)
  map_public_ip_on_launch = true

  tags = { Name = "oxagen-ci-${data.aws_availability_zone.ci[each.key].name}" }
}

resource "aws_route_table" "ci" {
  vpc_id = aws_vpc.ci.id
  tags   = { Name = "oxagen-ci" }
}

resource "aws_route" "ci_internet" {
  route_table_id         = aws_route_table.ci.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.ci.id
}

resource "aws_route_table_association" "ci" {
  for_each       = aws_subnet.ci
  subnet_id      = each.value.id
  route_table_id = aws_route_table.ci.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.ci.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.ci.id]

  tags = { Name = "oxagen-ci-s3" }
}

# The default security group of a new VPC admits traffic from itself. Nothing
# uses it, so it is emptied rather than left as a quiet allow rule.
resource "aws_default_security_group" "ci" {
  vpc_id = aws_vpc.ci.id
  tags   = { Name = "oxagen-ci-default-unused" }
}
