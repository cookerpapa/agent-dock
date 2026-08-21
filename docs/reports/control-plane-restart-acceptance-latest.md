# Control Plane restart acceptance

- Checked at: 2026-08-21T20:24:57.195Z
- Provider/model: deepseek / deepseek-v4-flash
- First visible / terminal sequence: 3 / 82
- SSE reconnects: 28
- Run Attempts: 1
- Elapsed: 55636 ms

The Control Plane container received SIGKILL after the first committed assistant delta. The trusted Worker continued committing the fenced Run and its coalesced event tail directly to PostgreSQL. SSE reconnected after the replacement Control Plane started, and the Run completed with one Attempt.
