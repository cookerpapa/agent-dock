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
6. validate each event as `event.publish`, retain it in the bounded spool, replay
   the complete suffix after a simulated disconnect, and apply cumulative ACKs;
7. receive a successful RPC `abort` response and then close Pi cleanly through EOF;
8. avoid passing provider credentials to the child process.

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
npm ci --ignore-scripts
npm run ci
```

`npm run spike` uses the locally pinned Pi binary. To probe another compatible
Pi build explicitly:

```bash
PI_COMMAND=/absolute/path/to/pi npm run spike:pi
```

## Run as a non-root container

Run both Phase 0 images from the repository root:

```bash
npm run container:check
```

Compose builds digest-pinned Node images and sequentially runs this RPC probe and
the embedded rehydrate probe. Each service uses UID/GID `1000:1000`, a read-only
root filesystem, a 64 MiB `/tmp`, no network or host volume, all capabilities
dropped, `no-new-privileges`, and CPU/memory/PID/file limits. The spike also
rejects root at runtime when Compose sets `AGENT_DOCK_REQUIRE_NON_ROOT=1`.

The Dockerfiles and Compose document have executable static contracts, and their
production-only npm layouts pass outside Docker. A real container run is still
required before claiming that the host engine enforced namespaces, cgroups, and
mount options.

## Data flow

```text
run-spike.ts -> JSONL get_commands -> Pi RPC -> cloud-check.ts
run-spike.ts <- extension_ui_request(confirm) <- Pi RPC
run-spike.ts -> extension_ui_response(true) -> Pi RPC
run-spike.ts <- extension_ui_request(notify) <- Pi RPC
run-spike.ts -> AgentDockEvent v1 -> event.publish -> event spool
run-spike.ts <- event.ack(throughSeq) <- simulated durable control plane
run-spike.ts -> replay(unacknowledged suffix) -> future WebSocket transport
```

The supervisor parses stdout as byte-delimited JSONL, correlates responses by
request ID, bounds every wait with a timeout, and closes stdin for graceful Pi
shutdown. It escalates to process-group `SIGTERM`/`SIGKILL` only on a hung exit.
The in-memory spool is a protocol reference, not a claim of crash-safe local
durability; production storage is added with the real supervisor transport.

The verified `0.80.10` lockfile currently reports zero dependency vulnerabilities
through the root `npm run security:audit` command.
