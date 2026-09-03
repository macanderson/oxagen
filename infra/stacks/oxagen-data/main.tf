/**
 * Oxagen's data plane: Postgres with pgvector, Neo4j, and ClickHouse.
 *
 * Split from the Oxagen website stack into its own state file even though it
 * carries the same `Brand` tag and appears in the same Resource Group. The
 * brand is the unit of *grouping*; the state file is the unit of *blast
 * radius*, and those are not the same question. A website deploy runs often
 * and touches CloudFront; a database apply runs rarely and can destroy data.
 * Sharing a state file between them means every routine site deploy computes a
 * plan that includes the database, which is one `-target` typo away from an
 * afternoon nobody enjoys.
 */

locals {
  brand = "oxagen"
}

module "data" {
  source = "../../modules/data-node"

  name       = "oxagen-data"
  region     = var.region
  account_id = var.account_id

  vpc_id            = var.vpc_id
  subnet_id         = var.subnet_id
  availability_zone = var.availability_zone

  instance_type    = var.instance_type
  data_volume_size = var.data_volume_size

  tags = { Brand = local.brand }
}
