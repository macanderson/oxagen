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

# Set to true once scripts/store-github-app.sh has written the App's values.
github_app_ready = false

# Idle runners per pool once the App is ready. Speed first (Mac, 2026-10-01).
warm_pool = {
  "oxagen-large-arm64" = 30
  "oxagen-large-x64"   = 10
  "oxagen-small-arm64" = 20
  "oxagen-small-x64"   = 4
  "oxagen-deploy"      = 1
}

alarm_email        = "mac@oxagen.sh"
monthly_budget_usd = 15000
