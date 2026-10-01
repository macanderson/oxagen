# Vendored files

`start-runner.sh` is `modules/runners/templates/start-runner.sh` from
[github-aws-runners/terraform-aws-github-runner](https://github.com/github-aws-runners/terraform-aws-github-runner)
at `v7.11.0` (commit `11ea3112e617adc392d6a652a94f4c7640ddc650`), unchanged.
SHA-256: `4de3a758bd73c27e6b50c3e39536c130e9182edc7019eee3456509bc0ae4505b`.

It is a Terraform template. `image.tf` renders it with `metadata_tags = "enabled"`
and wraps it in `../start-runner.sh.tftpl`. Copy it again from the new tag
whenever the module version in `runners.tf` changes, because the scale-up
Lambda and this script agree on the Parameter Store paths and instance tags
they share.
