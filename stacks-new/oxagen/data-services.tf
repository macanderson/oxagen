/**
 * The data plane: Aurora PostgreSQL Serverless v2 and Redshift Serverless.
 *
 * Both replace what the old account self-hosted on the data node — Postgres
 * and ClickHouse respectively — and both were chosen over the old account's
 * approach specifically because they now scale close enough to zero to beat
 * self-hosting at this traffic level, which was not true when the old
 * data-node module's own header was written. Neo4j stays self-hosted on
 * modules.app (see that module's header): Neptune Analytics, Amazon's only
 * graph product with native embeddings, has a real floor cost that does not
 * reach zero even paused.
 *
 * Both secrets go to Parameter Store rather than Secrets Manager, same
 * reasoning as everywhere else in this repository: standard parameters are
 * free, and they land under `/oxagen-app/*`, which the app node's own IAM
 * role can already read (modules/app-node/main.tf scopes it there) — no
 * extra IAM grant needed for the node to fetch either password at boot.
 */

resource "aws_db_subnet_group" "data" {
  name       = "oxagen-data"
  subnet_ids = module.network.private_subnet_ids
  tags       = { Brand = local.brand }
}

resource "aws_security_group" "aurora" {
  name        = "oxagen-aurora"
  description = "oxagen Aurora Postgres - inbound from the app node only"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "Postgres from the app node"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.app.security_group_id]
  }

  tags = { Brand = local.brand }
}

resource "aws_security_group" "redshift" {
  name        = "oxagen-redshift"
  description = "oxagen Redshift Serverless - inbound from the app node only"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "Redshift from the app node"
    from_port       = 5439
    to_port         = 5439
    protocol        = "tcp"
    security_groups = [module.app.security_group_id]
  }

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# Aurora PostgreSQL Serverless v2
# ---------------------------------------------------------------------------

resource "random_password" "aurora" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "aurora_password" {
  name        = "/oxagen-app/postgres/password"
  description = "Aurora PostgreSQL master password"
  type        = "SecureString"
  value       = random_password.aurora.result
  tags        = { Brand = local.brand }
}

# Requires 16.3+ to scale to zero ACUs when idle (13.15+/14.12+/15.7+ also
# qualify) — pin explicitly rather than trust a default, since scale-to-zero
# is the entire reason this beats self-hosting at zero customers.
resource "aws_rds_cluster" "postgres" {
  cluster_identifier     = "oxagen-postgres"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  engine_version         = "16.8"
  database_name          = "oxagen"
  master_username        = "oxagen"
  master_password        = random_password.aurora.result
  db_subnet_group_name   = aws_db_subnet_group.data.name
  vpc_security_group_ids = [aws_security_group.aurora.id]
  storage_encrypted      = true

  # 35 days is the maximum Aurora allows and costs nothing extra at this
  # data volume (backup storage up to 100% of cluster size is included) —
  # Aurora's continuous backup means point-in-time restore inside this
  # window is granular to the second, which is what "no more than a minute
  # of data lost" actually needs; the number to tune is the window length,
  # not the granularity.
  backup_retention_period = 35

  enabled_cloudwatch_logs_exports = ["postgresql"]

  # No customers yet, so no final snapshot to preserve on a deliberate
  # teardown. Revisit before this cluster carries anything worth keeping.
  skip_final_snapshot = true

  serverlessv2_scaling_configuration {
    min_capacity = 0
    max_capacity = 2
  }

  tags = { Brand = local.brand }
}

resource "aws_rds_cluster_instance" "postgres" {
  cluster_identifier = aws_rds_cluster.postgres.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgres.engine
  engine_version     = aws_rds_cluster.postgres.engine_version

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# Redshift Serverless — the ClickHouse-equivalent analytics store
# ---------------------------------------------------------------------------

resource "random_password" "redshift" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "redshift_password" {
  name        = "/oxagen-app/redshift/password"
  description = "Redshift Serverless admin password"
  type        = "SecureString"
  value       = random_password.redshift.result
  tags        = { Brand = local.brand }
}

resource "aws_redshiftserverless_namespace" "oxagen" {
  namespace_name      = "oxagen"
  db_name             = "oxagen"
  admin_username      = "oxagen"
  admin_user_password = random_password.redshift.result

  # Redshift Serverless takes its own automatic recovery points — every 30
  # minutes, or every 5GB/node changed if that comes first — with no
  # Terraform-configurable interval to tune. Verified against AWS's own docs
  # (docs.aws.amazon.com/redshift/latest/mgmt/serverless-snapshots-recovery-points.html),
  # not assumed: this beats the "no more than a day" fallback RPO comfortably,
  # but each automatic recovery point is only retained 24 hours. Restoring
  # further back than that requires converting a recovery point to a
  # snapshot before it ages out — not wired up here; add a scheduled Lambda
  # if a longer restore window turns out to matter.
  log_exports = ["useractivitylog", "userlog", "connectionlog"]

  tags = { Brand = local.brand }
}

resource "aws_redshiftserverless_workgroup" "oxagen" {
  namespace_name = aws_redshiftserverless_namespace.oxagen.namespace_name
  workgroup_name = "oxagen"

  # 4 RPU is the current minimum (reduced from 8 in mid-2025) — the cheapest
  # base capacity this product offers. Compute bills per RPU-second while a
  # query runs and the workgroup auto-pauses between them, so idle cost is
  # storage only.
  base_capacity = 4

  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [aws_security_group.redshift.id]

  publicly_accessible  = false
  enhanced_vpc_routing = true

  tags = { Brand = local.brand }
}
