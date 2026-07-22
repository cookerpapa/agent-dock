#!/usr/bin/env bash
set -euo pipefail

K3S_VERSION="v1.36.2+k3s1"
K3S_INSTALL_SHA256="46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"
K3S_BINARY_SHA256="65a55ec56c24eab44383086166ec620a491952b7e23941a49ddca6e8a4c4b4de"
EXPECTED_RUNSC_VERSION="release-20260714.0"
RUNSC_PACKAGE_VERSION="20260714.0"
HELM_VERSION="v3.18.6"
HELM_BUILD="v3.18.6+gb76a950"
HELM_ARCHIVE_SHA256="3f43c0aa57243852dd542493a0f54f1396c0bc8ec7296bbb2c01e802010819ce"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root (for example: sudo ./scripts/install-kubernetes-gvisor-host.sh)." >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ;;
  *)
    echo "AgentDock's pinned local Kubernetes execution plane currently supports Linux x86_64 only." >&2
    exit 1
    ;;
esac

if [[ ! -r /etc/os-release ]]; then
  echo "Unable to identify the Linux distribution." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "AgentDock's host installer currently supports Ubuntu only." >&2
  exit 1
fi
if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "AgentDock's pinned Kubernetes/gVisor execution plane requires amd64." >&2
  exit 1
fi

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_USER="${AGENT_DOCK_HOST_USER:-${SUDO_USER:-}}"
if [[ -z "${HOST_USER}" || "${HOST_USER}" == "root" ]]; then
  echo "Set AGENT_DOCK_HOST_USER to the non-root operator account." >&2
  exit 1
fi
HOST_UID="$(id -u "${HOST_USER}")"
HOST_GID="$(id -g "${HOST_USER}")"
RUNTIME_DIRECTORY="${AGENT_DOCK_RUNTIME_DIRECTORY:-${REPOSITORY_ROOT}/deploy/production/runtime}"

if [[ ! -c /dev/kvm || ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo "/dev/kvm must exist and be readable/writable; no systrap or runc fallback is allowed." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends ca-certificates curl gnupg

install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg \
  --output /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
UBUNTU_RELEASE="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
if [[ -z "${UBUNTU_RELEASE}" ]]; then
  echo "Ubuntu codename is unavailable." >&2
  exit 1
fi
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_RELEASE}
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

curl --fail --silent --show-error --location https://gvisor.dev/archive.key \
  | gpg --dearmor --yes --output /usr/share/keyrings/gvisor-archive-keyring.gpg
chmod 0644 /usr/share/keyrings/gvisor-archive-keyring.gpg
cat >/etc/apt/sources.list.d/gvisor.list <<'EOF'
deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main
EOF

apt-get update
apt-get install --yes --no-install-recommends \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  "runsc=${RUNSC_PACKAGE_VERSION}"

if [[ -n "${AGENT_DOCK_HOST_PROXY_URL:-}" ]]; then
  if [[ ${#AGENT_DOCK_HOST_PROXY_URL} -gt 2048 || "${AGENT_DOCK_HOST_PROXY_URL}" == *$'\n'* || "${AGENT_DOCK_HOST_PROXY_URL}" == *$'\r'* ]]; then
    echo "AGENT_DOCK_HOST_PROXY_URL is invalid." >&2
    exit 1
  fi
  install -d -m 0755 /etc/systemd/system/docker.service.d
  cat >/etc/systemd/system/docker.service.d/agent-dock-proxy.conf <<EOF
[Service]
Environment="HTTP_PROXY=${AGENT_DOCK_HOST_PROXY_URL}"
Environment="HTTPS_PROXY=${AGENT_DOCK_HOST_PROXY_URL}"
Environment="NO_PROXY=127.0.0.1,localhost,::1"
EOF
  export HTTP_PROXY="${AGENT_DOCK_HOST_PROXY_URL}"
  export HTTPS_PROXY="${AGENT_DOCK_HOST_PROXY_URL}"
  export http_proxy="${AGENT_DOCK_HOST_PROXY_URL}"
  export https_proxy="${AGENT_DOCK_HOST_PROXY_URL}"
fi

if [[ "$(runsc --version 2>/dev/null | sed -n 's/^runsc version //p' | head -1)" != "${EXPECTED_RUNSC_VERSION}" ]]; then
  echo "Expected runsc ${EXPECTED_RUNSC_VERSION} after installation." >&2
  exit 1
fi
if ! command -v containerd-shim-runsc-v1 >/dev/null 2>&1; then
  echo "The pinned runsc package did not install containerd-shim-runsc-v1." >&2
  exit 1
fi
runsc --platform=kvm do /bin/true
systemctl daemon-reload
systemctl enable --now docker

install -d -m 0755 /etc/rancher/k3s /etc/containerd
cat >/etc/rancher/k3s/config.yaml <<'EOF'
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
node-label:
  - agent-dock.io/sandbox-runtime=gvisor
EOF

cat >/etc/containerd/runsc.toml <<'EOF'
[runsc_config]
  platform = "kvm"
  network = "sandbox"
  gso = "false"
  software-gso = "false"
EOF
chmod 0644 /etc/containerd/runsc.toml

TEMPORARY_DIRECTORY="$(mktemp -d)"
cleanup() {
  if [[ "${TEMPORARY_DIRECTORY}" == /tmp/* && -d "${TEMPORARY_DIRECTORY}" ]]; then
    rm -rf -- "${TEMPORARY_DIRECTORY}"
  fi
}
trap cleanup EXIT
HELM_ARCHIVE="${TEMPORARY_DIRECTORY}/helm-${HELM_VERSION}-linux-amd64.tar.gz"
curl --fail --silent --show-error --location \
  "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
  --output "${HELM_ARCHIVE}"
printf '%s  %s\n' "${HELM_ARCHIVE_SHA256}" "${HELM_ARCHIVE}" | sha256sum --check --status
tar -xzf "${HELM_ARCHIVE}" -C "${TEMPORARY_DIRECTORY}"
install -m 0755 "${TEMPORARY_DIRECTORY}/linux-amd64/helm" /usr/local/bin/helm
if [[ "$(/usr/local/bin/helm version --short)" != "${HELM_BUILD}" ]]; then
  echo "Expected Helm ${HELM_BUILD} after installation." >&2
  exit 1
fi
INSTALL_SCRIPT="${TEMPORARY_DIRECTORY}/install-k3s.sh"
curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION//+/%2B}/install.sh" \
  --output "${INSTALL_SCRIPT}"
printf '%s  %s\n' "${K3S_INSTALL_SHA256}" "${INSTALL_SCRIPT}" | sha256sum --check --status
chmod 0700 "${INSTALL_SCRIPT}"

INSTALL_K3S_VERSION="${K3S_VERSION}" \
INSTALL_K3S_SKIP_START=true \
INSTALL_K3S_EXEC="server" \
  "${INSTALL_SCRIPT}"
printf '%s  %s\n' "${K3S_BINARY_SHA256}" /usr/local/bin/k3s | sha256sum --check --status

# K3s' installer persists the invoking shell's proxy variables. Wildcard
# values such as 192.168.* are not valid Go NO_PROXY entries, so API Server
# requests to the local kubelet can otherwise be sent to the desktop proxy.
# Keep public image pulls on the configured proxy while routing every cluster,
# loopback, private and link-local address directly.
K3S_NO_PROXY="127.0.0.1,localhost,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,.svc,.cluster.local,agent-dock-kubernetes"
K3S_ENVIRONMENT_FILE=/etc/systemd/system/k3s.service.env
if grep -q '^NO_PROXY=' "${K3S_ENVIRONMENT_FILE}"; then
  sed -i "s|^NO_PROXY=.*|NO_PROXY='${K3S_NO_PROXY}'|" "${K3S_ENVIRONMENT_FILE}"
else
  printf "NO_PROXY='%s'\n" "${K3S_NO_PROXY}" >>"${K3S_ENVIRONMENT_FILE}"
fi
if grep -q '^no_proxy=' "${K3S_ENVIRONMENT_FILE}"; then
  sed -i "s|^no_proxy=.*|no_proxy='${K3S_NO_PROXY}'|" "${K3S_ENVIRONMENT_FILE}"
else
  printf "no_proxy='%s'\n" "${K3S_NO_PROXY}" >>"${K3S_ENVIRONMENT_FILE}"
fi

install -d -m 0755 /var/lib/rancher/k3s/agent/etc/containerd
cat >/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl <<'EOF'
{{ template "base" . }}

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']
  runtime_type = "io.containerd.runsc.v1"
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc'.options]
    TypeUrl = "io.containerd.runsc.v1.options"
    ConfigPath = "/etc/containerd/runsc.toml"
EOF

DOCKER_GROUP="$(getent group docker | cut -d: -f1)"
if [[ -z "${DOCKER_GROUP}" ]]; then
  echo "The trusted operator must already belong to the local Docker group." >&2
  exit 1
fi
usermod --append --groups docker,kvm "${HOST_USER}"
install -d -m 0755 /etc/systemd/system/k3s.service.d
install -d -m 0755 /usr/local/libexec
cat >/usr/local/libexec/agent-dock-prepare-k3s-wsl <<'EOF'
#!/bin/sh
set -eu

# Docker Desktop currently exposes this WSL mount with an unescaped space in
# the `path=C:\Program Files\...` mount option. Kubernetes' mount parser treats
# that malformed /proc/mounts row as seven fields and kubelet refuses to start.
# AgentDock uses the native WSL Docker Engine and does not consume /Docker/host,
# so remove only this known integration mount before starting K3s.
if awk '$2 == "/Docker/host" && NF != 6 { found=1 } END { exit !found }' /proc/mounts; then
  umount /Docker/host
fi
if awk 'NF != 6 { print; invalid=1 } END { exit invalid ? 0 : 1 }' /proc/mounts | grep -q .; then
  echo "K3s cannot start while /proc/mounts contains malformed rows." >&2
  awk 'NF != 6 { print }' /proc/mounts >&2
  exit 1
fi
EOF
chmod 0755 /usr/local/libexec/agent-dock-prepare-k3s-wsl
cat >/etc/systemd/system/k3s.service.d/agent-dock-containerd-socket.conf <<EOF
[Service]
ExecStartPre=/usr/local/libexec/agent-dock-prepare-k3s-wsl
ExecStartPost=/bin/sh -eu -c 'for attempt in \$(seq 1 100); do test -S /run/k3s/containerd/containerd.sock && break; sleep 0.1; done; chgrp ${DOCKER_GROUP} /run/k3s/containerd/containerd.sock; chmod 0660 /run/k3s/containerd/containerd.sock'
EOF

systemctl daemon-reload
systemctl enable k3s
systemctl restart k3s
for _ in $(seq 1 120); do
  if /usr/local/bin/k3s kubectl get --raw=/readyz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
/usr/local/bin/k3s kubectl get --raw=/readyz >/dev/null

for _ in $(seq 1 120); do
  if /usr/local/bin/k3s kubectl get node --no-headers 2>/dev/null | grep -q .; then
    break
  fi
  sleep 1
done
/usr/local/bin/k3s kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null
/usr/local/bin/helm upgrade --install agent-dock-execution-plane \
  "${REPOSITORY_ROOT}/deploy/helm/agent-dock-execution-plane" \
  --namespace default \
  --take-ownership \
  --history-max 10 \
  --timeout 2m >/dev/null
/usr/local/bin/helm status agent-dock-execution-plane \
  --namespace default \
  --output json | grep -q '"status":"deployed"'

TOKEN=""
CA_DATA=""
for _ in $(seq 1 120); do
  TOKEN="$(/usr/local/bin/k3s kubectl -n agent-dock-system get secret sandbox-manager-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
  CA_DATA="$(/usr/local/bin/k3s kubectl -n agent-dock-system get secret sandbox-manager-token -o jsonpath='{.data.ca\.crt}' 2>/dev/null || true)"
  if [[ -n "${TOKEN}" && -n "${CA_DATA}" ]]; then
    break
  fi
  sleep 1
done
if [[ -z "${TOKEN}" || -z "${CA_DATA}" ]]; then
  echo "Kubernetes did not populate the scoped Sandbox Manager credential." >&2
  exit 1
fi

install -d -m 0700 -o "${HOST_UID}" -g "${HOST_GID}" "${RUNTIME_DIRECTORY}/kubernetes"
KUBECONFIG_PATH="${RUNTIME_DIRECTORY}/kubernetes/sandbox-manager.kubeconfig"
if ! grep -Eq '(^|[[:space:]])agent-dock-kubernetes([[:space:]]|$)' /etc/hosts; then
  printf '%s\n' '127.0.0.1 agent-dock-kubernetes' >>/etc/hosts
fi
umask 077
cat >"${KUBECONFIG_PATH}" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: agent-dock
    cluster:
      certificate-authority-data: ${CA_DATA}
      server: https://agent-dock-kubernetes:6443
contexts:
  - name: sandbox-manager
    context:
      cluster: agent-dock
      namespace: agent-dock-sandboxes
      user: sandbox-manager
current-context: sandbox-manager
users:
  - name: sandbox-manager
    user:
      token: ${TOKEN}
EOF
chown "${HOST_UID}:${HOST_GID}" "${KUBECONFIG_PATH}"
chmod 0600 "${KUBECONFIG_PATH}"

/usr/local/bin/k3s kubectl auth can-i create pods \
  --namespace agent-dock-sandboxes \
  --as system:serviceaccount:agent-dock-system:sandbox-manager | grep -qx yes
/usr/local/bin/k3s kubectl auth can-i get runtimeclasses.node.k8s.io/agent-dock-gvisor \
  --as system:serviceaccount:agent-dock-system:sandbox-manager | grep -qx yes
SECRET_ACCESS="$(/usr/local/bin/k3s kubectl auth can-i get secrets \
  --namespace agent-dock-sandboxes \
  --as system:serviceaccount:agent-dock-system:sandbox-manager || true)"
[[ "${SECRET_ACCESS}" == "no" ]]
/usr/local/bin/k3s kubectl get runtimeclass agent-dock-gvisor \
  -o jsonpath='{.handler}' | grep -qx runsc
grep -q "io.containerd.runsc.v1" /var/lib/rancher/k3s/agent/etc/containerd/config.toml
grep -q 'ConfigPath = "/etc/containerd/runsc.toml"' /var/lib/rancher/k3s/agent/etc/containerd/config.toml
grep -Eq '^[[:space:]]*platform[[:space:]]*=[[:space:]]*"kvm"' /etc/containerd/runsc.toml
grep -Eq '^[[:space:]]*gso[[:space:]]*=[[:space:]]*"false"' /etc/containerd/runsc.toml
grep -Eq '^[[:space:]]*software-gso[[:space:]]*=[[:space:]]*"false"' /etc/containerd/runsc.toml

echo "AgentDock Kubernetes/gVisor execution plane is installed."
echo "K3s: ${K3S_VERSION}; RuntimeClass: agent-dock-gvisor; runsc: ${EXPECTED_RUNSC_VERSION}; Helm: ${HELM_BUILD}"
echo "Scoped kubeconfig: ${KUBECONFIG_PATH}"
