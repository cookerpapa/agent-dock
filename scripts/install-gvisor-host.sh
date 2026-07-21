#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  printf '%s\n' 'install-gvisor-host.sh must run as root.' >&2
  exit 1
fi

if [[ $(uname -s) != Linux ]]; then
  printf '%s\n' 'AgentDock requires a native Linux Docker Engine.' >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  printf '%s\n' 'Unable to identify the Linux distribution.' >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
if [[ ${ID:-} != ubuntu ]]; then
  printf 'Unsupported distribution: %s. This installer targets Ubuntu.\n' "${ID:-unknown}" >&2
  exit 1
fi

architecture=$(dpkg --print-architecture)
if [[ ${architecture} != amd64 ]]; then
  printf 'Unsupported architecture: %s. The AgentDock gVisor KVM profile requires amd64.\n' "${architecture}" >&2
  exit 1
fi

if [[ ! -c /dev/kvm || ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  printf '%s\n' '/dev/kvm is unavailable. Enable nested virtualization before installing AgentDock.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg \
  --output /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc

ubuntu_codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
if [[ -z ${ubuntu_codename} ]]; then
  printf '%s\n' 'Ubuntu codename is unavailable.' >&2
  exit 1
fi

cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${ubuntu_codename}
Components: stable
Architectures: ${architecture}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

curl --fail --silent --show-error --location https://gvisor.dev/archive.key \
  | gpg --dearmor --yes --output /usr/share/keyrings/gvisor-archive-keyring.gpg
chmod 0644 /usr/share/keyrings/gvisor-archive-keyring.gpg
cat >/etc/apt/sources.list.d/gvisor.list <<EOF
deb [arch=${architecture} signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main
EOF

apt-get update
apt-get install --yes --no-install-recommends \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin runsc

if [[ -n ${AGENT_DOCK_DOCKER_PROXY_URL:-} ]]; then
  if [[ ${#AGENT_DOCK_DOCKER_PROXY_URL} -gt 2048 || ${AGENT_DOCK_DOCKER_PROXY_URL} == *$'\n'* || ${AGENT_DOCK_DOCKER_PROXY_URL} == *$'\r'* ]]; then
    printf '%s\n' 'AGENT_DOCK_DOCKER_PROXY_URL is invalid.' >&2
    exit 1
  fi
  install -m 0755 -d /etc/systemd/system/docker.service.d
  cat >/etc/systemd/system/docker.service.d/http-proxy.conf <<EOF
[Service]
Environment="HTTP_PROXY=${AGENT_DOCK_DOCKER_PROXY_URL}"
Environment="HTTPS_PROXY=${AGENT_DOCK_DOCKER_PROXY_URL}"
Environment="NO_PROXY=127.0.0.1,localhost"
EOF
fi

runsc install --runtime runsc -- --platform=kvm
systemctl daemon-reload
systemctl enable --now docker
systemctl restart docker

runtime=$(docker info --format '{{json .Runtimes.runsc}}')
if [[ ${runtime} != *'"path":"/usr/bin/runsc"'* || ${runtime} != *'"--platform=kvm"'* ]]; then
  printf 'Docker did not expose the required runsc KVM runtime: %s\n' "${runtime}" >&2
  exit 1
fi

runsc --platform=kvm do /bin/true

target_user=${AGENT_DOCK_HOST_USER:-${SUDO_USER:-}}
if [[ -n ${target_user} && ${target_user} != root ]]; then
  if ! id "${target_user}" >/dev/null 2>&1; then
    printf 'Requested host user does not exist: %s\n' "${target_user}" >&2
    exit 1
  fi
  usermod --append --groups docker,kvm "${target_user}"
fi

printf 'AgentDock gVisor host ready: docker=%s runsc=%s platform=kvm\n' \
  "$(docker version --format '{{.Server.Version}}')" \
  "$(runsc --version | head -1)"
printf '%s\n' 'Run npm run sandbox:check from the AgentDock repository to verify the full boundary.'
