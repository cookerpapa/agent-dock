# ADR-0025: Private multi-tenant identity and fair scheduling

- Status: accepted
- Date: 2026-07-19
- Amended by: ADR-0026 adds an opt-in, bounded loopback registration and
  conversation-discovery surface without changing the authenticated tenant
  authority

## Context

ADR-0023 completed a production-operable single-host deployment for one
operator and one tenant. The durable schema already carries `tenant_id` through
projects, workspaces, model profiles, sessions, commands, events, artifacts,
and the outbox, and most relationships use tenant-consistent composite foreign
keys. The production composition nevertheless remains single-tenant in four
important places:

1. one plaintext bearer secret authenticates every public request without
   producing a user or tenant identity;
2. one tenant and one default model profile are injected when the control-plane
   process starts;
3. REST stores, SSE replay, PostgreSQL notification filtering, and dispatch
   workers retain that tenant as process-wide state; and
4. the scheduler has no per-tenant admission limit or fairness state.

Adding a client-supplied tenant header would not fix those boundaries. It would
let a caller choose authorization scope, while background workers could still
ignore a newly created tenant. Likewise, creating one control-plane deployment
per tenant would duplicate Supervisor connections and capacity, prevent fair
sharing, and turn operational isolation into manual configuration.

The requested target is a private, single-host, multi-tenant deployment. It is
not direct Internet ingress, self-service public registration, enterprise SSO,
or a claim that Docker provides a hostile-cloud hard-multitenancy boundary.
Authenticated tenants are still treated as mutually untrusted at the API,
database-query, scheduling, object-key, and sandbox-lifecycle boundaries.

## Decision

### Identity and credentials

1. A public bearer credential resolves to one immutable request identity:
   `credentialId`, `tenantId`, `userId`, and `role`. The HTTP client never
   supplies `tenantId` or `userId` in a header, query, path, or request body.
   Every tenant-scoped store is constructed from the authenticated identity.
2. Add a `tenant_api_credentials` table. A row belongs to an exact
   tenant-local user, contains a bounded label and role, stores only a SHA-256
   digest of a high-entropy secret, and has explicit creation, optional expiry,
   and revocation timestamps. Plaintext credentials never enter PostgreSQL,
   logs, events, Pi JSONL, checkpoints, or sandbox configuration.
3. Credential syntax is `adk_<uuid>.<random-secret>`. The UUID performs one
   indexed lookup; the supplied secret is hashed and compared with a fixed-size
   stored digest using constant-time comparison. Unknown, malformed, expired,
   and revoked credentials all return the same `401 authentication_required`
   response and use a dummy digest comparison path.
4. Roles are `owner`, `member`, and `viewer`. Existing mutating project,
   session, turn, and cancellation routes require `owner` or `member`. Event
   replay and identity inspection also permit `viewer`. Tenant lifecycle and
   credential issuance/revocation are not public `/v1` operations in this
   private slice.
5. An offline production administration command runs inside the trusted
   control-plane image with the database secret. It can create a tenant and its
   first owner, issue an additional credential, revoke a credential, and list
   only safe metadata. A newly generated plaintext token is shown once or
   atomically written to an operator-selected private file. There is no
   long-lived platform-admin HTTP bearer token.
6. The existing production tenant, user, and token are migrated idempotently.
   The current token remains valid after upgrade, but the running public API no
   longer mounts or compares that plaintext file. Bootstrap alone reads it to
   create or verify its digest row.

The current `users` table intentionally represents a tenant-local user. A human
who participates in two tenants has two local user records and two explicit
credentials. Global identities, tenant memberships, OIDC, passkeys, password
recovery, and browser cookies are separate future identity-provider work; they
are not required to prove tenant isolation in a private deployment.

### Tenant policy, admission, and fair execution

7. Add one `tenant_runtime_policies` row per tenant. It owns the tenant's
   default model profile, enabled state, maximum projects, maximum sessions,
   maximum unsettled turns, maximum concurrently leased turns, and a scheduler
   cursor. Every referenced profile must belong to the same tenant and remain
   enabled when a turn snapshots it.
8. Project, session, and turn intake locks the policy row and enforces its
   configured bound in the same transaction as resource creation. Rejection is
   a stable `429 tenant_quota_exceeded`, and an idempotent retry of an already
   accepted turn is returned before consuming quota again. Disabling runtime
   intake does not invalidate otherwise valid credentials: existing resources
   remain readable and cancellation remains available as safety work.
9. Execute dispatch is global rather than process-tenant-specific. An eligible
   claim joins the command's tenant policy, excludes disabled or concurrency-
   saturated tenants, and orders first by the least recently scheduled tenant,
   then by the existing per-session mailbox and outbox order. The selected
   policy row is locked with the command claim and its scheduler cursor advances
   transactionally. Multiple lanes and control-plane replicas therefore cannot
   reserve the same fairness turn.
10. Cancellation is safety work and is not delayed by normal tenant fairness or
    intake quotas. It may claim any tenant only when its target session lease
    belongs to the exact Supervisor connection affinity. Every subsequent
    mutation uses the tenant read from that durably claimed command, never a
    process default.
11. One Supervisor pool serves all enabled tenants. Capacity is still bounded
    by live Supervisor lanes, while `maximum_concurrent_turns` prevents one
    tenant from occupying the entire configured pool. Cold sessions for every
    tenant retain no process, socket, thread, or timer.

### Request, event, and storage isolation

12. Fastify authentication attaches a validated request identity before NestJS
    routing. Controllers pass only that identity's tenant into a short-lived
    store/event-stream scope. Authentication infrastructure is process-wide;
    mutable tenant selection is not.
13. Every public lookup combines resource ID with authenticated tenant. A valid
    credential requesting another tenant's known UUID receives the same `404`
    as a nonexistent UUID. No response reveals whether the foreign object,
    session, turn, event cursor, or idempotency key exists.
14. The process-local event hub and PostgreSQL notification path key wakes by
    `(tenantId, sessionId)`. The listener accepts all valid tenant notifications
    for the deployment, but a subscriber is created only after the authenticated
    tenant's durable event cursor has been verified. Event bodies always come
    from a tenant-filtered PostgreSQL replay query.
15. Supervisor publications remain untrusted inputs. Event ingestion derives
    tenant from the closed `event.publish` command identity and verifies it
    against the durable session, command, lease, fencing token, and current
    connection before commit. A Supervisor cannot change tenant authority by
    changing an event payload.
16. Object keys retain an immutable tenant prefix and checkpoint metadata uses
    tenant-consistent rows. A restored snapshot must match tenant, session,
    turn, artifact hash, and current lease/fence. Workers still receive no
    database, S3, public API, or tenant credential.
17. Logs may contain opaque tenant/user/credential IDs and safe outcome codes,
    but never authorization headers or token material. Public identity responses
    contain tenant slug, display name, and role but never credential digest or
    secret reference.

### Private Web deployment

18. The Web application continues to accept an explicitly pasted bearer token
    and stores it only in browser memory. After authentication it calls
    `GET /v1/identity`, displays the resolved tenant/user/role, and clears all
    session UI state when the token changes. It does not offer a tenant-ID
    switch: switching tenants means presenting another credential.
19. Caddy remains loopback-only and proxies only `/v1`. Multi-tenancy does not
    relax the existing private-network, internal-route, TLS, or trusted
    Supervisor boundaries.

## Executable acceptance criteria

This decision is complete only when automated tests and the disposable
production topology prove all of the following:

1. bootstrap upgrades the existing operator token without changing it, and two
   additional tenant credentials authenticate to distinct identities;
2. each tenant can create a project, session, accepted turn, SSE stream, and
   settled S3 checkpoint through the same control-plane and Supervisor pool;
3. every foreign project/session/turn/cancellation/SSE UUID probe returns `404`,
   including when the attacker knows the exact ID and `Last-Event-ID`;
4. a malformed, unknown, expired, or revoked credential returns the same `401`,
   and no digest or token appears in response bodies, logs, events, worker
   environment, or Docker arguments;
5. `viewer` cannot mutate, while `member` and `owner` can use the existing
   coding-session routes inside only their tenant;
6. project/session/unsettled/concurrent limits are transactionally enforced
   under concurrent intake and dispatcher lanes;
7. when tenant A has a backlog and tenant B submits later, B receives a lane
   before A drains its backlog, while same-session mailbox order is preserved;
8. cancellation for either tenant follows the exact active lease and is not
   blocked by the normal concurrency quota;
9. control-plane scale `1 -> 2 -> 1`, a control-plane restart, and a fresh
   Supervisor boot preserve both tenants' isolation, events, and checkpoints;
10. the default production deployment upgrades without deleting PostgreSQL,
    MinIO, boot, or spool volumes, all services become healthy, and only Web is
    published on loopback.

## Consequences

- The deployment now has real request-scoped tenants rather than tenant columns
  used only as future schema decoration.
- One shared Supervisor increases utilization while per-tenant concurrency and
  least-recently-served scheduling bound the noisy-neighbor problem.
- Tenant policy locking serializes resource admission within one tenant. That is
  an intentional, short database critical section; it does not serialize model
  execution or other tenants.
- A token switch is a complete security-context switch. The browser must discard
  old tenant resources and streams rather than relabeling them.
- Database tenant predicates and composite foreign keys are both required.
  Neither is described as PostgreSQL row-level security in this slice. RLS may
  later be added as defense in depth after worker/admin connection roles are
  split; enabling it under one bypass-capable application role would create a
  misleading claim.
- This provides application-level multitenancy for a trusted private operator.
  It does not make the shared Docker daemon a suitable boundary for mutually
  hostile public customers; stronger sandboxing and a separate deployment
  threat model remain Phase 3/7 work.

## Rejected alternatives

### Accept `X-Tenant-ID` from the browser

Authentication would prove only possession of a global token while the caller
chooses its own authorization scope. A missed ownership check would become a
direct cross-tenant vulnerability.

### Keep one static public token and add tenant IDs to URLs

All users would still share one principal, revocation boundary, and authority.
That is namespacing, not multitenancy.

### Start one control-plane and Supervisor pair per tenant

It duplicates idle processes, credentials, sockets, and operational state,
prevents fair sharing of one host, and avoids rather than implements the
request-scoped architecture already anticipated by the schema.

### Store plaintext API tokens for lookup

A database read would immediately expose every tenant credential. High-entropy
secrets support indexed credential-ID lookup followed by constant-time digest
verification without retaining plaintext.

### Use only global FIFO ordering

A tenant that continuously inserts older work can occupy every free lane and
starve a later tenant. Per-tenant concurrency alone bounds occupancy but does not
choose fairly among waiting tenants.

### Claim PostgreSQL RLS is sufficient

Background workers legitimately cross tenant boundaries and currently share an
application database role. RLS without carefully separated roles and explicit
transaction-local tenant context could either break workers or be bypassed by
the same role. Application predicates, closed identities, composite keys, and
executable negative tests are the primary boundary for this slice.
