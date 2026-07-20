# Release evidence process

AgentDock's supported release process binds a clean Git revision to six local
production images and machine-readable dependency/security evidence. It does
not currently push, sign, or publish images; registry policy and signing need a
separate deployment decision.

## Preconditions

- use a clean checkout at the intended release commit;
- install only the lockfile with `npm ci --ignore-scripts`;
- run `npm run ci`, `npm run container:check`,
  `npm run sandbox-provider:check`, and `npm run production:check`;
- choose one immutable image version. Do not reuse a published version for a
  different commit.

Build all production images with the version. The Compose wrapper derives the
full lowercase Git revision and passes both values as OCI labels:

```bash
AGENT_DOCK_IMAGE_VERSION=0.1.0 npm run production:build
```

Generate evidence into an absent or empty path:

```bash
AGENT_DOCK_IMAGE_VERSION=0.1.0 npm run release:evidence -- \
  --output-dir dist/release-evidence-0.1.0
```

The first Trivy invocation may download a large vulnerability database. Its
cache defaults to `.cache/agent-dock-trivy` and is not release evidence. An
operator may select another private cache with `--cache-dir`.

## Evidence layout

```text
manifest.json
SHA256SUMS
agent-dock-root.cdx.json
images/control-plane.cdx.json
images/control-plane.vulnerabilities.json
... one SBOM/report pair for each of six images
```

`manifest.json` records:

- Git revision and whether the diagnostic `--allow-dirty` override was used;
- image version, exact local image IDs, optional registry digests, creation
  time, platform, and OCI labels;
- the immutable Trivy image digest and policy;
- HIGH/CRITICAL total and fixable counts;
- size and SHA-256 for every SBOM/report.

`SHA256SUMS` covers the root SBOM, manifest, and all image evidence. Retain the
whole directory next to the release record; do not keep only screenshots.

## Gate and review

The automated gate requires zero fixable HIGH and zero fixable CRITICAL
findings in every image. Unfixable findings remain in the complete
HIGH/CRITICAL report and require explicit review; the gate is not a statement
that the image has no lower-severity or unknown risk. Root `npm audit` remains a
separate lockfile gate.

The local scanner receives read-only `docker image save` archives, not the
Docker socket. Its root filesystem and capabilities are removed; only the
database cache and evidence directory are writable. Network is enabled only for
the one vulnerability-database refresh, then disabled for all image scans.

The `tool-sandbox` local image scan selects Trivy's `os` package type. Debian's
package inventory therefore covers the packaged Node and OpenJDK runtimes
without downloading Trivy's optional Java index; repository application
packages remain covered by the root npm audit/SBOM. This override and rationale
are recorded in `manifest.json`. CI deliberately performs the unrestricted
image scan, including language packages.

The Web runtime compiles Caddy 2.11.4 from the pinned module with a pinned Go
1.26.5 builder, then copies the static binary into a pinned minimal Alpine
runtime. This avoids inheriting stale packages from an older prebuilt Caddy
image while preserving the standard Caddy module set. The actual final image,
not either build stage, is what the release gate scans.

CI independently builds a matrix of all six images, generates CycloneDX with
Anchore SBOM Action, records all HIGH/CRITICAL findings with Trivy, runs the same
fixable-finding gate, and uploads each evidence set for 14 days. Checkout,
Node, Anchore, Trivy, Gitleaks, and artifact Actions are pinned to immutable
commits in `.github/workflows/ci.yml`.

## Release limitations

- Local image IDs prove which bytes were scanned on that Docker Engine; they
  are not a registry signature or transparency-log attestation.
- A local image may have no `RepoDigest` until it is pushed.
- Docker build timestamps mean this process does not claim bit-for-bit
  reproducible images across hosts.
- Before publishing images, add a trusted registry, keyless or protected-key
  signing, provenance attestation, retention, and rollback policy, then verify
  the pulled registry digest instead of relying only on a local tag.
