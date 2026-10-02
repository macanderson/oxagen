account_id = "916294258235"

# https://github.com/actions/runner/releases/tag/v2.337.0, the SHA-256 lines
# under "BEGIN SHA linux-x64" and "BEGIN SHA linux-arm64".
runner_version = {
  version = "2.337.0"
  sha256 = {
    x64   = "70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
    arm64 = "9b1dc70626422526e3c94767cf024896beb15da5342a3f4819bf2feac13e0393"
  }
}

# .node-version on main.
node_version = "24.21.0"

# Every private repository in the organization on 2026-10-01, except the
# namespace probe. Public repositories never belong here.
private_repositories = [
  "product",
  "gtm",
  "roadmap",
  "cgp-website",
  "oxagen-survey",
  "oxagen-cookbook",
  "oxagen-evals",
  "oxagen-wrapped-agents",
  "oxagen-scratch",
  "oxagen-gtm",
]

# The App exists (id 5153708) and its id, key, and webhook secret are in
# Parameter Store (2026-10-01).
github_app_ready = true

# Idle runners per pool. Mac chose speed over concurrency on 2026-10-01, so
# the heavy pipeline jobs run on oxagen-large-x64 and ten of those wait warm,
# enough for one pull request's heavy lanes to start at once. Ten small
# runners carry the light jobs and housekeeping. The account holds 300 spot
# and 300 on-demand vCPUs, so the warm pools hold 216 of them idle.
warm_pool = {
  "oxagen-large-arm64" = 0
  "oxagen-large-x64"   = 10
  "oxagen-small-arm64" = 0
  "oxagen-small-x64"   = 10
  "oxagen-deploy"      = 1
}

alarm_email        = "mac@oxagen.sh"
monthly_budget_usd = 20000
