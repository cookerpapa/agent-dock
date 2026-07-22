# Real-model production acceptance

- Checked at: 2026-07-22T19:02:47.759Z
- Provider/model: deepseek / deepseek-v4-flash
- Source: mathewjonas/java-calculator-junit@0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb
- Model calls: 22
- Input/output tokens: 7306 / 5787
- Warm Pod reused: ebd234aa-68fd-40c8-8cdf-1d1788adb813
- Fencing token advanced: 1 -> 2
- First Review Bundle: 241e9b8a-d4a2-5bac-a038-295361af77c0 (117931b831b0bd2d677cd31bf528ca9edf84ead9332083e20afe39183b995c2d)
- Second Review Bundle: ca266560-f6c3-5113-aa5a-1974de93c40e (44dff53882b4bc41c5608cd768ecfd902523a9ed1a59aea3b2d67621ce4aed5b)
- Exact Sandbox cleanup: true

Both turns changed the imported Java repository, executed tools inside the credential-free gVisor Sandbox, committed immutable Review Bundles, persisted real token usage, reused the same physical Pod with a newer writer fence, and then destroyed that exact assignment.
