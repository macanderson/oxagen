/**
 * CI images in ECR Public (ADR-246, decision 6).
 *
 * `oxagen-ci-base` and `oxagen-ci-e2e` hold only the toolchain (Node, pnpm,
 * Atlas, psql, Playwright's Chromium). They were public GHCR packages under
 * the `macanderson` user, which `ci-image.yml` in `oxageninc/product` cannot
 * push to, so their `:latest` stopped moving when the repository changed
 * owners. ECR Public serves anonymous pulls to our runners and to
 * GitHub-hosted ones alike, so rolling back to GitHub-hosted runners needs no
 * registry credentials, and no part of it bills through GitHub.
 *
 * The mirrors hold the service containers CI starts (Postgres, ClickHouse,
 * Neo4j). Pulling them from Docker Hub on shared AWS addresses meets Docker
 * Hub's anonymous rate limit sooner or later.
 *
 * ECR Public exists only in us-east-1, which is this stack's region.
 */

locals {
  # Third-party images CI jobs start as service containers. ci-image.yml reads
  # the same file and copies each one, every architecture, into ECR Public at
  # the same tag, so a job never pulls from Docker Hub. The key is the mirror
  # repository's name.
  service_images = jsondecode(file("${path.module}/service-images.json"))

  ci_images = {
    "oxagen-ci-base" = "Node, pnpm through corepack, Atlas, and psql. Every CI job that is not e2e runs in it."
    "oxagen-ci-e2e"  = "oxagen-ci-base plus Playwright's Chromium and its system packages, for the e2e job."
  }

  public_repositories = merge(
    local.ci_images,
    { for name, source in local.service_images : name => "A copy of ${source}, every architecture, for CI service containers." },
  )
}

resource "aws_ecrpublic_repository" "ci" {
  for_each        = local.public_repositories
  repository_name = each.key

  catalog_data {
    about_text        = each.value
    description       = each.value
    architectures     = ["ARM 64", "x86-64"]
    operating_systems = ["Linux"]
  }
}

locals {
  # `public.ecr.aws/<alias>`. The alias is the registry's, assigned by AWS
  # when the first repository was created.
  ecr_public_registry = regex("^(public\\.ecr\\.aws/[^/]+)/", aws_ecrpublic_repository.ci["oxagen-ci-base"].repository_uri)[0]
}
