#!/usr/bin/env bash
# Puts the job workspace and Docker's volumes on local NVMe when the instance
# type has it (m8gd, c8gd, m7gd, m6id and the like). Runs once per boot from
# ci-local-disk.service, before Docker and before the runner starts.
#
# Local NVMe is several times faster than EBS for the small-file churn of
# `pnpm install`, a build's output, and the service containers' databases.
# The pre-pulled images stay on the root volume, so nothing has to be pulled
# again. An instance type without local NVMe keeps everything on EBS, and this
# script exits without changing anything.
set -euo pipefail

disks=()
for dev in /dev/nvme*n1; do
  [ -b "$dev" ] || continue
  model=$(tr -d '[:space:]' < "/sys/block/$(basename "$dev")/device/model" 2>/dev/null || true)
  if [ "$model" = "AmazonEC2NVMeInstanceStorage" ]; then
    disks+=("$dev")
  fi
done

if [ "${#disks[@]}" -eq 0 ]; then
  echo "ci-local-disk: no instance store. The workspace stays on EBS."
  exit 0
fi

if [ "${#disks[@]}" -gt 1 ]; then
  mdadm --create /dev/md0 --level=0 --raid-devices="${#disks[@]}" "${disks[@]}" --force --run
  target=/dev/md0
else
  target=${disks[0]}
fi

# -K skips the discard pass. Instance store arrives empty, and discarding
# hundreds of GB would add seconds to every boot.
mkfs.xfs -f -K "$target"
mkdir -p /mnt/local
mount -o noatime "$target" /mnt/local
mkdir -p /mnt/local/work /mnt/local/docker-volumes

mkdir -p /opt/actions-runner/_work /var/lib/docker/volumes
mount --bind /mnt/local/work /opt/actions-runner/_work
mount --bind /mnt/local/docker-volumes /var/lib/docker/volumes
chown runner:runner /mnt/local/work

echo "ci-local-disk: workspace and Docker volumes on ${target}."
