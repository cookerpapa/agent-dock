# Real-model production acceptance

- Checked at: 2026-07-22T22:52:32.873Z
- Provider/model: deepseek / deepseek-v4-flash
- Source: mathewjonas/java-calculator-junit@0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb
- Model calls: 24
- Input/output tokens: 5675 / 4877
- Warm Pod reused: 0509f617-02dc-4754-a2d9-b8a048b1fba2
- Fencing token advanced: 1 -> 2
- First Review Bundle: ce2d2be1-6e85-5527-ae21-db7b91ab567f (b5b4419281ff0448087f1e8204b7e435754afa368fb54d6e3f68a333f0375d01)
- Second Review Bundle: 0e1e7eed-6e74-5df3-a55e-4b6ddbb4a676 (5050f5b46834e715427cc606d680b575c863b756119b76ada56aa4832250defa)
- Exact Sandbox cleanup: true

Both turns changed the imported Java repository, executed tools inside the credential-free gVisor Sandbox, committed immutable Review Bundles, persisted real token usage, reused the same physical Pod with a newer writer fence, and then destroyed that exact assignment.
