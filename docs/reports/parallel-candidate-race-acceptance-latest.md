# Parallel candidate race production acceptance

- Checked at: 2026-07-23T16:53:36.426Z
- Provider/model: deepseek / deepseek-v4-flash
- Candidate concurrency: 2
- Candidate execution intervals overlapped: true
- Distinct gVisor Pods observed simultaneously: true
- Shared trusted Supervisor with isolated Tool activations: true
- Minimal patch: 7 model requests, 1164/664 input/output tokens, 2 test attempt(s) / 1 green effective result(s), gVisor Pod f347e02c-6244-4e50-9f79-5bdff6a603cd, activation 97a4da3d-a97c-41a0-9905-abb366861d53
- Verification first: 8 model requests, 1026/776 input/output tokens, 3 test attempt(s) / 1 green effective result(s), gVisor Pod 1e90c423-e38c-4a58-a7b7-8b32be62b549, activation e08b552a-42f7-43b8-88b4-8cd3aa2c6f41
- Recommended/promoted candidate: 936296bb-f440-4e31-a704-9f4981c123bd
- Promotion preserved parent Pi context: true
- Exact Sandbox cleanup: true

One immutable parent Workspace was forked into two child Sessions. Both Runs executed concurrently in distinct gVisor Pods, produced immutable Review Bundles with green tests, passed deterministic acceptance, and remained isolated until an explicit CAS promotion copied only the selected Workspace into the parent Session.
