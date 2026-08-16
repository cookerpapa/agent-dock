# ADR-0084: Explicit bounded project settlement gate

- Status: Accepted
- Date: 2026-08-08
- Refines: ADR-0042, ADR-0081 and ADR-0083

## Context

A coding Agent can produce a plausible final answer after changing the
Workspace without running the project's actual verification command. A generic
"always review once more" loop would add latency and model cost to chat-only
Runs, guess completion criteria from prompts, and risk unbounded self-review.

PiCloud already freezes a project environment recipe in the accepted Turn.
Its verification commands are trusted project configuration rather than model
output, so one deliberately named command can define an opt-in completion
criterion without adding another mutable configuration channel.

## Decision

1. The gate is disabled unless the accepted environment recipe contains a
   verification command whose ID is exactly `settlement-gate`.
2. The trusted Pi extension observes native Tool execution boundaries. A
   successful `write`, `edit` or any `bash` means the Run may have changed the
   Workspace. A successful Bash invocation matching the configured command
   satisfies the gate.
3. After a successful low-level Pi run, if mutation was observed and
   verification was not, the extension queues one hidden Pi-native follow-up.
   It asks the model to run the frozen command, inspect the result and address
   failure before its final response.
4. The gate never executes a command itself and never bypasses Tool policy,
   budget, lease, Step, Sandbox or network enforcement. The follow-up is a
   normal Pi continuation with new Cloud Steps and normal model accounting.
5. At most one gate follow-up is allowed per Run. Error/aborted subturns do not
   trigger it, and the gate does not repeat if the model ignores the request or
   verification fails.
6. The hidden custom message is stored in Pi's native Session and therefore
   participates in normal checkpoint, fresh-Worker restore and compaction.

## Consequences

- Pure chat and projects without explicit policy retain their existing latency
  and token cost.
- Configured projects obtain a concrete, bounded stop hook without a second
  agent loop or heuristic prompt classifier.
- The model can interpret and repair a failed verification command, while the
  platform still has a hard upper bound on additional sampling.
- Exact command observation is intentionally conservative. Alternate commands
  may still cause one redundant follow-up, but never skip security controls or
  create an infinite loop.

## Rejected alternatives

### Infer verification from changed files or natural-language intent

This is model- and repository-dependent, cannot define success reliably and
would add overhead to unrelated Runs.

### Execute the verification command directly from the trusted Worker

That would bypass the Tool Sandbox boundary and separate command ledger. All
project code must continue to execute through the normal remote Bash Tool.

### Repeat until tests pass

An unbounded self-repair loop can consume arbitrary time and tokens. The gate
is a single bounded opportunity, not an autonomous CI system.
