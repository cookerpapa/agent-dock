# Parallel candidate race production acceptance

- Checked at: 2026-07-30T16:38:48.317Z
- Provider/model: deepseek / deepseek-v4-flash
- Candidate concurrency: 2
- Candidates passing deterministic acceptance: 2/2
- Candidate execution intervals overlapped: true
- Distinct Cube KVM guests observed simultaneously: true
- Shared trusted Supervisor with isolated Tool activations: false
- Minimal patch: completed/passed, 4 model requests, 722/357 input/output tokens, 1 test attempt(s) / 1 green effective result(s), Cube microVM 6643800962024c4a90f4f1237689f4cf, activation da33f8f4-a931-4ebd-9f23-14a8fbf1cf69
- Verification first: completed/passed, 7 model requests, 1003/777 input/output tokens, 1 test attempt(s) / 1 green effective result(s), Cube microVM 76607a46e76a44a49b5918c31239cc0a, activation d76f24c5-21e8-42fc-ba55-a6bdc5d6389f
- Recommended/promoted candidate: 03d13bec-b97d-4293-bfd8-c64bdeffc054
- Promotion preserved parent Pi context: true
- Exact Sandbox cleanup: true

One immutable parent Workspace was forked into two child Sessions. Both Runs executed concurrently in distinct Cube KVM microVMs. Every passing candidate produced an immutable Review Bundle with green tests; failed candidates remained explicit rather than blocking selection. An explicit CAS promotion copied only the selected passing Workspace into the parent Session.
