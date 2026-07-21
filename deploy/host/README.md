# AgentDock gVisor host

AgentDock has one supported Tool Sandbox runtime: `runsc` with the KVM platform
on a native Linux Docker Engine. There is no runc, Docker Desktop, systrap, or
microVM Provider fallback.

On Ubuntu or Ubuntu under WSL2 with nested KVM enabled:

```bash
cd /home/rayn/agent-dock
sudo AGENT_DOCK_HOST_USER="$USER" ./scripts/install-gvisor-host.sh
newgrp docker
npm run sandbox:check
```

If image downloads require a host-loopback proxy, pass it only to the trusted
Docker daemon installation:

```bash
sudo AGENT_DOCK_HOST_USER="$USER" \
  AGENT_DOCK_DOCKER_PROXY_URL=http://127.0.0.1:10808 \
  ./scripts/install-gvisor-host.sh
```

The installer:

- installs Docker Engine from Docker's Ubuntu repository;
- installs `runsc` from the official gVisor repository;
- configures Docker runtime `runsc` with the fixed `--platform=kvm` argument;
- refuses to continue without a readable and writable `/dev/kvm`;
- enables the Docker service and optionally adds the invoking user to `docker`
  and `kvm`;
- executes a direct KVM-platform `runsc` probe.

`npm run sandbox:check` is the authoritative end-to-end gate. It builds the
Tool image and proves the gVisor kernel identity, resource enforcement,
credential and network isolation, cross-tenant isolation, bounded output,
cancellation cleanup, and a real Pi remote-tool turn.

The KVM profile is mandatory on WSL2 because the gVisor systrap platform is not
supported there and fails to start reliably. This project intentionally fails
closed if `runsc` or `--platform=kvm` is absent.
