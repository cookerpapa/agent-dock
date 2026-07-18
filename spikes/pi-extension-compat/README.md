# Pi extension compatibility spike

This executable spike proves that an external supervisor can load an unchanged
Pi extension and bridge its UI protocol without embedding Pi or calling an LLM.
It is the first small boundary AgentDock needs before adding an HTTP API or web UI.

## Acceptance checks

The runner must:

1. start pinned Pi `0.80.10` in RPC mode with an isolated, empty agent directory;
2. discover the extension's `/cloud-check` command through `get_commands`;
3. receive `ctx.ui.confirm()` as an `extension_ui_request` and return the matching
   `extension_ui_response`;
4. observe the subsequent `ctx.ui.notify()` request;
5. map the confirm, resolution, and notification to versioned AgentDock events
   without exposing Pi's private UI request ID;
6. receive a successful RPC `abort` response and then close Pi cleanly through EOF;
7. avoid passing provider credentials to the child process.

This checks the protocol seam. Active model/tool cancellation and killing a full
tool process tree belong to the later sandbox vertical slice and are not claimed here.

## Run locally

Node.js 22.19 or newer is required because the spike uses Node's built-in
erasable TypeScript support.

The TypeScript configuration uses `skipLibCheck` because Pi's provider dependencies
ships transitive provider declaration files with unresolved optional type
references. Project and extension source remains under strict type checking.

Run these commands from the repository root:

```bash
npm ci
npm run check
npm audit --omit=dev
```

`npm run spike` uses the locally pinned Pi binary. To probe another compatible
Pi build explicitly:

```bash
PI_COMMAND=/absolute/path/to/pi npm run spike:pi
```

## Run as a non-root container

Run from the repository root so the image can include the protocol and adapter workspaces:

```bash
docker build -f spikes/pi-extension-compat/Dockerfile -t agent-dock/pi-extension-compat .
docker run --rm --read-only \
  --tmpfs /tmp:rw,nosuid,size=64m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  agent-dock/pi-extension-compat
```

The container runs as the image's unprivileged `node` user. The read-only and
resource/security flags are deliberately supplied by the sandbox launcher,
because an image cannot enforce its own runtime limits.

## Data flow

```text
run-spike.ts -> JSONL get_commands -> Pi RPC -> cloud-check.ts
run-spike.ts <- extension_ui_request(confirm) <- Pi RPC
run-spike.ts -> extension_ui_response(true) -> Pi RPC
run-spike.ts <- extension_ui_request(notify) <- Pi RPC
run-spike.ts -> AgentDockEvent v1 -> future persistence/SSE client
```

The supervisor parses stdout as byte-delimited JSONL, correlates responses by
request ID, bounds every wait with a timeout, and closes stdin for graceful Pi
shutdown. It escalates to process-group `SIGTERM`/`SIGKILL` only on a hung exit.

The verified `0.80.10` lockfile currently reports zero production dependency
vulnerabilities through `npm audit --omit=dev`.
