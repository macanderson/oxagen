resource "random_id" "secrets" {
  for_each    = toset(["auth", "tokens", "ingestion", "engine", "inngest-event", "inngest-signing"])
  byte_length = 32
}
data "aws_ssm_parameter" "neo4j" {
  name       = "/${local.node_name}/neo4j/password"
  depends_on = [module.app]
}
data "aws_ssm_parameter" "clickhouse" {
  name       = "/${local.node_name}/clickhouse/password"
  depends_on = [module.app]
}
locals {
  config = merge({
    DATABASE_URL              = "postgres://oxagen:${random_password.postgres.result}@${aws_rds_cluster.postgres.endpoint}:5432/oxagen?sslmode=require"
    CLICKHOUSE_URL            = "http://127.0.0.1:8123"
    CLICKHOUSE_USERNAME       = "oxagen"
    CLICKHOUSE_PASSWORD       = data.aws_ssm_parameter.clickhouse.value
    CLICKHOUSE_DATABASE       = "oxagen"
    NEO4J_URI                 = "bolt://127.0.0.1:7687"
    NEO4J_USERNAME            = "neo4j"
    NEO4J_PASSWORD            = data.aws_ssm_parameter.neo4j.value
    NEO4J_DATABASE            = "neo4j"
    BETTER_AUTH_SECRET        = random_id.secrets["auth"].hex
    BETTER_AUTH_URL           = "https://app.${var.domain}"
    NEXT_PUBLIC_APP_URL       = "https://app.${var.domain}"
    NEXT_PUBLIC_API_URL       = "https://api.${var.domain}"
    APP_URL                   = "https://app.${var.domain}"
    AUTH_TOKEN_ENCRYPTION_KEY = random_id.secrets["tokens"].b64_std
    INGESTION_CRYPTO_PROVIDER = "env"
    INGESTION_ENCRYPTION_KEY  = random_id.secrets["ingestion"].b64_std
    STELLA_SERVE_URL          = "http://127.0.0.1:4300"
    STELLA_SERVE_TOKEN        = random_id.secrets["engine"].hex
    }, var.local_inngest ? {
    INNGEST_EVENT_KEY   = random_id.secrets["inngest-event"].hex
    INNGEST_SIGNING_KEY = random_id.secrets["inngest-signing"].hex
    INNGEST_DEV         = "1"
  } : {})
}
resource "aws_ssm_parameter" "config" {
  for_each = nonsensitive(toset(keys(local.config)))
  name     = "${local.prefix}/${each.key}"
  type     = "SecureString"
  value    = local.config[each.key]
  tags     = local.tags
}
resource "aws_ssm_parameter" "engine_token" {
  name  = "${local.prefix}/stella-serve/STELLA_SERVE_TOKEN"
  type  = "SecureString"
  value = random_id.secrets["engine"].hex
  tags  = local.tags
}
resource "aws_ssm_parameter" "postgres_password" {
  name  = "/${local.node_name}/postgres/password"
  type  = "SecureString"
  value = random_password.postgres.result
  tags  = local.tags
}
resource "aws_s3_object" "node_script" {
  for_each = toset(["deploy-service.sh"])
  bucket   = aws_s3_bucket.deploy.id
  key      = "_bin/${each.key}"
  source   = "${path.module}/../../tools/node/${each.key}"
  etag     = filemd5("${path.module}/../../tools/node/${each.key}")
}
resource "aws_s3_object" "node_env" {
  bucket  = aws_s3_bucket.deploy.id
  key     = "_bin/node.env"
  content = "DEPLOY_BUCKET=${local.bucket}\nREGION=${var.region}\nLOG_DRIVER=awslogs\nLOG_GROUP_PREFIX=/${local.node_name}\n"
}
resource "aws_s3_object" "caddy" {
  bucket  = aws_s3_bucket.deploy.id
  key     = "_caddy/Caddyfile"
  content = <<-CONFIG
    {
      auto_https off
    }
    :80 {
      handle /healthz {
        rewrite * /health
        reverse_proxy 127.0.0.1:4000
      }
      @app host app.${var.domain}
      handle @app {
        reverse_proxy 127.0.0.1:3000
      }
      @api host api.${var.domain}
      handle @api {
        reverse_proxy 127.0.0.1:4000
      }
      @mcp host mcp.${var.domain}
      handle @mcp {
        reverse_proxy 127.0.0.1:4100
      }
      @docs host docs.${var.domain}
      handle @docs {
        reverse_proxy 127.0.0.1:3002
      }
      respond 404
    }
  CONFIG
}
resource "aws_ssm_document" "deploy" {
  name            = "${local.name}-deploy-service"
  document_type   = "Command"
  document_format = "YAML"
  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Deploy one service to the isolated environment."
    parameters = {
      service = { type = "String", allowedPattern = "^(app|api|mcp|docs|stella-serve)$" }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deployService"
      inputs = { runCommand = ["/opt/oxagen/bin/deploy-service.sh '{{ service }}'"], timeoutSeconds = "900" }
    }]
  })
}
resource "aws_iam_role" "deploy" {
  name = "${local.name}-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = var.oidc_provider_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = { StringEquals = {
        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub" = var.oidc_subjects
      } }
    }]
  })
  tags = local.tags
}
resource "aws_iam_role_policy" "deploy" {
  name = "isolated-deployment"
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.deploy.arn}/_deploy/*" },
    { Effect = "Allow", Action = ["s3:ListBucket", "s3:ListBucketVersions"], Resource = aws_s3_bucket.deploy.arn },
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"], Resource = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.prefix}", "arn:aws:ssm:${var.region}:${var.account_id}:parameter${local.prefix}/*", "arn:aws:ssm:${var.region}:${var.account_id}:parameter/${local.node_name}/*"] },
    { Effect = "Allow", Action = ["ec2:DescribeInstances", "ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"], Resource = "*" },
    { Effect = "Allow", Action = ["ssm:SendCommand"], Resource = [aws_ssm_document.deploy.arn, "arn:aws:ec2:${var.region}:${var.account_id}:instance/${module.app.instance_id}"] },
    { Effect = "Allow", Action = ["ssm:StartSession"], Resource = ["arn:aws:ssm:${var.region}::document/AWS-StartPortForwardingSession", "arn:aws:ssm:${var.region}::document/AWS-StartPortForwardingSessionToRemoteHost", "arn:aws:ec2:${var.region}:${var.account_id}:instance/${module.app.instance_id}"] },
    { Effect = "Allow", Action = ["ssm:TerminateSession", "ssm:ResumeSession"], Resource = "arn:aws:ssm:${var.region}:${var.account_id}:session/*" },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "*", Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } } }
  ] })
}

resource "aws_ssm_association" "inngest" {
  count            = var.local_inngest ? 1 : 0
  name             = "AWS-RunShellScript"
  association_name = "${local.name}-inngest"
  targets {
    key    = "InstanceIds"
    values = [module.app.instance_id]
  }
  parameters = {
    commands = <<-SCRIPT
      set -eu
      cloud-init status --wait
      mkdir -p /opt/oxagen/inngest
      if ! docker inspect oxagen-local-inngest >/dev/null 2>&1; then
        docker run -d --name oxagen-local-inngest --restart unless-stopped --network host \
          -v /opt/oxagen/inngest:/data -w /data \
          inngest/inngest@sha256:4ed7502b19e0ec15cc7ed5eaf5b7c81f23e01b895918e62162ef935250e5376c \
          inngest dev -u http://127.0.0.1:4000/api/inngest
      fi
      docker inspect -f '{{.State.Running}}' oxagen-local-inngest
    SCRIPT
  }
}
