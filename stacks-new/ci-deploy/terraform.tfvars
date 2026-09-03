account_id = "916294258235"

# tofu -chdir=stacks-new/oxagen output app_node_instance_id
node_instance_id = "i-094fcb34c7e715cf8"
# tofu -chdir=stacks-new/oxagen output app_node_role_name
node_role_name = "oxagen-app-node"

# Copied by hand from each brand stack's own output, same pattern the old
# account's ci-deploy uses:
# tofu -chdir=stacks-new/cgp output site
# tofu -chdir=stacks-new/oxagen output web
sites = {
  cgp = {
    bucket          = "cgp-site-916294258235"
    distribution_id = "E3FOT1HB57C89U"
  }
  oxagen-web = {
    bucket          = "oxagen-web-916294258235"
    distribution_id = "E2NYX5PXV8HXB3"
  }
}

# GitHub numeric id for this repository, so the OpenTofu roles trust an
# identity that survives a rename. Read with:
#   gh api repos/macanderson/oxagen-aws-infra -q .id
infra_repo_id = 1355538788
