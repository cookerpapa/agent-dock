# ADR-0037: Browser accounts and a platform-managed model

- Status: accepted
- Date: 2026-07-20
- Scope: private/loopback product entry, account sessions, default Workspace,
  model-configuration ownership, and browser navigation

## Context

The Milestone 7 Web surface exposed the platform's implementation evidence, but
its entry flow still behaved like an operator console: a user pasted a bearer
token, selected a tenant model, and started from the Java acceptance fixture.
That was useful during development and wrong for the intended product. A normal
user should register or log in, see only their conversations, and send a first
message without understanding model profiles, API credentials, fixtures, or
Control Plane internals.

The old API token remains valuable for automation and offline tenant
administration. Removing it would break supported operator workflows. Likewise,
the model credential must remain inside the existing tenant-bound encrypted
credential and Model Gateway boundary; sharing plaintext provider credentials
with the browser or Tool Sandbox is not acceptable.

## Decision

1. The default Web application is a product shell with a conventional
   login/register screen, a left conversation list, a right transcript, and an
   anchored composer. The Session inspector remains an optional evidence and
   operations surface rather than the landing page.
2. A browser account has one globally normalized username and one tenant-local
   owner user. Passwords use Node's asynchronous scrypt with a random 128-bit
   salt and persisted parameters. Only the salt and derived key are stored.
3. Registration and login issue an opaque 256-bit session secret in an
   `HttpOnly`, `SameSite=Strict`, path-scoped cookie. PostgreSQL stores only the
   SHA-256 digest. Sessions expire, can be revoked immediately, and are capped
   per account. Reloading the page restores the login from PostgreSQL.
4. Bearer authentication remains supported for operator automation, existing
   tenants, and acceptance tooling. The production gateway prefers an explicit
   Bearer credential when present and otherwise authenticates the browser
   cookie. Neither mechanism allows a client-supplied tenant identifier.
5. The bootstrap operator tenant is the source of the platform default model.
   When a browser account is created, the active allowlisted DeepSeek model and
   credential are decrypted inside the trusted Control Plane and immediately
   re-sealed under the new tenant/binding associated data. The API key never
   enters an HTTP response, cookie, Web bundle, Tool RPC, or Tool Sandbox.
   Deterministic deployments inherit the deterministic profile without a key.
6. Normal users do not receive model controls in the product UI. In production,
   model replacement is authorized only for the configured platform operator
   tenant even though each product user is the owner of their own resource
   tenant. An operator replacement updates the source and all browser-account
   tenant bindings in one transaction; accepted Runs keep their immutable old
   version. Registration resolves the current source rather than a process-start
   cache. Safe model metadata remains available for diagnostics.
7. A message sent without an open conversation lazily creates an `empty`
   Workspace, Project, and Session, then durably accepts the Turn. The Java
   fixture remains an explicit development/import option; it is not the default
   chat experience.
8. Public browser registration remains opt-in and shares the existing total
   tenant cap. Username uniqueness, tenant creation, password credential,
   quotas, model binding, and owner identity commit in one PostgreSQL
   transaction.

## Security and product boundary

The cookie is intentionally not marked `Secure` on the supported plain-HTTP
loopback ingress; deployments terminated by HTTPS must enable the secure-cookie
setting. `SameSite=Strict` and same-origin REST/SSE reduce the current private
deployment's cross-site request surface. This is not a public identity system:
there is no verified email, password recovery, MFA, distributed login rate
limiter, CAPTCHA, billing, or Internet abuse defence. Those capabilities and a
hostile-public deployment review remain prerequisites for public ingress.

The browser account does not weaken the execution boundary. Pi and provider
authentication remain in the trusted Runner path; repository commands still
execute only through the capability-scoped, credential-free Tool Sandbox.

## Compatibility and consequences

- Existing tenants, bearer tokens, conversations, Workspaces, and model
  bindings continue to work.
- The browser account flow is the only maintained production entrypoint; no
  alternate token-oriented React shell is retained.
- A platform model change creates a new immutable version for existing browser
  account bindings and becomes the template for later registrations. Existing
  accepted Turns retain their immutable model snapshot. Manually provisioned
  API-only tenants remain independently managed.
- Account deletion, password change/recovery, organization membership, and
  session-management UI are deliberately not claimed.

## Executable evidence

- migration up/down tests cover password/session tables and the `empty`
  Workspace source constraints;
- PostgreSQL integration tests cover password derivation, generic login
  failures, opaque cookie issuance, logout revocation, duplicate usernames,
  tenant isolation, per-tenant re-encryption, and the platform-only model write
  boundary;
- Web tests assert the username/password product entry and absence of API-token
  or model-configuration fields;
- the disposable production gate covers registration, persisted cookie login,
  logout/re-login, empty conversation creation, model-write denial, tenant
  isolation, the built Web bundle, backup/restore, and the existing complete
  agent/sandbox lifecycle.
