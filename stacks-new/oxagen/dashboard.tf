/**
 * One operational dashboard: ALB traffic and health, the app node's own
 * vitals, Aurora's capacity usage, Redshift's capacity usage, and an
 * error-rate graph built from the same log groups observability.tf ships to
 * CloudWatch. A CloudWatch Dashboard rather than Amazon Managed Grafana —
 * the latter bills per user per month on top of its data source costs,
 * which is real money for a dashboard nobody but this account's own
 * operators will ever open.
 */

resource "aws_cloudwatch_dashboard" "oxagen" {
  dashboard_name = "oxagen"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ALB — requests and 5xx"
          region = var.region
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.app.arn_suffix, { stat = "Sum" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.app.arn_suffix, { stat = "Sum" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.app.arn_suffix, { stat = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "App node — CPU and status checks"
          region = var.region
          metrics = [
            ["AWS/EC2", "CPUUtilization", "InstanceId", module.app.instance_id],
            ["AWS/EC2", "StatusCheckFailed", "InstanceId", module.app.instance_id],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Aurora — capacity and connections"
          region = var.region
          metrics = [
            ["AWS/RDS", "ServerlessDatabaseCapacity", "DBClusterIdentifier", aws_rds_cluster.postgres.cluster_identifier],
            ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", aws_rds_cluster.postgres.cluster_identifier],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Redshift Serverless — RPU capacity"
          region = var.region
          metrics = [
            ["AWS/Redshift-Serverless", "ComputeCapacity", "Workgroup", aws_redshiftserverless_workgroup.oxagen.workgroup_name],
          ]
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 12
        width  = 24
        height = 8
        properties = {
          title  = "Errors and warnings, last 3 hours — every service"
          region = var.region
          view   = "table"
          query  = <<-QUERY
            SOURCE ${join(" | SOURCE ", [for s in local.log_group_services : "'/oxagen-app/${s}'"])}
            | fields @timestamp, @logStream, @message
            | filter @message like /(?i)(error|warn|fatal|critical|incident|outage)/
            | sort @timestamp desc
            | limit 100
          QUERY
        }
      },
    ]
  })
}
