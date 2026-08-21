# Control Plane restart acceptance

- Checked at: 2026-08-21T16:02:42.405Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 87
- SSE reconnects: 8
- Run Attempts: 1
- Elapsed: 13470 ms

The Control Plane container received SIGKILL after the first committed assistant delta. The trusted Worker continued committing the fenced Run and its coalesced event tail directly to PostgreSQL. SSE reconnected after the replacement Control Plane started, and the Run completed with one Attempt.
