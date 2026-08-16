# Architecture discussion archive

These files preserve the user-visible architecture discussions that drive
PiCloud changes. They are design input, not implementation truth: code,
tests, current architecture documents and upstream primary sources win when a
discussion contains a stale assumption.

To refresh a ChatGPT shared conversation:

```bash
node scripts/import-chatgpt-share.mjs \
  https://chatgpt.com/share/SHARE_ID \
  docs/discussions/YYYY-MM-DD-topic.md
```

The importer records the complete visible user/assistant conversation in
chronological order and intentionally excludes hidden reasoning, Tool traffic
and internal metadata. Re-running the command replaces the generated Markdown
deterministically with the latest shared snapshot.

Current archive:

- [2026-08-13 PiCloud architecture review](./2026-08-13-chatgpt-picloud-architecture-review.md)
- [2026-08-14 Streaming durability and thin Pi runtime](./2026-08-14-chatgpt-streaming-and-pi-runtime.md)
