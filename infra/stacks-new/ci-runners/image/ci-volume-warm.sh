#!/usr/bin/env bash
# Reads the whole root volume once, at boot, so its blocks come down from the
# AMI's snapshot now rather than when a job first touches them.
#
# A volume made from a snapshot fetches each block from S3 the first time it
# is read. The image carries Docker images and the pnpm store, and a job that
# starts a 2 GB container on an unread volume waits on that fetch. One
# sequential read at a deep queue runs at the volume's provisioned throughput
# (1,000 MB/s on the large pools), so a warm-pool runner is fully read long
# before it takes a job, and a cold one is mostly read by the time its job
# needs the data. Blocks the snapshot never held read back as zeros at once.
set -euo pipefail

root_part=$(findmnt -n -o SOURCE /)
root_disk="/dev/$(lsblk -no PKNAME "$root_part")"

exec nice -n 10 fio --name=warm --filename="$root_disk" --rw=read --bs=1M \
  --iodepth=32 --ioengine=libaio --direct=1 --readonly
