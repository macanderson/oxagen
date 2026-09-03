/**
 * The Oxagen brand in the new account: the `oxagen.sh` zone, the static
 * marketing site, the VPC + ALB + app node that serves docs, app, api and
 * mcp, and (in data-services.tf) Aurora PostgreSQL Serverless v2 and
 * Redshift Serverless. `stella.oxagen.sh`'s alias record lives in
 * `stacks-new/stella`, same split as the old account, because the hostname
 * is Oxagen's but the resource belongs to Stella's own state and Resource
 * Group.
 *
 * Differences from `stacks/oxagen` in the old account, and why:
 *
 *   - Postgres moves to Aurora Serverless v2 and ClickHouse's role moves to
 *     Redshift Serverless — both now scale close enough to zero to beat
 *     self-hosting at this traffic level (see data-services.tf). Neo4j stays
 *     self-hosted on the app node: Neptune Analytics, Amazon's only graph
 *     product with native vector search, has a real floor cost that does not
 *     reach zero even paused, and Neo4j 5.11+ already gives this app vector
 *     indexes today.
 *   - No `nextjs-site` (Lambda) module for docs or stella. In the old account
 *     that module exists in state but never serves traffic — CloudFront in
 *     front of a Lambda Function URL returns 403 in that account for reasons
 *     never root-caused — and Terraform fighting a hand-overridden DNS record
 *     is exactly the trap this account does not reproduce. `docs.oxagen.sh`
 *     is a plain node service here from the start, alongside app/api/mcp.
 *   - The node sits behind an ALB in a private subnet instead of holding a
 *     public IP and terminating its own TLS. See modules/app-node/main.tf.
 */

locals {
  brand = "oxagen"
}

module "brand" {
  source = "../../modules/brand-group"

  brand        = local.brand
  display_name = "Oxagen"
}

# ---------------------------------------------------------------------------
# DNS zone
# ---------------------------------------------------------------------------

resource "aws_route53_zone" "oxagen_sh" {
  name    = "oxagen.sh"
  comment = "Oxagen — apex, docs, and the subdomains delegated to other brands"
}

# ---------------------------------------------------------------------------
# oxagen.sh — the marketing site (static, unchanged shape from the old account)
# ---------------------------------------------------------------------------

module "web" {
  source = "../../modules/static-site"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                   = "oxagen-web"
  bucket_name            = "oxagen-web-${var.account_id}"
  domain_name            = "oxagen.sh"
  alternate_domain_names = ["www.oxagen.sh"]
  hosted_zone_id         = aws_route53_zone.oxagen_sh.zone_id
  url_rewrite_mode       = "directory_index"
  not_found_path         = "/index.html"

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# Network + app node
# ---------------------------------------------------------------------------

module "network" {
  source = "../../modules/network"

  name               = "oxagen"
  region             = var.region
  availability_zones = var.availability_zones

  tags = { Brand = local.brand }
}

module "app" {
  source = "../../modules/app-node"

  name              = "oxagen-app"
  region            = var.region
  account_id        = var.account_id
  vpc_id            = module.network.vpc_id
  subnet_id         = module.network.app_node_subnet_id
  availability_zone = var.availability_zones[0]

  alb_security_group_id = aws_security_group.alb.id

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# ALB — the one public entry point for docs/stella/app/api/mcp
# ---------------------------------------------------------------------------

## Built from separate rule resources rather than inline `ingress`/`egress`
## blocks. The egress rule targets the node's own security group, and the
## node's security group (created inside module.app, below) in turn admits
## only this security group — each references the other's id, which inline
## blocks on both sides cannot express without a cycle.

resource "aws_security_group" "alb" {
  name        = "oxagen-alb"
  description = "oxagen ALB - public HTTP/HTTPS in, node only out"
  vpc_id      = module.network.vpc_id

  tags = { Brand = local.brand }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_v6" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere, IPv6"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS by the listener below"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_v6" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS by the listener below, IPv6"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv6         = "::/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_node" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the app nodes Caddy, nothing else"
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
  referenced_security_group_id = module.app.security_group_id
}

resource "aws_lb" "app" {
  name               = "oxagen-app"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids

  access_logs {
    bucket  = aws_s3_bucket.logs_archive.id
    prefix  = "alb"
    enabled = true
  }

  tags = { Brand = local.brand }

  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_lb_target_group" "app" {
  name     = "oxagen-app"
  port     = 80
  protocol = "HTTP"
  vpc_id   = module.network.vpc_id

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Brand = local.brand }
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = module.app.instance_id
  port             = 80
}

resource "aws_acm_certificate" "app" {
  domain_name       = "app.oxagen.sh"
  validation_method = "DNS"
  subject_alternative_names = [
    "docs.oxagen.sh",
    "stella.oxagen.sh",
    "api.oxagen.sh",
    "mcp.oxagen.sh",
  ]

  lifecycle {
    create_before_destroy = true
  }

  tags = { Brand = local.brand }
}

resource "aws_route53_record" "app_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.oxagen_sh.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.value]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.app_cert_validation : r.fqdn]
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.app.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---------------------------------------------------------------------------
# Node services — everything Caddy routes by hostname
# ---------------------------------------------------------------------------

locals {
  # host -> what answers on it. Port and process are the artifact's business
  # (oxagen-run.json), not this stack's — see tools/node/README.md.
  node_services = toset([
    "docs.oxagen.sh",
    "app.oxagen.sh",
    "api.oxagen.sh",
    "mcp.oxagen.sh",
  ])
}

resource "aws_route53_record" "node_service" {
  for_each = local.node_services

  zone_id = aws_route53_zone.oxagen_sh.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
