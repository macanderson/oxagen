/**
 * The scaler and its pools (ADR-246, decisions 1 to 3).
 *
 * github-aws-runners/terraform-aws-github-runner, multi-runner module, pinned
 * to the v7.11.0 commit. The GitHub App sends each `workflow_job` event to the
 * webhook, which matches the job's one label to a pool and queues it. The
 * scale-up Lambda starts one EC2 instance per job, registered just in time,
 * and the instance terminates after that one job. The pool Lambda keeps idle
 * runners registered so most jobs start in seconds.
 *
 * Speed comes first here, at Mac's direction on 2026-10-01: the heavy pools
 * are 16 vCPU, the instance types with local NVMe come first in priority, and
 * the warm pools run around the clock. Spot comes first and on-demand fills
 * in, because the two have separate quotas and together hold more runners.
 */

locals {
  # Instance types in priority order. capacity-optimized-prioritized asks for
  # the first ones first and moves down the list when spot capacity is short.
  # Local NVMe (the "d" types) first, then the newest cores, then the rest for
  # capacity. Every type in one pool has the same vCPU count and at least the
  # same memory (64 GB large, 16 GB small), so a job runs at the same width
  # wherever it lands and the concurrency the workflows set never outgrows it.
  pools = {
    "oxagen-large-arm64" = {
      arch     = "arm64"
      types    = ["m8gd.4xlarge", "m7gd.4xlarge", "m8g.4xlarge", "r8g.4xlarge", "m7g.4xlarge", "r7g.4xlarge"]
      max      = 250
      disk     = { size = 150, iops = 16000, throughput = 1000 }
      priority = 10
    }
    "oxagen-large-x64" = {
      arch     = "x64"
      types    = ["m7a.4xlarge", "m6id.4xlarge", "m7i.4xlarge", "r7a.4xlarge", "m6a.4xlarge", "m6i.4xlarge"]
      max      = 100
      disk     = { size = 150, iops = 16000, throughput = 1000 }
      priority = 20
    }
    "oxagen-small-arm64" = {
      arch     = "arm64"
      types    = ["m8gd.xlarge", "m7gd.xlarge", "m8g.xlarge", "m7g.xlarge", "m6g.xlarge"]
      max      = 150
      disk     = { size = 80, iops = 6000, throughput = 500 }
      priority = 30
    }
    "oxagen-small-x64" = {
      arch     = "x64"
      types    = ["m7a.xlarge", "m6id.xlarge", "m7i.xlarge", "m6a.xlarge"]
      max      = 50
      disk     = { size = 80, iops = 6000, throughput = 500 }
      priority = 40
    }
  }

  github_app_ssm = {
    id             = "/oxagen/ci-runners/github-app/id"
    key_base64     = "/oxagen/ci-runners/github-app/key_base64"
    webhook_secret = "/oxagen/ci-runners/github-app/webhook_secret"
  }

  ssm_arn = "arn:aws:ssm:${var.region}:${var.account_id}:parameter"

  # The runner's own settings, shared by every pool.
  runner_defaults = {
    runner_os                       = "linux"
    runner_run_as                   = "runner"
    enable_ephemeral_runners        = true
    enable_jit_config               = true
    enable_job_queued_check         = true
    enable_organization_runners     = true
    pool_runner_owner               = var.github_org
    enable_userdata                 = false
    enable_runner_binaries_syncer   = false
    enable_ssm_on_runners           = false
    runner_disable_default_labels   = true
    create_service_linked_role_spot = false
    instance_target_capacity_type   = "spot"
    instance_allocation_strategy    = "capacity-optimized-prioritized"
    # Spot capacity, the spot quota, and a spot fleet limit all fall through
    # to on-demand at once, in the same Lambda call.
    enable_on_demand_failover_for_errors = [
      "InsufficientInstanceCapacity",
      "MaxSpotInstanceCountExceeded",
      "UnfulfillableCapacity",
      "SpotMaxPriceTooLow",
    ]
    # A pool runner takes a job within a second or two. With no delay the
    # scale-up Lambda may start one runner the pool already covered, and that
    # runner waits for the next job. Speed is worth the spare runner.
    delay_webhook_event                     = 0
    scale_up_reserved_concurrent_executions = -1
    runner_boot_time_in_minutes             = 5
    minimum_running_time_in_minutes         = 30
    job_queue_retention_in_seconds          = 3600
    job_retry = {
      enable           = true
      delay_in_seconds = 120
      max_attempts     = 2
    }
  }
}

# ---------------------------------------------------------------------------
# GitHub App parameters
# ---------------------------------------------------------------------------
#
# scripts/store-github-app.sh creates these three SecureString parameters from
# the App's manifest conversion, so the App can be made before or after this
# stack is applied. The module needs only their names and ARNs, and the
# Lambdas read the values at call time.

# ---------------------------------------------------------------------------
# The AMI the pools launch, written by Image Builder after each build
# ---------------------------------------------------------------------------

data "aws_ssm_parameter" "ubuntu" {
  for_each = local.image_arches
  name     = replace(each.value.parent, "ssm:", "")
}

# Seeded with Canonical's Ubuntu image so the launch templates have a valid
# parameter before the first build. Image Builder overwrites the value, and
# Terraform leaves it alone after creation. A runner launched before the first
# build has no runner agent and terminates when its start script fails.
resource "aws_ssm_parameter" "runner_ami" {
  for_each = local.image_arches

  name        = each.value.ami_parameter
  description = "The ${each.key} CI runner AMI. Image Builder writes it after each build."
  type        = "String"
  data_type   = "aws:ec2:image"
  value       = data.aws_ssm_parameter.ubuntu[each.key].value

  lifecycle {
    ignore_changes = [value]
  }
}

# ---------------------------------------------------------------------------
# Service-linked roles EC2 and Image Builder need. The account had none.
# ---------------------------------------------------------------------------

resource "aws_iam_service_linked_role" "spot" {
  aws_service_name = "spot.amazonaws.com"
  description      = "EC2 Spot, for the CI runner fleets."
}

resource "aws_iam_service_linked_role" "fleet" {
  aws_service_name = "ec2fleet.amazonaws.com"
  description      = "EC2 Fleet, for the CI runner fleets."
}

resource "aws_iam_service_linked_role" "image_builder" {
  aws_service_name = "imagebuilder.amazonaws.com"
  description      = "EC2 Image Builder, for the CI runner image."
}

# ---------------------------------------------------------------------------
# The deploy pool's network: the production VPC's public subnets
# ---------------------------------------------------------------------------

data "aws_vpc" "production" {
  tags = { Name = "oxagen" }
}

data "aws_subnets" "production_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.production.id]
  }

  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

# The production stack admits this group to Aurora, ClickHouse, and Neo4j in
# the change that moves migration-gate here. Nothing admits it yet.
resource "aws_security_group" "deploy_runner" {
  name        = "oxagen-ci-deploy-runner"
  description = "CI deploy runners in the production VPC - nothing inbound"
  vpc_id      = data.aws_vpc.production.id

  egress {
    description      = "GitHub, registries, and AWS APIs"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# ---------------------------------------------------------------------------
# The scaler
# ---------------------------------------------------------------------------

module "runners" {
  source = "git::https://github.com/github-aws-runners/terraform-aws-github-runner.git//modules/multi-runner?ref=11ea3112e617adc392d6a652a94f4c7640ddc650"

  prefix     = "ci"
  aws_region = var.region

  # The provider's default tags reach only what Terraform creates. These also
  # reach every instance, volume, and network interface EC2 Fleet launches, so
  # the budget's Stack filter counts the runners themselves.
  tags = {
    Brand       = "shared"
    Application = "ci"
    ManagedBy   = "opentofu"
    Stack       = "platform/ci-runners"
  }
  vpc_id     = aws_vpc.ci.id
  subnet_ids = [for s in aws_subnet.ci : s.id]

  associate_public_ipv4_address = true

  github_app = {
    id_ssm             = { name = local.github_app_ssm.id, arn = "${local.ssm_arn}${local.github_app_ssm.id}" }
    key_base64_ssm     = { name = local.github_app_ssm.key_base64, arn = "${local.ssm_arn}${local.github_app_ssm.key_base64}" }
    webhook_secret_ssm = { name = local.github_app_ssm.webhook_secret, arn = "${local.ssm_arn}${local.github_app_ssm.webhook_secret}" }
  }

  ssm_paths = { root = "oxagen/ci-runners/scaler" }

  # Jobs from any repository not listed are ignored at the webhook. The App is
  # installed on these alone, and the runner groups admit private repositories
  # only, so a public repository's job reaches no runner three ways over.
  repository_white_list = [for r in var.private_repositories : "${var.github_org}/${r}"]

  # The webhook dispatches straight to the pool's queue. EventBridge would add
  # a hop to every job and tell us nothing we use.
  eventbridge = { enable = false }

  webhook_lambda_zip = "${path.module}/.lambdas/webhook.zip"
  runners_lambda_zip = "${path.module}/.lambdas/runners.zip"

  instance_termination_watcher = {
    enable = true
    zip    = "${path.module}/.lambdas/termination-watcher.zip"
  }

  metrics = {
    enable    = true
    namespace = "oxagen/ci-runners"
  }

  lambda_architecture                        = "arm64"
  webhook_lambda_memory_size                 = 512
  scale_up_lambda_memory_size                = 1024
  runners_scale_up_lambda_timeout            = 60
  pool_lambda_reserved_concurrent_executions = -1
  pool_lambda_timeout                        = 120
  logging_retention_in_days                  = 30

  multi_runner_config = merge(
    {
      for name, p in local.pools : name => {
        matcherConfig = {
          labelMatchers           = [[name]]
          bidirectionalLabelMatch = true
          priority                = p.priority
        }
        redrive_build_queue = { enabled = true, maxReceiveCount = 3 }
        runner_config = merge(local.runner_defaults, {
          runner_architecture   = p.arch
          runner_extra_labels   = [name]
          runner_name_prefix    = "${name}-"
          runner_group_name     = var.ci_runner_group
          instance_types        = p.types
          runners_maximum_count = p.max
          ami = {
            owners               = ["099720109477"]
            filter               = { name = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-*"] }
            id_ssm_parameter_arn = aws_ssm_parameter.runner_ami[p.arch].arn
          }
          block_device_mappings = [{
            device_name = "/dev/sda1"
            volume_size = p.disk.size
            volume_type = "gp3"
            iops        = p.disk.iops
            throughput  = p.disk.throughput
            encrypted   = true
          }]
          pool_config = var.github_app_ready && lookup(var.warm_pool, name, 0) > 0 ? [{
            schedule_expression = "rate(1 minute)"
            size                = var.warm_pool[name]
          }] : []
        })
      }
    },
    {
      # Every job that touches production (ADR-246, decision 2). On-demand,
      # in the production VPC, in a runner group that admits only main. 16
      # vCPU, because deploy-node builds the Next app for the node.
      "oxagen-deploy" = {
        matcherConfig = {
          labelMatchers           = [["oxagen-deploy"]]
          bidirectionalLabelMatch = true
          priority                = 5
        }
        redrive_build_queue = { enabled = true, maxReceiveCount = 3 }
        runner_config = merge(local.runner_defaults, {
          runner_architecture                  = "arm64"
          runner_extra_labels                  = ["oxagen-deploy"]
          runner_name_prefix                   = "oxagen-deploy-"
          runner_group_name                    = var.deploy_runner_group
          instance_types                       = ["m8gd.4xlarge", "m8g.4xlarge", "m7g.4xlarge"]
          instance_target_capacity_type        = "on-demand"
          instance_allocation_strategy         = "prioritized"
          enable_on_demand_failover_for_errors = []
          runners_maximum_count                = 6
          vpc_id                               = data.aws_vpc.production.id
          subnet_ids                           = data.aws_subnets.production_public.ids
          runner_additional_security_group_ids = [aws_security_group.deploy_runner.id]
          ami = {
            owners               = ["099720109477"]
            filter               = { name = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-*"] }
            id_ssm_parameter_arn = aws_ssm_parameter.runner_ami["arm64"].arn
          }
          block_device_mappings = [{
            device_name = "/dev/sda1"
            volume_size = 150
            volume_type = "gp3"
            iops        = 16000
            throughput  = 1000
            encrypted   = true
          }]
          pool_config = var.github_app_ready && lookup(var.warm_pool, "oxagen-deploy", 0) > 0 ? [{
            schedule_expression = "rate(1 minute)"
            size                = var.warm_pool["oxagen-deploy"]
          }] : []
        })
      }
    },
  )

  depends_on = [
    aws_iam_service_linked_role.spot,
    aws_iam_service_linked_role.fleet,
  ]
}

# ---------------------------------------------------------------------------
# A stable webhook address, so the GitHub App never needs editing when the
# API Gateway is replaced
# ---------------------------------------------------------------------------

data "aws_route53_zone" "oxagen_sh" {
  name         = "oxagen.sh"
  private_zone = false
}

resource "aws_acm_certificate" "webhook" {
  domain_name       = var.webhook_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "webhook_validation" {
  for_each = {
    for o in aws_acm_certificate.webhook.domain_validation_options : o.domain_name => o
  }

  zone_id = data.aws_route53_zone.oxagen_sh.zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "webhook" {
  certificate_arn         = aws_acm_certificate.webhook.arn
  validation_record_fqdns = [for r in aws_route53_record.webhook_validation : r.fqdn]
}

resource "aws_apigatewayv2_domain_name" "webhook" {
  domain_name = var.webhook_domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.webhook.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "webhook" {
  api_id      = module.runners.webhook.gateway.id
  domain_name = aws_apigatewayv2_domain_name.webhook.id
  stage       = "$default"
}

resource "aws_route53_record" "webhook" {
  zone_id = data.aws_route53_zone.oxagen_sh.zone_id
  name    = var.webhook_domain
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.webhook.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.webhook.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
