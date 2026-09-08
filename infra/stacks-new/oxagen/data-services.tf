/**
 * The data plane: Aurora PostgreSQL Serverless v2.
 *
 * It replaces the Postgres the old account self-hosted on the data node, and
 * was chosen over that approach specifically because it now scales close
 * enough to zero to beat self-hosting at this traffic level — which was not
 * true when the old data-node module's own header was written.
 *
 * ClickHouse and Neo4j both stay self-hosted on modules.app (see that
 * module's header). An earlier revision of this file paired Aurora with
 * Redshift Serverless as ClickHouse's replacement; that plan is withdrawn
 * (#2693). Nothing was ever pointed at it — `CLICKHOUSE_URL` has always been
 * the node's own loopback and `packages/telemetry` reads it — so the
 * migration existed in this comment and in a workgroup no query reached.
 * Neo4j stays for its own reason: Neptune Analytics, Amazon's only graph
 * product with native embeddings, has a real floor cost that does not reach
 * zero even paused.
 *
 * Aurora's secret goes to Parameter Store rather than Secrets Manager, same
 * reasoning as everywhere else in this repository: standard parameters are
 * free, and they land under `/oxagen-app/*`, which the app node's own IAM
 * role can already read (modules/app-node/main.tf scopes it there) — no
 * extra IAM grant needed for the node to fetch it at boot.
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
