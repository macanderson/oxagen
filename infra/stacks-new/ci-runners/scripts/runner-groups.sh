#!/usr/bin/env bash
# Creates or updates the two organization runner groups the CI pools join
# (ADR-246, decision 7). Safe to run again: it finds each group by name and
# sets it to the state below.
#
#   oxagen-ci          the organization's private repositories, listed by id
#   oxagen-production  oxageninc/product only, and only these workflows on main
#
# oxagen-ci lists the private repositories one by one. GitHub's `private`
# visibility would admit new private repositories by itself, but on
# 2026-10-01 the API accepted it and stored `all` instead. A list that the
# script rebuilds from the organization's private repositories on every run
# admits no public repository whatever GitHub does with the setting. Run this
# again after creating a private repository.
#
# Needs a GitHub token with admin:org (`gh auth refresh -s admin:org`).
# Terraform does not own these because the stack has no GitHub credential at
# plan time. This script is the record, and running it recreates them.
set -euo pipefail

org=oxageninc
repo=product
# Every workflow with a job that declares `environment: production`. Those
# jobs, and only those, ask for the oxagen-deploy label.
deploy_workflows=(
  pipeline.yml
  db-migrate.yml
  desktop.yml
  infra.yml
  store-migrate.yml
  store-migrate-drift.yml
  stripe-sync.yml
  where-is-production.yml
)

group_id() {
  gh api "orgs/$org/actions/runner-groups?per_page=100" \
    --jq ".runner_groups[] | select(.name == \"$1\") | .id"
}

upsert() {
  local name=$1 body=$2 id
  id=$(group_id "$name")
  if [ -z "$id" ]; then
    gh api -X POST "orgs/$org/actions/runner-groups" --input - <<<"$body" --jq '"created \(.name) id=\(.id)"'
  else
    # An update takes no repository list. The PUT after each upsert sets it.
    gh api -X PATCH "orgs/$org/actions/runner-groups/$id" --input - \
      <<<"$(jq 'del(.selected_repository_ids)' <<<"$body")" --jq '"updated \(.name) id=\(.id)"'
  fi
}

private_ids=$(gh api "orgs/$org/repos?type=private&per_page=100" --paginate \
  --jq '.[] | select(.private and (.archived | not)) | .id' | jq -s .)

upsert oxagen-ci "$(jq -n --argjson ids "$private_ids" '{
  name: "oxagen-ci",
  visibility: "selected",
  selected_repository_ids: $ids,
  allows_public_repositories: false,
  restricted_to_workflows: false
}')"
gh api -X PUT "orgs/$org/actions/runner-groups/$(group_id oxagen-ci)/repositories" \
  --input - <<<"{\"selected_repository_ids\": $private_ids}"

repo_id=$(gh api "repos/$org/$repo" --jq .id)
workflows_json=$(printf '%s\n' "${deploy_workflows[@]}" \
  | jq -R --arg r "$org/$repo" '"\($r)/.github/workflows/\(.)@refs/heads/main"' | jq -s .)

body=$(jq -n --argjson ids "[$repo_id]" --argjson wf "$workflows_json" '{
  name: "oxagen-production",
  visibility: "selected",
  selected_repository_ids: $ids,
  allows_public_repositories: false,
  restricted_to_workflows: true,
  selected_workflows: $wf
}')
upsert oxagen-production "$body"

id=$(group_id oxagen-production)
gh api -X PUT "orgs/$org/actions/runner-groups/$id/repositories" \
  --input - <<<"{\"selected_repository_ids\": [$repo_id]}"

gh api "orgs/$org/actions/runner-groups?per_page=100" --jq '.runner_groups[]
  | select(.name | startswith("oxagen-"))
  | {name, visibility, allows_public_repositories, restricted_to_workflows, selected_workflows}'
