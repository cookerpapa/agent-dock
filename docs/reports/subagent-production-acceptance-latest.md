# Pi subagent production acceptance

- Checked at: 2026-08-19 01:02 CST
- Provider/model: DeepSeek / `deepseek-v4-flash`
- Parent Session: `d8d018d7-fc99-434a-9378-088a529ebe3e`
- Upstream contract: `pi-subagents@0.50.0`

| Mode | Child Session/Run | Workspace evidence | Result |
| --- | --- | --- | --- |
| `none` | durable, completed | no independent Workspace or Cube requirement | passed |
| `shared_serialized` | durable, completed | child Workspace ID equals parent Workspace ID | passed |
| `isolated` | durable, completed | distinct internal Workspace, terminal tombstone, patch contains `isolated-child-only.txt` | passed |

The acceptance used real model requests through the production Web/API path.
Every child was scheduled through the shared PostgreSQL Pi Worker queue and
stored as a native PostgreSQL Pi Session. The isolated child used a trusted
revision-bound persistent-Volume fork; its file appeared in the child Patch
artifact and remained absent from the parent Workspace.

Machine-readable identities and evidence are in
`subagent-production-acceptance-latest.json`.
