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
# the heavy pipeline jobs run on oxagen-large-x64, and six of those wait warm.
# Six is one pull request's large jobs once #5056 moves rls-integration and
# rds-compatibility to the small pool: checks, e2e, and the four unit lanes
# (#5070). Ten small runners carry the build lanes, the light jobs, and
# housekeeping. The warm pools hold 152 vCPUs idle.
warm_pool = {
  "oxagen-large-arm64" = 0
  "oxagen-large-x64"   = 6
  "oxagen-small-arm64" = 0
  "oxagen-small-x64"   = 10
  "oxagen-deploy"      = 1
}

# The most runners each pool holds at once, idle and busy together (#5070).
# The account has 300 spot and 300 on-demand vCPUs. The deploy pool and
# production run on on-demand only. The large pools never use on-demand
# (`on_demand` in runners.tf), so only the small pools can compete with them:
#
#   300 on-demand vCPUs
#   - 144 for the small pools at most (36 runners x 4 vCPUs)
#   -  96 for the deploy pool (6 runners x 16 vCPUs)
#   -   6 for production (the oxagen-app node and the NAT instance)
#   =  54 spare, enough to replace a production node
#
# The large cap of 22 (352 vCPUs) sits above the 300-vCPU spot quota, so
# spot limits the large pool first. On 2026-10-02, with both pools falling
# back to on-demand, CI held both quotas full, and the deploy pool's
# scale-up failed with VcpuLimitExceeded 161 times in four hours. Raise
# these when AWS approves the open quota requests (2,400 spot and 1,000
# on-demand). Each arm64 pool gets the same cap as its x64 twin, because
# CI_RUNNER_ARCH sends every job to one or the other.
max_runners = {
  "oxagen-large-arm64" = 22
  "oxagen-large-x64"   = 22
  "oxagen-small-arm64" = 36
  "oxagen-small-x64"   = 36
  "oxagen-deploy"      = 6
}

alarm_email        = "mac@oxagen.sh"
monthly_budget_usd = 20000
