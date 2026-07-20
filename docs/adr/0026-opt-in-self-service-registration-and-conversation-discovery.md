# ADR-0026: Opt-in self-service registration and tenant-scoped conversation discovery

- Status: accepted
- Date: 2026-07-19
- Amends: ADR-0025's private Web boundary by adding a deliberately bounded,
  opt-in anonymous registration route
- Amended by: ADR-0037 replaces the default token handoff with password accounts
  and persistent browser sessions while retaining this legacy API route

## Context

ADR-0025 proves that an authenticated bearer resolves one immutable tenant
scope and that known foreign project, session, turn, cancellation, event, and
checkpoint identities cannot cross that scope. Creating every test tenant with
an offline operator command is nevertheless awkward for a browser demonstration.
The Web application also has no discovery API: after a refresh or token switch,
a user must already know a session UUID before the durable SSE stream can be
opened. This makes the isolation real but difficult to inspect interactively.

The requested slice is a self-service registration and conversation browser for
the loopback, single-host deployment. It is not an Internet-ready identity
provider. There is no verified email, password/passkey recovery, CAPTCHA,
distributed rate limiter, billing, or claim that the shared Docker daemon is a
hard boundary for hostile public customers.

## Decision

### Registration boundary

1. Add exactly one anonymous mutation: `POST /v1/registrations`. The production
   HTTP gateway bypasses bearer authentication only for that exact method and
   path when `AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED=true`. The secure default
   is disabled; a disabled deployment returns `404` and every other `/v1`
   operation continues to require a valid bearer.
2. A registration accepts only a bounded tenant slug and owner display name.
   The server generates all UUIDs and a high-entropy indexed API credential.
   One PostgreSQL transaction creates the tenant, tenant-local owner, fake-model
   binding/profile, runtime policy, and owner credential. The response returns
   the plaintext owner token exactly once; PostgreSQL retains only its SHA-256
   digest, and logs/events never contain the token.
3. Self-service tenants receive operator-configured project, session,
   unsettled-turn, and concurrent-turn limits. Public registration also has a
   configured maximum total tenant count. Registrations serialize on one stable
   existing tenant row before counting and inserting, so concurrent requests
   cannot exceed that bound. Offline administration intentionally remains able
   to create a tenant outside this public admission cap.
4. A duplicate slug returns `409 tenant_slug_unavailable`; a full deployment
   returns `429 registration_capacity_reached`. Neither response contains a
   generated credential or tenant UUID. Failed or rolled-back registrations
   leave no partial identity/profile rows.
5. The returned bearer is the only login and recovery material in this slice.
   Refreshing after losing it requires an offline operator to issue another
   credential. This endpoint is not described as a global human account,
   membership system, OIDC flow, or password service.

### Conversation discovery

6. Add authenticated read-only conversation list and detail resources. Every
   query receives its tenant only from the verified request identity; no client
   tenant header, query parameter, or path segment is accepted. A known foreign
   session UUID returns the same `404` as a nonexistent one.
7. Conversation summaries are ordered by durable `last_active_at` and bounded
   to the newest 100 sessions, with an explicit `truncated` flag. Detail returns
   project/session metadata and the newest 200 durable prompt turns. If older
   turns exist, it reports `historyTruncated` plus a durable replay boundary so
   the browser does not synthesize or misorder omitted history. Existing SSE
   remains the authority for assistant/tool/terminal events.
8. `viewer`, `member`, and `owner` may list and inspect their tenant's
   conversations. Only `member` and `owner` retain mutation authority.

### Web behavior and deployment claim

9. The production login card offers the registration form; the server keeps the
   capability disabled by default and returns a bounded `404` until the operator
   enables it. A successful response is verified through `/v1/identity`, then
   the browser switches to that exact security context and loads only its
   conversation list. The new token remains in React memory and may be shown in
   a dismissible one-time recovery notice; it is never written to localStorage,
   sessionStorage, URL, logs, or analytics.
10. Token change, logout, or registration clears the previous conversation,
    SSE cursor, list, and pending operations before loading the new tenant.
    Selecting a historical conversation loads bounded prompt metadata first
    and then replays its tenant-scoped durable SSE suffix.
11. The bundled deployment remains loopback-only. Enabling this route makes
    browser validation convenient; it does not change the documented warning
    that direct Internet exposure needs an identity-aware edge, abuse controls,
    stronger sandboxing, and a separate public-SaaS threat model.

## Executable acceptance criteria

This decision is complete only when automated and disposable production tests
prove all of the following:

1. with registration disabled, anonymous registration is `404`; when enabled,
   two anonymous requests receive distinct owner identities and indexed tokens;
2. malformed input, duplicate slugs, total-tenant capacity, and concurrent
   registration have stable bounded failures without partial rows or secrets;
3. tenant A and tenant B can each create a project, session, turn, and durable
   event history, but each conversation list contains only its own session;
4. tenant B receives `404` for tenant A's exact conversation detail and SSE
   UUID, while a viewer can read but cannot mutate its own tenant;
5. registration tokens do not appear in control-plane/Supervisor logs, events,
   worker configuration, or Docker arguments;
6. the Web can register, auto-authenticate, render an empty tenant, create a
   conversation, reload its own list, and switch credentials without retaining
   the previous tenant's state; and
7. the disposable Docker topology and the upgraded default loopback deployment
   both remain healthy with the resident control plane still mounting no tenant
   API token.

## Consequences

- Multi-tenancy becomes demonstrable with two independent browser contexts
  instead of an operator-only CLI ceremony.
- Registration deliberately creates one tenant per owner rather than a global
  person plus memberships. That keeps the identity model consistent with
  ADR-0025 but means cross-tenant membership and recovery remain future work.
- The stable-row lock serializes only the short public tenant-creation
  transaction. It does not serialize normal tenant API traffic or execution.
- Returning a one-time bearer in a response is sensitive by design. The client
  must treat it like a recovery code and the server must never replay it from
  storage.
- Bounded recent-history resources avoid an unbounded database/API response;
  full archival pagination can be added when measured session sizes require it.

## Rejected alternatives

### Let the browser call the offline administration command

That would expose the database/platform administration boundary through HTTP
and turn one privileged credential into a cross-tenant escalation target.

### Accept a tenant ID during login or listing

The caller would be selecting authorization scope. Tenant identity must remain
an output of credential verification, never an input to a resource query.

### Store the generated token so registration can be replayed

Plaintext storage would weaken the credential boundary for a convenience path.
This slice prefers an explicit one-time response and operator-assisted recovery.

### Enable registration unconditionally

An operator who only wants manually provisioned private tenants should not gain
an anonymous resource-creation surface during upgrade. The capability is
explicit and disabled by default.
