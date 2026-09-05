account_id = "578673726240"

node_instance_id = "i-023d002d6e44f8f84"
node_role_name   = "oxagen-data-node"
deploy_bucket    = "oxagen-deploy-578673726240"

# Copied from the brand stacks' outputs rather than read across state. Remote
# state between stacks would make every deploy-permission apply depend on
# another stack's state being readable and current, which is the coupling the
# separate state keys exist to avoid. These two identifiers change only if a
# distribution is replaced, and a wrong one fails loudly on the first
# invalidation rather than quietly.
sites = {
  # tofu -chdir=stacks/cgp output site
  cgp = {
    bucket          = "cgp-site-578673726240"
    distribution_id = "EPNX5MRWY4Y58"
  }

  # tofu -chdir=stacks/oxagen output web
  oxagen-web = {
    bucket          = "oxagen-web-578673726240"
    distribution_id = "E291NC0ETAP42G"
  }
}
