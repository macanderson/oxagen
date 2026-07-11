# atlas.hcl — Atlas migration configuration for Oxagen
#
# TypeScript Drizzle schema is the sole source of truth.
# Atlas reads the desired state via `drizzle-kit export` and computes diffs
# against a dev database to generate versioned SQL migration files.
#
# Developer workflow (generate a new migration):
#   cd packages/database
#   atlas migrate diff --env local "describe_your_change"
#   git add atlas/migrations/
#   git commit -m "db: add <describe_your_change>"
#
# Production deployment (automated in CI on push to main):
#   atlas migrate apply --env ci
#
# Full rebuild from scratch:
#   atlas migrate apply --env local
#
# Check drift / pending migrations:
#   atlas migrate status --env local

data "external_schema" "drizzle" {
  program = [
    "npx",
    "drizzle-kit",
    "export",
  ]
}

env "local" {
  src = data.external_schema.drizzle.url
  # atlas_dev is a dedicated scratch DB on the local Postgres instance.
  # It has citext + uuid-ossp pre-installed. Atlas uses it only for diff
  # computation — it is never the migration target.
  dev = "postgres://oxagen:oxagen@localhost:5433/atlas_dev?sslmode=disable"
  url = "postgres://oxagen:oxagen@localhost:5433/oxagen?sslmode=disable"
  migration {
    dir        = "file://atlas/migrations"
    format     = atlas
    # Parallel agent sessions cut migrations against different bases, so a
    # persistent DB (preview/prod/shared-local) routinely sees a new file whose
    # timestamp sorts below an already-applied version. Linear order would wedge
    # every subsequent apply (atlasgo.io/versioned/apply#non-linear-error);
    # non-linear applies pending files in version order and no-ops when history
    # is already linear.
    exec_order = NON_LINEAR
  }
  # Exclude Atlas's own revision-tracking table and the old custom runner table.
  exclude = ["atlas_schema_revisions", "_migrations"]
}

env "ci" {
  # CI only runs `atlas migrate apply` — no diff generation, no dev DB needed.
  url = getenv("DATABASE_URL")
  migration {
    dir        = "file://atlas/migrations"
    format     = atlas
    # See env "local" for why exec_order is NON_LINEAR everywhere.
    exec_order = NON_LINEAR
  }
  exclude = ["atlas_schema_revisions", "_migrations"]
}

env "prod" {
  url = getenv("PRODUCTION_DATABASE_URL")
  migration {
    dir        = "file://atlas/migrations"
    format     = atlas
    # See env "local" for why exec_order is NON_LINEAR everywhere.
    exec_order = NON_LINEAR
  }
  exclude = ["atlas_schema_revisions", "_migrations"]
}

env "preview" {
  url = getenv("PREVIEW_DATABASE_URL")
  migration {
    dir        = "file://atlas/migrations"
    format     = atlas
    # See env "local" for why exec_order is NON_LINEAR everywhere.
    exec_order = NON_LINEAR
  }
  exclude = ["atlas_schema_revisions", "_migrations"]
}
