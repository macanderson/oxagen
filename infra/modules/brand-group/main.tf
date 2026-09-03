/**
 * Everything that makes one brand a separately-visible thing inside a shared
 * AWS account.
 *
 * The three brands — Oxagen, Stella, and the Context Graph Protocol — are
 * distinct products that happen to bill to one account. Separate AWS accounts
 * would isolate them harder, but an Organization adds real operational weight
 * (cross-account roles, a payer account, per-account bootstrapping) for a
 * migration whose stated constraint is to cost as little as possible. So the
 * separation is carried by three mechanisms that cost nothing:
 *
 *   1. A `Brand` tag on every resource, applied through the provider's
 *      `default_tags` so it cannot be forgotten on a new resource.
 *   2. A Resource Group per brand, which turns that tag into a browsable
 *      collection in the console and a target for Systems Manager.
 *   3. A separate Terraform state key per brand, so applying one brand's
 *      stack can neither read nor write another's resources.
 *
 * Cost allocation is the fourth mechanism and the one piece that cannot be
 * created here: `Brand` has to be activated as a cost allocation tag in the
 * Billing console before Cost Explorer will group by it, and that API is not
 * exposed to Terraform. `make activate-cost-tags` in the repository root does
 * it in one call; until it runs, per-brand spend is invisible even though the
 * tags are correct.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_resourcegroups_group" "brand" {
  name        = "brand-${var.brand}"
  description = "Every resource belonging to ${var.display_name}"

  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters = [
        {
          Key    = "Brand"
          Values = [var.brand]
        },
      ]
    })
  }

  tags = {
    Brand     = var.brand
    ManagedBy = "opentofu"
  }
}
