/**
 * The platform's own services, which answer from the shared node rather than
 * from a CDN.
 *
 * `oxagen.sh` and `docs.oxagen.sh` above are websites and belong on CloudFront.
 * These three are applications: they hold sessions, write to Postgres, read
 * Neo4j and ClickHouse, and reach all three over loopback because that is the
 * only way to reach them — every database port is bound to 127.0.0.1 on the
 * instance and the security group opens no inbound port at all. A Lambda in
 * front of them would need the VPC, and a VPC-attached Lambda needs a NAT
 * gateway costing more per month than everything else in this account
 * combined.
 *
 * So they are plain `A` records at the instance, and Caddy on the node routes
 * by hostname and terminates TLS. There is no CloudFront distribution and no
 * ACM certificate for these three: Caddy gets its own from Let's Encrypt,
 * which the zone's CAA already authorises.
 *
 * `stella.oxagen.sh` and `docs.oxagen.sh` are served the same way today, but
 * their records are NOT here — each is an alias to a CloudFront distribution,
 * created by the module that owns the site, and repointed at this instance by
 * hand during the migration. That is drift, it is deliberate for now, and it
 * is not repaired in this file: a plan that rewrites a live record for a site
 * that is currently serving is a bigger change than adding three that do not
 * exist yet.
 */

variable "node_public_ip" {
  description = <<-EOT
    Elastic IP of the shared application node. An EIP rather than the
    instance's assigned address, which is what makes these records survive a
    stop/start — the ordinary public IPv4 address is released on stop and the
    instance comes back on a different one, which would take every hostname
    here down until someone noticed and edited DNS.
  EOT
  type        = string
}

locals {
  # host -> what answers on it. The port each one listens on is NOT here: it is
  # declared by the artifact the repository publishes (`oxagen-run.json`) and
  # read by the node's deploy script, so a service changing its port is a
  # change to the repository that owns it rather than an infrastructure apply.
  node_services = {
    "app.oxagen.sh" = "The product — Next.js, sessions, Server Actions."
    "api.oxagen.sh" = "The Hono API: /v1, Stripe webhooks, the Inngest handler."
    "mcp.oxagen.sh" = "The MCP server."
  }
}

resource "aws_route53_record" "node_service" {
  for_each = local.node_services

  zone_id = aws_route53_zone.oxagen_sh.zone_id
  name    = each.key
  type    = "A"

  # Five minutes. Long enough that these are not re-resolved on every request,
  # short enough that moving a service off this node — or onto a replacement
  # instance after a failure — is a change that propagates within the length of
  # an incident rather than a working day.
  ttl     = 300
  records = [var.node_public_ip]
}
