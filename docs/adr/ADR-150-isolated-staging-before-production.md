# ADR-150: Isolated staging before production

- **Status:** Accepted
- **Date:** 2026-09-23
- **Owners:** platform
- **Decided by:** the maintainer, authorizing the deployment tiers in Desktop MUST-HAVE.html
- **Related:** ADR-042, ADR-046, ADR-147

## Context

The hosted platform has one production environment. A browser response proves availability but cannot establish which commit runs. The deployment tiers requirement calls for staging and a reusable deployment into an account operated for a customer.

## Decision

Create staging in its own Terraform state, VPC, Aurora cluster, artifact bucket, application node, Parameter Store prefix, and GitHub deployment role. Reuse the network and application-node modules. Generate staging credentials independently. Do not copy production records or integration credentials.

The isolated-environment module accepts the account, region, DNS zone, domain, environment slug, AMI, network range, and OIDC subjects. The existing production stack keeps its state and resource addresses. The staging stack lives under `infra/stacks-new/staging`.

Artifacts carry the target Parameter Store prefix. Staging builds resolve the preview environment from staging parameters, including browser URLs. The deployment action accepts a node, bucket, and SSM document with production values as defaults.

Staging must pass its schema migrations, deployment, and public endpoint checks for the same commit before production deploys that commit. A release record carries that commit and the artifact versions. Availability and release identity are separate checks.

## Consequences

Staging has recurring AWS infrastructure cost and an independent database migration history. Its stores can be reset without changing production. Integration-dependent features need staging credentials from their providers.

The module provides a starting point for a customer-owned AWS account. Its runbook must distinguish an exercised staging deployment from a second-account deployment. No second account was available during this implementation: the authenticated account is not a member of AWS Organizations.
