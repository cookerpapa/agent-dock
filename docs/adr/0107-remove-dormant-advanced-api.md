# ADR-0107: Remove the dormant advanced API

Status: accepted

## Context

The default Web product had no workflow for Candidate Race, Run Rewind,
Review Bundle, advanced model-governance, usage-inspection, operational-insight
or Project Environment management APIs. They were hidden behind a disabled
flag, but still carried protocol schemas, database reads, tests and deployment
configuration. Normal successful Runs also generated a Review Bundle even when
the API was disabled.

This made the maintained system larger without improving the supported user
journey, and obscured the current architecture during review and operation.

## Decision

Remove the dormant controller, providers, protocol surface and deployment flag.
Normal Run settlement no longer prepares a Review Bundle. Run history has one
canonical product projection; conversation branching remains the supported
user-facing way to continue from an earlier settled response.

Keep the capabilities used by the current product:

- administrator model and Cube proxy configuration;
- model-request usage records for internal accounting and future policy work;
- immutable Project Environment snapshots selected by Runs;
- human Session-tree navigation and transactional conversation forks;
- Run/Attempt leases, fencing and canonical terminal projection.

Historical migration files remain in the ordered migration chain so a fresh
database can still reach the current schema. Migration 061 then removes their
unused tables; current code does not read or write them.

## Consequences

The production Control Plane has one smaller public surface and successful Run
settlement performs less work. Reintroducing any removed capability requires a
complete UI/API workflow, a measured need and a new architecture decision.

ADR-0078's Worker Control Channel decision remains current; its decision to
retain an optional advanced controller is superseded by this ADR.
