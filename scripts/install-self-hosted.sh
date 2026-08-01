#!/usr/bin/env bash
set -euo pipefail
umask 077

# Credentials deliberately stay out of this command line. Configure the model
# provider through the platform administrator page after deployment.
readonly NODE_VERSION="24.18.1"
readonly NODE_ARCHIVE_SHA256="d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0"
readonly HELM_VERSION="v3.18.6"
readonly HELM_ARCHIVE_SHA256="3f43c0aa57243852dd542493a0f54f1396c0bc8ec7296bbb2c01e802010819ce"
readonly K3S_VERSION="v1.36.2+k3s1"
readonly K3S_INSTALLER_SHA256="46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"
readonly CUBE_COMMIT="8721dd151971ce3c2966482bbd32904ad98f378e"
readonly CUBE_REPOSITORY_URL="https://github.com/TencentCloud/CubeSandbox.git"

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_directory="${repository_root}/deploy/production/runtime"
cube_repository="${repository_root}/.cache/sources/CubeSandbox-${CUBE_COMMIT}"
if [[ -d "${repository_root}/../CubeSandbox/.git" ]]; then
  cube_repository="$(cd "${repository_root}/../CubeSandbox" && pwd)"
fi
bind_address="127.0.0.1"
http_port="8080"
bind_address_explicit="false"
http_port_explicit="false"
pi_workers=""
pi_workers_explicit="false"
assume_yes="false"
check_only="false"
print_plan_only="false"
skip_host_bootstrap="false"
current_phase="argument validation"
temporary_directory=""
docker_wrapper_directory=""

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Install or reconcile AgentDock on one x86_64 Linux host (native Linux or
WSL2 with systemd and KVM).

Options:
  --yes                         Skip the single confirmation prompt.
  --check-only                  Run read-only checks and exit.
  --print-plan                  Print the plan without checking or changing anything.
  --skip-host-bootstrap         Do not install OS packages, Docker, or K3s.
  --pi-workers MODE             MODE is kubernetes or compose. Fresh installs
                                 default to kubernetes.
  --runtime-dir PATH            Private runtime directory.
  --cube-repository PATH        Existing or AgentDock-managed Cube checkout.
  --bind-address ADDRESS        Fresh-install Web bind address (default: 127.0.0.1).
  --port PORT                   Fresh-install Web port (default: 8080).
  -h, --help                    Show this help.

The installer never accepts a model API key or administrator password. Configure
those through the administrator page after deployment.
EOF
}

log() { printf '\n[AgentDock] %s\n' "$*"; }
note() { printf '[AgentDock] %s\n' "$*"; }
fail() {
  printf '[AgentDock] ERROR (%s): %s\n' "${current_phase}" "$*" >&2
  exit 1
}
cleanup() {
  if [[ -n "${temporary_directory}" && -d "${temporary_directory}" ]]; then
    rm -rf -- "${temporary_directory}"
  fi
}
on_error() {
  local status=$?
  printf '\n[AgentDock] Installation stopped during: %s\n' "${current_phase}" >&2
  printf '[AgentDock] Fix the cause and run the same command again; completed phases are reused.\n' >&2
  exit "${status}"
}
trap cleanup EXIT
trap on_error ERR

absolute_path() {
  [[ "$1" == /* ]] && printf '%s\n' "$1" || printf '%s\n' "${repository_root}/$1"
}

while (($# > 0)); do
  case "$1" in
    --yes) assume_yes="true"; shift ;;
    --check-only) check_only="true"; shift ;;
    --print-plan) print_plan_only="true"; shift ;;
    --skip-host-bootstrap) skip_host_bootstrap="true"; shift ;;
    --pi-workers)
      (($# >= 2)) || fail "--pi-workers requires kubernetes or compose"
      pi_workers=$2; pi_workers_explicit="true"; shift 2 ;;
    --runtime-dir)
      (($# >= 2)) || fail "--runtime-dir requires a path"
      runtime_directory="$(absolute_path "$2")"; shift 2 ;;
    --cube-repository)
      (($# >= 2)) || fail "--cube-repository requires a path"
      cube_repository="$(absolute_path "$2")"; shift 2 ;;
    --bind-address)
      (($# >= 2)) || fail "--bind-address requires an address"
      bind_address=$2; bind_address_explicit="true"; shift 2 ;;
    --port)
      (($# >= 2)) || fail "--port requires a port"
      http_port=$2; http_port_explicit="true"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ -z "${pi_workers}" || "${pi_workers}" == "compose" || "${pi_workers}" == "kubernetes" ]] ||
  fail "--pi-workers must be kubernetes or compose"
[[ "${http_port}" =~ ^[0-9]+$ ]] || fail "--port must be an integer"
((http_port >= 1 && http_port <= 65535)) || fail "--port must be from 1 to 65535"
[[ -n "${bind_address}" && ! "${bind_address}" =~ [[:space:]] ]] || fail "bind address is invalid"
[[ ! "${runtime_directory}" =~ [$'\r\n'] && ! "${cube_repository}" =~ [$'\r\n'] ]] ||
  fail "paths cannot contain newlines"

print_plan() {
  cat <<EOF
AgentDock self-hosted deployment plan

  Repository:       ${repository_root}
  Runtime data:     ${runtime_directory}
  Cube source:      ${cube_repository}
  Web endpoint:     http://${bind_address}:${http_port}
  Pi Worker mode:   ${pi_workers:-kubernetes for a fresh deployment; preserve existing mode on rerun}

  1. Validate Linux x86_64, systemd, KVM, memory and disk capacity.
  2. Install required Debian/Ubuntu packages and Docker Engine when absent.
  3. Install checksum-verified Node.js ${NODE_VERSION} and Helm ${HELM_VERSION}.
  4. Install/reuse single-node K3s ${K3S_VERSION}.
  5. Check out CubeSandbox at ${CUBE_COMMIT}.
  6. Initialize private AgentDock/Cube runtime material.
  7. Reconcile Cube's KVM plane and register the Tool template.
  8. Build/start AgentDock and the selected Pi Worker Pool.
  9. Verify Web, Compose services and Worker Pool status.

No model credential or administrator password is read by this installer.
EOF
}

if [[ "${print_plan_only}" == "true" ]]; then print_plan; exit 0; fi

check_result_failures=0
check_pass() { printf '  [ok]   %s\n' "$1"; }
check_warn() { printf '  [warn] %s\n' "$1"; }
check_fail() { printf '  [fail] %s\n' "$1"; check_result_failures=$((check_result_failures + 1)); }
memory_kib() { awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo; }
available_disk_kib() { df -Pk "${repository_root}" | awk 'NR == 2 {print $4}'; }
available_disk_percent() { df -Pk "${repository_root}" | awk 'NR == 2 {gsub(/%/, "", $5); print 100 - $5}'; }
systemd_usable() {
  local state
  state="$(systemctl is-system-running 2>/dev/null || true)"
  [[ "${state}" == "running" || "${state}" == "degraded" ]]
}
docker_command_usable() {
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}
sudo_docker_usable() {
  sudo -n docker version --format '{{.Server.Version}}' >/dev/null 2>&1 &&
    sudo -n docker compose version >/dev/null 2>&1
}

run_read_only_checks() {
  current_phase="read-only preflight"
  log "Read-only deployment preflight"
  [[ "$(uname -s)" == "Linux" ]] && check_pass "Linux host" || check_fail "Linux is required"
  [[ "$(uname -m)" == "x86_64" ]] && check_pass "x86_64 architecture" || check_fail "Cube requires x86_64"
  systemd_usable && check_pass "systemd is available" || check_fail "systemd must be enabled"
  [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] && check_pass "/dev/kvm is usable" ||
    check_fail "read/write KVM access is required"
  local memory disk_kib disk_percent
  memory="$(memory_kib)"; disk_kib="$(available_disk_kib)"; disk_percent="$(available_disk_percent)"
  ((memory >= 7500000)) && check_pass "memory is at least 8 GB" ||
    check_fail "at least 8 GB RAM is required (found $((memory / 1024 / 1024)) GiB)"
  if ((disk_kib >= 40 * 1024 * 1024 && disk_percent >= 15)); then
    check_pass "disk has at least 40 GiB and 15% free"
  else
    check_fail "need at least 40 GiB and 15% free (found $((disk_kib / 1024 / 1024)) GiB, ${disk_percent}%)"
  fi
  if docker_command_usable; then
    check_pass "Docker Engine and Compose are usable"
  elif sudo_docker_usable; then
    check_warn "Docker works through passwordless sudo but this shell lacks direct access"
  else
    check_fail "Docker Engine and Compose are not usable"
  fi
  if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'; then
    check_pass "Node.js $(node --version) satisfies the repository engine"
  else
    check_warn "compatible Node.js absent; normal installation supplies a pinned copy"
  fi
  command -v helm >/dev/null 2>&1 && check_pass "Helm is available" ||
    check_warn "Helm absent; normal installation supplies a pinned copy"
  [[ -x /usr/local/bin/k3s && -e /etc/rancher/k3s/k3s.yaml ]] && check_pass "K3s is installed" ||
    check_fail "K3s and its kubeconfig are not installed"
  if [[ -d "${cube_repository}/.git" ]]; then
    [[ "$(git -C "${cube_repository}" rev-parse HEAD 2>/dev/null || true)" == "${CUBE_COMMIT}" ]] &&
      check_pass "CubeSandbox checkout is pinned" || check_fail "Cube checkout is at the wrong commit"
  else
    check_warn "Cube checkout absent; normal installation clones it"
  fi
  [[ -f "${runtime_directory}/deployment.json" ]] && check_pass "production runtime is initialized" ||
    check_warn "production runtime is not initialized"
  ((check_result_failures == 0)) || {
    printf '\n[AgentDock] Preflight found %d blocking condition(s).\n' "${check_result_failures}"
    return 1
  }
  printf '\n[AgentDock] Preflight passed.\n'
}

if [[ "${check_only}" == "true" ]]; then
  trap - ERR
  run_read_only_checks
  exit $?
fi

current_phase="host validation"
[[ "$(uname -s)" == "Linux" ]] || fail "only Linux is supported"
[[ "$(uname -m)" == "x86_64" ]] || fail "CubeSandbox requires x86_64"
[[ "$(id -u)" -ne 0 ]] || fail "run as the deployment user, not root; sudo is requested only when needed"
systemd_usable || fail "systemd must be enabled and running"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || fail "/dev/kvm must be readable and writable"
(( $(memory_kib) >= 7500000 )) || fail "CubeSandbox requires at least 8 GB RAM"
(( $(available_disk_kib) >= 40 * 1024 * 1024 )) || fail "installation requires 40 GiB free disk"
(( $(available_disk_percent) >= 15 )) || fail "installation requires at least 15% free disk"
[[ -r /etc/os-release ]] || fail "/etc/os-release is required"
# shellcheck disable=SC1091
source /etc/os-release
distribution_id="${ID:-}"
distribution_codename="${VERSION_CODENAME:-}"

print_plan
if [[ "${assume_yes}" != "true" ]]; then
  [[ -t 0 ]] || fail "non-interactive installation requires --yes"
  printf '\nThis installs host services and allocates a 25 GiB Cube XFS image. Continue? [y/N] '
  read -r answer
  [[ "${answer}" == "y" || "${answer}" == "Y" ]] || { note "Cancelled without host changes."; exit 0; }
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/agent-dock-install.XXXXXXXX")"
current_phase="privilege acquisition"
command -v sudo >/dev/null 2>&1 || fail "sudo is required"
sudo -v

base_commands=(curl git openssl tar xz sha256sum findmnt mountpoint ip awk sed)
base_packages=(ca-certificates curl git jq openssl tar gzip xz-utils coreutils util-linux iproute2 iptables xfsprogs e2fsprogs conntrack socat)

install_base_packages() {
  current_phase="base package installation"
  if [[ "${skip_host_bootstrap}" == "true" ]]; then
    local missing=() command
    for command in "${base_commands[@]}"; do command -v "${command}" >/dev/null 2>&1 || missing+=("${command}"); done
    ((${#missing[@]} == 0)) || fail "missing commands with --skip-host-bootstrap: ${missing[*]}"
    return
  fi
  [[ "${distribution_id}" == "debian" || "${distribution_id}" == "ubuntu" ]] ||
    fail "automatic bootstrap supports Debian/Ubuntu; install prerequisites and use --skip-host-bootstrap"
  [[ -n "${distribution_codename}" ]] || fail "VERSION_CODENAME is missing"
  log "Installing required host packages"
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${base_packages[@]}"
}

download_verified() {
  local url=$1 target=$2 expected=$3 actual
  curl --fail --location --silent --show-error "${url}" --output "${target}"
  actual="$(sha256sum "${target}" | awk '{print $1}')"
  [[ "${actual}" == "${expected}" ]] || fail "checksum mismatch for ${url}"
}

install_local_node() {
  current_phase="Node.js toolchain installation"
  local target="${repository_root}/.cache/tools/node-v${NODE_VERSION}-linux-x64"
  if [[ -x "${target}/bin/node" && "$("${target}/bin/node" --version)" == "v${NODE_VERSION}" ]]; then
    export PATH="${target}/bin:${PATH}"; return
  fi
  [[ ! -e "${target}" ]] || fail "invalid Node cache at ${target}; move it aside and rerun"
  log "Installing checksum-verified Node.js ${NODE_VERSION}"
  local archive="${temporary_directory}/node.tar.xz" staging="${temporary_directory}/node"
  download_verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    "${archive}" "${NODE_ARCHIVE_SHA256}"
  mkdir -p "${staging}" "$(dirname "${target}")"
  tar -xJf "${archive}" --strip-components=1 -C "${staging}"
  mv "${staging}" "${target}"
  export PATH="${target}/bin:${PATH}"
  [[ "$(node --version)" == "v${NODE_VERSION}" ]] || fail "pinned Node.js did not become active"
}

install_local_helm() {
  current_phase="Helm toolchain installation"
  local target="${repository_root}/.cache/tools/helm-v3.18.6"
  if [[ -x "${target}/helm" ]]; then export PATH="${target}:${PATH}"; return; fi
  [[ ! -e "${target}" ]] || fail "invalid Helm cache at ${target}; move it aside and rerun"
  log "Installing checksum-verified Helm ${HELM_VERSION}"
  local archive="${temporary_directory}/helm.tar.gz" staging="${temporary_directory}/helm"
  download_verified "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
    "${archive}" "${HELM_ARCHIVE_SHA256}"
  mkdir -p "${staging}" "$(dirname "${target}")"
  tar -xzf "${archive}" -C "${staging}"
  chmod 0755 "${staging}/linux-amd64/helm"
  mv "${staging}/linux-amd64" "${target}"
  export PATH="${target}:${PATH}"
}

install_docker_if_needed() {
  current_phase="Docker Engine installation"
  if docker_command_usable || sudo_docker_usable; then return; fi
  [[ "${skip_host_bootstrap}" != "true" ]] || fail "Docker Engine and Compose are required"
  [[ "${distribution_id}" == "debian" || "${distribution_id}" == "ubuntu" ]] ||
    fail "automatic Docker installation supports Debian/Ubuntu only"
  local conflict
  for conflict in docker.io docker-compose docker-doc podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "${conflict}" 2>/dev/null | grep -q 'install ok installed'; then
      fail "conflicting package ${conflict} is installed; migrate/remove it explicitly before Docker CE"
    fi
  done
  log "Installing Docker Engine from Docker's official apt repository"
  local key="${temporary_directory}/docker.asc" sources="${temporary_directory}/docker.sources"
  curl --fail --location --silent --show-error \
    "https://download.docker.com/linux/${distribution_id}/gpg" --output "${key}"
  local architecture
  architecture="$(dpkg --print-architecture)"
  cat >"${sources}" <<EOF
Types: deb
URIs: https://download.docker.com/linux/${distribution_id}
Suites: ${distribution_codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "${key}" /etc/apt/keyrings/docker.asc
  sudo install -m 0644 "${sources}" /etc/apt/sources.list.d/docker.sources
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
}

enable_docker_for_current_run() {
  current_phase="Docker access configuration"
  if docker_command_usable; then return; fi
  sudo docker version --format '{{.Server.Version}}' >/dev/null
  sudo docker compose version >/dev/null
  getent group docker >/dev/null 2>&1 && sudo usermod -aG docker "$(id -un)"
  docker_wrapper_directory="${temporary_directory}/docker-wrapper"
  mkdir -m 0700 "${docker_wrapper_directory}"
  local docker_binary
  docker_binary="$(command -v docker)"
  cat >"${docker_wrapper_directory}/docker" <<EOF
#!/usr/bin/env bash
exec sudo "${docker_binary}" "\$@"
EOF
  chmod 0700 "${docker_wrapper_directory}/docker"
  export PATH="${docker_wrapper_directory}:${PATH}"
  docker_command_usable || fail "Docker could not be used through the temporary sudo wrapper"
  check_warn "Docker group membership activates after the next login; this run uses a private sudo wrapper"
}

write_fresh_k3s_configuration() {
  local config="${temporary_directory}/k3s-config.yaml"
  cat >"${config}" <<'EOF'
write-kubeconfig-mode: "0600"
tls-san:
  - agent-dock-kubernetes
disable:
  - traefik
  - servicelb
  - metrics-server
secrets-encryption: true
kubelet-arg:
  - pod-max-pids=128
EOF
  sudo install -d -m 0755 /etc/rancher/k3s
  if [[ ! -e /etc/rancher/k3s/config.yaml ]]; then
    sudo install -m 0644 "${config}" /etc/rancher/k3s/config.yaml
  fi

  if grep -qi microsoft-standard-wsl /proc/sys/kernel/osrelease; then
    local helper="${temporary_directory}/agent-dock-prepare-k3s-wsl"
    cat >"${helper}" <<'EOF'
#!/bin/sh
set -eu

if ! ip link show dev agentdock0 >/dev/null 2>&1; then
  ip link add name agentdock0 type dummy
fi
ip link set dev agentdock0 mtu 1500 up
ip address replace 10.255.255.254/32 dev agentdock0
mount --make-rshared /
mountpoint -q /sys/fs/bpf || mount -t bpf bpf /sys/fs/bpf

if awk '$2 == "/Docker/host" && NF != 6 { found=1 } END { exit !found }' /proc/mounts; then
  umount /Docker/host
fi
if awk 'NF != 6 { print; invalid=1 } END { exit invalid ? 0 : 1 }' /proc/mounts | grep -q .; then
  echo "K3s cannot start while /proc/mounts contains malformed rows." >&2
  exit 1
fi
EOF
    local dropin="${temporary_directory}/agent-dock-containerd-socket.conf"
    cat >"${dropin}" <<'EOF'
[Service]
ExecStartPre=/usr/local/libexec/agent-dock-prepare-k3s-wsl
ExecStartPost=/bin/sh -eu -c 'for attempt in $(seq 1 100); do test -S /run/k3s/containerd/containerd.sock && break; sleep 0.1; done; chgrp docker /run/k3s/containerd/containerd.sock; chmod 0660 /run/k3s/containerd/containerd.sock'
EOF
    sudo install -d -m 0755 /usr/local/libexec /etc/systemd/system/k3s.service.d
    if [[ ! -e /usr/local/libexec/agent-dock-prepare-k3s-wsl ]]; then
      sudo install -m 0755 "${helper}" /usr/local/libexec/agent-dock-prepare-k3s-wsl
    fi
    sudo install -m 0644 "${dropin}" /etc/systemd/system/k3s.service.d/agent-dock-containerd-socket.conf
  fi
}

wait_for_k3s() {
  local attempt
  for attempt in $(seq 1 120); do
    if sudo /usr/local/bin/k3s kubectl get nodes >/dev/null 2>&1; then return; fi
    sleep 2
  done
  fail "K3s did not become ready within four minutes; inspect sudo journalctl -u k3s"
}

install_k3s_if_needed() {
  current_phase="K3s installation"
  if [[ -x /usr/local/bin/k3s && -f /etc/systemd/system/k3s.service ]]; then
    write_fresh_k3s_configuration
    sudo systemctl daemon-reload
    sudo systemctl enable --now k3s
    wait_for_k3s
    return
  fi
  [[ "${skip_host_bootstrap}" != "true" ]] || fail "K3s is required with --skip-host-bootstrap"
  log "Installing pinned single-node K3s ${K3S_VERSION}"
  write_fresh_k3s_configuration
  local installer="${temporary_directory}/install-k3s.sh"
  local encoded_version="${K3S_VERSION/+/%2B}"
  download_verified "https://raw.githubusercontent.com/k3s-io/k3s/${encoded_version}/install.sh" \
    "${installer}" "${K3S_INSTALLER_SHA256}"
  sudo env INSTALL_K3S_VERSION="${K3S_VERSION}" INSTALL_K3S_SKIP_START=true sh "${installer}"
  sudo systemctl daemon-reload
  sudo systemctl enable --now k3s
  wait_for_k3s
}

prepare_cube_repository() {
  current_phase="CubeSandbox source preparation"
  if [[ ! -d "${cube_repository}/.git" ]]; then
    [[ ! -e "${cube_repository}" ]] || fail "Cube source path is not a Git checkout: ${cube_repository}"
    log "Cloning the pinned CubeSandbox source"
    mkdir -p "$(dirname "${cube_repository}")"
    git clone --no-checkout --filter=blob:none "${CUBE_REPOSITORY_URL}" "${cube_repository}"
  fi
  local origin
  origin="$(git -C "${cube_repository}" remote get-url origin 2>/dev/null || true)"
  case "${origin,,}" in
    "${CUBE_REPOSITORY_URL,,}"|https://github.com/tencentcloud/cubesandbox) ;;
    *) fail "CubeSandbox origin is not the official TencentCloud repository: ${origin}" ;;
  esac
  [[ -z "$(git -C "${cube_repository}" status --porcelain)" ]] || fail "Cube checkout has local changes"
  if [[ "$(git -C "${cube_repository}" rev-parse HEAD 2>/dev/null || true)" != "${CUBE_COMMIT}" ]]; then
    git -C "${cube_repository}" fetch --depth=1 origin "${CUBE_COMMIT}"
    git -C "${cube_repository}" checkout --detach "${CUBE_COMMIT}"
  fi
  [[ "$(git -C "${cube_repository}" rev-parse HEAD)" == "${CUBE_COMMIT}" ]] || fail "Cube pin failed"
}

runtime_environment_value() {
  local name=$1 file="${runtime_directory}/.env"
  [[ -r "${file}" ]] || return 1
  sed -n "s/^${name}=//p" "${file}" | tail -n 1
}
run_npm() { (cd "${repository_root}" && npm "$@"); }
run_root_node() {
  local clean_path="${PATH}"
  if [[ -n "${docker_wrapper_directory}" ]]; then clean_path="${clean_path#${docker_wrapper_directory}:}"; fi
  sudo env PATH="${clean_path}" \
    AGENT_DOCK_RUNTIME_DIRECTORY="${runtime_directory}" \
    AGENT_DOCK_CUBESANDBOX_REPOSITORY="${cube_repository}" \
    HTTP_PROXY="${HTTP_PROXY:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" NO_PROXY="${NO_PROXY:-}" \
    http_proxy="${http_proxy:-}" https_proxy="${https_proxy:-}" no_proxy="${no_proxy:-}" \
    node "$@"
}

install_base_packages
install_local_node
install_local_helm
install_docker_if_needed
enable_docker_for_current_run
install_k3s_if_needed
prepare_cube_repository

export AGENT_DOCK_RUNTIME_DIRECTORY="${runtime_directory}"
export AGENT_DOCK_CUBESANDBOX_REPOSITORY="${cube_repository}"
export AGENT_DOCK_HTTP_BIND_ADDRESS="${bind_address}"
export AGENT_DOCK_HTTP_PORT="${http_port}"

runtime_was_initialized="false"
[[ -f "${runtime_directory}/deployment.json" ]] && runtime_was_initialized="true"

current_phase="Node dependency installation"
log "Installing pinned AgentDock dependencies"
(cd "${repository_root}" && npm ci --ignore-scripts)
run_npm run dependencies:harden

current_phase="private runtime initialization"
log "Initializing private AgentDock and Cube runtime material"
run_npm run production:init
run_npm run cubesandbox:init

install_intent_path="${runtime_directory}/.self-hosted-install-pi-worker-intent"
[[ ! -L "${install_intent_path}" ]] || fail "install intent must not be a symbolic link"
if [[ -z "${pi_workers}" ]]; then
  if [[ -r "${install_intent_path}" ]]; then
    pi_workers="$(<"${install_intent_path}")"
  elif [[ "${runtime_was_initialized}" == "true" ]]; then
    pi_workers="$(runtime_environment_value AGENT_DOCK_PI_WORKER_DEPLOYMENT || true)"
  else
    pi_workers="kubernetes"
  fi
  [[ -n "${pi_workers}" ]] || pi_workers="kubernetes"
fi
[[ "${pi_workers}" == "compose" || "${pi_workers}" == "kubernetes" ]] ||
  fail "persisted Pi Worker install intent is invalid"

configured_bind_address="$(runtime_environment_value AGENT_DOCK_HTTP_BIND_ADDRESS || true)"
configured_http_port="$(runtime_environment_value AGENT_DOCK_HTTP_PORT || true)"
if [[ "${bind_address_explicit}" == "true" && "${configured_bind_address}" != "${bind_address}" ]]; then
  fail "existing runtime uses bind address ${configured_bind_address}; bootstrap options do not overwrite it"
fi
if [[ "${http_port_explicit}" == "true" && "${configured_http_port}" != "${http_port}" ]]; then
  fail "existing runtime uses HTTP port ${configured_http_port}; bootstrap options do not overwrite it"
fi
bind_address="${configured_bind_address:-${bind_address}}"
http_port="${configured_http_port:-${http_port}}"

current_mode="$(runtime_environment_value AGENT_DOCK_PI_WORKER_DEPLOYMENT || true)"
if [[ "${pi_workers_explicit}" == "true" && "${pi_workers}" == "compose" && "${current_mode}" == "kubernetes" ]]; then
  fail "existing deployment uses Kubernetes Workers; use npm run kubernetes:pi-workers:down for explicit downgrade"
fi
if [[ "${runtime_was_initialized}" != "true" || "${pi_workers_explicit}" == "true" || -e "${install_intent_path}" ]]; then
  printf '%s\n' "${pi_workers}" >"${install_intent_path}"
  chmod 0600 "${install_intent_path}"
fi

current_phase="CubeSandbox cluster reconciliation"
log "Reconciling CubeSandbox's KVM execution plane"
run_root_node "${repository_root}/scripts/install-cubesandbox-k3s.mjs"

current_phase="AgentDock production deployment"
log "Building and starting AgentDock"
run_npm run production:deploy

current_mode="$(runtime_environment_value AGENT_DOCK_PI_WORKER_DEPLOYMENT || true)"
if [[ "${pi_workers}" == "kubernetes" && "${current_mode}" != "kubernetes" ]]; then
  current_phase="Kubernetes Pi Worker Pool deployment"
  log "Switching the Pi Worker Pool to Kubernetes"
  run_npm run kubernetes:pi-workers:up
fi

current_phase="post-deployment verification"
log "Verifying the deployed product"
run_npm run production:ps
if [[ "$(runtime_environment_value AGENT_DOCK_PI_WORKER_DEPLOYMENT || true)" == "kubernetes" ]]; then
  run_npm run kubernetes:pi-workers:status
fi

display_host="${bind_address}"
if [[ "${display_host}" == *:* && "${display_host}" != \[*\] ]]; then display_host="[${display_host}]"; fi
health_url="http://${display_host}:${http_port}/healthz"
health_response="$(curl --fail --silent --show-error "${health_url}")"
[[ "${health_response}" == "ok" ]] || fail "Web health returned an unexpected response at ${health_url}"
rm -f -- "${install_intent_path}"

cat <<EOF

[AgentDock] Deployment completed successfully.

  Open: http://${display_host}:${http_port}

  Next:
    1. Register the dedicated platform administrator account.
    2. Put its tenant UUID in AGENT_DOCK_PLATFORM_OPERATOR_TENANT_ID in:
       ${runtime_directory}/.env
    3. Restart the Control Plane and configure the provider/model key in the
       administrator page. The key is never handled by this installer.

  Reconcile later:       ./install.sh
  Read-only diagnosis:   ./install.sh --check-only
EOF
