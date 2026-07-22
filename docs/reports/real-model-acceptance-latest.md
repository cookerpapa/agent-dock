# Real-model production acceptance

- Checked at: 2026-07-22T19:18:42.422Z
- Provider/model: deepseek / deepseek-v4-flash
- Source: mathewjonas/java-calculator-junit@0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb
- Model calls: 34
- Input/output tokens: 6797 / 8771
- Warm Pod reused: 714fed06-da04-49e9-8899-13861bd50d7e
- Fencing token advanced: 1 -> 2
- First Review Bundle: 2e73c854-87c2-5b74-ae2e-a1d7864713a9 (7710c0ab96eddbdb9d8f554bf9498f3edddbb8e0a52e19939d4246779caa03c9)
- Second Review Bundle: 253dedec-5c3e-500d-a2af-6e0e4c50be16 (bc979dd2c6edb0983005fe4919c2659fc178b787e6d4212e9566a91efbd55b5d)
- Exact Sandbox cleanup: true

Both turns changed the imported Java repository, executed tools inside the credential-free gVisor Sandbox, committed immutable Review Bundles, persisted real token usage, reused the same physical Pod with a newer writer fence, and then destroyed that exact assignment.
