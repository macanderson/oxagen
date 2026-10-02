/**
 * Service-linked roles for EC2 Spot, EC2 Fleet, and Image Builder.
 *
 * The CI runner pools created these, and the pools are gone (#5218).
 * The roles stay because they belong to the whole account: deleting one
 * breaks any later Spot, Fleet, or Image Builder use in it, and they cost
 * nothing.
 */

resource "aws_iam_service_linked_role" "spot" {
  aws_service_name = "spot.amazonaws.com"
  description      = "EC2 Spot, for the CI runner fleets."
}

resource "aws_iam_service_linked_role" "fleet" {
  aws_service_name = "ec2fleet.amazonaws.com"
  description      = "EC2 Fleet, for the CI runner fleets."
}

resource "aws_iam_service_linked_role" "image_builder" {
  aws_service_name = "imagebuilder.amazonaws.com"
  description      = "EC2 Image Builder, for the CI runner image."
}
