# Tacho intake alert

The remaining #3167 gap was an alert scoped to Tacho request failures. Added a CloudWatch request-log metric filter and a three-period alarm, with fixture assertions against the actual Terraform. AWS test-metric-filter accepted the pattern and selected only Tacho 500/503 events. It excluded 200, 429, unrelated paths, and non-request records.

The independent coverage audit required explicit zero-default and missing-data assertions. Both now pin the documented no-traffic behavior. No local test suite ran. No Terraform apply or live failure canary ran. The existing SNS topic has no subscriptions, so delivered alert proof remains outstanding.
