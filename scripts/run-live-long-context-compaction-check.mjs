import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
if (process.env.PI_CLOUD_LIVE_LONG_CONTEXT_CHECK !== "1") {
  throw new Error(
    "Set PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1 to acknowledge sustained real-model and Cube KVM usage",
  );
}

const maximumCodingTurns = Number(process.env.PI_CLOUD_LONG_CONTEXT_MAX_TURNS ?? "32");
if (
  !Number.isSafeInteger(maximumCodingTurns) ||
  maximumCodingTurns < 8 ||
  maximumCodingTurns > 64
) {
  throw new Error("PI_CLOUD_LONG_CONTEXT_MAX_TURNS must be an integer between 8 and 64");
}
const writeReport = process.env.PI_CLOUD_LONG_CONTEXT_REPORT !== "0";
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);

async function readPrivate(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new Error(`${label} is not a private bounded file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const environment = Object.fromEntries(
  (await readPrivate(resolve(runtimeDirectory, ".env"), 64 * 1_024, "Production environment"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error("Production environment file is invalid");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const bindAddress = environment.PI_CLOUD_HTTP_BIND_ADDRESS;
const port = environment.PI_CLOUD_HTTP_PORT;
if (bindAddress === undefined || port === undefined) {
  throw new Error("Production HTTP endpoint configuration is missing");
}
const connectHost = bindAddress === "0.0.0.0" || bindAddress === "::" ? "127.0.0.1" : bindAddress;
const baseUrl = new URL(
  `http://${connectHost.includes(":") ? `[${connectHost}]` : connectHost}:${port}`,
);
const bootstrapToken = (
  await readPrivate(resolve(runtimeDirectory, "secrets/api-token"), 4_096, "Production API token")
).trim();
const databaseUrl = new URL(
  (
    await readPrivate(
      resolve(runtimeDirectory, "secrets/database-url"),
      4_096,
      "Production database URL",
    )
  ).trim(),
);
const databaseUser = decodeURIComponent(databaseUrl.username);
const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
if (
  databaseUrl.protocol !== "postgresql:" ||
  !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(databaseUser) ||
  !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(databaseName)
) {
  throw new Error("Production database identity is invalid");
}
const fetchFromProduction = (input, init = {}) =>
  fetch(new URL(String(input), baseUrl), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20 * 60_000),
  });
let api = new PiCloudApi(fetchFromProduction, bootstrapToken);
let authorizationToken = bootstrapToken;
let tenantId;

function capture(command, args, timeoutMs = 120_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        cwd: repositoryRoot,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4 * 1_024 * 1_024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`${command} failed: ${stderr.trim().slice(-2_000) || error.message}`, {
              cause: error,
            }),
          );
        } else {
          resolvePromise(stdout.trim());
        }
      },
    );
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function psql(query) {
  return capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "postgres",
    "psql",
    "--username",
    databaseUser,
    "--dbname",
    databaseName,
    "--no-align",
    "--tuples-only",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    query,
  ]);
}

async function acceptanceIdentity(suffix) {
  const reusable = await psql(
    `select tenant.id::text || '|' || tenant.slug || '|' || user_row.id::text
       from tenants tenant
       join users user_row on user_row.tenant_id = tenant.id
       join tenant_runtime_policies policy on policy.tenant_id = tenant.id
       left join projects project on project.tenant_id = tenant.id
      where tenant.slug like 'long-context-%'
      group by tenant.id, tenant.slug, tenant.created_at, user_row.id, user_row.created_at,
               policy.maximum_projects
      having count(project.id) < policy.maximum_projects
      order by tenant.created_at desc, user_row.created_at asc
      limit 1`,
  );
  if (reusable.length === 0) {
    return new PiCloudApi(fetchFromProduction).registerTenant(
      `long-context-${suffix}`.replaceAll(/[^a-z0-9-]/g, "-").slice(0, 63),
      "Long-context compaction acceptance",
    );
  }
  const [reusableTenantId, tenantSlug, userId] = reusable.split("|");
  assert(reusableTenantId && tenantSlug && userId, "Reusable acceptance identity is invalid");
  const issued = JSON.parse(
    await capture(process.execPath, [
      "scripts/production-compose.mjs",
      "exec",
      "-T",
      "control-plane",
      "node",
      "packages/control-plane/src/tenant-admin.ts",
      "issue",
      "--tenant",
      tenantSlug,
      "--user-id",
      userId,
      "--label",
      `long-context-${suffix}`.slice(0, 128),
      "--role",
      "owner",
    ]),
  );
  const token = issued?.credential?.token;
  assert.equal(typeof token, "string", "Tenant administration did not issue an API token");
  return {
    tenantId: reusableTenantId,
    tenantSlug,
    userId,
    displayName: "Long-context compaction acceptance",
    role: "owner",
    apiToken: token,
  };
}

async function revokeAcceptanceCredential(registration) {
  const separator = registration.apiToken.indexOf(".");
  assert(separator > 4, "Acceptance API token identity is invalid");
  const credentialId = registration.apiToken.slice(4, separator);
  await capture(process.execPath, [
    "scripts/production-compose.mjs",
    "exec",
    "-T",
    "control-plane",
    "node",
    "packages/control-plane/src/tenant-admin.ts",
    "revoke",
    "--tenant",
    registration.tenantSlug,
    "--credential-id",
    credentialId,
  ]);
}

function wait(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolvePromise();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
}

function progress(message) {
  process.stdout.write(`[long-context-check] ${message}\n`);
}

async function waitForRun(runId) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (run.state === "completed") return run;
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      throw new Error(
        `Run ${run.runId} ended as ${run.state}${
          run.failure === undefined
            ? ""
            : ` (${run.failure.code}: ${run.failure.message ?? "no detail"})`
        }`,
      );
    }
    await wait(200);
  }
  throw new Error(`Run ${runId} did not settle`);
}

async function usageForRun(runId) {
  const rows = await psql(
    `select request_sequence || '|' ||
            coalesce(actual_input_tokens, 0) || '|' ||
            coalesce(actual_output_tokens, 0) || '|' ||
            coalesce(actual_cache_read_tokens, 0) || '|' ||
            coalesce(actual_cache_write_tokens, 0) || '|' ||
            state || '|' || coalesce(failure_code, '') || '|' || coalesce(upstream_status, 0)
       from model_requests
      where tenant_id = ${sqlLiteral(tenantId)}
        and run_id = ${sqlLiteral(runId)}
      order by request_sequence`,
  );
  const requests =
    rows.length === 0
      ? []
      : rows.split(/\r?\n/).map((row) => {
          const [
            sequence,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            state,
            failureCode,
            upstreamStatus,
          ] = row.split("|");
          const parsed = {
            sequence: Number(sequence),
            inputTokens: Number(inputTokens),
            outputTokens: Number(outputTokens),
            cacheReadTokens: Number(cacheReadTokens),
            cacheWriteTokens: Number(cacheWriteTokens),
            state,
            failureCode: failureCode || undefined,
            upstreamStatus: Number(upstreamStatus) || undefined,
          };
          assert(
            [
              parsed.sequence,
              parsed.inputTokens,
              parsed.outputTokens,
              parsed.cacheReadTokens,
              parsed.cacheWriteTokens,
            ].every((value) => Number.isSafeInteger(value) && value >= 0),
            "Model request usage is invalid",
          );
          parsed.contextInputTokens =
            parsed.inputTokens + parsed.cacheReadTokens + parsed.cacheWriteTokens;
          return parsed;
        });
  assert(requests.length > 0, `Run ${runId} did not record a model request`);
  const completedRequests = requests.filter((request) => request.state === "completed");
  const recoveredFailures = requests.filter((request) => request.state === "failed");
  assert(completedRequests.length > 0, `Run ${runId} did not complete a model request`);
  assert(
    requests.every((request) => request.state === "completed" || request.state === "failed"),
    `Run ${runId} retained a denied, reserved, or aborted model request`,
  );
  assert(
    recoveredFailures.every((request) => request.failureCode !== "budget_denied"),
    `Run ${runId} crossed a governance budget`,
  );
  return {
    requests,
    attemptCount: requests.length,
    requestCount: completedRequests.length,
    recoveredFailures: recoveredFailures.map((request) => ({
      sequence: request.sequence,
      failureCode: request.failureCode,
      upstreamStatus: request.upstreamStatus,
    })),
    inputTokens: completedRequests.reduce((total, request) => total + request.inputTokens, 0),
    outputTokens: completedRequests.reduce((total, request) => total + request.outputTokens, 0),
    cacheReadTokens: completedRequests.reduce(
      (total, request) => total + request.cacheReadTokens,
      0,
    ),
    cacheWriteTokens: completedRequests.reduce(
      (total, request) => total + request.cacheWriteTokens,
      0,
    ),
    maximumRequestInputTokens: Math.max(
      ...completedRequests.map((request) => request.contextInputTokens),
    ),
  };
}

async function runEvidence(runId) {
  const row = await psql(
    `select sandbox.supervisor_id || '|' ||
            coalesce(attempt.sandbox_id::text, '') || '|' ||
            coalesce(activation.activation_id::text, '') || '|' ||
            coalesce(activation.runtime_id, '') || '|' ||
            coalesce(pi.total_bytes, 0) || '|' ||
            coalesce(pi.total_entries, 0) || '|' ||
            coalesce(pi.active_bytes, 0) || '|' ||
            coalesce(pi.active_entries, 0)
       from runs run
       join run_attempts attempt on attempt.id = run.current_attempt_id
       join sandboxes sandbox on sandbox.id = attempt.sandbox_id
       left join tool_broker_activations activation
        on activation.attempt_id = attempt.id
        and activation.session_id = run.session_id
       left join lateral (
         select coalesce(sum(pg_column_size(entry.payload)), 0)::bigint as total_bytes,
                count(*)::bigint as total_entries,
                coalesce(sum(pg_column_size(entry.payload)) filter (
                  where entry.seq >= coalesce(compaction.latest_seq, 0)
                ), 0)::bigint as active_bytes,
                count(*) filter (
                  where entry.seq >= coalesce(compaction.latest_seq, 0)
                )::bigint as active_entries
           from pi_session_entries entry
           cross join lateral (
             select max(candidate.seq) as latest_seq
               from pi_session_entries candidate
              where candidate.tenant_id = run.tenant_id
                and candidate.session_id = run.session_id
                and candidate.type = 'compaction'
           ) compaction
          where entry.tenant_id = run.tenant_id
            and entry.session_id = run.session_id
       ) pi on true
      where run.id = ${sqlLiteral(runId)}
      order by activation.created_at desc nulls last
      limit 1`,
  );
  const [
    supervisorId,
    sandboxId,
    activationId,
    runtimeId,
    sessionBytes,
    sessionEntries,
    activeContextBytes,
    activeContextEntries,
  ] = row.split("|");
  assert(supervisorId, `Run ${runId} has no Worker assignment`);
  return {
    supervisorId,
    sandboxId: sandboxId || undefined,
    activationId: activationId || undefined,
    runtimeId: runtimeId || undefined,
    sessionBytes: Number(sessionBytes),
    sessionEntries: Number(sessionEntries),
    activeContextBytes: Number(activeContextBytes),
    activeContextEntries: Number(activeContextEntries),
  };
}

async function compactionsForSession(sessionId) {
  const rows = await psql(
    `select run_id::text || '|' || reason || '|' || state || '|' ||
            coalesce(tokens_before, 0) || '|' || coalesce(estimated_tokens_after, 0) || '|' ||
            coalesce(extract(epoch from (completed_at - started_at)) * 1000, 0)::bigint
       from context_compactions
      where tenant_id = ${sqlLiteral(tenantId)}
        and session_id = ${sqlLiteral(sessionId)}
      order by started_at`,
  );
  if (rows.length === 0) return [];
  return rows.split(/\r?\n/).map((row) => {
    const [runId, reason, state, tokensBefore, estimatedTokensAfter, durationMs] = row.split("|");
    return {
      runId,
      reason,
      state,
      tokensBefore: Number(tokensBefore),
      estimatedTokensAfter: Number(estimatedTokensAfter),
      durationMs: Number(durationMs),
    };
  });
}

async function runTurn(sessionId, prompt, afterSequence, expectedTools) {
  const submittedAt = performance.now();
  const accepted = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("turn"), "off");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Long-context live turn timed out")),
    20 * 60_000,
  );
  const events = [];
  const text = [];
  let firstTextAt;
  let firstResponseAt;
  let terminal;
  try {
    const cursor = await streamSessionEvents({
      sessionId,
      afterSequence,
      signal: controller.signal,
      authorizationToken,
      fetchImplementation: fetchFromProduction,
      retryDelayMs: 100,
      onStatus() {},
      onEvent(event) {
        if (event.turnId !== accepted.turnId) return;
        events.push(event);
        if (event.type === "assistant.text.delta" || event.type === "tool.started") {
          firstResponseAt ??= performance.now();
        }
        if (event.type === "assistant.text.delta") {
          firstTextAt ??= performance.now();
          text.push(event.payload.text);
        }
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.cancelled"
        ) {
          terminal = event;
          controller.abort();
        }
      },
    });
    assert(terminal, "Turn did not publish a terminal event");
    assert.equal(terminal.type, "turn.completed", JSON.stringify(terminal.payload));
    assert.notEqual(
      terminal.payload.stopReason,
      "length",
      "Model exhausted its output allowance before completing the coding Turn",
    );
    assert(firstResponseAt !== undefined, "Turn did not stream a model response or Tool call");
    const toolCalls = events.filter((event) => event.type === "tool.started").length;
    if (expectedTools) {
      assert(toolCalls > 0, "Coding turn did not execute a Tool");
      assert(events.some((event) => event.type === "tool.completed"));
    } else {
      assert.equal(toolCalls, 0, "Conversation-only turn unexpectedly used a Tool");
    }
    await waitForRun(accepted.runId);
    return {
      ...accepted,
      cursor,
      text: text.join(""),
      toolCalls,
      firstResponseMs: Math.round(firstResponseAt - submittedAt),
      firstTextMs: firstTextAt === undefined ? undefined : Math.round(firstTextAt - submittedAt),
      settledMs: Math.round(performance.now() - submittedAt),
      eventCompactions: events
        .filter((event) => event.type === "context.compaction.completed")
        .map((event) => event.payload),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function activeWorkers() {
  const output = await psql(
    `select distinct supervisor_id
       from supervisor_connections
      where state = 'active'
        and expires_at > now()
      order by supervisor_id`,
  );
  return output.length === 0 ? [] : output.split(/\r?\n/);
}

async function waitForWorkers(expectedCount) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const workers = await activeWorkers();
    if (workers.length === expectedCount) return workers;
    await wait(250);
  }
  throw new Error(`Worker pool did not converge to ${String(expectedCount)} active Workers`);
}

function composeService(supervisorId) {
  if (supervisorId.endsWith("-1")) return "supervisor-host";
  if (supervisorId.endsWith("-2")) return "supervisor-host-1";
  throw new Error(`No production Compose service mapping for ${supervisorId}`);
}

async function stopWorker(supervisorId) {
  const service = composeService(supervisorId);
  await capture(process.execPath, ["scripts/production-compose.mjs", "stop", service]);
  return service;
}

async function restoreWorker(service) {
  await capture(process.execPath, ["scripts/production-compose.mjs", "start", service]);
  await waitForWorkers(2);
}

const algorithmTasks = [
  [
    "elementary sorting",
    "Create algolab/sorting_elementary.py and tests/test_sorting_elementary.py.",
    "Implement stable bubble sort, insertion sort with a key function, and stable binary insertion sort.",
    "Do not call Python's sorted inside an implementation. Test empty, singleton, sorted, reverse, duplicate, negative, tuple/key, and stability cases. Run only this test module.",
  ],
  [
    "divide-and-conquer sorting",
    "Create algolab/sorting_divide_conquer.py and tests/test_sorting_divide_conquer.py.",
    "Implement stable top-down merge sort, three-way quicksort, and heap sort.",
    "Cover adversarial sorted/reverse/equal inputs, duplicates, negative values, and deterministic randomized arrays without using sorted in production code. Run the tests.",
  ],
  [
    "distribution sorting",
    "Create algolab/sorting_distribution.py and tests/test_sorting_distribution.py.",
    "Implement counting sort with negatives, stable key-value counting sort, and LSD radix sort for signed integers.",
    "Validate duplicates, wide ranges, signs, stability, and deterministic random fixtures. Run the tests.",
  ],
  [
    "search primitives",
    "Create algolab/searching.py and tests/test_searching.py.",
    "Implement lower_bound, upper_bound, exact binary search, rotated-array search, and matrix staircase search.",
    "Define edge behavior precisely and test absent/present boundaries, duplicates, rotations, and degenerate matrices. Run the tests.",
  ],
  [
    "order statistics",
    "Create algolab/order_statistics.py and tests/test_order_statistics.py.",
    "Implement iterative randomized quickselect with an injected seed, deterministic median-of-medians selection, and inversion count.",
    "Test duplicates, negatives, invalid ranks, non-mutation, deterministic behavior, and brute-force cross-checks. Run the tests.",
  ],
  [
    "linear data structures",
    "Create algolab/linear_structures.py and tests/test_linear_structures.py.",
    "Implement an array ring deque, min stack, LRU cache, and disjoint-set union with path compression and union by rank.",
    "Include invariants, empty errors, capacity edge cases, repeated unions, and compact deterministic model-based tests. Run the tests.",
  ],
  [
    "binary trees",
    "Create algolab/binary_trees.py and tests/test_binary_trees.py.",
    "Implement iterative preorder/inorder/postorder, level-order traversal, tree reconstruction from preorder+inorder, round-trip serialization, and lowest common ancestor.",
    "Test empty, skewed, invalid reconstruction, ancestor, and round-trip serialization cases. Run the tests.",
  ],
  [
    "balanced trees",
    "Create algolab/balanced_trees.py and tests/test_balanced_trees.py.",
    "Implement an AVL map with insert/update/search, rotations, ordered iteration, rank, and select using subtree sizes.",
    "Write an invariant checker and use a bounded deterministic operation trace to compare against a Python dict plus ordered keys. Run the tests.",
  ],
  [
    "priority structures",
    "Create algolab/priority_structures.py and tests/test_priority_structures.py.",
    "Implement a binary min-heap, indexed priority queue with decrease-key, stable priority queue, and merge-k-sorted iterables.",
    "Test heap invariants after mutations, stable ties, invalid handles, and bounded deterministic traces. Run the tests.",
  ],
  [
    "hashing and probabilistic structures",
    "Create algolab/hashing.py and tests/test_hashing.py.",
    "Implement an open-addressing hash map with resizing/tombstones, a deterministic Bloom filter, rolling hash, and a consistent-hash ring with virtual nodes.",
    "Use deterministic hashes rather than Python's process-randomized hash where reproducibility matters. Test collision-heavy and resize scenarios. Run the tests.",
  ],
  [
    "graph representations and traversal",
    "Create algolab/graph_traversal.py and tests/test_graph_traversal.py.",
    "Implement directed/undirected adjacency graphs, BFS/DFS forests, parent/path reconstruction, connected components, bipartite check with witness, and cycle detection.",
    "Specify self-loop behavior and test disconnected and adversarial graphs. Run the tests.",
  ],
  [
    "directed graph structure",
    "Create algolab/directed_graphs.py and tests/test_directed_graphs.py.",
    "Implement Kahn and DFS topological sorts, Tarjan and Kosaraju SCC, condensation DAG, transitive closure for small graphs, transitive reduction for DAGs, and dominator sets for small control-flow graphs.",
    "Test cycles, disconnected vertices, equivalent SCC partitions, and order validity. Run the tests.",
  ],
  [
    "shortest paths",
    "Create algolab/shortest_paths.py and tests/test_shortest_paths.py.",
    "Implement Dijkstra with path reconstruction, 0-1 BFS, Bellman-Ford with reachable negative-cycle witness, Floyd-Warshall with next-hop paths, DAG shortest paths, and A* on a weighted grid.",
    "Test unreachable nodes, parallel edges, invalid negative Dijkstra edges, and brute-force cross-checks on deterministic small graphs. Run the tests.",
  ],
  [
    "spanning trees and connectivity",
    "Create algolab/spanning_connectivity.py and tests/test_spanning_connectivity.py.",
    "Implement Kruskal and Prim minimum spanning forests, second-best MST for small connected graphs, offline dynamic connectivity with rollback DSU, and minimum arborescence verification for supplied candidates.",
    "Cross-check Prim/Kruskal weights, disconnected behavior, ties, rollback snapshots, and brute-force small MSTs. Run the tests.",
  ],
  [
    "network flow and matching",
    "Create algolab/flow_matching.py and tests/test_flow_matching.py.",
    "Implement Dinic max flow, min-cut extraction, min-cost max-flow with potentials for nonnegative initial costs, Hopcroft-Karp bipartite matching, and minimum vertex cover recovery.",
    "Test conservation, residual invariants, zero capacity, disconnected networks, and matching/cover duality. Run the tests.",
  ],
  [
    "grid traversal",
    "Create algolab/grid_algorithms.py and tests/test_grid_algorithms.py.",
    "Implement flood fill, island counting, multi-source distance, shortest path with obstacle elimination, word search, Pacific-Atlantic reachability, surrounded-region capture, and weighted maze A*.",
    "Cover empty/ragged rejection, one-cell, unreachable, repeated letters, and deterministic generated grids. Run the tests.",
  ],
  [
    "string matching",
    "Create algolab/string_matching.py and tests/test_string_matching.py.",
    "Implement prefix-function/KMP, Z algorithm, Rabin-Karp with collision verification, Boyer-Moore-Horspool, longest prefix-suffix, minimal period, and streaming substring matching across chunks.",
    "Test Unicode, empty pattern policy, overlaps, collisions, chunk boundaries, and brute-force comparison. Run the tests.",
  ],
  [
    "tries and multi-pattern text",
    "Create algolab/tries.py and tests/test_tries.py.",
    "Implement mutable trie map with delete/prefix enumeration, radix trie, Aho-Corasick with overlapping matches, word-break reconstruction, and a suffix automaton supporting substring membership and distinct-substring count.",
    "Test Unicode, shared prefixes, duplicate pattern policy, deletion pruning, and brute-force counts. Run the tests.",
  ],
  [
    "sequence dynamic programming",
    "Create algolab/dp_sequences.py and tests/test_dp_sequences.py.",
    "Implement LIS reconstruction, LCS reconstruction, edit distance with operations, longest palindromic subsequence, maximum subarray with indices, weighted interval scheduling, and bitonic subsequence length.",
    "Define deterministic tie-breaking and test reconstructions by replaying operations. Run the tests.",
  ],
  [
    "knapsack dynamic programming",
    "Create algolab/dp_knapsack.py and tests/test_dp_knapsack.py.",
    "Implement 0/1 and unbounded knapsack with chosen items, subset-sum witness, partition difference, coin-change count/minimum, bounded coin change, and target-sum count.",
    "Reject invalid weights, define empty cases, and brute-force small deterministic instances. Run the tests.",
  ],
  [
    "interval dynamic programming",
    "Create algolab/dp_intervals.py and tests/test_dp_intervals.py.",
    "Implement matrix-chain parenthesization, optimal BST cost, palindrome partition with reconstruction, burst balloons, minimum triangulation, CYK membership for a normalized grammar, and stone merge cost.",
    "Test reconstruction validity and brute-force tiny inputs. Run the tests.",
  ],
  [
    "backtracking and exact cover",
    "Create algolab/backtracking.py and tests/test_backtracking.py.",
    "Implement permutations with duplicates, combinations, N-Queens, Sudoku solver with validation, exact-cover Algorithm X for a set representation, graph coloring, and Hamiltonian path for small graphs.",
    "Use deterministic solution ordering, input immutability where promised, and known unsatisfiable fixtures. Run the tests.",
  ],
  [
    "range query structures",
    "Create algolab/range_queries.py and tests/test_range_queries.py.",
    "Implement Fenwick tree, iterative segment tree, lazy range-add/range-min tree, sparse table, disjoint sparse table, prefix-sum 2D matrix, and Mo's algorithm for offline distinct counts.",
    "Test index validation, empty behavior, update/query interleavings, and brute-force randomized traces. Run the tests.",
  ],
  [
    "computational geometry",
    "Create algolab/geometry.py and tests/test_geometry.py.",
    "Implement orientation, robust integer segment intersection, monotonic-chain convex hull, polygon area, point-in-polygon boundary policy, closest pair, rotating-calipers diameter, and sweep-line interval overlap maximum.",
    "Test collinear/duplicate/large integer coordinates and brute-force small fixtures. Run the tests.",
  ],
  [
    "number theory",
    "Create algolab/number_theory.py and tests/test_number_theory.py.",
    "Implement extended gcd, modular inverse, fast modular power, deterministic 64-bit Miller-Rabin, Pollard-rho factorization with seeded randomness, sieve variants, CRT, Euler phi, and discrete log by baby-step giant-step.",
    "Test primes/composites/Carmichael numbers, invalid moduli, and reconstruction identities. Run the tests.",
  ],
  [
    "matrix algorithms",
    "Create algolab/matrices.py and tests/test_matrices.py.",
    "Implement dense matrix multiply, exponentiation, Gaussian elimination over rationals, determinant, inverse, rank, Strassen with cutoff/padding, and boolean transitive closure.",
    "Reject shape errors and cross-check exact arithmetic and multiplication against straightforward references. Run the tests.",
  ],
  [
    "scheduling algorithms",
    "Create algolab/scheduling.py and tests/test_scheduling.py.",
    "Implement interval selection, room allocation, job sequencing with deadlines/profits, round-robin simulation, shortest-remaining-time simulation, weighted completion-time ordering, and critical-path scheduling on a DAG.",
    "Use deterministic ties and test invalid/cyclic inputs plus schedule invariants. Run the tests.",
  ],
  [
    "online and streaming algorithms",
    "Create algolab/streaming.py and tests/test_streaming.py.",
    "Implement reservoir sampling with seeded RNG, Misra-Gries heavy hitters, count-min sketch, sliding-window median, exponential moving statistics, online variance, and mergeable top-k summaries.",
    "Test merge laws, bounds, deterministic seeds, empty streams, and exact small-stream comparisons. Run the tests.",
  ],
  [
    "compression algorithms",
    "Create algolab/compression.py and tests/test_compression.py.",
    "Implement canonical Huffman encode/decode, run-length encoding, LZ77 tokenization, LZW with reset, delta+varint integer coding, and Burrows-Wheeler transform with inverse.",
    "Test binary round trips, Unicode wrappers, malformed streams, empty data, and deterministic encodings. Run the tests.",
  ],
  [
    "concurrency-safe algorithms",
    "Create algolab/concurrent_algorithms.py and tests/test_concurrent_algorithms.py.",
    "Using only the standard library, implement a bounded blocking queue, reader-writer lock with writer fairness, future/promise, cancellable worker pool, parallel stable merge sort, and deterministic task dependency executor.",
    "Use bounded timeouts so tests cannot hang; verify cancellation, exception propagation, ordering, and clean thread shutdown. Run the tests.",
  ],
  [
    "integration registry",
    "Read the existing algolab modules, then create algolab/registry.py, tests/test_registry.py, and docs/ALGORITHM_CATALOG.md.",
    "Expose a deterministic metadata registry covering every implemented module, category, public callable, stability/mutation notes, and asymptotic complexity. Validate that registered import paths resolve and names are unique.",
    "Run the registry tests and a unittest discovery smoke test. Keep the final answer concise.",
  ],
  [
    "cross-module verification",
    "Read representative early, middle, and recent modules, then create tests/test_cross_module_properties.py.",
    "Add deterministic property-style checks that connect sorting to searching, graph traversal to shortest paths, DSU to Kruskal, string matching variants to a brute-force oracle, and compression round trips.",
    "Run this test module and fix only genuine regressions you uncover. Keep the final answer concise.",
  ],
];

function codingPrompt(task, index, marker) {
  const [title, target, requirements, tests] = task;
  return [
    `Long-context coding acceptance round ${String(index + 1)}: ${title}.`,
    index === 0
      ? `The project invariant marker is ${marker}; preserve that exact marker in algolab/__init__.py and README.md for later conversation recovery validation.`
      : "Continue in the existing Workspace from earlier rounds; do not replace or delete unrelated modules.",
    target,
    requirements,
    tests,
    "Use the remote file and shell tools; do not merely describe an implementation.",
    "Use only Python 3.11 standard-library dependencies, add clear type hints/docstrings, and keep all tests deterministic.",
    "Do not initialize Git or create a .git directory. End with a short statement of files changed and the exact test command/result.",
  ].join(" ");
}

const initialWorkers = await waitForWorkers(2);
const bootstrapApi = api;
const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const marker = `ALGO-LAB-${suffix.toUpperCase()}`;
const registration = await acceptanceIdentity(suffix);
api = new PiCloudApi(fetchFromProduction, registration.apiToken);
authorizationToken = registration.apiToken;
tenantId = registration.tenantId;
const model = await api.getModelConfiguration();
assert.equal(model.mode, "real", "Long-context acceptance requires a real model");
const project = await api.createProject(`Long-context algorithm lab ${suffix}`);
const session = await api.createSession(
  project.projectId,
  project.workspaceId,
  `Long-context algorithm lab ${suffix}`,
  "persistent",
);

const rounds = [];
let cursor = 0;
let completedCompaction;
let stoppedWorkerService;
let cleanupCompleted = false;

try {
  progress(
    `starting ${model.provider}/${model.modelId} Session ${session.sessionId} on ${initialWorkers.length} Workers`,
  );
  const selectedTasks = algorithmTasks.slice(0, maximumCodingTurns);
  for (const [index, task] of selectedTasks.entries()) {
    const turn = await runTurn(session.sessionId, codingPrompt(task, index, marker), cursor, true);
    cursor = turn.cursor;
    const [usage, evidence, compactions] = await Promise.all([
      usageForRun(turn.runId),
      runEvidence(turn.runId),
      compactionsForSession(session.sessionId),
    ]);
    const round = {
      round: index + 1,
      task: task[0],
      runId: turn.runId,
      worker: evidence.supervisorId,
      runtimeId: evidence.runtimeId,
      toolCalls: turn.toolCalls,
      firstResponseMs: turn.firstResponseMs,
      firstTextMs: turn.firstTextMs,
      settledMs: turn.settledMs,
      usage,
      sessionBytes: evidence.sessionBytes,
      sessionEntries: evidence.sessionEntries,
      activeContextBytes: evidence.activeContextBytes,
      activeContextEntries: evidence.activeContextEntries,
      eventCompactions: turn.eventCompactions,
    };
    rounds.push(round);
    progress(
      `round ${String(index + 1)} ${task[0]}: input(max/sum)=${String(usage.maximumRequestInputTokens)}/${String(usage.inputTokens)}, output=${String(usage.outputTokens)}, tools=${String(turn.toolCalls)}, firstResponse=${String(turn.firstResponseMs)}ms, settled=${String(turn.settledMs)}ms, active-context=${String(evidence.activeContextBytes)}B/${String(evidence.activeContextEntries)} entries`,
    );
    completedCompaction = compactions.find(
      (compaction) => compaction.runId === turn.runId && compaction.state === "completed",
    );
    if (completedCompaction !== undefined) {
      progress(
        `Pi compaction completed: ${String(completedCompaction.tokensBefore)} -> ${String(completedCompaction.estimatedTokensAfter)} estimated tokens in ${String(completedCompaction.durationMs)}ms`,
      );
      break;
    }
  }

  assert(
    completedCompaction !== undefined,
    `Pi did not compact after ${String(rounds.length)} real coding turns`,
  );
  assert(["threshold", "overflow"].includes(completedCompaction.reason));
  assert(completedCompaction.tokensBefore > completedCompaction.estimatedTokensAfter);

  const recall = await runTurn(
    session.sessionId,
    "Do not call any tool. What exact project invariant marker did I give you in the first coding round? Reply with that marker only.",
    cursor,
    false,
  );
  cursor = recall.cursor;
  const recallUsage = await usageForRun(recall.runId);
  const recallEvidence = await runEvidence(recall.runId);
  assert(
    recall.text.includes(marker),
    `Compacted conversation did not retain the first-round marker: ${recall.text}`,
  );
  progress(
    `post-compaction recall succeeded: firstResponse=${String(recall.firstResponseMs)}ms, settled=${String(recall.settledMs)}ms, maxInput=${String(recallUsage.maximumRequestInputTokens)}`,
  );

  const postCompaction = await runTurn(
    session.sessionId,
    [
      "Continue the algorithm project after context compaction and use tools.",
      "Create algolab/post_compaction_validation.py and tests/test_post_compaction_validation.py.",
      "Implement a deterministic function that runs representative sorting, graph traversal, shortest-path, string-matching, and compression checks through the existing public APIs and returns a structured report.",
      `Require the report to include the exact project invariant marker ${marker}.`,
      "Read the relevant existing modules rather than guessing their APIs, run the new tests, and fix integration mistakes.",
      "Do not initialize Git. End with a concise test result.",
    ].join(" "),
    cursor,
    true,
  );
  cursor = postCompaction.cursor;
  const postCompactionUsage = await usageForRun(postCompaction.runId);
  const postCompactionEvidence = await runEvidence(postCompaction.runId);
  progress(
    `post-compaction coding succeeded: tools=${String(postCompaction.toolCalls)}, firstResponse=${String(postCompaction.firstResponseMs)}ms, settled=${String(postCompaction.settledMs)}ms`,
  );

  stoppedWorkerService = await stopWorker(postCompactionEvidence.supervisorId);
  const survivingWorkers = await waitForWorkers(1);
  assert(!survivingWorkers.includes(postCompactionEvidence.supervisorId));
  progress(
    `stopped ${postCompactionEvidence.supervisorId}; forcing compacted Session to a fresh Worker`,
  );

  const crossWorker = await runTurn(
    session.sessionId,
    [
      "Use tools and continue the existing algorithm project on this Worker.",
      "Read algolab/post_compaction_validation.py and the first-round algolab/sorting_elementary.py.",
      "Add a regression proving binary insertion sort preserves the relative order of equal-key records, and update post_compaction_validation.py to report that check.",
      `Also assert that the persisted project invariant is exactly ${marker}.`,
      "Run the directly affected tests and report the exact commands/results concisely. Do not create Git metadata.",
    ].join(" "),
    cursor,
    true,
  );
  cursor = crossWorker.cursor;
  const crossWorkerUsage = await usageForRun(crossWorker.runId);
  const crossWorkerEvidence = await runEvidence(crossWorker.runId);
  assert.notEqual(crossWorkerEvidence.supervisorId, postCompactionEvidence.supervisorId);
  assert.equal(
    crossWorkerEvidence.runtimeId,
    postCompactionEvidence.runtimeId,
    "Cross-Worker continuation did not rebind the same persistent Cube runtime",
  );
  progress(
    `cross-Worker compacted recovery succeeded: ${postCompactionEvidence.supervisorId} -> ${crossWorkerEvidence.supervisorId}`,
  );

  await restoreWorker(stoppedWorkerService);
  stoppedWorkerService = undefined;

  const versions = await api.listWorkspaceVersions(session.sessionId);
  assert(versions.currentVersionId !== undefined);
  const files = await api.listWorkspaceFiles(versions.currentVersionId);
  assert(files.files.some((entry) => entry.path === "algolab/post_compaction_validation.py"));
  assert(files.files.some((entry) => entry.path === "tests/test_sorting_elementary.py"));
  const compactions = await compactionsForSession(session.sessionId);
  const totalUsage = [
    ...rounds.map((round) => round.usage),
    recallUsage,
    postCompactionUsage,
    crossWorkerUsage,
  ].reduce(
    (total, usage) => ({
      modelRequests: total.modelRequests + usage.requestCount,
      modelAttempts: total.modelAttempts + usage.attemptCount,
      recoveredRequestFailures: total.recoveredRequestFailures + usage.recoveredFailures.length,
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    }),
    {
      modelRequests: 0,
      modelAttempts: 0,
      recoveredRequestFailures: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  );
  const beforeCompaction = rounds.at(-1);
  const priorRounds = rounds.slice(0, -1);
  const report = {
    accepted: true,
    checkedAt: new Date().toISOString(),
    revision: (await capture("git", ["rev-parse", "HEAD"])).trim(),
    topology: {
      workers: initialWorkers,
      scheduler: "postgresql-run-queue",
      sandbox: "CubeSandbox KVM",
      sessionRuntime: "Pi SDK 0.84.1 PostgreSQL SessionStorage runtime",
    },
    model: {
      provider: model.provider,
      modelId: model.modelId,
      configuredContextWindow: 128_000,
      compactionReserveTokens: 16_384,
      compactionKeepRecentTokens: 20_000,
    },
    session: {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      marker,
      codingTurnsUntilCompaction: rounds.length,
      finalWorkspaceVersionId: versions.currentVersionId,
      visibleFilesOnFirstPage: files.files.length,
    },
    rounds,
    compactions,
    compaction: {
      ...completedCompaction,
      triggeringRun: beforeCompaction,
      preCompactionMaximumInputTokens: Math.max(
        ...priorRounds.map((round) => round.usage.maximumRequestInputTokens),
      ),
      triggeringRunMaximumInputTokens: beforeCompaction.usage.maximumRequestInputTokens,
    },
    postCompaction: {
      recall: {
        runId: recall.runId,
        markerRecovered: true,
        worker: recallEvidence.supervisorId,
        firstResponseMs: recall.firstResponseMs,
        firstTextMs: recall.firstTextMs,
        settledMs: recall.settledMs,
        usage: recallUsage,
        sessionBytes: recallEvidence.sessionBytes,
        sessionEntries: recallEvidence.sessionEntries,
        activeContextBytes: recallEvidence.activeContextBytes,
        activeContextEntries: recallEvidence.activeContextEntries,
      },
      coding: {
        runId: postCompaction.runId,
        worker: postCompactionEvidence.supervisorId,
        runtimeId: postCompactionEvidence.runtimeId,
        toolCalls: postCompaction.toolCalls,
        firstResponseMs: postCompaction.firstResponseMs,
        firstTextMs: postCompaction.firstTextMs,
        settledMs: postCompaction.settledMs,
        usage: postCompactionUsage,
      },
      crossWorker: {
        runId: crossWorker.runId,
        from: postCompactionEvidence.supervisorId,
        to: crossWorkerEvidence.supervisorId,
        differentWorker: true,
        sameCubeRuntimeRebound: true,
        toolCalls: crossWorker.toolCalls,
        firstResponseMs: crossWorker.firstResponseMs,
        firstTextMs: crossWorker.firstTextMs,
        settledMs: crossWorker.settledMs,
        usage: crossWorkerUsage,
        sessionBytes: crossWorkerEvidence.sessionBytes,
        sessionEntries: crossWorkerEvidence.sessionEntries,
        activeContextBytes: crossWorkerEvidence.activeContextBytes,
        activeContextEntries: crossWorkerEvidence.activeContextEntries,
      },
    },
    totalUsage,
  };

  if (writeReport) {
    const reportDirectory = resolve(repositoryRoot, "docs/reports");
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      resolve(reportDirectory, "long-context-compaction-acceptance-latest.json"),
      await format(JSON.stringify(report), { parser: "json" }),
      "utf8",
    );
    await writeFile(
      resolve(reportDirectory, "long-context-compaction-acceptance-latest.md"),
      [
        "# Long-context Pi compaction production acceptance",
        "",
        `- Checked at: ${report.checkedAt}`,
        `- Revision: \`${report.revision}\``,
        `- Provider/model: ${report.model.provider} / ${report.model.modelId}`,
        `- Coding Turns before first completed compaction: ${String(report.session.codingTurnsUntilCompaction)}`,
        `- Compaction reason/tokens: ${report.compaction.reason}, ${String(report.compaction.tokensBefore)} -> ${String(report.compaction.estimatedTokensAfter)}`,
        `- Compaction duration: ${String(report.compaction.durationMs)} ms`,
        `- Triggering Run first-response/settled: ${String(report.compaction.triggeringRun.firstResponseMs)} / ${String(report.compaction.triggeringRun.settledMs)} ms`,
        `- Post-compaction recall first-response/settled: ${String(report.postCompaction.recall.firstResponseMs)} / ${String(report.postCompaction.recall.settledMs)} ms`,
        `- Post-compaction coding first-response/settled: ${String(report.postCompaction.coding.firstResponseMs)} / ${String(report.postCompaction.coding.settledMs)} ms`,
        `- Cross-Worker recovery: ${report.postCompaction.crossWorker.from} -> ${report.postCompaction.crossWorker.to}`,
        `- Same persistent Cube runtime rebound: ${String(report.postCompaction.crossWorker.sameCubeRuntimeRebound)}`,
        `- Real model attempts/completed/recovered failures: ${String(report.totalUsage.modelAttempts)} / ${String(report.totalUsage.modelRequests)} / ${String(report.totalUsage.recoveredRequestFailures)}`,
        `- Real input/output/cache-read/cache-write tokens: ${String(report.totalUsage.inputTokens)} / ${String(report.totalUsage.outputTokens)} / ${String(report.totalUsage.cacheReadTokens)} / ${String(report.totalUsage.cacheWriteTokens)}`,
        `- Final Pi SessionStorage bytes/entries: ${String(report.postCompaction.crossWorker.sessionBytes)} / ${String(report.postCompaction.crossWorker.sessionEntries)}`,
        `- Final active context bytes/entries: ${String(report.postCompaction.crossWorker.activeContextBytes)} / ${String(report.postCompaction.crossWorker.activeContextEntries)}`,
        "",
        "The workload used real multi-round Python coding tasks, remote Tool calls, deterministic tests and a persistent CubeSandbox KVM. Pi completed native threshold/overflow compaction, retained an early conversation invariant, continued coding after compaction, and restored the compacted native Session on a different Worker while rebinding the same persistent Cube runtime.",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);

  await api.deleteConversation(session.sessionId, newIdempotencyKey("delete"));
  cleanupCompleted = true;
  progress("acceptance Session deleted and retained Cube released");
} finally {
  if (stoppedWorkerService !== undefined) {
    await restoreWorker(stoppedWorkerService).catch(() => undefined);
  }
  if (!cleanupCompleted) {
    await api
      .deleteConversation(session.sessionId, newIdempotencyKey("delete"))
      .catch(() => undefined);
  }
  await revokeAcceptanceCredential(registration).catch(() => undefined);
  // Keep bootstrap identity reachable so accidental reassignment is visible in
  // static analysis; test traffic always uses the isolated acceptance tenant.
  void bootstrapApi;
}
