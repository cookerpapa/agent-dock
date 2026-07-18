# Vibe coding playbook

This project may be implemented almost entirely through coding agents, but it
must not become an unreviewed pile of generated code. The owner's main work is
specifying behavior, checking evidence, asking for explanations, and making
architecture decisions.

## One task per coding session

Start each session with:

```text
Read AGENTS.md, README.md, docs/ARCHITECTURE.md, docs/ROADMAP.md and
docs/BACKLOG.md. Work only on <one backlog item>.

Before editing:
1. inspect the relevant existing code;
2. explain the proposed data flow and failure behavior;
3. list the files and tests you expect to change.

Then implement it, run the relevant tests, update the backlog/documentation,
and explain the final behavior in plain language. Do not start a later roadmap
phase or add infrastructure that is not required by this item.
```

## Questions to ask after every implementation

1. What happens on success?
2. What happens when the process dies at every await/network boundary?
3. Which component is the source of truth?
4. Can this operation be delivered twice?
5. How is same-session ordering guaranteed?
6. What prevents a stale runner from writing?
7. Where are secrets visible?
8. What resource is bounded, and by what limit?
9. Which tests prove these claims?
10. How would I demonstrate this behavior in an interview?

If the coding agent cannot answer these concretely, the item is not finished.

## Review without hand-writing code

The owner does not need to author implementation lines manually, but should:

- read the module-level interfaces and state machines;
- ask the agent to trace one real request end to end;
- inspect database constraints and public protocol definitions;
- run tests and deliberately break dependencies/processes;
- compare logs, database state, snapshots, and UI events;
- ask another coding-agent session to review security and concurrency;
- keep a short architecture journal for interview preparation.

## Commit discipline

Prefer one verified behavior per commit. A useful sequence is:

```text
spec/ADR -> failing test -> implementation -> integration test -> docs/demo
```

Do not combine formatting rewrites, dependency upgrades, architecture changes,
and new behavior in one commit.

## Evidence required for resume claims

- repeatable demo script;
- architecture and recovery documentation;
- load-test configuration and raw results;
- failure-injection tests;
- security boundary tests;
- dashboards or traces;
- measured numbers tied to a documented machine/environment.

Only measured results should appear as scale or performance claims on a resume.
