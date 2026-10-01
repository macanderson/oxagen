#!/usr/bin/env bash
# Provisions an Oxagen CI runner image on Ubuntu 24.04 (ADR-246, decision 5).
#
# EC2 Image Builder runs this on a build instance:
#
#   provision.sh build    <dir>   install everything below
#   provision.sh validate <dir>   check the image before Image Builder snapshots it
#
# <dir> holds the files Terraform uploaded beside this script: config.json,
# start-runner.sh, daemon.json, and the ci-start-runner, ci-local-disk, and
# ci-volume-warm units and scripts.
#
# The image carries what a job would otherwise download first: the runner
# agent, Docker, the host tools our workflows call, Node in the runner's tool
# cache, every CI and service container image, and the pnpm store. A cold
# runner downloads nothing large before its job starts.
set -euxo pipefail

mode=${1:?build or validate}
dir=${2:?directory with config.json}
config="$dir/config.json"

export DEBIAN_FRONTEND=noninteractive
deb_arch=$(dpkg --print-architecture) # amd64 or arm64
case "$deb_arch" in
  amd64) runner_arch=x64; aws_arch=x86_64; ssm_arch=ubuntu_64bit ;;
  arm64) runner_arch=arm64; aws_arch=aarch64; ssm_arch=ubuntu_arm64 ;;
  *) echo "unsupported architecture $deb_arch" >&2; exit 1 ;;
esac

# Retries a command that reaches the network. A daily build that fails on one
# dropped connection leaves runners on yesterday's image.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 5 ]; then return 1; fi
    sleep $((n * 5))
  done
}

build() {
  # The base image's own first boot may still hold the apt lock.
  cloud-init status --wait || true

  retry apt-get update
  retry apt-get -y install jq
  local runner_version runner_sha node_version bucket
  runner_version=$(jq -r .runner_version "$config")
  runner_sha=$(jq -r --arg a "$runner_arch" '.runner_sha256[$a]' "$config")
  node_version=$(jq -r .node_version "$config")
  bucket=$(jq -r .assets_bucket "$config")

  # --- Host packages -------------------------------------------------------
  # The tools GitHub's ubuntu-24.04 image ships that our host-level jobs and
  # composite actions call. Jobs that run in a container bring their own.
  retry apt-get -y install --no-install-recommends \
    acl build-essential ca-certificates curl fd-find file fio git git-lfs gnupg \
    lsb-release mdadm nvme-cli openssh-client pigz postgresql-client \
    python3 python3-pip python3-venv pipx ripgrep rsync shellcheck \
    software-properties-common sudo time tree unzip wget xfsprogs xz-utils \
    zip zstd
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd

  # Docker CE from Docker's own repository, with buildx and compose.
  install -m 0755 -d /etc/apt/keyrings
  retry curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$deb_arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list

  # GitHub CLI from GitHub's repository.
  retry curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
  chmod a+r /etc/apt/keyrings/githubcli.gpg
  echo "deb [arch=$deb_arch signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list

  retry apt-get update
  retry apt-get -y install --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh
  install -m 0644 "$dir/daemon.json" /etc/docker/daemon.json
  systemctl enable docker.service containerd.service
  systemctl restart docker.service

  # AWS CLI v2, the Session Manager plugin (migration-gate's store tunnels),
  # and the CloudWatch agent the runner's start script configures.
  local tmp
  tmp=$(mktemp -d)
  retry curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$aws_arch.zip" -o "$tmp/awscli.zip"
  unzip -q "$tmp/awscli.zip" -d "$tmp"
  "$tmp/aws/install" --update
  retry curl -fsSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/$ssm_arch/session-manager-plugin.deb" -o "$tmp/ssm.deb"
  dpkg -i "$tmp/ssm.deb"
  retry curl -fsSL "https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/$deb_arch/latest/amazon-cloudwatch-agent.deb" -o "$tmp/cwagent.deb"
  dpkg -i "$tmp/cwagent.deb"

  # --- The runner user -----------------------------------------------------
  # Named `runner` with uid 1001 and passwordless sudo, like GitHub's hosted
  # image, because our workflows call `sudo` and some paths assume that home.
  if ! id runner >/dev/null 2>&1; then
    useradd --create-home --uid 1001 --shell /bin/bash runner
  fi
  usermod -aG docker,adm,systemd-journal runner
  echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
  chmod 0440 /etc/sudoers.d/runner

  # --- The runner agent ----------------------------------------------------
  mkdir -p /opt/actions-runner /opt/hostedtoolcache
  retry curl -fsSL \
    "https://github.com/actions/runner/releases/download/v$runner_version/actions-runner-linux-$runner_arch-$runner_version.tar.gz" \
    -o "$tmp/runner.tar.gz"
  echo "$runner_sha  $tmp/runner.tar.gz" | sha256sum -c -
  tar -xzf "$tmp/runner.tar.gz" -C /opt/actions-runner
  /opt/actions-runner/bin/installdependencies.sh
  cat > /opt/actions-runner/.env <<EOF
ImageOS=ubuntu24
ImageVersion=$(date -u +%Y%m%d)
RUNNER_TOOL_CACHE=/opt/hostedtoolcache
AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
LANG=C.UTF-8
EOF
  chown -R runner:runner /opt/actions-runner /opt/hostedtoolcache

  # Node in the tool cache at the version .node-version pins, so
  # actions/setup-node finds it instead of downloading it.
  local node_dir="/opt/hostedtoolcache/node/$node_version/$runner_arch"
  retry curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$runner_arch.tar.xz" -o "$tmp/node.tar.xz"
  retry curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$tmp/node.sums"
  (cd "$tmp" && grep " node-v$node_version-linux-$runner_arch.tar.xz\$" node.sums | sed "s# node-v.*# node.tar.xz#" | sha256sum -c -)
  mkdir -p "$node_dir"
  tar -xJf "$tmp/node.tar.xz" -C "$node_dir" --strip-components=1
  touch "$node_dir.complete"
  chown -R runner:runner /opt/hostedtoolcache

  # The module's start script reads its settings from the instance's tags and
  # Parameter Store, registers, and runs one job. A systemd unit starts it as
  # soon as the network and Docker are up, about 20 seconds into boot. The
  # module's own images use cloud-init's per-boot directory, which runs it at
  # about 57 seconds, and which Image Builder's end-of-build cleanup empties.
  install -m 0755 "$dir/start-runner.sh" /usr/local/sbin/ci-start-runner
  install -m 0644 "$dir/ci-start-runner.service" /etc/systemd/system/ci-start-runner.service
  systemctl enable ci-start-runner.service

  # Local NVMe, on the instance types that have it, carries the workspace and
  # Docker's volumes. It is formatted on each boot, before Docker starts.
  install -m 0755 "$dir/ci-local-disk.sh" /usr/local/sbin/ci-local-disk
  install -m 0644 "$dir/ci-local-disk.service" /etc/systemd/system/ci-local-disk.service
  systemctl enable ci-local-disk.service

  # The root volume comes from the AMI's snapshot and loads lazily. This reads
  # it once at boot, in the background, so the images and the store are local
  # before a job needs them.
  install -m 0755 "$dir/ci-volume-warm.sh" /usr/local/sbin/ci-volume-warm
  install -m 0644 "$dir/ci-volume-warm.service" /etc/systemd/system/ci-volume-warm.service
  systemctl enable ci-volume-warm.service

  # --- Container images ----------------------------------------------------
  # Every image a CI job starts, for this architecture. The runner still asks
  # the registry for the tag at job time, and finds the layers already here.
  # A missing image is a warning, not a failed build: the first build can run
  # before ci-image.yml has published, and the GHCR images are amd64 only, so
  # the arm64 build cannot pull them. A job pulls what the image lacks.
  jq -r '.images[]' "$config" | while read -r image; do
    retry docker pull "$image" || echo "WARNING: could not pull $image for $deb_arch. Jobs will pull it."
  done

  # --- pnpm store ----------------------------------------------------------
  # ci-image.yml publishes a store for each architecture. It is optional: a
  # missing store only means the first install of the day downloads packages.
  if aws s3 cp "s3://$bucket/pnpm-store/$runner_arch.tar.zst" "$tmp/store.tar.zst" --only-show-errors; then
    mkdir -p /opt/pnpm-store
    tar --zstd -xf "$tmp/store.tar.zst" -C /opt/pnpm-store
    chown -R runner:runner /opt/pnpm-store
  else
    echo "No pnpm store for $runner_arch yet. Continuing without one."
  fi

  # --- Clean up ------------------------------------------------------------
  rm -rf "$tmp"
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  docker builder prune -af || true
}

validate() {
  local node_version
  node_version=$(jq -r .node_version "$config")
  docker version
  docker buildx version
  docker compose version
  aws --version
  session-manager-plugin --version
  gh --version
  git --version
  jq --version
  test -x /opt/actions-runner/run.sh
  test -x /usr/local/sbin/ci-start-runner
  systemctl is-enabled ci-start-runner.service
  "/opt/hostedtoolcache/node/$node_version/$runner_arch/bin/node" --version
  systemctl is-enabled ci-local-disk.service
  systemctl is-enabled ci-volume-warm.service
  fio --version
  id runner
  jq -r '.images[]' "$config" | while read -r image; do
    docker image inspect "$image" >/dev/null 2>&1 || echo "not baked: $image"
  done
}

"$mode"
