# ADR-0108: Keep the Workspace API aligned with the file browser

Status: accepted

## Context

The current Web product exposes Workspace history only to select a settled
revision, list its files and read source code. Older protocol and service code
also exposed Artifact download, version comparison and version-based
Fork/Rollback operations. Those routes no longer existed in the current
controller or browser; conversation-tree Fork is the supported branching
workflow.

Workspace version responses also returned Pi, patch and internal snapshot
Artifact metadata that the browser did not consume. This leaked storage details
and forced every version query to join unrelated Artifact rows.

## Decision

Keep only these Workspace-version operations in the product API:

- list settled versions for a conversation;
- read one version's metadata;
- page its file index;
- materialize one validated file;
- archive or restore a conversation.

Remove the dormant compare, Artifact download and version Fork/Rollback
contracts and implementations. Remove canonical/superseded Run projection
fields that existed only for the retired rewind feature. Workspace version
responses no longer expose internal Artifact metadata.

## Consequences

The Workspace service and browser model match the actual product. File browsing
requires fewer joins, while Session-tree Fork remains a separate, explicit
conversation operation. Adding historical Diff or Artifact delivery later
requires a user-facing workflow and a new bounded contract.
