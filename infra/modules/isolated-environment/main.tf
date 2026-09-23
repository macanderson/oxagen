terraform {
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}
locals {
  name      = "oxagen-${var.environment}"
  node_name = "${local.name}-app"
  prefix    = "/oxagen/${var.environment}"
  bucket    = "${local.name}-deploy-${var.account_id}"
  services  = toset(["app", "api", "mcp", "docs"])
  tags      = { Brand = "oxagen", Environment = var.environment, ManagedBy = "opentofu" }
}
module "network" {
  source             = "../network"
  name               = local.name
  region             = var.region
  availability_zones = var.availability_zones
  ami_id             = var.ami_id
  vpc_cidr           = var.vpc_cidr
  tags               = local.tags
}
resource "aws_s3_bucket" "deploy" {
  bucket = local.bucket
  tags   = local.tags
}
resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket                  = aws_s3_bucket.deploy.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = module.network.vpc_id
  tags   = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.alb.id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}
resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.alb.id
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}
resource "aws_vpc_security_group_egress_rule" "node" {
  security_group_id            = aws_security_group.alb.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
  referenced_security_group_id = module.app.security_group_id
}
module "app" {
  depends_on                = [aws_s3_object.node_script, aws_s3_object.node_env, aws_s3_object.caddy]
  bootstrap_artifact_access = true
  source                    = "../app-node"
  name                      = local.node_name
  ami_id                    = var.ami_id
  deploy_bucket             = aws_s3_bucket.deploy.id
  region                    = var.region
  account_id                = var.account_id
  vpc_id                    = module.network.vpc_id
  subnet_id                 = module.network.app_node_subnet_id
  availability_zone         = var.availability_zones[0]
  alb_security_group_id     = aws_security_group.alb.id
  tags                      = local.tags
}
resource "aws_lb" "app" {
  name               = local.node_name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids
  idle_timeout       = 180
  tags               = local.tags
}
resource "aws_lb_target_group" "app" {
  name     = local.node_name
  port     = 80
  protocol = "HTTP"
  vpc_id   = module.network.vpc_id
  health_check {
    path    = "/healthz"
    matcher = "200"
  }
  tags = local.tags
}
resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = module.app.instance_id
  port             = 80
}
resource "aws_acm_certificate" "app" {
  domain_name               = "app.${var.domain}"
  subject_alternative_names = [for service in ["api", "mcp", "docs"] : "${service}.${var.domain}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
  tags = local.tags
}
resource "aws_route53_record" "certificate" {
  for_each = { for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => option }
  zone_id  = var.hosted_zone_id
  name     = each.value.resource_record_name
  type     = each.value.resource_record_type
  ttl      = 300
  records  = [each.value.resource_record_value]
}
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate : record.fqdn]
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
resource "aws_lb_listener" "http" {
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
resource "aws_route53_record" "service" {
  for_each = local.services
  zone_id  = var.hosted_zone_id
  name     = "${each.key}.${var.domain}"
  type     = "A"
  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}
resource "aws_db_subnet_group" "data" {
  name       = local.name
  subnet_ids = module.network.private_subnet_ids
  tags       = local.tags
}
resource "aws_security_group" "postgres" {
  name   = "${local.name}-postgres"
  vpc_id = module.network.vpc_id
  tags   = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "postgres" {
  security_group_id            = aws_security_group.postgres.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = module.app.security_group_id
}
resource "random_password" "postgres" {
  length  = 32
  special = false
}
resource "aws_rds_cluster" "postgres" {
  cluster_identifier        = "${local.name}-postgres"
  engine                    = "aurora-postgresql"
  engine_version            = "16.8"
  database_name             = "oxagen"
  master_username           = "oxagen"
  master_password           = random_password.postgres.result
  db_subnet_group_name      = aws_db_subnet_group.data.name
  vpc_security_group_ids    = [aws_security_group.postgres.id]
  storage_encrypted         = true
  backup_retention_period   = 7
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-postgres-final"
  deletion_protection       = true
  serverlessv2_scaling_configuration {
    min_capacity = 0
    max_capacity = 2
  }
  tags = local.tags
}
resource "aws_rds_cluster_instance" "postgres" {
  cluster_identifier = aws_rds_cluster.postgres.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgres.engine
  engine_version     = aws_rds_cluster.postgres.engine_version
  tags               = local.tags
}
resource "aws_iam_role_policy" "node_environment" {
  name = "${local.name}-runtime"
  role = module.app.role_name
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.deploy.arn}/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.deploy.arn },
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], Resource = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.prefix}", "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.prefix}/*"] }
  ] })
}
