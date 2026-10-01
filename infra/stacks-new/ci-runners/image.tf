/**
 * The runner image (ADR-246, decision 5).
 *
 * EC2 Image Builder builds one Ubuntu 24.04 AMI per architecture every day and
 * writes its id to `/imagebuilder/oxagen-ci-runner/<arch>`. The scale-up
 * Lambda reads that parameter on each launch, so a new image takes effect on
 * the next runner without an apply. No GitHub workflow takes part in the
 * build. The path sits under `/imagebuilder/` because Image Builder's
 * service-linked role may write parameters there and nowhere else.
 *
 * Image Builder components and recipes are immutable: changing one means a new
 * version, and Terraform would replace them on every edit. So the component
 * stays a thin, fixed wrapper. It downloads `image/` from the assets bucket and
 * runs `provision.sh`, and the real work lives in those files, which Terraform
 * uploads from `image/` in this directory. Editing the script changes the next
 * build and nothing else.
 *
 * The parent image is Canonical's public Parameter Store entry for the current
 * Ubuntu 24.04 build, which Image Builder resolves when each build starts, so
 * every daily build starts from that day's patched base.
 */

locals {
  image_arches = {
    arm64 = {
      parent        = "ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
      build_types   = ["m8g.2xlarge", "m7g.2xlarge"]
      runner_arch   = "arm64"
      node_arch     = "arm64"
      ami_parameter = "/imagebuilder/oxagen-ci-runner/arm64"
    }
    x64 = {
      parent        = "ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
      build_types   = ["m7a.2xlarge", "m7i.2xlarge"]
      runner_arch   = "x64"
      node_arch     = "x64"
      ami_parameter = "/imagebuilder/oxagen-ci-runner/x64"
    }
  }

  # What provision.sh installs. A JSON file beside the script rather than
  # template variables, so the script stays a plain file a reviewer can read.
  image_config = {
    runner_version = var.runner_version.version
    runner_sha256  = var.runner_version.sha256
    node_version   = var.node_version
    assets_bucket  = aws_s3_bucket.image_assets.id
    images = concat(
      [for name in keys(local.ci_images) : "${aws_ecrpublic_repository.ci[name].repository_uri}:latest"],
      # What pipeline.yml pulls until CI_IMAGE_REGISTRY points at ECR Public.
      # amd64 only, so the arm64 build skips them.
      [for name in keys(local.ci_images) : "ghcr.io/macanderson/${name}:latest"],
      [for name, source in local.service_images : source],
      [for name, source in local.service_images : "${aws_ecrpublic_repository.ci[name].repository_uri}:${split(":", source)[length(split(":", source)) - 1]}"],
    )
  }

  # The module's start script at the pinned release, wrapped the way the
  # module's own Packer images wrap it (images/start-runner.sh upstream).
  start_runner = templatefile("${path.module}/image/start-runner.sh.tftpl", {
    start_runner = templatefile("${path.module}/image/vendor/start-runner.sh", { metadata_tags = "enabled" })
  })

  image_files = {
    "provision.sh"           = file("${path.module}/image/provision.sh")
    "ci-local-disk.sh"       = file("${path.module}/image/ci-local-disk.sh")
    "ci-local-disk.service"  = file("${path.module}/image/ci-local-disk.service")
    "ci-volume-warm.sh"      = file("${path.module}/image/ci-volume-warm.sh")
    "ci-volume-warm.service" = file("${path.module}/image/ci-volume-warm.service")
    "daemon.json"            = file("${path.module}/image/daemon.json")
    "start-runner.sh"        = local.start_runner
    "config.json"            = jsonencode(local.image_config)
  }
}

# ---------------------------------------------------------------------------
# Assets bucket: the build's files, its logs, and the pnpm store tarballs
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "image_assets" {
  bucket = "oxagen-ci-runners-${var.account_id}"
}

resource "aws_s3_bucket_public_access_block" "image_assets" {
  bucket                  = aws_s3_bucket.image_assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "image_assets" {
  bucket = aws_s3_bucket.image_assets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "image_assets" {
  bucket = aws_s3_bucket.image_assets.id

  rule {
    id     = "expire-build-logs"
    status = "Enabled"

    filter {
      prefix = "logs/"
    }

    expiration {
      days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_object" "image_files" {
  for_each = local.image_files

  bucket       = aws_s3_bucket.image_assets.id
  key          = "image/${each.key}"
  content      = each.value
  content_type = "text/plain"
  etag         = md5(each.value)
}

# ---------------------------------------------------------------------------
# The build instance's role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "image_builder_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "image_builder" {
  name               = "oxagen-ci-image-builder"
  description        = "The EC2 instance Image Builder starts to build a CI runner image."
  assume_role_policy = data.aws_iam_policy_document.image_builder_assume.json
}

resource "aws_iam_role_policy_attachment" "image_builder" {
  for_each = toset([
    "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])

  role       = aws_iam_role.image_builder.name
  policy_arn = each.value
}

data "aws_iam_policy_document" "image_builder" {
  statement {
    sid       = "ReadBuildFiles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.image_assets.arn}/image/*", "${aws_s3_bucket.image_assets.arn}/pnpm-store/*"]
  }

  statement {
    sid       = "ListBuildFiles"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.image_assets.arn]
  }

  statement {
    sid       = "WriteBuildLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.image_assets.arn}/logs/*"]
  }
}

resource "aws_iam_role_policy" "image_builder" {
  name   = "ci-image-build-files"
  role   = aws_iam_role.image_builder.id
  policy = data.aws_iam_policy_document.image_builder.json
}

resource "aws_iam_instance_profile" "image_builder" {
  name = "oxagen-ci-image-builder"
  role = aws_iam_role.image_builder.name
}

resource "aws_security_group" "image_builder" {
  name        = "oxagen-ci-image-builder"
  description = "Image Builder build instances - nothing inbound"
  vpc_id      = aws_vpc.ci.id

  egress {
    description      = "Package mirrors, registries, and AWS APIs"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# ---------------------------------------------------------------------------
# Component, recipes, infrastructure, distribution, pipelines
# ---------------------------------------------------------------------------

resource "aws_imagebuilder_component" "provision" {
  name     = "oxagen-ci-runner-provision"
  platform = "Linux"
  version  = "1.0.0"

  data = <<-YAML
    name: oxagen-ci-runner-provision
    description: Downloads image/ from the CI assets bucket and runs provision.sh.
    schemaVersion: 1.0
    phases:
      - name: build
        steps:
          - name: Fetch
            action: S3Download
            inputs:
              - source: s3://${aws_s3_bucket.image_assets.id}/image/*
                destination: /tmp/oxagen-ci-image/
          - name: Provision
            action: ExecuteBash
            inputs:
              commands:
                - bash /tmp/oxagen-ci-image/provision.sh build /tmp/oxagen-ci-image
      - name: validate
        steps:
          - name: Check
            action: ExecuteBash
            inputs:
              commands:
                - bash /tmp/oxagen-ci-image/provision.sh validate /tmp/oxagen-ci-image
  YAML

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_imagebuilder_image_recipe" "runner" {
  for_each = local.image_arches

  name              = "oxagen-ci-runner-${each.key}"
  version           = "1.0.0"
  parent_image      = each.value.parent
  working_directory = "/tmp"

  component {
    component_arn = aws_imagebuilder_component.provision.arn
  }

  block_device_mapping {
    device_name = "/dev/sda1"

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = 60
      volume_type           = "gp3"
      iops                  = 6000
      throughput            = 500
    }
  }

  systems_manager_agent {
    uninstall_after_build = false
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Image Builder writes pipeline logs outside /aws/imagebuilder/ only through an
# execution role. The first apply on 2026-10-01 failed on that, so the group
# lives under the prefix Image Builder writes to by itself.
resource "aws_cloudwatch_log_group" "image_builds" {
  name              = "/aws/imagebuilder/oxagen-ci-runner"
  retention_in_days = 30
}

resource "aws_imagebuilder_infrastructure_configuration" "runner" {
  for_each = local.image_arches

  name                          = "oxagen-ci-runner-${each.key}"
  description                   = "Builds the ${each.key} CI runner image in the CI VPC."
  instance_profile_name         = aws_iam_instance_profile.image_builder.name
  instance_types                = each.value.build_types
  security_group_ids            = [aws_security_group.image_builder.id]
  subnet_id                     = values(aws_subnet.ci)[0].id
  terminate_instance_on_failure = true

  instance_metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  logging {
    s3_logs {
      s3_bucket_name = aws_s3_bucket.image_assets.id
      s3_key_prefix  = "logs/${each.key}"
    }
  }
}

resource "aws_imagebuilder_distribution_configuration" "runner" {
  for_each = local.image_arches

  name = "oxagen-ci-runner-${each.key}"

  distribution {
    region = var.region

    ami_distribution_configuration {
      name        = "oxagen-ci-runner-${each.key}-{{ imagebuilder:buildDate }}"
      description = "Oxagen CI runner, ${each.key}, actions/runner ${var.runner_version.version}."

      ami_tags = {
        Name         = "oxagen-ci-runner-${each.key}"
        ImageFamily  = "oxagen-ci-runner"
        Architecture = each.key
        Stack        = "platform/ci-runners"
      }
    }

    ssm_parameter_configuration {
      parameter_name = each.value.ami_parameter
      data_type      = "aws:ec2:image"
    }
  }
}

resource "aws_imagebuilder_image_pipeline" "runner" {
  for_each = local.image_arches

  name                             = "oxagen-ci-runner-${each.key}"
  description                      = "Daily ${each.key} CI runner image."
  image_recipe_arn                 = aws_imagebuilder_image_recipe.runner[each.key].arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.runner[each.key].arn
  distribution_configuration_arn   = aws_imagebuilder_distribution_configuration.runner[each.key].arn

  # Inventory collection adds a step that tells us nothing the image's own
  # validate phase does not.
  enhanced_image_metadata_enabled = false

  image_tests_configuration {
    image_tests_enabled = false
  }

  schedule {
    schedule_expression                = var.image_build_schedule
    pipeline_execution_start_condition = "EXPRESSION_MATCH_ONLY"
  }

  logging_configuration {
    image_log_group_name    = aws_cloudwatch_log_group.image_builds.name
    pipeline_log_group_name = aws_cloudwatch_log_group.image_builds.name
  }

  # The build reads image/ when it starts, so the files must be in place first.
  depends_on = [aws_s3_object.image_files]
}

# ---------------------------------------------------------------------------
# Keep the newest images, delete the rest with their snapshots
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "image_lifecycle_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["imagebuilder.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "image_lifecycle" {
  name               = "oxagen-ci-image-lifecycle"
  description        = "Image Builder deletes CI runner images beyond the newest few."
  assume_role_policy = data.aws_iam_policy_document.image_lifecycle_assume.json
}

resource "aws_iam_role_policy_attachment" "image_lifecycle" {
  role       = aws_iam_role.image_lifecycle.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/EC2ImageBuilderLifecycleExecutionPolicy"
}

resource "aws_imagebuilder_lifecycle_policy" "runner" {
  for_each = local.image_arches

  name           = "oxagen-ci-runner-${each.key}"
  description    = "Keep the newest ${var.images_to_keep} ${each.key} runner images."
  execution_role = aws_iam_role.image_lifecycle.arn
  resource_type  = "AMI_IMAGE"

  policy_detail {
    action {
      type = "DELETE"

      include_resources {
        amis      = true
        snapshots = true
      }
    }

    filter {
      type  = "COUNT"
      value = var.images_to_keep
    }
  }

  resource_selection {
    recipe {
      name             = aws_imagebuilder_image_recipe.runner[each.key].name
      semantic_version = aws_imagebuilder_image_recipe.runner[each.key].version
    }
  }

  depends_on = [aws_iam_role_policy_attachment.image_lifecycle]
}
