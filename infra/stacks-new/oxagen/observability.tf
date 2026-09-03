/**
 * Logging, an error/warning/incident event stream, and long-term archival.
 *
 * Everything lands in CloudWatch Logs first — the node's containers, Aurora,
 * Redshift, the ALB — and from there splits two ways:
 *
 *   1. Every log line is shipped to S3 via Kinesis Data Firehose for
 *      long-term archival (lifecycle down to Glacier Deep Archive; see
 *      `aws_s3_bucket_lifecycle_configuration.archive` below). Traces the
 *      agent code emits go through the same path, tagged onto their own
 *      prefix, retained 14 years.
 *   2. Lines matching an error/warning/incident pattern are also shipped to
 *      a small Lambda that republishes each one as a structured event on an
 *      EventBridge bus — the "channel that something can subscribe to" —
 *      substituted for Kafka (MSK) or Redis (ElastiCache) because both of
 *      those have a real always-on floor cost and this is pay-per-event.
 *
 * What this cannot do: invent a source file, line number, or trace id for a
 * log line that never carried one. The Lambda forwards whatever structured
 * fields a service's own log line contains — the fields themselves are an
 * application-side logging change, not an infrastructure one.
 */

# ---------------------------------------------------------------------------
# CloudWatch Log Groups — one per service, plus Neo4j
# ---------------------------------------------------------------------------

locals {
  log_group_services = ["docs", "stella", "app", "api", "mcp", "neo4j", "caddy"]
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(local.log_group_services)

  name = "/oxagen-app/${each.value}"
  # 30 days searchable in CloudWatch itself; everything is also in S3
  # indefinitely (see the archive bucket below) at a fraction of the cost.
  retention_in_days = 30

  tags = { Brand = local.brand }
}

# ---------------------------------------------------------------------------
# Long-term archive bucket — all logs and all traces, one lifecycle
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "logs_archive" {
  bucket = "oxagen-logs-archive-${var.account_id}"
  tags   = { Brand = local.brand }
}

resource "aws_s3_bucket_public_access_block" "logs_archive" {
  bucket                  = aws_s3_bucket.logs_archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# One retention policy for both logs and traces: Glacier Deep Archive storage
# is cheap enough (~$0.00099/GB-month) that splitting general logs onto a
# shorter retention buys negligible savings against the complexity of a
# second lifecycle policy. 14 years is 5,110 days.
resource "aws_s3_bucket_lifecycle_configuration" "logs_archive" {
  bucket = aws_s3_bucket.logs_archive.id

  rule {
    id     = "logs-and-traces-to-deep-archive"
    status = "Enabled"

    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "DEEP_ARCHIVE"
    }

    expiration {
      days = 5110
    }
  }
}

# ---------------------------------------------------------------------------
# Firehose: CloudWatch Logs -> S3 (every line, both prefixes)
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "firehose_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name               = "oxagen-logs-firehose"
  assume_role_policy = data.aws_iam_policy_document.firehose_assume.json
  tags               = { Brand = local.brand }
}

data "aws_iam_policy_document" "firehose_s3" {
  statement {
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.logs_archive.arn,
      "${aws_s3_bucket.logs_archive.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "firehose_s3" {
  name   = "write-archive-bucket"
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose_s3.json
}

resource "aws_kinesis_firehose_delivery_stream" "logs" {
  name        = "oxagen-logs-archive"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose.arn
    bucket_arn = aws_s3_bucket.logs_archive.arn
    prefix     = "logs/"

    buffering_size     = 5
    buffering_interval = 300
    compression_format = "GZIP"
  }

  tags = { Brand = local.brand }
}

resource "aws_kinesis_firehose_delivery_stream" "traces" {
  name        = "oxagen-traces-archive"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose.arn
    bucket_arn = aws_s3_bucket.logs_archive.arn
    prefix     = "traces/"

    buffering_size     = 5
    buffering_interval = 300
    compression_format = "GZIP"
  }

  tags = { Brand = local.brand }
}

# CloudWatch Logs delivers to Firehose through its own role, one per
# subscription filter's log group is not required — a single role scoped to
# both streams covers every log group below.
data "aws_iam_policy_document" "cwl_to_firehose_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cwl_to_firehose" {
  name               = "oxagen-cwl-to-firehose"
  assume_role_policy = data.aws_iam_policy_document.cwl_to_firehose_assume.json
  tags               = { Brand = local.brand }
}

data "aws_iam_policy_document" "cwl_to_firehose" {
  statement {
    actions = ["firehose:PutRecord", "firehose:PutRecordBatch"]
    resources = [
      aws_kinesis_firehose_delivery_stream.logs.arn,
      aws_kinesis_firehose_delivery_stream.traces.arn,
    ]
  }
}

resource "aws_iam_role_policy" "cwl_to_firehose" {
  name   = "write-firehose"
  role   = aws_iam_role.cwl_to_firehose.id
  policy = data.aws_iam_policy_document.cwl_to_firehose.json
}

# Every service's full log stream, unfiltered, to the archive.
resource "aws_cloudwatch_log_subscription_filter" "archive" {
  for_each = aws_cloudwatch_log_group.service

  name            = "archive-to-s3"
  log_group_name  = each.value.name
  filter_pattern  = ""
  destination_arn = aws_kinesis_firehose_delivery_stream.logs.arn
  role_arn        = aws_iam_role.cwl_to_firehose.arn
}

# ---------------------------------------------------------------------------
# EventBridge — the error/warning/incident stream
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_event_bus" "incidents" {
  name = "oxagen-incidents"
  tags = { Brand = local.brand }
}

data "archive_file" "log_event_publisher" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/log-event-publisher"
  output_path = "${path.module}/lambda/log-event-publisher.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "log_event_publisher" {
  name               = "oxagen-log-event-publisher"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = { Brand = local.brand }
}

resource "aws_iam_role_policy_attachment" "log_event_publisher_basic" {
  role       = aws_iam_role.log_event_publisher.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "log_event_publisher_publish" {
  statement {
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.incidents.arn]
  }
}

resource "aws_iam_role_policy" "log_event_publisher_publish" {
  name   = "publish-to-incidents-bus"
  role   = aws_iam_role.log_event_publisher.id
  policy = data.aws_iam_policy_document.log_event_publisher_publish.json
}

resource "aws_lambda_function" "log_event_publisher" {
  function_name = "oxagen-log-event-publisher"
  role          = aws_iam_role.log_event_publisher.arn
  handler       = "index.handler"
  runtime       = "python3.13"
  architectures = ["arm64"]
  timeout       = 30
  memory_size   = 128

  filename         = data.archive_file.log_event_publisher.output_path
  source_code_hash = data.archive_file.log_event_publisher.output_base64sha256

  environment {
    variables = {
      EVENT_BUS_NAME = aws_cloudwatch_event_bus.incidents.name
    }
  }

  tags = { Brand = local.brand }
}

resource "aws_lambda_permission" "cwl_invoke" {
  for_each = aws_cloudwatch_log_group.service

  statement_id  = "AllowCloudWatchLogs-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.log_event_publisher.function_name
  principal     = "logs.${var.region}.amazonaws.com"
  source_arn    = "${each.value.arn}:*"
}

# Matches common warning/error/incident markers. Case-sensitive by design —
# CloudWatch Logs filter patterns are, and a service logging lowercase
# "error" should say so in its own log format rather than this pattern
# guessing at every casing convention every service might use.
resource "aws_cloudwatch_log_subscription_filter" "incidents" {
  for_each = aws_cloudwatch_log_group.service

  name            = "publish-incidents"
  log_group_name  = each.value.name
  filter_pattern  = "?ERROR ?WARN ?FATAL ?CRITICAL ?\"incident\" ?\"outage\""
  destination_arn = aws_lambda_function.log_event_publisher.arn

  depends_on = [aws_lambda_permission.cwl_invoke]
}

# ---------------------------------------------------------------------------
# ALB access logs -> S3
# ---------------------------------------------------------------------------

data "aws_elb_service_account" "main" {}

data "aws_iam_policy_document" "alb_logs_bucket" {
  statement {
    sid = "ALBLogDelivery"
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.main.arn]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs_archive.arn}/alb/*"]
  }

  statement {
    sid = "ALBLogDeliveryLogsService"
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs_archive.arn}/alb/*"]
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.logs_archive.id
  policy = data.aws_iam_policy_document.alb_logs_bucket.json
}
