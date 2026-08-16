# ADR-0110: Pi Cloud product identity

## Status

Accepted on 2026-08-16.

## Context

The project began under a different pre-release identity. That identity became
part of npm package scopes, environment variables, PostgreSQL schemas, event topics,
container images, Kubernetes resources, Cube Volume drivers, backup headers
and documentation. Renaming only the repository would leave two permanent
names for one pre-release product and make fresh deployment, operations and
interview explanation unnecessarily ambiguous.

## Decision

1. Rename the product to Pi Cloud and the repository to `pi-cloud`.
2. Use one identity throughout the maintained product path:
   `Pi Cloud`, `PiCloud`, `pi-cloud`, `@pi-cloud`, `PI_CLOUD` and `pi_cloud`
   according to the conventions of each interface.
3. Do not retain aliases for former package scopes, environment variables,
   schemas, topics, images, runtime paths, Volume drivers or backup headers.
4. Treat the rename as a pre-release, clean-deployment boundary. Existing local
   development state must be removed and recreated with the Pi Cloud deployment
   contract; old backups are not accepted by the new backup reader.
5. Historical Git commits remain the source for the former name. Maintained
   documentation and reports describe the current product as Pi Cloud.

## Consequences

- a clean checkout has one product and deployment identity;
- package and infrastructure discovery no longer mixes old and new prefixes;
- existing pre-rename deployments and backups require an explicit offline
  export/rebuild rather than a hidden compatibility path;
- the rename must pass the complete build, test, Helm and deployment-rendering
  gates before publication.
