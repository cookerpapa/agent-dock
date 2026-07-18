# ADR-0001: TypeScript runtime and RPC-first Pi integration

- Status: Accepted
- Date: 2026-07-18

## Context

AgentDock is intended specifically to cloud-enable Pi while preserving native
Pi extension behavior. Pi extensions are TypeScript modules loaded in a Node.js
runtime. They may use Pi packages, Node built-ins, npm dependencies, lifecycle
hooks, tools, providers, commands, and interactive `ctx.ui` calls.

A Java control plane plus a TypeScript SDK runner would remain viable, but it
would add a second implementation language and cross-language protocol without
improving extension compatibility. Direct SDK embedding would also require
AgentDock to recreate mode bindings that Pi RPC already provides, particularly
the extension UI request/response subprotocol.

## Decision

1. AgentDock v1 is a TypeScript monorepo.
2. The control plane uses NestJS with the Fastify adapter.
3. Each active sandbox runs a TypeScript supervisor and a pinned Pi RPC child process.
4. The supervisor communicates with Pi through its JSONL RPC protocol.
5. Pi performs native extension/resource discovery and lifecycle handling.
6. The supervisor maps supported extension UI requests to web events and sends
   user responses back through the RPC extension UI protocol.
7. Extensions never load in the API/control-plane process.
8. Direct Pi SDK embedding remains a future optimization, not the initial path.

## Consequences

Positive:

- maximum reuse of Pi's native extension and session behavior;
- one language across API, supervisor, shared schemas, and browser;
- fewer cross-language integration failures;
- faster implementation and easier AI-assisted maintenance;
- extension UI compatibility can be tested independently of a model provider.

Negative:

- every active sandbox contains a Pi child process;
- TUI-only extension behavior cannot be reproduced exactly in a browser;
- the platform must pin Pi and run RPC conformance tests on upgrades;
- arbitrary extension code requires a real OS/container security boundary.

## Revisit criteria

Reconsider direct SDK embedding only when measurements show that child-process
overhead is material, or when a required cloud capability is impossible through
the public RPC protocol and cannot be supplied by an extension.
