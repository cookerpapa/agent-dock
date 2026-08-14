# 审阅流式持久化方案

- Source: https://chatgpt.com/share/6a7f1034-76a0-83ea-8f84-3b599ae53231
- Imported: 2026-08-14T13:12:07.716Z
- Visible messages: 231
- Scope: user messages and final assistant answers in the shared conversation; internal reasoning and tool traffic are intentionally excluded.

## 001 · User · 2026-08-11T01:21:49.571Z

我正在处理llm产生的流式数据与前端交互的问题，具体你可以看看我的agent-dock的代码。我的cloud agent采用流式输出，在前端页面用户看到的也是流式文本。为了让用户看到的流式文本在看到之前都已经被持久化（我感觉这是必要的，因为cloud环境是可能会出现崩溃的），但是如果流式文本全部入pgsql，如果用户很多，将来可能会产生几十亿行的数据。我觉得既然是流式数据，那完全没有必要将流式数据入库，因为像这种流式输出api，在输出完成的时候都会带一条message的完整文本，我觉得pgsql里面存这条message完整文本足矣。但是为了保证前端用户的流式体验，这些delta文本也是需要持久化的，codex提出了用kafka搭配valekey映射的方案（我忘了，可能是叫这个名字），我没太懂这个方案，你审阅一下这个方案

## 002 · Assistant · 2026-08-11T01:25:27.473Z

我看完你现在这条链路后，结论比较明确：**你的判断是对的——“用户已经看到的内容必须先有 durable copy”是必要的，但这不等于“每个 delta 都必须永久存在 PostgreSQL”。**

而且你现在 `agent-dock` 实际上已经走到这个问题的中间状态了。

当前代码大致是：

```text
Pi SDK
  ↓ raw text_delta
Runner 内先做 delta coalesce
  ↓
Worker/File WAL
  ↓
BatchedEventPublisher
  ↓ 20ms / ≤64 events / ≤512KiB
Control Plane
  ↓
PostgreSQL session_events
  ↓ commit
ACK
  ↓
SSE → Browser
```

你的 Runner 已经会把连续 `text_delta` 合并，第一段立即发，后面的 delta 按窗口/大小聚合。 `BatchedEventPublisher` 又进一步把 event 按 20ms、最多 64 个、最多 512 KiB 批量送到 Control Plane。

**但问题正如你发现的：batch 只是减少 transaction/ACK 次数，没有减少最终 PG 行数。** `DurableEventStore` 最后还是把 batch 内每个 event 分别插进 `session_events`。所以规模上来后，确实可能出现一个回答几十/几百行 `session_events`，长期累计非常夸张。

### 我认为真正应该拆的是两种“durability”

现在你的 ADR-0008 把两件事情混在了一个 `session_events` 里：

```text
短期 durability：
  用户刚刚看到了 "hello wor..."
  Control Plane 崩溃后，这段不能消失

长期 durability：
  三个月以后打开这个 Conversation
  我只需要看到完整 assistant message：
  "hello world..."
```

这两个需求的生命周期完全不一样。

ADR-0049 虽然增加了 `conversation_turn_projections`，已经能让历史会话不用重新扫描所有 delta，但底层 delta 还是永久保留。

所以我会把它改成：

```text
                   ┌──────── short-lived durable journal ────────┐
LLM delta → WAL →  │ Kafka                                       │
                   │ retention: 比如数小时/1天                    │
                   └────────────────┬─────────────────────────────┘
                                    │ commit ACK
                                    ▼
                                  SSE
                                    │
                                    ▼
                                Browser


LLM message complete
        │
        ▼
PostgreSQL
messages / conversation_turn_projection
        │
        └──── 长期保存完整 semantic message
```

这才是我认为 **Kafka + PG** 真正合理的边界。

---

## 那 Valkey 是干什么的？

我没在你仓库或者我们之前的记录里找到 Codex 当时那段完整设计，所以无法确认它当时说的 “Kafka + Valkey mapping” 原文。但如果这个设计是合理的，我猜它表达的应该是类似：

```text
Kafka
= delta 的 durable append-only journal

Valkey
= session → 当前 stream/replay position 的快速索引
```

比如：

```text
live:{sessionId}:{turnId}

{
    topic: "agent-stream-v1",
    partition: 17,
    firstOffset: 8127301,
    highWaterOffset: 8127456,
    lastSeq: 381,
    status: "streaming"
}
```

或者更进一步：

```text
Kafka
  ↓ consumer
Valkey Stream
  key = stream:{sessionId}
  ↓
SSE Gateway
  ↓
Browser
```

Kafka 保存**可恢复的原始流**，Valkey 给你一个**按 session 快速定位和 replay 的 materialized view / routing index**。

原因是 Kafka 本身是：

```text
topic
 ├ partition 0
 ├ partition 1
 ├ partition 2
 ...
```

而不是：

```text
session A → 自己一条 stream
session B → 自己一条 stream
session C → 自己一条 stream
```

你可以用 `sessionId` 作为 key，让同一 session 稳定落在同一 partition，但 partition 里仍然会交错很多 session。

所以如果浏览器说：

```text
GET /sessions/abc/events
Last-Event-ID: 391
```

你真正希望系统快速回答：

> session abc 的 seq=392 从哪里开始？

Valkey 可以承担这个快速索引/短期 replay view。

Valkey Streams 自己也天然支持追加、范围读取和 trimming。

---

## 但这里有一个非常重要的原则

**Valkey 不应该成为你“用户可见前必须 durable”的 correctness boundary。**

正确的顺序应该是：

```text
delta
  ↓
Kafka produce
  ↓
Kafka ACK             ← durability boundary
  ↓
更新 Valkey           ← 可以重建
  ↓
SSE
  ↓
Browser
```

而不是：

```text
delta
 ↓
Valkey
 ↓
SSE
 ↓
异步 Kafka
```

后者还是存在：

```text
Valkey/SSE 成功
Kafka 尚未成功
↓
故障
↓
用户已经看到了，durable journal 却没有
```

Kafka 如果配置 `acks=all`，producer 会等待 ISR 副本确认；配合 replication factor 3、`min.insync.replicas=2` 是 Kafka 官方给出的典型高 durability 配置。Producer idempotence 又可以处理 retry 导致的重复写。

而 Valkey 虽然可以 AOF，甚至可以 `WAITAOF` 等待本地/副本 fsync，但 Valkey 文档也明确说明 Streams 默认复制是异步的，failover 下仍有丢失窗口。

因此我会定义：

> **Kafka 是 durability，Valkey 是 acceleration。**

Valkey 全挂了，最多导致：

- SSE replay 慢一点；
- active stream index 需要恢复；
- consumer 重建 materialized view；

**绝不能导致用户已经看到的文本找不回来。**

---

## 这样一来，你的几十亿 PG 行问题就消失了

假设一个 assistant message：

```text
LLM 实际吐：
2000 个 token delta

Runner coalesce 后：
100 个 streaming chunks

Kafka：
100 records
保留 24h

PostgreSQL：
1 assistant_message row
```

24 小时后 Kafka 这 100 个 chunk 自动过期。

Kafka 本身就适合这种 retention model：`cleanup.policy=delete` 时可以按照 `retention.ms` / `retention.bytes` 删除旧 segment，而不是像关系数据库那样永久累积业务行。

所以长期数据量就从：

```text
Postgres:
users × conversations × turns × hundreds_of_deltas
```

变成：

```text
Postgres:
users × conversations × semantic_messages
```

这差一个数量级以上。

---

## 不过我还会对 Codex 的方案砍一刀：Valkey 可能暂时没必要

这是我审这个方案时最想强调的地方。

**Kafka 我认为有明确价值；Valkey 是否必要，我现在持保留意见。**

你目前真正必须解决的只有：

```text
1. delta durable before SSE
2. crash 后能 replay
3. final message 长期写 PG
4. delta 最终自动删除
```

这四个 Kafka + PG 已经能解决。

Valkey只有当你进一步遇到：

```text
大量并发 SSE
按 session replay Kafka 成本很高
跨 Control Plane replica fan-out
active stream routing 很频繁
```

才明显有价值。

所以我甚至更喜欢你第一版做：

```text
Pi
 ↓
Worker WAL
 ↓
Kafka short-lived stream journal
 ↓ ACK
Control Plane
 ├──→ SSE
 │
 └── final message → PostgreSQL
```

而不是一上来：

```text
Pi
 ↓
WAL
 ↓
Kafka
 ↓
Valkey
 ↓
Control Plane
 ↓
PG
 ↓
SSE
```

后者对一个简历项目来说已经开始有“为了分布式而分布式”的味道了。

---

还有一个细节我会改：**不要依赖“LLM API 最后肯定会给完整 message”这个假设。**

你的 Harness 应该自己维护：

```text
canonicalAssistantMessage += delta
```

或者从 Pi 最终 session/message state 取得 canonical message。

也就是说，这是 **AgentDock 自己的协议保证**：

```text
message.delta*
      ↓
message.completed {
    content: complete canonical content
}
```

而不是相信 OpenAI/Anthropic/DeepSeek 每家 provider 都有完全相同的 final-event 行为。

你现有 ADR-0040 其实已经写了这一原则：**final canonical message independently persisted from UI delta coalescing**。

所以我觉得你现在的方向可以概括成一句非常漂亮的架构原则：

> **Streaming delta 是短生命周期的 durable journal；completed message 才是长期的 conversation state。**

这比现在 `session_events = 永久 event sourcing` 更适合 Cloud Agent。

下一步我觉得我们可以只讨论一个最麻烦的问题：**如果 Kafka 保存 delta、PG 保存 final message，那么 Agent 在输出到一半崩溃，比如用户已经看到 60% assistant message，恢复后这 60% 到底怎么重新进入 Pi 的 `messages[]`。**  
这个问题比 Kafka/Valkey 本身更关键，因为它决定你的 durable streaming 到底只是“UI 不丢”，还是“Agent 状态也真的不丢”。

## 003 · User · 2026-08-11T01:30:00.621Z

你看的是main分支吗？codex应该是在今早凌晨修改的代码，你看看commit信息里有提及codex给出的方案吗

## 004 · Assistant · 2026-08-11T01:31:16.675Z

刚才那一轮我主要看的是 `feat/cubesandbox-primary-runtime`，这点确实看错分支了。现在按你 **main 最近这批 commit** 往回看，已经能确定：**Codex 给出的 Kafka + Valkey 方案就在今天凌晨那批提交里，而且设计写得非常明确。**

最关键的是这三次演进：

1. `35f7bff` — **`refactor enterprise events to Kafka-first ingest`**  
   这一步把 Kafka 提升成了 **Worker 流式事件的第一个共享持久化边界**。以前是：

   ```text
   Worker
     → PostgreSQL Outbox
     → ACK
     → Kafka
   ```

   改成：

   ```text
   Worker
     → Event Gateway
     → Kafka
     → ACK Worker
   ```

   commit 里明确写的是：**只有 Kafka 接受了 Session-keyed batch，才给 Worker cumulative ACK**。

2. `6b8dd42` — **`feat: tier agent session and event storage`**  
   这是一个中间方案。当时 Codex 还是打算：

   ```text
   PG：保留 14 天 hot event
   S3：之后归档 cold events
   ```

   也就是说它当时已经意识到“delta 永久留 PostgreSQL”不可取，但解决办法还是 hot/cold 分层。

3. `7c774b9` — **`feat: separate live streams from canonical conversations`**  
   这个才是你记得的最终方案，而且名字确实就是 **Valkey**，不是我上次推测出来的。

   这个 commit 直接把架构描述改成：

   ```text
   PostgreSQL canonical state
   Kafka + Valkey live-event path
   ```

   并且明确规定：

   ```text
   Kafka
   = accepted high-frequency Worker batches
   = durable source

   Valkey
   = bounded, rebuildable SSE read model

   PostgreSQL
   = terminal canonical Turns
   + monotonic cursors
   ```

   

而且时间也完全吻合。`7c774b9` 的提交时间是 **2026-08-11 00:10（+08:00）**，就是你说的今天凌晨。

### 所以我上次对方案的理解，需要修正一点

Codex 的方案比我刚才猜的更完整。它并不是简单：

```text
Kafka → Valkey mapping
```

而实际上是：

```text
                         durable boundary
                               │
Worker WAL                    ▼
   │                     ┌──────────┐
   └─ event batch ──────→│  Kafka   │
                         └────┬─────┘
                              │
                         projector
                              │
                              ▼
                         ┌──────────┐
                         │  Valkey  │
                         │ Streams  │
                         └────┬─────┘
                              │
                         Event Gateway
                              │
                             SSE
                              │
                           Browser


Turn settled
      │
      ▼
PostgreSQL
  canonical transcript
  + terminal event
  + event cursors
```

这里最漂亮的一点是：**Kafka 和 Valkey 的职责是完全分开的。**

Kafka负责：

> “用户看到之前，这些 delta 有没有一个真正 durable 的 copy？”

Valkey负责：

> “浏览器需要按 `sessionId + seq` 高效 replay 时，从哪里读？”

PostgreSQL负责：

> “这轮最终到底产生了什么完整消息/Tool transcript？”

这正好解决你最开始担心的：

> delta 不能丢，但又绝对没有必要永久变成几十亿条 PG row。

而且 Codex 甚至明确写了：

> live-stream compactor **不会把 token delta 归档到 PostgreSQL 或 S3**；Kafka retention 要比 Valkey replay window 长，因此 Valkey 整体丢失后可以从 Kafka 重建。

这意味着它最终把之前 `6b8dd42` 的：

```text
PG hot
→ S3 cold
```

也否掉了。

现在变成：

```text
Kafka     短/中期 durable journal
Valkey    更短期 live replay cache/read model
PG        永久 canonical state
```

并且 Valkey 本身配置也不是普通缓存：当前代码给它开了 AOF、`appendfsync always`、`noeviction`。

所以，**这次你记得是对的**。Codex 凌晨实际上已经针对你刚才描述的“delta 持久化但不能全塞 PG”这个问题做了一轮比较大的重构。

我现在反而觉得值得继续审的是一个更细的问题：**为什么 Kafka 已经能 durable + replay 了，还要再加一层 Valkey Stream？** 这个地方是整个方案里最值得判断有没有过度设计的地方。

## 005 · User · 2026-08-11T01:33:56.960Z

valkey是用来干什么的，我没太懂，你再审一审这个设计

## 006 · Assistant · 2026-08-11T01:36:12.389Z

我重新按 `main` 的实际代码顺了一遍。现在我对 Valkey 的定位更清楚了：

**Valkey 不是 Kafka 的持久化备份，也不只是一个“session → Kafka offset 映射表”。它实际上是一份“按 Session 重排后的、给 SSE 使用的短期事件数据库”。**

比如 Kafka 里真实的数据更像：

```text
partition 17

offset 1001 -> session A, seq 31
offset 1002 -> session B, seq 18
offset 1003 -> session A, seq 32
offset 1004 -> session C, seq 91
offset 1005 -> session A, seq 33
```

同一个 session 因为 `sessionId` 被用作 Kafka key，所以会稳定落到同一 partition，并保持 partition 内顺序；但一个 partition 里面会混着大量 session。Kafka 的 consumer group 也是按 partition 分配消费者，而不是按 session 给浏览器提供随机查询接口。

可你的浏览器要问的问题却是：

```text
session A
Last-Event-ID: 31

请给我：
seq 32
seq 33
seq 34
...
```

这就是 Valkey 的价值。

Codex 当前实现会给每个 Session 建一个 Valkey Stream：

```text
agent-dock:live-events:{sessionId}:stream
```

然后直接把 AgentDock 的 `seq` 当 Stream ID：

```text
31-0 → event JSON
32-0 → event JSON
33-0 → event JSON
```

而且存的不是 offset mapping，**是完整 event JSON + sha256**。然后 SSE reconnect 时直接做类似：

```text
XRANGE session-stream 32-0 57-0
```

就能精确取得这个 session 的一段事件。代码就是这么写的。 Valkey Streams 本身也正好支持显式 ID、`XRANGE` 范围读取和 `XTRIM`，所以这个数据结构和你的 `session seq` 很契合。

所以我会把三者画成这样：

```text
                 durable log
Worker ───────────→ Kafka
                       │
                       │ projector
                       ▼
                 Valkey Stream
                 session A: 31,32,33...
                       │
                    XRANGE
                       │
                       ▼
                 Event Gateway
                       │
                      SSE
                       ▼
                   Browser


Turn 完成
   │
   ▼
PostgreSQL
canonical transcript
+ terminal event
+ seq cursors
```

这里 **Kafka 回答“事件有没有可靠保存”**，**Valkey 回答“浏览器怎么高效按 session 重放”**，**PG 回答“这轮对话最终是什么”**。

这三个职责拆得其实挺漂亮。

更关键的是，你现在的“用户可见前必须持久化”约束并不依赖 Valkey。当前 Kafka producer 开了 idempotence，`acks=-1`，Worker event 先写 Kafka；Kafka 成为 enterprise stream 的第一 shared durability boundary。 随后 projector 才把 Kafka event append 到 Valkey，再推进 PG 的 `last_projected_seq`；SSE 读取的上界又是这个 `last_projected_seq`。因此逻辑上是：

```text
Kafka durable
     ↓
Valkey 已有 event
     ↓
PG last_projected_seq = N
     ↓
SSE 才允许读到 N
```

而不是：

```text
Valkey 写了
↓
浏览器看到了
↓
Kafka 慢慢持久化
```

这一点是正确的。`readReplayPage()` 也会把 Valkey live events 和 PG 里的 terminal event 合并，并逐个检查 `seq` 是否连续；缺一条就报 invariant error，不会悄悄给浏览器一个残缺流。

### 那为什么不能 Kafka → SSE，砍掉 Valkey？

理论上当然可以，但你很快就得自己重新造一个“Valkey”。

因为 Kafka offset 是：

```text
partition 17 / offset 1003
```

浏览器 cursor 是：

```text
session A / seq 32
```

两者不是一个坐标系。

你要支持几十万条长连接、浏览器断线重连、任意 Event Gateway replica 接管，就得解决：

```text
(sessionId, seq)
      ↓
Kafka partition + offset
```

以及找到 offset 后如何过滤同 partition 里其他几千个 session。

最后你大概率又会造一个：

```text
session → event index
```

这就是现在的 Valkey Stream。

所以对于你的 **enterprise profile，我赞成保留 Valkey**。对小型 self-hosted 环境则没必要；你当前代码其实已经这么区分了：没有 external Kafka/Valkey 时还是直接走 PG event log，有 enterprise event plane 才启用 Kafka + Valkey。

### 我审下来有三个地方值得继续改

第一，**Valkey 现在有点“既说自己是 cache，又把自己当 durable store 用”。**

设计文档说它是：

> rebuildable SSE read model

这个定义我赞同。但 compose 又给 Valkey 配了 AOF + `appendfsync always`。这相当于每次写 Valkey 都要求落盘。

其实你的真正 durability 已经是 Kafka。Valkey 丢掉之后，仓库甚至已经实现了 `events:rebuild-live`，会从 Kafka 按 PG 的 `replay_floor_seq ~ last_persisted_seq` 重建 Valkey。

所以从架构纯洁性上，我更希望：

```text
Kafka = 必须 durable
Valkey = 可以丢，但必须自动恢复
```

现在则更接近：

```text
Kafka = durable
Valkey = 最好也别丢
如果真丢了 → 人工停 projector → rebuild
```

这不是错误，但**自动恢复能力还不够成熟**。我宁可加强自动 rebuild/repair，再适当降低 Valkey 自身的持久化要求，而不是长期靠 `fsync always`。

第二，**Valkey 的 trim 设计我很喜欢，但应该专门做故障测试。**

Turn 完成之后，系统已经把完整 transcript 持久化到 PG，就会创建 compaction job；worker `XTRIM` 掉这个 Turn 的 Valkey delta，再把 PG `replay_floor_seq` 推进。旧浏览器拿太老的 `Last-Event-ID` 再连时会收到 `410 event_cursor_expired`，然后重新加载 canonical conversation。

所以最终：

```text
正在生成：
Kafka + Valkey

生成结束：
PG canonical transcript
       ↓
Valkey delta 删除
```

**这正是你最初想要的行为。**

不过我会加一个很刁钻的 fault test：`Kafka duplicate/redelivery` 在对应 Valkey range 已经被 trim 后才抵达 projector。当前 projector 对 `seq <= last_projected_seq` 的 redelivery 会回 Valkey 检查原 event 是否一致；如果已经 trim 了，这里可能产生冲突。 正常时序下窗口很小，但 correctness 最好不要依赖“它一般处理得够快”。

第三，整个方案里我现在**更担心的反而不是 Valkey，而是 Kafka 写入发生在 PG transaction 持锁期间**。

代码明确是锁住 Session/cursor，完成 fence/seq 校验后：

```text
PG transaction
  lock session
  lock cursor
      ↓
  await Kafka append   ← 网络 IO
      ↓
  update cursor
commit
```

注释甚至明确说为了防止 projector overtaking，故意一直持锁到 broker ACK。

这样 correctness 很清楚，但 Kafka 出现 300ms、1s 抖动时，你的 PostgreSQL transaction 和连接也跟着被占住。用户规模上来后，这个地方我会比“Valkey 是否多余”更早做压测。

所以我现在对 Codex 这版的评价是：

**Kafka + Valkey 并不是为了堆技术栈而堆出来的。Kafka 是 write-optimized durable log，Valkey 是 session-oriented hot replay read model，PG 是 canonical semantic state；三层职责是成立的。**

如果让我改，我**不会砍 Valkey**，而会把它的定位再坚定一点：

> **Valkey 可以丢，Kafka 绝不能丢；Valkey 丢失只能影响短期 SSE availability，绝不能影响 conversation correctness。**

然后把“Valkey gap 自动从 Kafka repair”补起来。做到这一点，这套流式持久化设计我认为就相当扎实了。

## 007 · User · 2026-08-11T01:50:23.010Z

所以valkey为前端提供sse数据的吗，那它会无限存数据吗，如果按这套架构，那流式片段和完整message分别存在哪，当pgsql收到完整message之后，流式片段最终会从整个架构的存储中剔除吗

## 008 · Assistant · 2026-08-11T01:50:41.733Z

对。按照你现在 `main` 的实现，可以把 Valkey 理解成：

> **专门给前端 SSE 服务的“短期流式事件库”。**

但更准确一点，Event Gateway 的 SSE 读取实际上是：**普通流式事件从 Valkey 读，terminal event 从 PostgreSQL 读，然后按 `seq` 合并。** 当前 `readReplayPage()` 就是这么做的。

整个生命周期可以这样看：

```text
LLM 正在输出

delta
  │
  ▼
Worker WAL/spool
  │
  ▼
Kafka                ← durable source
  │
  ▼ projector
Valkey Stream         ← SSE hot read model
  │
  ▼
Event Gateway
  │
  ▼
SSE
  │
Browser


LLM 输出完成 / Turn settle

Valkey 中的 delta
       │
       ├── 聚合成完整 transcript
       ▼
PostgreSQL
canonical Turn / 完整 message、Tool transcript
       │
       ▼
创建 compaction job
       │
       ▼
XTRIM Valkey
删除这一 Turn 的 delta
```

所以你问的几个问题，答案分别是：

**第一，Valkey 不会无限存。**

当前代码专门有一个 `SessionLiveStreamCompactionService`。当一个 Turn 已经有 canonical transcript 后，它会执行：

```text
trimThrough(sessionId, throughSequence)
```

底层就是 Valkey：

```text
XTRIM stream MINID ...
```

然后 PostgreSQL 的 `replay_floor_seq` 会推进。也就是说，这些已经完成的历史 delta 会从 Valkey Stream 里删除。

如果一个很老的浏览器还拿着：

```text
Last-Event-ID: 123
```

但是 `123` 已经被 trim 了，系统不会试图从残缺的 Valkey 数据继续，而是返回：

```text
410 event_cursor_expired
```

让前端重新加载 PostgreSQL 里的完整 conversation。

---

**第二，流式片段和完整 message 确实被放到了不同的地方。**

生成期间大致是：

```text
Kafka
  保存 delta/event batch
  ↓
Valkey
  保存 session-oriented delta/event
  ↓
PG
  只保存 seq / high-water / cursor 等元数据
```

enterprise 模式下，`DurableEventStore` 不再把每个 delta 插入 `session_events`，而是先 `Kafka append()`，然后只推进 PG cursor。

而 Turn 完成以后：

```text
PostgreSQL
  保存完整 canonical transcript
  + terminal event

Valkey
  旧 delta 删除

Kafka
  旧 delta 暂时继续存在
```

Turn settlement 之前，系统甚至会从 Valkey 把当前 Turn 的事件全部读取出来，再生成完整 transcript，所以 PG 最终保存的不是“最后一个 delta”，而是完整的语义结果。

---

这里有一个你特别需要注意的区别：

### PG 收到完整 message 后，delta **不会马上从整个系统彻底消失**

它会分阶段消失。

大概是：

```text
                    Turn 完成
                       │
             ┌─────────▼──────────┐
             │ PG canonical state │
             └─────────┬──────────┘
                       │
             compaction confirmed
                       │
                       ▼
Valkey delta ───────── DELETE


Kafka delta ────────── 继续保留一段时间
                       │
                  retention 到期
                       │
                       ▼
                     DELETE
```

这是故意的。

因为如果：

```text
PG 已完整落库
Valkey 已 trim
↓
Valkey 整个集群突然坏掉
```

Kafka 仍然可以承担一段时间的恢复源。

你现在甚至已经有：

```text
npm run events:rebuild-live
```

它会从 Kafka 把仍处在 hot replay 范围内的 event 重新投影进一个新的 Valkey。

因此 Codex 设计里要求：

> Kafka retention 要长于 Valkey replay window。

---

而 Worker 本地的 WAL/spool 又更短。

正常情况下：

```text
Worker WAL
   │
Kafka ACK
   │
   └────→ WAL 中对应 prefix 可以删除
```

所以长期来看，你不会有四份永久 delta。

最终应该趋向：

```text
刚生成时：

Worker WAL   ✓
Kafka        ✓
Valkey       ✓
PostgreSQL   只有 cursor


Turn 刚完成：

Worker WAL   ×
Kafka        ✓
Valkey       ✓（短暂）
PostgreSQL   ✓ 完整 message


compaction 后：

Kafka        ✓
Valkey       ×
PostgreSQL   ✓ 完整 message


Kafka retention 到期：

Kafka        ×
Valkey       ×
PostgreSQL   ✓ 完整 message
```

**这才是这套设计最核心的价值。**

也就是说，假设一个回答产生了 500 个 streaming delta：

```text
短期：
Kafka 500
Valkey 500

长期：
PostgreSQL 1 个完整 semantic message / transcript
```

而不是：

```text
PostgreSQL 永远留 500 delta + 1 message
```

从这个角度讲，这套架构实际上非常贴合你最初的需求：

> **delta 需要 crash-safe，但不值得永久保存。**

我唯一会进一步确认的是 **Kafka 的 retention 到底设置成多少，以及 topic 是否真的配置了有界 retention**。因为只有 Kafka 最终也淘汰这些 delta，你说的“最后从整个架构里彻底剔除，只留下完整 message”才真正成立。当前设计意图明确是如此，但这部分值得直接检查部署配置。

## 009 · User · 2026-08-11T01:58:34.660Z

嗯，那你继续确认配置是否正确吧

## 010 · Assistant · 2026-08-11T02:03:16.553Z

我确认完了。**整体设计是正确的，而且现在的实际参数满足“Kafka 保留时间 > Valkey 热重放窗口”这个核心约束；但配置还不能算完全收口，有几个值得修的缺口。**

当前真实配置是这样的：

| 层 | 当前生命周期 | 用途 |
|---|---:|---|
| Worker WAL | Kafka ACK 后即可清 | Worker 崩溃保护 |
| Valkey | **默认 1 小时** | SSE 热重放 |
| Kafka / Compose | **默认 1 天** | durable stream journal |
| Kafka / Enterprise | **7 天** | durable stream journal |
| PostgreSQL canonical transcript | 长期 | 最终会话历史 |

Valkey 的“1 小时”不是 `event-retention` worker 的配置，而是在 Turn terminal commit 时硬编码的默认值：`liveStreamRetentionMs ?? 60 * 60 * 1000`。PG 会先写入 terminal event、完整 `conversation_turn_projection`，然后创建一个 `available_at = now + 1h` 的 compaction job。 Compactor 默认每 60 秒扫一次、一次最多处理 100 个 job，因此正常情况下一个已完成 Turn 的 delta 会在**约 1 小时 + 调度延迟**后从 Valkey `XTRIM` 掉。

Compose 的 Kafka topic 默认 `retention.ms=86400000`，即 **24 小时**；enterprise 的 Strimzi KafkaTopic 则是 `604800000`，即 **7 天**，并且都是 `cleanup.policy=delete`。  Kafka 官方定义也正是：`delete` policy 会依据 retention 删除旧 segment，`retention.ms` 是时间上限配置。

所以最终生命周期确实是：

```text
LLM delta
   ↓
Kafka
   ↓
Valkey
   ↓
SSE → Browser

        Turn 完成
            ↓
PostgreSQL
完整 canonical transcript
            ↓
      保留 Valkey 1h
            ↓
        XTRIM Valkey

Kafka 继续留：
Compose 约 1 天
Enterprise 约 7 天
            ↓
      Kafka retention
            ↓

最终长期只剩：
PostgreSQL canonical transcript
```

这部分是符合你最开始设想的。

### 不过我找到了 5 个配置问题

**1. Compose 的 Valkey 缺少 `maxmemory`，这是目前最明确的问题。**

现在是：

```text
valkey-server
  --appendonly yes
  --appendfsync always
  --maxmemory-policy noeviction

Docker mem_limit: 512m
```

但**没有 `--maxmemory`**。

Valkey 官方说明，64 位环境默认 `maxmemory=0`，意思是 Valkey 自己没有内存上限；`noeviction` 只有在设置了 `maxmemory` 后才真正形成“达到上限后拒绝写入”的保护。否则你现在首先撞到的很可能是 Docker 的 512 MB cgroup limit，然后进程直接被 OOM kill。

我会改成类似：

```text
--maxmemory 384mb
--maxmemory-policy noeviction
```

给 AOF、client buffer、allocator fragmentation 留出剩余空间。具体 384 MB 不必固定，但**Valkey maxmemory 必须明显低于 container memory limit**。

---

**2. Kafka 有时间上限，但没有空间上限。**

Enterprise topic 当前：

```text
256 partitions
RF = 3
retention.ms = 7 days
segment.bytes = 512 MiB
retention.bytes = 未设置
```



Kafka 的 `retention.bytes` 默认是 `-1`，也就是**没有 size cap，只有时间 cap**。

所以极端情况下如果一天突然产生特别多 Agent delta：

```text
7 天 retention 尚未到
        +
磁盘已经满了
```

Kafka 不会因为你的磁盘快满了就提前按某个 topic size 主动满足一个不存在的 `retention.bytes`。

Enterprise 每个 broker 虽然有 1 TiB PVC，但我仍然建议增加：

```text
retention.ms
        +
retention.bytes
```

双保险。

具体 `retention.bytes` 不能拍脑袋，因为它**是 per-partition limit**，要根据你预期的 Agent 并发、delta 吞吐和磁盘 headroom 算。Kafka 官方也明确说明该限制按 partition 生效。

---

**3. Compose 的 Kafka bootstrap 不会可靠地“更新已有 topic 配置”。**

现在是：

```bash
kafka-topics.sh \
  --create --if-not-exists \
  ...
  --config retention.ms=${...}
```



第一次创建没问题。

但是假设你今天运行：

```text
retention = 1 day
```

下个月改成：

```text
retention = 3 days
```

topic 已经存在，`--create --if-not-exists` 不是一个配置 reconciliation 机制。Kafka 官方推荐修改已有 topic override 使用 `kafka-configs.sh --alter --add-config ...`。

所以 bootstrap 最好变成：

```text
create if absent
      ↓
kafka-configs --alter
      ↓
kafka-configs --describe
      ↓
assert actual config == desired config
```

Enterprise Strimzi 没这个问题那么严重，因为 `KafkaTopic` CR 本身就是声明式配置，Operator 会负责 reconcile。

---

**4. “Valkey 1 小时”目前是代码默认值，不是部署配置。**

Helm 里现在只有：

```yaml
eventRetention:
  intervalMs: 60000
  batchSize: 100
```

没有：

```yaml
liveStreamRetentionMs
```



所以现在实际关系是：

```text
Valkey        1h   ← 代码硬编码默认值
Compose Kafka 24h
Enterprise    168h
```

比例本身很好：

```text
Compose:    Kafka / Valkey = 24x
Enterprise: Kafka / Valkey = 168x
```

但我更希望它成为一个**显式架构 invariant**：

```text
AGENT_DOCK_LIVE_STREAM_RETENTION_MS = 3600000
Kafka retention                   = 604800000

startup:
assert(kafkaRetention > liveRetention + safetyMargin)
```

而不是靠两个不同地方的 magic number 恰好满足。

---

**5. 你的 CI 没检查最关键的 retention 配置。**

`scripts/check-enterprise-kafka.mjs` 现在会 assert：

```text
256 partitions
replicas = 3
min.insync.replicas = 2
unclean leader election = false
TLS / SCRAM
```

这些都很好。

但是它**没有 assert**：

```text
cleanup.policy == delete
retention.ms == 604800000
segment.bytes == 536870912
```



这意味着以后有人不小心删掉：

```yaml
retention.ms: "604800000"
```

CI 仍然可能绿。

这几个值恰恰决定了“几十亿 delta 会不会永远留在 Kafka”，所以应该加入配置 gate。

### 有一个地方我暂时不会改

现在 Valkey 是：

```text
appendonly yes
appendfsync always
```

第一眼看会觉得太重，因为 Kafka 已经是 durable source。

但你当前 projector 的顺序是：

```text
Kafka
 ↓
Valkey append 成功
 ↓
PG last_projected_seq 推进
```

PG 一旦说：

```text
last_projected_seq = 500
```

SSE 就认为 Valkey 至少有到 `500`。

如果 Valkey 只是 `appendfsync everysec`：

```text
Valkey ACK
PG cursor = 500
↓
Valkey 还没 fsync
↓
机器断电
↓
Valkey 恢复只有 seq 490
PG 却说已经有 500
```

这时 SSE 就出现 gap，只能靠 Kafka rebuild 修复。

所以在你**目前 rebuild 还是人工操作**的情况下，`appendfsync always` 虽然贵，但并不荒唐。等以后实现：

```text
发现 Valkey seq < PG high-water
        ↓
自动从 Kafka repair
```

再考虑把它降成 `everysec` 会更合理。

### 因此我给现在配置的判断

**核心生命周期设计是对的：**

```text
Valkey 1h
<
Kafka 1d / 7d
<
PG canonical 永久
```

而且 enterprise Kafka 的 durability 参数也比较标准：RF3 + `min.insync.replicas=2`，你的 producer 又是 idempotent + `acks=-1/all`，这正是 Kafka 官方给出的典型高 durability 组合。 

我认为现在最值得改的优先级是：

1. **给 Valkey 加真正的 `maxmemory`。**
2. **给 Kafka 加磁盘容量保护，并让 Compose bootstrap reconcile topic config。**
3. **把 1h Valkey retention 变成显式配置，并在启动/CI 检查 `Kafka retention > Valkey retention`。**
4. **补 CI 对 `cleanup.policy / retention.ms` 的 assert。**

做完这几项以后，“delta 短期 durable、最终完全淘汰；PG 只永久保存 canonical message”这条链路就比较完整了。

## 011 · User · 2026-08-11T02:18:31.229Z

配置以后再调优吧，你review一下我现在的架构，看看如果我这套cloud coding agent代码要用于中型企业部署时，大概1000+active agent loop这个量级，哪些部件可能会遇到瓶颈，就像我刚跟你讨论的，你需要考虑存储，高并发，流式，崩溃恢复，隔离等多方面问题

## 012 · Assistant · 2026-08-11T02:47:24.634Z

# 结论

你这套架构的**方向已经具备中型企业级 Cloud Coding Agent 的基本形态**：状态权威划分清楚，Pi Agent Loop 与不可信 Tool 执行分离，Run 有 Temporal、Lease、Fence、WAL、Checkpoint 和 Workspace CAS，流式链路也已经从“PostgreSQL 永久存 delta”演进成了“Kafka durable、Valkey hot replay、PostgreSQL canonical state”。

但以当前 `main` 的实现，我不会直接宣称它已经可以承载 **1000 个同时运行的 Agent Loop**。

需要先区分三个量级：

| 场景 | 当前判断 |
|---|---|
| 1000 个已创建、可随时继续的 Conversation，实际同时运行 100～200 个 | 架构基本可行，接近当前默认容量设计 |
| 1000 个同时进行模型流式输出的 Agent Loop | 多 Cell 架构理论可容纳，但有几个全局瓶颈必须先改 |
| 1000 个同时使用 Bash/Edit/Write、各自占用 Cube microVM 的 Agent Loop | 当前默认部署不行；Stage 1 多 Cell 理论上够，但计算、Workspace 存储和 Cube 控制面尚未做容量证明 |

你当前默认单 Cell Helm 配置最多是：

```text
32 个 Pi Worker Pod × 每 Pod 4 个 Run slot
= 128 个同时执行的 Agent Loop
```

Sandbox Manager 是 3 个副本、每副本最多 128 个 active sandbox，理论上约 384 个同时存在的 Cube。默认租户并发 Turn 配额还是 32。

你已经准备的 Stage 1 企业配置则是：

```text
8 Cells
× 64 Worker Pods / Cell
× 4 slots / Worker
= 2048 个理论 Run slots

8 Cells
× 3 Sandbox Managers / Cell
× 128 active Cubes / Manager
= 3072 个理论 Cube slots
```

所以你的**容量拓扑设计并不是只到 128**；1000 并发对应的正确部署基线应当是 Stage 1 多 Cell，而不是把单个 Worker 的并发从 4 调到 16。

不过这些只是静态上限。真正先撞墙的，很可能不是 Worker 数量，而是下面几个共享路径。

---

# 第一优先级瓶颈：Model Gateway 的 PostgreSQL 配额事务

这是我审下来最严重的全局瓶颈。

当前每次模型请求开始前，Worker 内置的 `TenantModelGateway` 会：

1. 开启 PostgreSQL 事务；
2. 对该租户的 `tenant_runtime_policies` 行执行 `FOR UPDATE`；
3. 聚合查询该租户历史上的 `model_requests`；
4. 计算当前 Run 请求数、Run 花费、当日 Token、当月花费；
5. 插入一条 reservation；
6. 才允许请求上游模型。

也就是说，同一个租户的所有模型请求都会争抢同一条 policy 行。

更严重的是，当前聚合查询大致是：

```sql
FROM model_requests
WHERE tenant_id = ?
```

日、月、Run 的统计主要通过聚合表达式内部的 `CASE WHEN` 计算，而不是通过独立计数器或可有效裁剪的时间分区完成。随着 `model_requests` 越来越大，每次模型请求开始前的成本会持续增长。

如果 1000 个 Agent Loop 属于同一个企业租户：

```text
1000 个模型请求
        ↓
争抢同一 tenant_runtime_policies 行锁
        ↓
逐个执行租户历史 model_requests 聚合
```

这条链路很可能在几十到几百并发时就出现明显排队，而不是等到 1000。

## 应有的改法

模型配额不能继续依赖“扫描历史明细实时算余额”，而应维护可幂等更新的聚合状态：

```text
run_usage_counters
  key = run_id

tenant_daily_usage
  key = tenant_id + yyyy-mm-dd

tenant_monthly_cost
  key = tenant_id + yyyy-mm

model_request
  仍然保存请求审计明细
  但不再参与每次请求的全量预算计算
```

一次 reservation 只需要：

```text
原子增加 Run counter
原子增加 tenant-day counter
原子增加 tenant-month counter
插入 model_request reservation
```

实际 Token 返回后，再以 `model_request_id` 幂等地从 reserved 修正为 actual。

即便这样，1000 个同租户请求仍可能竞争同一个日/月 counter。进一步可以采用：

- 分片计数器；
- 租户级请求队列；
- 一个专门的配额服务；
- 数据库 advisory lock 加短事务；
- 预分配额度块，例如 Worker 一次领取一批 Token/Cost credit。

除此之外，我没有看到当前实现里存在**跨 Worker、跨 Cell 的 provider 并发限制器**。每个 Worker 都有自己的 Model Gateway，上游出现 429 后可以 fallback，但没有一个全局 token bucket 阻止 1000 个 Agent 同时冲击同一套 API Key。

对 1000 并发来说，模型提供方的 RPM、TPM、并发流数量和连接限制很可能比你的 Agent 系统先到顶。建议最终把 Model Gateway 从 Worker 内部进程进一步独立出来，形成可横向扩展的模型出口层：

```text
Pi Workers
    ↓ 短期 Run capability
Model Gateway Cluster
    ├─ provider concurrency limiter
    ├─ tenant quota reservation
    ├─ retry/fallback
    ├─ credential injection
    └─ usage settlement
```

这样还能避免每个 Worker Pod 都持有模型凭据主密钥，缩小可信面。

---

# 第二优先级瓶颈：Kafka 和 Valkey 网络 I/O 位于 PostgreSQL 事务内

现在 enterprise 流式事件的 ingest 顺序是：

```text
BEGIN
  锁 Session
  锁 event cursor
  锁 lease
  校验 seq / fence
  等待 Kafka acks=all
  更新 cursor
COMMIT
```

也就是说，在等待 Kafka Broker 网络响应期间，数据库连接和对应 Session/Cursor 行锁仍然被占用。代码注释明确说明这是为了防止 projector 超过 PostgreSQL 已授权的 cursor。

Kafka projector 侧又是：

```text
BEGIN
  锁 projection offset
  锁 session event cursor
  等待 Valkey Lua/XADD
  更新 last_projected_seq
  更新 Kafka offset
  pg_notify
COMMIT
```

同样把 Valkey 网络 I/O 放进了 PostgreSQL 事务。

这个方案的 correctness 很直观，但高并发下会产生尾延迟放大：

```text
Kafka p99 偶尔 500 ms
        ↓
一批 PG transaction 持锁 500 ms
        ↓
PG connection pool 被占满
        ↓
新的事件 ingest、terminal commit、lease 等待
        ↓
更多 Run 无法完成
        ↓
Worker slot 无法释放
```

同理，Valkey 抖动会通过 projector 反向传导给 PostgreSQL。

## 这里存在一个架构上的三难问题

你同时希望：

1. Kafka 是第一份共享 durable copy；
2. 只有 Kafka 成功后才能 ACK Worker；
3. 不能在 PostgreSQL 事务里等待 Kafka。

这三件事要同时做到，需要一个短生命周期的 handoff/sequencer，而不是简单调整事务顺序。

比较合适的做法是恢复一个**批级别、短期保留的 transfer journal**：

```text
短 PG transaction：
  校验 Session / fence / seq
  预留 [seqStart, seqEnd]
  写一条 event_batch_transfer
COMMIT

异步：
  append Kafka

Kafka ACK 后：
  短 PG transaction
  标记 transfer published
  推进 durable cursor
  ACK Worker
```

这里是“一批一行”，而不是“一个 delta 一行”，并且发布完成后可以快速删除或按小时保留，因此不会回到几十亿条永久 delta 的问题。

另一种方式是把 Session sequence authorization 下沉到一个专门的 Kafka ingest sequencer，但复杂度更高。

Projector 侧则可以利用 Kafka 的 partition ordering 和 Valkey append 幂等性，把网络操作移出长事务：

```text
读取当前 projected cursor
    ↓
Valkey 幂等 append
    ↓
短 PG CAS transaction：
  last_projected_seq: old → new
  consumed offset: old → new
```

进程在 Valkey append 后、PG CAS 前崩溃，重放时只会再次验证相同 digest，而不是产生重复内容。

---

# 第三优先级瓶颈：PostgreSQL `LISTEN/NOTIFY` 的全副本广播

现在所有 Event Gateway 都监听同一个全局 channel：

```text
agent_dock_session_events_v1
```

每次 projector 推进一个 Session 的 `last_projected_seq`，都会执行一次 `pg_notify`。而 PostgreSQL 会把这个通知发送给所有监听该 channel 的 Event Gateway 副本。

这意味着它不是：

```text
一个 Session 更新
→ 唤醒持有该 Session SSE 的 Gateway
```

而是：

```text
一个 Session 更新
→ 唤醒所有 Event Gateway
→ 每个 Gateway 再判断自己有没有订阅者
```

考虑一个上界场景：Pi 当前把文本 delta 按最多 50 ms 聚合一次，因此单个高流速 Agent 最多约产生 20 个文本事件/秒。1000 个同时流式输出的 Agent，理论上可以接近：

```text
20,000 个 projected event wake / 秒
```

如果 Stage 1 的 Event Gateway 扩到 64 副本，则全局广播量可能达到数量级上的：

```text
20,000 × 64
≈ 1,280,000 次副本通知投递 / 秒
```

这不是实际基准结果，因为批处理、模型输出速度和 coalesce 会降低它，但它说明了当前 fan-out 模型的扩展方向不对。Pi 的 50 ms / 2 KiB 聚合规则见当前 Runner。

## 建议拆分 Event Gateway

目前同一个 Event Gateway 进程同时承担：

- Worker HTTP event ingest；
- Kafka producer；
- Kafka projector consumer；
- Valkey projection；
- PostgreSQL notification listener；
- SSE 长连接；
- terminal Turn projection准备。

这会导致一个不太理想的现象：为了处理 Kafka lag 扩容 Event Gateway，会同时增加 SSE 副本和 PostgreSQL listeners，并触发 Kafka consumer group rebalance；为了 SSE 连接数扩容，又会无意义地增加 Kafka consumers。

建议拆成三个独立 workload：

```text
Event Ingest Gateway
  Worker HTTP → Kafka
  按 ingest QPS 扩容

Event Projector
  Kafka → Valkey → PG cursor
  按 Kafka lag 扩容

SSE Gateway
  Valkey/PG → Browser
  按连接数、网络吞吐扩容
```

Projector 完成后，不再通过全局 PG channel 广播给所有 SSE 副本，而使用以下一种方式：

- Session 一致性哈希，让同一 Session 的 SSE 固定落在一个 shard；
- Valkey Sharded Pub/Sub；
- 专门的轻量通知 topic；
- 按 Session shard 划分多个 notification channel；
- 每个 SSE 副本只订阅它实际持有的 Session 路由。

PostgreSQL 仍然保留 cursor，通知只作为 wake hint，不作为 correctness authority。

---

# 第四优先级瓶颈：terminal barrier 每 25 ms 查询 PostgreSQL

Run 完成或失败之前，Worker 必须确保 Kafka 中的全部流式事件已经投影到 Valkey，避免完整 terminal message 越过还没显示的 delta。

当前 `PostgresEventProjectionBarrier` 每 25 ms 查询一次：

```text
last_persisted_seq == last_projected_seq ?
```

最长等待 60 秒。

单个 Run 在 projector lag 时最多产生约 40 次查询/秒。假如 1000 个 Run 同时结束，并且 Kafka projector 出现一两秒积压：

```text
1000 × 40
= 40,000 次 cursor 查询 / 秒
```

而 projector 越慢，轮询越多；轮询越多，PG 越忙；PG 越忙，projector commit 又越慢，形成正反馈。

应改为：

```text
Worker 注册 wait(sessionId, expectedSeq)
        ↓
Projector 推进 watermark
        ↓
通知对应 waiter
```

数据库轮询只作为低频故障恢复兜底，例如 500 ms～1 秒一次，而不是正常路径每 25 ms 查询。

---

# 第五优先级瓶颈：Worker 本地 WAL 的每事件 `fsync`

你现在的 durable-before-visible 约束在 Worker 上实现得很严格：

```text
event
  ↓
append WAL
  ↓
fsync
  ↓
允许送往 Event Gateway
```

ACK 本身也会写 WAL 并同步；WAL 达到条件后还会原子 compact。

现有基准中，一个 WAL 对 500 个事件的 durable append 吞吐约 153 次/秒。这个基准是在单 assignment、无模型调用的环境测得，并不能直接等同于生产吞吐，但可以作为风险信号。

每个 Worker 当前只有 4 个 slot。按照 50 ms delta coalesce 的极端上界：

```text
4 Agent × 20 events/s
≈ 80 次 WAL append+fsync / 秒
```

再加 Tool lifecycle、thinking、sampling、notification 等事件，已经没有特别夸张的余量。

因此我赞成你当前的 `capacity=4`。不建议为了减少 Pod 数量直接把它拉到 16：

```text
16 × 20
≈ 320 次 fsync / 秒
```

还没有计入其他事件。

更好的扩展方式是：

- 保持每 Pod 4 个左右的 Pi slots；
- 横向扩 Worker；
- WAL writer 支持 5～10 ms 的 group fsync；
- 同一次 fsync 可以确认多个独立 Session 的 append；
- 第一段文本仍然优先 flush；
- 对底层 PVC 的 p99 fsync 延迟设置准入门槛。

1000 个 Run 按 4 slots/Pod 需要约 250 个 Worker Pod。每个 Worker 当前数据库连接池最大值大约是 `capacity × 4`，因此理论 client pool 总数可能达到约 4000。PgBouncer transaction pooling 在这个规模下不是可选优化，而是必需基础设施。

另一个问题是：一个 Worker Node.js 进程内同时运行多个 Pi AgentSession。用户 Bash 已经被隔离在 Cube 中，这一点很好；但 Pi SDK、Harness、模型响应解析和 Tool adapter 仍共享同一个可信进程。一个内存泄漏、未捕获异常或 OOM 可能同时影响该 Pod 的 4 个 Run。当前代码有 `PiSdkIsolationFailure` 和 Worker poison 语义，但这不是进程级隔离。

面向高安全企业，可以考虑：

```text
一个 Worker Pod
  ├─ supervisor/control process
  ├─ Pi child process slot 1
  ├─ Pi child process slot 2
  ├─ Pi child process slot 3
  └─ Pi child process slot 4
```

这样用户代码仍只在 KVM，而可信 Agent Harness 的故障域也能缩小到单 Run。

---

# 第六优先级瓶颈：Temporal 在容量不足时会产生 deferred churn

当前每个 Worker Pod启动两个 Temporal Worker：

- Cell shared queue；
- Worker-specific affinity queue。

两个 Worker 都配置了并发 Activity 上限，但进程内部再通过一个共享的 `#activeExecutions` 限制真实并发。shared queue 在 Worker 已满时会返回：

```text
status = deferred
retryAfterMs = 250
```

Workflow 收到后 sleep 250 ms，再次调度 Activity，最多循环 200 次后 `continueAsNew`。 

在正常容量下这没有问题。但当系统有 1000 个 Run、只有 128 个实际 slot 时，大量任务会：

```text
被 Worker 拉取
→ 发现 busy
→ Activity 完成 deferred
→ Workflow sleep 250ms
→ 再次调度
```

这会把原本简单的“任务留在 Temporal queue 等待”变成大量 Activity execution、Workflow history 和定时器操作。

应当让 Temporal poller 尽量不要领取超过真实进程容量的 Activity。affinity 与 shared queue 的总容量要统一，而不是两个 poller 各自认为自己拥有完整容量。

数据库准入导致的 deferred 仍然可能存在，但应该使用：

- 指数退避；
- jitter；
- 事件唤醒；
- 明确的 Workspace/Session queue；
- 更长的 retry interval。

而不是所有容量不足都固定 250 ms 重试。

1000 个 active Activity 每 5 秒一次 Temporal heartbeat，大约是 200 heartbeat/s，本身未必是首要瓶颈；真正的问题是容量不足时的短周期 deferred churn。

---

# 第七优先级瓶颈：Cube 计算资源与 persistent sandbox 占用

每个 Cube 当前策略上限大致是：

```text
1 vCPU
768 MiB memory
128 PIDs
1 GiB temporary root
1 GiB workspace
```

并使用 KVM microVM、无平台凭据、禁止 host mount、禁止 Docker socket、所有 capabilities 被移除。隔离边界本身做得比较扎实。

但如果真有 1000 个同时运行 Tool 的 Agent，单是策略额度就意味着：

```text
约 1000 vCPU
约 750 GiB guest memory
```

还没有计算 hypervisor、Cubelet、页缓存、Kubernetes、Workspace Volume 和宿主机开销。

因此“1000 active Agent Loop”中 Tool 使用比例非常关键：

```text
1000 个纯聊天 Agent
Cube = 0

1000 个 Agent，其中 20% 正在执行 Tool
Cube ≈ 200

1000 个 Agent 全部在跑构建或测试
Cube ≈ 1000
```

你的 lazy activation 是正确设计：纯聊天不会触碰 Cube。

更值得警惕的是 persistent sandbox。当前 ephemeral warm sandbox 有 TTL 和 LRU；persistent sandbox 则没有 expiresAt，并且不参与普通 ephemeral warm limit。它仍然占用 `maximumActiveSandboxes`，而 Manager 满载时只会尝试淘汰 ephemeral warm sandbox。 

如果大量用户选择 persistent：

```text
persistent Cubes 填满 Cell
        ↓
没有 ephemeral 可回收
        ↓
新的 Tool activation 进入 admission waiter
        ↓
可能长期无法取得容量
```

这里需要独立控制：

- 每租户 persistent Cube 配额；
- 每 Cell persistent Cube 上限；
- persistent idle suspend；
- 会话归档后的强制回收；
- 最大 persistent 生命周期；
- 管理员可见的 pinned capacity；
- 与 active Tool 容量分离的资源池。

---

# 第八优先级瓶颈：Workspace Data Mover、Kopia 和共享存储

每次冷启动 Tool Sandbox 可能需要：

```text
从 Kopia/S3 restore Workspace
```

每次 Workspace 被修改并成功结算时又需要：

```text
冻结进程
生成 Git patch
Kopia snapshot create
上传对象存储
PostgreSQL CAS 推进 Workspace head
```

当前 `KopiaWorkspaceDataMover` 对同一个 volume 做了串行锁，这能保证同一 Workspace 的 correctness；但我没有看到跨 volume 的全局并发 semaphore。每个 restore/snapshot 都会启动 Kopia 子进程。 

因此在 1000 个 Run 同时结束时，可能出现：

```text
大量 Kopia processes
大量目录扫描 / git diff
大量对象存储 PUT
大量 Workspace snapshot
```

而 Stage 1 每个 Cell 默认只有 3 个 Data Mover/Sandbox Manager 副本，每个 Data Mover 资源上限约 2 CPU、1 GiB。

这条链路很可能比 Pi JSONL checkpoint 更先成为存储瓶颈。

需要增加：

- 每 Data Mover 的 restore concurrency；
- snapshot concurrency；
- 每 Cell 总体 snapshot token bucket；
- Workspace 大小和文件数上限；
- 大型 monorepo 单独队列；
- S3 PUT/GET 和 metadata IOPS 指标；
- snapshot completion backlog；
- Cell 级本地缓存；
- 对 burst settlement 的背压。

还要注意，你的普通 Conversation 共享同一个 Workspace head，并且同一 Workspace 的普通 Run 会被序列化。

所以：

> 1000 个 Agent 分布在 1000 个 Workspace，可以并发；1000 个 Agent 同时修改同一个 Workspace，不可能通过增加 Worker 数量获得 1000 路并发。

想在同一个大型仓库内并行，需要明确使用：

- Candidate branch；
- Fork Session；
- 独立 Workspace branch head；
- Git worktree 或等价的物理隔离分支；

然后再通过 promotion/merge 合并结果。

---

# 第九优先级瓶颈：事件 Projector 存在重复扫描当前 Turn 的风险

Kafka projector 每投影一批新事件后，会调用 Valkey 的 `readTurn()`，从较早位置扫描到当前 projected sequence，找出当前 Turn 的全部事件，再执行某些结构化事件处理。

如果一个长 Agent Turn 产生很多批次，可能形成近似：

```text
第 1 批扫描 1
第 2 批扫描 1..2
第 3 批扫描 1..3
...
```

也就是随 Turn 长度增长的重复读取。

文本 delta 本身不会全部进入结构化测试逻辑，但 `readTurn()` 仍然要把事件从 Valkey 取出并解析，再按 `turnId` 过滤。

应改成增量状态：

```text
projector 只处理这一批 newMessages
必要状态单独维护：
  current test command state
  context compaction state
  sampling boundary state
```

terminal transcript 的完整归并可以在最终 settlement 时执行一次；普通 Kafka batch 不应不断重扫整个 Turn。

---

# 存储方面：delta 问题解决了，但新的增长点要关注

我确认了 enterprise 路径不会把每个 streaming delta 插入 `session_events`。只有非 external event-log 的本地模式才写 raw event rows。

因此长期布局确实是：

```text
Kafka
  短期保存流式事件

Valkey
  更短期保存 SSE hot replay

PostgreSQL
  一 Turn 一份 canonical transcript
  一条 terminal event
  cursor / watermark
```

你最开始担心的“几十亿条带 JSONB 的 delta 行”已经被解决。

但 PostgreSQL 中另外几个表会成为长期增长重点：

```text
model_requests
usage_ledger
runs
run_attempts
run_attempt_transitions
commands / outbox
conversation_turn_projections
review_bundles metadata
checkpoint manifests
```

其中 `model_requests` 是一模型请求一行，而且当前又被实时预算聚合扫描，它同时是**容量问题和查询问题**。表结构目前只有 active reservation 和按 Run 的索引，没有看到按时间分区或长期归档。

中型企业部署至少应规划：

- `model_requests` 按月或按时间分区；
- `usage_ledger` 分区；
- 预算使用独立 rollup；
- 明细保留期限；
- 审计归档；
- 删除租户时 Kafka、Valkey、S3、Kopia、PG 的完整删除语义。

Pi JSONL 本身设计得比较好。现有基准中，120 Turn 的长 Session 最终约 560 KiB，content-addressed segment 方案把累计写入从约 33.9 MiB 降到 1.44 MiB，下降约 95.75%。

但大规模故障恢复会产生突发对象读取。例如 1000 个长 Session 在 Worker 节点批量丢失后，每个恢复需要几十个 segment GET，可能瞬间形成数万对象请求。应做：

- 每 Cell checkpoint cache；
- 相同对象并发请求合并；
- 恢复并发限制；
- recovery 优先级；
- manifest/segment orphan GC；
- S3 生命周期与对象数监控。

---

# SSE 本身不是第一瓶颈

单纯 1000 条 SSE 长连接，对当前 Node/Fastify 形态不应该是最先撞墙的部分。

当前实现具备：

- `Last-Event-ID`；
- 先订阅再 replay，避免 missed-event race；
- HTTP backpressure；
- 15 秒 heartbeat；
- cursor gap 检查；
- Valkey live event 与 PG terminal event 合并。

1000 个完全空闲的 SSE，每 15 秒检查一次 suffix，大约产生 67 次 replay-window 查询/秒，这个量级本身不算严重。

真正的问题是：

- 所有副本都收到所有 Session 的通知；
- Event Gateway 同时承担 Kafka projector；
- 每个 event wake 都需要读取 PG watermark；
- projector lag 会阻止 terminal settlement；
- HPA 扩缩容会同时断开 SSE、重平衡 Kafka consumer。

所以应该优化 SSE 的**路由和唤醒面**，而不是先替换 SSE 协议。

---

# 崩溃恢复：单点语义很强，批量恢复能力尚未验证

你目前已经具备不少正确的恢复不变量：

- Worker event 在 WAL `fsync` 后才允许发送；
- Kafka ACK 是共享 durable boundary；
- ACK 丢失可以安全重放；
- stale Worker 由 fencing token 阻止；
- Workspace 由 base revision CAS 阻止陈旧覆盖；
- checkpoint 未提交时 Run 不能 completed；
- catchable interruption 保存 Pi-native interrupted branch；
- SIGKILL/OOM 时使用已持久化公共语义生成隐藏 recovery entry；
- Tool operation 对未知结果不会盲目重放。

当前故障测试报告中的 15 个确定性故障案例全部通过，包括 Worker SIGKILL、Control Plane SIGKILL、ACK 丢失、checkpoint corruption、取消/完成竞争和 orphan runtime 清理。

但报告明确不是 live chaos，也不是 1000 active Run 容量测试。现有 Control Plane load report也明确标注 `activeAgentRunBenchmark: false`，只测了冷 Session admission 和 conversation read。

1000 并发时最危险的是**相关性故障**：

```text
一个 Worker 节点丢失
→ 数十个 Run 同时恢复

一个 Cell 丢失
→ 数百个 Pi Session 冷 restore
→ 数百个 Workspace restore

Valkey failover
→ projector 停顿
→ terminal barriers 堆积
→ Worker slots 不释放

对象存储延迟
→ checkpoint commit 堆积
→ Run 无法完成

PostgreSQL failover
→ 所有 Cell 的 lease/event/quota 同时暂停
```

你的多 Cell 设计隔离了 Cube 和执行面，但 PostgreSQL、Temporal、Kafka、Valkey、对象存储和模型出口仍然是全局共享平面。

需要一个明确的 recovery admission 策略：

```text
故障恢复期间：
  暂停或降低新 Run admission
  旧 Run recovery 获得优先级
  每 Cell 限制同时 restore 数
  每 Workspace 仍保持单一恢复者
  避免 1000 个恢复任务同时冲击 S3 / Kopia / PG
```

Valkey 当前可以从 Kafka rebuild，但主要还是运维命令式恢复，不是自动 self-healing。对中型企业部署，RPO 可以接近 0，但 RTO 还需要加强。

---

# 隔离方面的评价

## 做得好的部分

你现在把真正危险的用户代码执行放进 CubeSandbox KVM：

- User Bash 不在 Pi Worker 运行；
- Cube 没有模型凭据、数据库凭据或 Cube API key；
- 禁止 Docker socket；
- 禁止 host mount；
- 网络只允许通过受控 Web Proxy；
- 私网、metadata、平台地址被拒绝；
- 每个 Cube 有独立 CPU、内存、PID 和磁盘限额；
- Workspace commit 仍由可信 Data Mover 和 PG CAS 控制。

这比仅用 Kubernetes Pod 或 worktree 做隔离扎实得多。

## 仍然需要注意的可信面

为了运行 1000 个 Agent，你可能会有约 250 个 Pi Worker Pod。每个 Worker 当前需要接触：

- PostgreSQL；
- checkpoint object store；
-模型凭据主密钥或解析能力；
- Sandbox Manager token；
- Event Gateway ingest token；
- Temporal；
- Workspace/Checkpoint 元数据。

Pod 数越多，长期凭据的暴露面越大。

建议逐步改为：

```text
Kubernetes Workload Identity
mTLS / SPIFFE identity
短期服务 capability
每 Cell 独立 Sandbox Manager credential
每服务独立 PG role
每 Cell / tenant 限定的 S3 prefix policy
```

另外，示例企业配置中的部分内部 HTTP 仍允许明文。即使 NetworkPolicy 存在，中型企业生产环境也应把 Cell 间和全局平面通信切到 mTLS，而不是只依赖“集群内网可信”。

---

# 我认为当前最值得保留的设计

这次 review 并不是说整体需要推倒。相反，以下边界是正确的：

```text
Temporal
= Run 的 durable orchestration

PostgreSQL
= business state / lease / fence / canonical result

Kafka
= high-frequency stream durability

Valkey
= bounded SSE read model

Pi checkpoint
= model conversation authority

Kopia Workspace checkpoint
= /workspace authority

Cube
= untrusted process world
```

这套 state ownership 很适合 Cloud Coding Agent。

需要调整的是几条高频共享路径，而不是改变总体边界。

---

# 在宣称“支持 1000 active Agent Loop”之前的优先顺序

## P0：必须先改

1. **用 Stage 1 多 Cell 作为容量基线**，不要在单 Cell 上堆到 1000。
2. **重构 Model Gateway 预算预留**，移除单租户 policy 行长时间串行和全量历史聚合。
3. **增加全局 provider/model/tenant 并发限制器**，避免 1000 请求直接冲击模型 API。
4. **拆分 Event Ingest、Kafka Projector、SSE Gateway**。
5. **替换全局 PG `NOTIFY` 广播**，做按 Session shard 路由。
6. **把 terminal barrier 从 25 ms 轮询改成事件驱动**。
7. **移除 Kafka/Valkey 网络等待期间的长 PG transaction**。
8. **为 Data Mover/Kopia 增加明确的 Cell 级并发队列**。
9. **给 persistent Cube 单独配额和回收机制**。

## P1：容量稳定性

1. Worker WAL group fsync。
2. 保持每 Worker 低密度，避免直接调到 16 slots。
3. `model_requests`、`usage_ledger` 等高增长表分区和归档。
4. 自动 Valkey repair。
5. Pi checkpoint 和 Workspace snapshot 的恢复限流。
6. 每 Cell 存储 IOPS 与对象存储请求预算。
7. Pi AgentSession 进程级故障隔离。
8. PgBouncer client/backend connection budget。

## P2：运维与合规

1. 多 Cell 热点迁移和 capacity rebalance。
2. Kafka/Valkey/S3/PG 的租户删除闭环。
3. mTLS 和 workload identity。
4. 日志与 trace sampling，避免高基数 observability 反过来成为瓶颈。
5. 多 Region 或至少同 Region 多 AZ 的故障演练。

---

# 建议的 1000 并发验收模型

不要一次只跑“1000 个固定文本 Agent”。更有代表性的 workload mix 是：

```text
60% 纯模型聊天
30% 轻 Tool：read/edit/git/status/短 bash
10% 重 Tool：编译、测试、依赖安装、Workspace snapshot
```

测试分四档：

```text
100 → 250 → 500 → 1000 active Runs
```

每一档至少维持 30～60 分钟，并同时建立 1000 个真实 SSE client。

重点观察：

```text
Temporal schedule-to-start / queue wait
Worker slot utilization
Worker RSS / event-loop lag
WAL fsync p95/p99
Kafka produce p95/p99
Kafka consumer lag
Valkey append/XRANGE p95/p99
PG transaction duration
PG row-lock wait
PG pool wait
NOTIFY rate
terminal barrier duration
Cube cold activation p95/p99
active/warm/persistent Cube 数
Kopia restore/snapshot queue
S3 GET/PUT rate
Workspace metadata IOPS
模型 429 / timeout / fallback 比例
```

然后在 1000 active 状态下注入：

```text
杀掉 10% Worker Pods
杀掉一个 Worker node
杀掉一个 Cell 的 Sandbox Manager leader
Kafka broker leader 切换
Valkey failover
PostgreSQL failover
S3 延迟增加
Workspace RWX 短时停顿
Event Projector 停止 30 秒后恢复
```

验收重点不只是吞吐，而是：

- 浏览器已经看到的内容不回退；
- 不重复执行 Tool；
- 不发生 stale Workspace commit；
- 故障恢复有界，不形成重试风暴；
- overload 时进入队列或明确拒绝，而不是全局超时；
- 一个 Cell 的故障不会拖垮其他 Cell；
- 1000 个恢复任务不会同时冲击对象存储。

---

# 最终评价

我会这样定位当前版本：

> **它已经是一套 correctness-oriented、企业级边界比较完整的 Cloud Coding Agent 架构，但还不是一套经过验证的 1000-concurrent runtime。**

当前默认配置更适合作为：

```text
1000+ durable conversations
100～128 simultaneous active loops
其余 Run 在 Temporal/准入队列等待
```

Stage 1 多 Cell 在静态容量上已经能覆盖 1000 simultaneous loops，但在真正把并发上限打开之前，最先需要处理的不是 Kafka retention 或 Valkey 参数，而是：

```text
Model Gateway 租户锁
PostgreSQL 长事务
全局 NOTIFY 广播
terminal barrier 轮询
Workspace/Kopia 并发
persistent Cube 容量占用
```

其中 **Model Gateway 配额事务**和**Event Gateway/PG 通知链路**是最可能最早把整个系统拖慢的两条全局路径。

## 013 · User · 2026-08-11T03:43:19.547Z

你一下子吐一大堆信息出来看得我力竭了，遵照第一性原理，我们从很多个用户发送消息这里作为起点，逐步分析哪里可能是中型企业化部署的瓶颈，小步讨论，别一下讨论太多，然后你要心里记得整体架构

## 014 · Assistant · 2026-08-11T03:43:22.244Z

可以，我们就按链路一段一段走，不提前跳到 Kafka、Cube、Temporal 后面的问题。

先只看**起点：很多用户同时点击“发送”**。

你现在大致是：

```text
Browser
   ↓ POST message
Web / Control Plane
   ↓
PostgreSQL transaction
   ├─ 写 user message
   ├─ 创建 Turn / Run / Command
   ├─ 做同 Session 顺序约束
   ├─ 做租户并发/准入判断
   └─ 写用于启动 Temporal 的 outbox
   ↓ commit
返回用户：消息已接受
```

第一性原理上，这一步要解决的事情其实只有一个：

> **用户的请求有没有被可靠地接受。**

所以这个阶段**不应该做任何慢操作**。不能调模型，不能创建 Cube，不能访问 S3，更不能等待 Agent Worker。

只应该完成一个很短的 PG 事务：

```text
请求
 ↓
鉴权
 ↓
检查 idempotency
 ↓
写业务状态
 ↓
commit
```

然后后面的执行全部异步。

你现在这个大方向是对的。

---

我们先考虑 1000 个用户几乎同时发送消息。

这里我首先不会担心 Node.js/Fastify。

1000 个短 HTTP 请求对它不是什么特别大的数量。真正应该先看的其实是：

> **这 1000 个请求会不会在 PostgreSQL 里互相锁住？**

而且这里要区分两种情况。

### 1000 个不同 Session

例如：

```text
user1 → session A
user2 → session B
user3 → session C
...
user1000 → session 1000
```

理想情况下，这 1000 个事务操作的是不同的 Session 行：

```text
Session A lock
Session B lock
Session C lock
...
```

它们应该高度并行。

这时候主要压力只是：

```text
PG connection 数
+
事务 TPS
+
index / WAL 写入
```

对于一个正常配置的企业 PostgreSQL，这种量级本身并不可怕。

---

### 1000 个请求打到同一个 Session

例如用户连续疯狂点发送，或者 API client 并发调用：

```text
session A:

message1
message2
message3
...
```

这里反而**就应该串行**。

因为你的 Agent conversation 本来就是：

```text
message1
 ↓
agent turn1
 ↓
message2
 ↓
agent turn2
```

不能两个 Turn 同时修改同一份 Pi Session。

所以：

```text
不同 Session → 应该并行
同一 Session → 应该串行
```

这是非常重要的一个扩展原则。

如果你的数据库锁设计符合这个边界，那么 1000 active users 本身不会导致一个“全局大锁”。

---

所以我们现在只得到第一个需要验证的问题：

> **Run admission 的 PostgreSQL transaction，有没有锁到“租户级别”或者某个全局共享行，从而把本来独立的 Session 串行化？**

如果只是：

```text
lock Session
lock Workspace（必要时）
```

那很好。

但如果每个用户发消息都要：

```text
lock tenant_runtime_policy
统计 tenant 当前 active runs
```

那么一个企业租户里的 1000 个用户，就可能全部争抢同一条 tenant row。

**这个才是第一段链路最可能出现的企业级瓶颈。**

我们下一步就只看你当前代码里的 **POST message → PG admission transaction**，看看它到底锁了哪些表、有没有 tenant-level contention。先不往 Temporal 后面走。

## 015 · User · 2026-08-11T03:51:46.640Z

那你确认一下有没有出现你说的这种情况

## 016 · Assistant · 2026-08-11T03:52:53.930Z

确认了，**确实存在，而且比我刚才假设的还明确**。

当前 `acceptTurn()` 进入新 Turn 的事务后，第一件事就是：

```ts
const policy = await this.#lockTenantPolicy(transaction);
```

而 `#lockTenantPolicy()` 对这个租户唯一的 `tenant_runtime_policies` 行执行了：

```sql
... WHERE tenant_id = ?
FOR UPDATE
```



关键在于：**这把锁不是检查完配额马上释放，而是一直持有到整个 acceptTurn 事务 commit。**

后面事务还会继续做：

```text
lock tenant policy
    ↓
lock Session
    ↓
lock Workspace
    ↓
COUNT 该 tenant 所有 unsettled turns
    ↓
解析 model / environment / source set
    ↓
查 Pi checkpoint artifact
    ↓
INSERT turn
    ↓
INSERT command
    ↓
INSERT run
    ↓
INSERT outbox
    ↓
UPDATE session mailbox
    ↓
COMMIT
```

代码就是这个顺序。 

所以假设一家企业就是一个 tenant：

```text
用户 A → Session A ─┐
用户 B → Session B ─┤
用户 C → Session C ─┤
...
用户 1000          ─┤
                    ▼
         tenant_runtime_policies
                  一行
               FOR UPDATE
```

**哪怕这 1000 个 Session 完全互不相关，也会在这里串行。**

这就是一个真实的中型企业扩展瓶颈。

而且还有第二层问题：拿到这把锁以后，每次请求还会执行：

```sql
SELECT count(*)
FROM turns
WHERE tenant_id = ?
  AND state IN (
    queued,
    dispatching,
    running,
    waiting_approval,
    cancelling
  )
```

来判断：

```text
count >= maximumUnsettledTurns
```



也就是说现在实现实际上是：

> **用一把 tenant 行锁，把“读取当前并发量 → 判断额度 → 新增一个 Turn”变成串行临界区。**

从 correctness 来说很好理解——否则两个并发请求可能同时看到 `99 < 100`，然后一起创建，最后变成 101。

但扩展性不好。

所以我们现在只先记住这个问题，不急着往后跳：

```text
第一个发现的瓶颈：

很多用户同时发送消息
        ↓
不同 Session 本来应该并行
        ↓
却因为 tenant_runtime_policies FOR UPDATE
        ↓
被强制串行
```

**这个我认为应该改。**

下一小步我们可以只讨论一件事：

> **如果不锁 tenant 这一行，`maximumUnsettledTurns` 这种租户级并发配额应该怎么安全实现？**

这个问题解决以后，我们再继续沿着“用户消息已经被 PG 接受”往下一站走。

## 017 · User · 2026-08-11T05:14:07.560Z

所以假设一家企业就是一个 tenant：   tenant是这个意思吗？我这个东西本来就是想在中型企业里部署，那么应该一个用户是一个tenant才对吧

## 018 · Assistant · 2026-08-11T05:14:28.257Z

不是。**按你这个“部署到中型企业内部”的产品定位，我反而认为现在代码里的语义更合理：一个企业/组织是一个 tenant，一个员工是一个 user。**

你当前数据库其实也是这样设计的：

```text
Tenant：某家公司
├── User A
├── User B
├── User C
├── Project / Workspace
├── Model Profile
└── Credential / Policy
```

`users` 表本身就是：

```text
users
  id
  tenant_id  → tenants.id
```

说明设计上明确允许**多个 user 属于同一个 tenant**；Project、Workspace、Model Profile 等也都是以 `tenant_id` 做组织级隔离。

比如你把 AgentDock 部署给“XX 公司”，比较自然的是：

```text
tenant = XX公司

user =
  张三
  李四
  王五
  ...
  1000个员工
```

而不是：

```text
tenant张三
tenant李四
tenant王五
...
```

后者比较像面向个人消费者的 SaaS，每个人天然就是一个独立账户空间。

而企业内部通常会有一些**公司级共享东西**：

```text
公司的模型 API Key
公司的模型策略
公司的总额度
公司的 Workspace / Project
公司级管理员
```

这些东西正适合挂在 tenant 上。

所以刚才发现的那个问题**不能靠“一个 user 一个 tenant”来绕掉**。那等于为了消除数据库锁竞争，把业务模型改歪了。

反而应该保持：

```text
tenant = 企业
user = 员工
```

然后解决：

```text
1000 个员工
      ↓
同一个 tenant
      ↓
发送消息时不应该因为 tenant policy 行锁
全部串行
```

也就是说，**刚才发现的瓶颈是真问题，而且在你的目标部署场景里甚至更重要了**：一家中型企业很可能正好就是一个 tenant，里面几百到几千个 user。

## 019 · User · 2026-08-11T06:24:48.685Z

哦我想起来了，当时说的是tenant可以是公司里的部门

## 020 · Assistant · 2026-08-11T06:24:50.959Z

对，这样就对上了。你当时实际上更接近一个 **三级模型**：

```text
企业 / Platform
├── Tenant A = 算法部门
│   ├── User 1
│   ├── User 2
│   └── ...
├── Tenant B = 后端部门
│   ├── User 3
│   └── ...
└── Tenant C = 测试部门
```

你现在代码也比较符合这个语义：`user` 属于 `tenant`，而 Project、Workspace、模型配置、配额等大量资源也挂在 `tenant_id` 下。

这样一来，刚才那个锁问题会**有所缓解，但仍然存在**。

比如一家 1000 人企业拆成 10 个 tenant：

```text
1000 users
÷
10 departments
≈
100 users / tenant
```

那么不是 1000 人争一把 `tenant_runtime_policies` 锁，而是每个部门内部几十到几百人争自己的那一把锁。

所以我的判断会调整成：

> `tenant = 部门/业务单元` 是合理的业务模型；但 `acceptTurn()` 的 tenant 行锁依然值得优化，只是严重程度从“全公司串行”下降到了“部门内串行”。

而且我不建议为了性能再继续把 tenant 缩成 user。**Tenant 应该由隔离/管理边界决定，而不是由数据库锁设计决定。**

我们下一步就继续停留在“很多用户发消息”这里，看看这个 tenant 锁到底有没有必要，以及怎样在不破坏 `maximumUnsettledTurns` 配额正确性的情况下去掉它。

## 021 · User · 2026-08-11T06:26:44.589Z

诶，一个tenant内的user会争一把锁吗，这把锁是保护什么资源的

## 022 · Assistant · 2026-08-11T06:26:46.237Z

会。**只要是同一个 tenant 里的多个 user 同时创建新 Turn，他们现在都会争同一把 PostgreSQL 行锁。**

锁住的并不是 user、Session 或 Workspace，而是这一行：

```text
tenant_runtime_policies
tenant_id = 当前部门
```

代码里是：

```sql
SELECT ...
FROM tenant_runtime_policies
WHERE tenant_id = ?
FOR UPDATE
```



这把锁真正想保护的是**tenant 级配额判断**，尤其是：

```text
maximum_unsettled_turns
```

假设部门规定最多只能同时存在 100 个未完成 Turn。

如果没有锁，两个请求可能同时发生：

```text
请求 A：COUNT = 99
请求 B：COUNT = 99

A：99 < 100，允许
B：99 < 100，也允许

结果：
101 个 unsettled Turn
```

所以现在代码用了最简单、最稳妥的方法：

```text
锁 tenant policy
    ↓
COUNT 当前 tenant 未完成 Turn
    ↓
检查是否 < maximumUnsettledTurns
    ↓
创建新的 Turn / Run
    ↓
COMMIT
    ↓
释放 tenant lock
```

当前 `acceptTurn()` 确实就是这么干的。

所以你可以把这把锁理解成：

> **“这个部门新增 Agent 任务的总闸门。”**

比如：

```text
Tenant = 算法部门

张三 Session A ─┐
李四 Session B ─┤
王五 Session C ─┤
赵六 Session D ─┤
                 ▼
      tenant_runtime_policies
             FOR UPDATE
```

即使四个人操作的是**完全不同的 Session、不同 Workspace**，只要他们属于同一个 tenant，同时发消息时仍然需要排队拿这把锁。

这里的问题不是“用了锁”，而是**锁的粒度太粗，而且持锁时间偏长**。

它本来只是想保证：

```text
maximumUnsettledTurns 不被超卖
```

但实际上拿到锁以后，还继续做 model/environment/source 查询以及 `turn + command + run + outbox + session update`，最后才释放。 

所以我们下一步真正值得讨论的是：**能不能把“部门还剩几个 Agent 并发名额”变成一个很短的原子操作，而不让整个发消息事务都拿着 tenant 锁。**这应该就是我们沿链路遇到的第一个需要优化的点。

## 023 · User · 2026-08-11T06:32:03.291Z

可以，你觉得怎么优化比较合适呢

## 024 · Assistant · 2026-08-11T06:32:05.208Z

我会分两步优化，**先做简单且风险低的，不急着引入复杂分布式 semaphore。**

现在最大的问题其实不是“tenant 有一把锁”本身，而是：

> **太早拿锁，而且拿着锁做了太多事情。**

现在近似是：

```text
BEGIN
↓
拿 tenant policy FOR UPDATE   ← 从这里开始，整个部门串行
↓
锁 Session
↓
锁 Workspace
↓
查 model / environment / source set / artifact
↓
COUNT unsettled turns
↓
写 Turn / Run / Command / Outbox
↓
更新 Session
↓
COMMIT                         ← 到这里才释放
```

我的第一步会改成：

```text
BEGIN
↓
锁自己的 Session
↓
锁自己的 Workspace
↓
查 model / environment / source set / artifact
↓
其他所有准备工作完成
↓
──────────── 临界区开始 ────────────
锁 tenant quota
↓
检查剩余额度
↓
创建 Turn / Run / Command / Outbox
↓
更新 Session
↓
COMMIT
──────────── 临界区结束 ────────────
```

这样不同用户的大部分工作仍然能并行，只有最后“抢一个 Agent 并发名额 + 落业务记录”这几毫秒是串行的。

这一步我认为**应该先做**，因为 correctness 基本不变。

---

然后第二步，我会把现在这个：

```sql
SELECT count(*)
FROM turns
WHERE tenant_id = ?
AND state IN (...)
```

去掉。

改成一张很小的状态表，比如：

```text
tenant_runtime_counters

tenant_id
unsettled_turns
```

接受新 Turn 时直接：

```sql
UPDATE tenant_runtime_counters
SET unsettled_turns = unsettled_turns + 1
WHERE tenant_id = ?
  AND unsettled_turns < ?
RETURNING unsettled_turns;
```

如果返回 0 行：

```text
配额满了
```

Turn 最终进入 completed / failed / cancelled 时：

```sql
unsettled_turns = unsettled_turns - 1
```

这样原来的：

```text
锁 tenant
→ 扫 turns
→ COUNT
→ 判断
```

就变成：

```text
锁一个很小的 counter row
→ +1
```

数据库干的事情非常少。

---

这里有一个很重要的点：**我暂时不会把这个 counter +1 拆成另一个事务。**

也就是说仍然保持：

```text
同一个 PG transaction：

counter +1
Turn insert
Run insert
Command insert
Outbox insert
Session update

一起 commit
```

这样如果后面任何一个 INSERT 失败：

```text
整个事务 rollback
→ counter 的 +1 也自动 rollback
```

不会出现“额度已经扣了，但 Run 没创建出来”的泄漏问题。

代价就是 tenant counter 的行锁仍然会持有到 commit。

但如果我们已经把它移动到了事务**最后几步**，这个锁可能只持有很短时间。我觉得对于：

```text
一个 tenant = 一个部门
几十～几百用户
```

这很可能已经足够了。

所以我现在不会上来就设计什么 Redis distributed semaphore、reservation service，那属于优化过头。

**我建议第一版就做这两个变化：**

```text
1. tenant quota lock 移到事务尽可能靠后的位置
2. COUNT(turns) → tenant unsettled_turn counter
```

然后压测。

如果做到这里，一个 tenant 内 100～200 个用户并发发消息仍然明显卡在这个 counter row，我们才需要继续讨论“怎么彻底消除这个单行热点”。

我觉得这才符合我们现在的小步走法。

## 025 · User · 2026-08-11T06:34:08.540Z

我觉得你可以给出完整的解决方案来消除这个单行热点

## 026 · Assistant · 2026-08-11T06:34:10.736Z

可以，而且如果目标是**真正消除 tenant 单行热点**，我不会再做 `tenant_counter + 1`。因为那只是把热点从 `tenant_runtime_policies` 搬到 `tenant_runtime_counters`，本质没变。

第一性原理上，这个问题是：

> tenant 有 N 个“未完成 Turn 名额”，每个新 Turn 必须原子占一个名额。

既然是 **N 个名额**，那数据库里就直接把它建模成 **N 个独立 slot**，不要用一个共享计数器。

### 我建议：Tenant Turn Slot Pool

例如算法部门最多允许 128 个 unsettled Turn：

```text
tenant_turn_slots

tenant_id       slot_no     turn_id
算法部             1        NULL
算法部             2        NULL
算法部             3        turn-X
...
算法部           128        NULL
```

这里每一行就是一个真实的“Agent 并发名额”。

用户发送消息时，不再：

```text
锁 tenant policy
COUNT turns
+1
```

而是直接原子抢一个空闲 slot：

```sql
WITH candidate AS (
    SELECT tenant_id, slot_no
    FROM tenant_turn_slots
    WHERE tenant_id = $tenantId
      AND enabled = true
      AND turn_id IS NULL
    ORDER BY slot_no
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE tenant_turn_slots AS slot
SET turn_id = $turnId,
    acquired_at = now()
FROM candidate
WHERE slot.tenant_id = candidate.tenant_id
  AND slot.slot_no = candidate.slot_no
RETURNING slot.slot_no;
```

关键就在：

```text
FOR UPDATE SKIP LOCKED
```

假设 100 个员工同时发消息：

```text
张三 → slot 1
李四 → slot 2
王五 → slot 3
赵六 → slot 4
...
```

他们**不会争同一行**。

即使张三已经锁住 slot 1，李四看到它被锁了，也不会等待：

```text
SKIP LOCKED
→ 跳过 slot 1
→ 直接拿 slot 2
```

所以原来的：

```text
100 users
    ↓
一个 tenant row
    ↓
排队
```

变成：

```text
100 users
    ↓
128 个独立 quota rows
    ↓
并行占用
```

这才是真正把单行热点消掉。

---

### correctness 也很好处理

仍然放在你当前 `acceptTurn()` 的**同一个 PostgreSQL transaction** 中。

例如：

```text
BEGIN

lock Session             ← 同 Session 串行，本来就应该
lock Workspace           ← 当前架构要求

准备 model/environment 等信息

INSERT Turn

claim tenant_turn_slot   ← SKIP LOCKED

如果没有 slot：
    ROLLBACK
    → tenant quota exceeded

INSERT Command
INSERT Run
INSERT Outbox
UPDATE Session

COMMIT
```

如果后面任何步骤失败：

```text
ROLLBACK
```

slot 的占用也一起 rollback。

所以没有：

```text
名额扣掉了
但 Run 没创建
```

这种资源泄漏。

---

### Run 结束时释放 slot

例如 Turn 从：

```text
running
→ completed / failed / cancelled
```

在**最终状态提交的同一个事务**里：

```sql
UPDATE tenant_turn_slots
SET turn_id = NULL,
    acquired_at = NULL
WHERE tenant_id = $tenantId
  AND turn_id = $turnId;
```

然后 slot 马上可以被下一个用户拿走。

最好加：

```sql
UNIQUE(turn_id)
```

或者：

```text
UNIQUE(tenant_id, turn_id)
WHERE turn_id IS NOT NULL
```

保证一个 Turn 永远只能占一个 slot。

---

### 崩溃怎么办？

这里反而比 Redis semaphore 简单。

因为 slot 与 Turn 都在 PostgreSQL：

```text
turn = running
slot.turn_id = turn
```

Worker 崩了，**slot 不应该释放**，因为这个 Turn 还没有终态，Temporal 可能正在恢复它。

等恢复后最终：

```text
completed / failed / cancelled
```

再释放。

如果出现程序 bug：

```text
Turn 已 terminal
但 slot 还被占着
```

可以有一个非常简单的 reconciler：

```sql
SELECT slot
FROM tenant_turn_slots slot
JOIN turns t ON t.id = slot.turn_id
WHERE t.state IN ('completed', 'failed', 'cancelled');
```

发现这种记录就释放。

正常事务路径不会产生它，reconciler 只是保险。

---

### 配额从 128 改到 256

非常自然：

```text
原来：
slot 1 ... 128

管理员调成 256：

插入
slot 129 ... 256
```

立即增加容量。

从 128 降到 64 稍微特殊一点。

不能把正在使用的 slot 直接删掉，所以做：

```text
slot 65~128
enabled = false
```

空闲的立即不再分配；

正在使用的：

```text
等对应 Turn 完成
→ 释放
→ 保持 disabled
```

最后系统自然收缩到最多 64 个 active Turn。

这就是类似 drain。

---

### 这样 `tenant_runtime_policies` 还要不要？

要，但它变成**配置数据**，不再是运行时互斥锁。

例如：

```text
tenant_runtime_policies
maximum_unsettled_turns = 128
```

管理员修改它的时候，同步调整 slot pool。

用户发消息时最多普通：

```sql
SELECT ...
```

甚至这一项都不必读取，因为：

> **slot pool 本身就是运行时容量的物理表达。**

抢不到 slot 就说明满了。

所以：

```text
Policy
= desired configuration

Turn slots
= runtime admission state
```

这个职责划分很干净。

---

我比较推荐这个方案，而不是 sharded counter。

Sharded counter 例如：

```text
counter shard 1
counter shard 2
...
counter shard 16
```

虽然也能分散热点，但你最后要保证：

```text
sum(counter) <= 128
```

就会重新引入跨 shard 协调问题。

Slot pool 没这个问题。

128 个 slot 就意味着：

> **物理上永远不可能存在第 129 个合法占位。**

这是我认为最适合你这套架构的解法。

而且它和你已有的 `Lease / Fence / RunAttempt / Temporal` 思路也很一致：**不要用“统计出来的状态”代表资源，而是给资源一个明确的 durable ownership record。**

这样我们第一段链路就可以变成：

```text
很多用户发送消息
        ↓
Control Plane
        ↓
各自 Session / Workspace 锁
        ↓
各自抢一个 tenant Turn Slot
        ↓
Turn + Run + Command + Outbox
        ↓
COMMIT
```

到这里，**tenant 级单行热点基本就消掉了**。

不过再往下一层看时，你会马上发现一个有趣的问题：现在 `acceptTurn()` 还会 `FOR UPDATE` 锁 **Workspace**。如果同一个部门很多 Session 共享同一个 Workspace，这可能成为我们这条链路上的下一个热点。这个我们可以下一步只看它。

## 027 · User · 2026-08-11T07:47:20.770Z

其实我只是服务1000+的active agent loop，貌似争用强度也不是很高，1000+争一把锁属于高并发吗，其实一个中型企业里，1000个程序员同时写prompt发起agent loop，感觉也挺稀有的，一般同一时间能有100个程序员在发起agent loop就感觉很厉害了，大家都在努力工作
一般不会出现很多session共享一个workspace，这属于多虑了，其实后面还可以对workspace加权限，可能组权限，个人权限，但目前这里不属于我考虑的范畴。

## 028 · Assistant · 2026-08-11T07:47:22.205Z

对，我也会把刚才那个 `tenant_runtime_policies FOR UPDATE` 的严重程度往下调。**它在架构上确实是一个串行点，但对于你实际目标的 1000+ active Agent Loop，不一定构成现实瓶颈。**

关键区别是：

> **1000 active loops ≠ 1000 个用户同时执行 `acceptTurn()`。**

Agent Loop 是长任务。比如一个 Loop 平均跑几十秒甚至几分钟，那么即便系统稳定维持 1000 个 active loop，每秒真正“新发起”的 Turn 可能也只有个位数到几十个。

你说的“100 个程序员恰好在很短时间内一起点发送”，已经算一个挺猛的 burst 了。

这时候单行锁是否有问题，主要取决于 `acceptTurn()` 事务到底持锁多久。假设拿到 tenant lock 后的事务耗时大概：

```text
5 ms   → 理论串行吞吐约 200 次/s
10 ms  → 约 100 次/s
20 ms  → 约 50 次/s
50 ms  → 约 20 次/s
```

所以如果实际生产里这段事务只有十几毫秒，100 个请求同时打进来，也就是后面的请求排几十到几百毫秒，未必值得为了它引入一整套 Slot Pool。

而且你的 tenant 还是“部门”级，不是一家公司所有程序员共用一个 tenant，争用会进一步下降。

所以我现在更倾向于：

**先保留当前 tenant 行锁。**

它有一个很大的优点：实现非常简单，而且 `maximumUnsettledTurns` 的正确性几乎一眼就能证明，没有 quota 泄漏、超卖、reconcile 等额外机制。

真正需要做的是加一个指标：

```text
acceptTurn tenant lock wait duration
acceptTurn transaction duration
```

然后压一个比较贴近现实的场景：

```text
同一 tenant
10 / 25 / 50 / 100 个并发 acceptTurn
不同 Session、不同 Workspace
```

如果到 100 并发时：

```text
p95 < 200~300ms
```

我基本不会动它。

如果已经出现：

```text
p95 > 1s
数据库 lock wait 明显
```

那时候再上刚才说的 Slot Pool 就有充分依据。

所以我们可以把目前第一站的结论定成：

> **用户发消息 → PG admission 这里存在 tenant 级串行点，但以 1000 active loops 的真实流量模型看，目前更像“需要测量的潜在热点”，而不是必须立即重构的瓶颈。**

至于 Workspace 锁，我同意你说的，现阶段不用继续钻。正常 Coding Agent 使用模式下一般就是一个人/一个 Session 操作自己的 Workspace，大量 Session 争同一个 Workspace 属于边缘场景；以后权限模型再单独处理。

这样的话，我们可以认为**“用户发送消息并落库”这一站暂时过关**，下一小步就沿链路继续往后看：消息 commit 以后，**怎么启动那 1000 个 Agent Loop**。

## 029 · User · 2026-08-11T07:49:33.544Z

嗯，可以，你继续往下小步看

## 030 · Assistant · 2026-08-11T07:51:09.115Z

这一站我确认下来，**有一个值得改的结构问题**，但不是“1000 active loop 本身把 Temporal 打爆”。

现在是：

```text
PG acceptTurn
  ↓
outbox(published_at = NULL)
  ↓
TemporalRunOrchestrator 每 100ms 扫描
  ↓
最多取前 100 条
  ↓
逐条 workflow.start()
```

问题在于：`workflow.start()` 成功以后，**outbox 并不会马上变成 published**。`published_at` 要等后面的 Worker 真正 claim 并开始执行时才写。 

这会造成一个很典型的 head-of-line 问题。

例如现在 Worker 已经比较忙，又突然来了 500 个新 Run：

```text
PG outbox:

1~100     → 已经创建 Temporal Workflow
            但 Worker 还没开始
            published_at 仍然 NULL

101~500   → 还没创建 Workflow
```

下一轮 relay 查询还是：

```text
ORDER BY created_at
LIMIT 100
WHERE published_at IS NULL
```

所以它**又看到 1~100**。虽然本进程有个内存 `#started` map，会暂时避免重复 `workflow.start()`，但 101~500 仍然进不了这个 `LIMIT 100`。

这其实违背了你现在的一个架构思想：

> **Temporal 应该负责排队和 durable scheduling。**

现在反而变成：

```text
PostgreSQL outbox
先偷偷承担了一层 backlog queue

Temporal
只能看到最前面约 100 个待执行 Run
```

### 我会怎么改

这里我觉得语义应该拆干净。

**Outbox 只负责一件事：**

> “这条已经 commit 的 Run，是否已经可靠地交给 Temporal？”

因此：

```text
acceptTurn commit
↓
outbox pending
↓
workflow.start()
↓
Temporal 返回成功
↓
立即：
outbox.published_at = now()
```

从这一刻起，就算 Worker 一个都没有：

```text
1000 Run
   ↓
1000 Temporal Workflows
   ↓
Temporal 自己排队
```

这才符合你想要的架构。

而 Worker 后面有没有真正执行，则应该由：

```text
command.state
run.state
run_attempt
lease
fence
```

这些状态管理，**不要继续借用 `outbox.published_at` 表示 Worker 执行状态**。

你当前 `RunCommandExecutor` 的 claim 还要求：

```text
outbox.published_at IS NULL
```

并且还用 outbox 的 `available_at / attempts` 做执行侧 retry。

这一部分应该逐步从 outbox 中拿掉，因为你现在已经有 Temporal：

```text
Temporal
= retry / timer / task queue

Outbox
= PG → Temporal 的可靠 handoff
```

职责分开以后会干净很多。

至于现在 `workflow.start()` 是逐条 `await`：

```ts
for (...) {
    await workflow.start(...)
}
```

这个可以顺手改成**有界并发，比如 16/32 路**，但我认为它是次要问题。

所以这一站我的判断是：

> **真正应该改的是 outbox 的状态语义，而不是先提高 batchSize。**

修完以后：

```text
很多用户发消息
↓
PG admission
↓
outbox
↓
快速、可靠地全部交给 Temporal
↓
Temporal 成为真正的 backlog owner
```

到这里我觉得比较合理。

下一小步我们就可以进入 **Temporal 已经拿到了大量 Run，接下来它是怎么把这些 Run 分给 Pi Worker 的**。这里就开始真正接近“1000 active Agent Loop”的核心容量问题了。

## 031 · User · 2026-08-11T08:09:34.193Z

诶，等等，我们回到多租户的问题，你之前说tenant内的用户会抢夺一把锁，那意思是每一个tenant都有活跃agent loop数量配额吗？不同的tenant会有锁争用吗，如果争不到锁，是不是就先等待

## 032 · Assistant · 2026-08-11T08:09:36.473Z

对，不过这里有一个关键点：**当前配额不是“active Agent Loop 数”，而是每个 tenant 的 `unsettled Turn` 数量上限。**

也就是每个 tenant 的 `tenant_runtime_policies` 都有自己的：

```text
maximum_unsettled_turns
```

它统计的状态包括：

```text
queued
dispatching
running
waiting_approval
cancelling
```

所以它更准确地表示：

> 这个部门最多允许多少个“已经提交但还没结束的 Agent Turn”。



因此假设：

```text
Tenant A = 算法部
Tenant B = 后端部
```

数据库里其实是两行：

```text
tenant_runtime_policies

tenant=A   maximum_unsettled_turns=100
tenant=B   maximum_unsettled_turns=200
```

算法部用户发消息时：

```sql
WHERE tenant_id = A
FOR UPDATE
```

后端部用户则锁：

```sql
WHERE tenant_id = B
FOR UPDATE
```

所以**不同 tenant 之间不会因为这把行锁互相争用**。它们锁的是不同 PostgreSQL row。

当然，它们仍然共享 PostgreSQL 的 CPU、连接池、磁盘等，但那是数据库整体资源竞争，不是这把 tenant lock 的锁竞争。

---

而**同一个 tenant**里的两个用户同时发消息，确实是这样的：

```text
张三
  ↓
拿到 Tenant A policy row lock
  ↓
执行 acceptTurn transaction

李四
  ↓
也请求 Tenant A policy row lock
  ↓
等待……
```

PostgreSQL 的 `FOR UPDATE` 默认语义就是等待当前持锁事务结束。

张三：

```text
COMMIT
↓
释放锁
```

然后李四才能拿到锁，**重新读取当前状态，再重新 COUNT unsettled turns，再判断有没有配额**。

所以不是“抢不到就请求失败”，而是：

> **先在数据库里排队等这把锁。**

只有遇到数据库 lock timeout、deadlock 等异常情况才会失败。

这也是为什么它虽然存在串行点，但以你这种实际流量未必严重：**锁竞争发生在“新 Turn 发起瞬间”，而不是整个 Agent Loop 运行期间。**

例如算法部已经有：

```text
80 个 Agent Loop 正在跑
```

这 80 个 Loop **不会一直持有 tenant policy 锁**。

只有又有人点击发送时：

```text
acceptTurn
→ 短暂拿一次锁
→ 创建 Turn
→ COMMIT
→ 立即释放
```

所以“1000+ active Agent Loop”并不意味着有 1000 个请求长期争这把锁。

还有一点我觉得值得记住：目前 `maximum_unsettled_turns` 同时把 **排队中的 Run 和真正运行中的 Run** 算在一起。以后我们分析 Temporal/Worker 容量时，可能需要再讨论：

```text
unsettled quota
≠
actual running concurrency quota
```

但先不展开。

## 033 · User · 2026-08-11T08:21:39.673Z

如果每个tenant都是固定配额，那么总配额就是所有tenant的配额加起来，因为是固定配额，所以以tenant为单位，不存在超卖问题，我理解的对吗？

## 034 · Assistant · 2026-08-11T08:21:42.264Z

对一半。这里要把 **“tenant 配额超卖”** 和 **“整个集群资源超卖”** 分开。

假设：

```text
Tenant A：100
Tenant B：200
Tenant C：100

配置总配额 = 400
```

不同 tenant 之间确实互不抢配额：

```text
A 只能用自己的 100
B 只能用自己的 200
C 只能用自己的 100
```

所以 **A 不可能因为 B 多发几个请求，把 A 的 quota 吃掉**。

但这并不意味着可以取消 tenant 内的同步。比如 A 当前已经 99 个：

```text
张三看到：99 < 100
李四同时看到：99 < 100
```

如果没有锁/原子操作，两个人都可能通过，最后 A 变成 101。

所以那把锁保护的是：

> **同一个 tenant 内，固定配额不能被并发请求突破。**

---

还有另一个更重要的层次：

```text
Tenant quota 总和
≠
集群真实容量
```

例如：

```text
A 200
B 200
C 200
D 200
E 200

总 quota = 1000
```

但你实际上只有：

```text
Pi Worker capacity = 400 active loops
```

这也是完全可以的。

此时：

```text
最多允许 1000 个 unsettled Turn
但真正同时执行只有 400 个
剩下 600 个在 Temporal queue 里排队
```

这叫**资源 overcommit / oversubscription**，但不是 quota correctness 出错。

甚至企业系统通常就应该允许一定程度的 overcommit，因为所有部门同时把 quota 用满的概率不高。

所以我会把这两层理解成：

```text
Tenant quota
= 防止一个部门无限占资源

Cluster capacity
= 系统真实能同时跑多少 Agent Loop
```

你当前的 `maximum_unsettled_turns` 更接近第一层，而且它甚至包含 queued，所以它还不是严格意义上的“active loop quota”。

这也意味着我们后面分析 Temporal → Worker 时，会遇到一个真正更重要的问题：**1000 个 tenant quota 允许进来的 Run，怎么限制实际只有例如 500 个同时占用 Pi Worker。**这才是 1000+ active Agent Loop 这个目标真正对应的全局容量控制。

## 035 · User · 2026-08-11T08:33:11.670Z

嗯，可以，那接着讲

## 036 · Assistant · 2026-08-11T08:33:48.247Z

好，这一站其实很清楚。

Temporal 已经拿到 Run 以后，**真正限制“同时有多少 Agent Loop 在执行”的，是 Pi Worker 的本地并发槽位。**

你当前每个 Pi Worker 有：

```text
AGENT_DOCK_SUPERVISOR_CAPACITY
默认 = 4
范围 = 1 ~ 16
```

也就是说一个 Worker 进程默认最多同时执行 4 个 Run。

代码里还有一个真正的总闸门：

```ts
#activeExecutions

if (#activeExecutions >= #maximumConcurrentRuns) {
    ...
}

#activeExecutions += 1

await commandExecutor.dispatchCommand(...)

#activeExecutions -= 1
```

所以这个 slot 基本覆盖整个 Agent Loop 的执行周期，而不是只占几毫秒。

于是非常直观：

```text
1 个 Pi Worker Pod
capacity = 4
        ↓
最多 4 个 active Agent Loop
```

如果一个 Cell 有：

```text
32 Pi Worker Pods × 4
= 128 active Agent Loops
```

剩下的 Run 就应该留在 Temporal Task Queue 里等 Worker 空闲。

这个设计本身我认为是对的：

```text
1000 个 Run 已进入 Temporal

↓
128 个有 Worker slot
→ 真正执行

872 个
→ Temporal 排队
```

而不是让 1000 个 Node/Pi 实例全创建出来以后再自己抢资源。

---

这也让我们重新定义你说的目标：

如果你说：

> **支持 1000+ active Agent Loop**

是严格指 **1000 个 Pi Agent Loop 同时正在调用模型/思考/调用 Tool**，

那以默认 `capacity=4`：

```text
1000 / 4
≈ 250 个 Pi Worker Pod
```

这已经是一个相当大的运行规模。

但如果你说的是：

```text
1000 个 Run 同时处于系统中
其中例如 300 正在跑
700 在 Temporal 排队
```

那压力完全不是一个等级。

目前这一层我暂时**没有看到明显的 correctness 问题**。Temporal 当 durable queue，Pi Worker 用固定 slot 控制实际并发，这个模型是合理的。

不过代码里有个小细节值得下一步看：每个 Pi Worker 实际创建了 **两个 Temporal Worker**：

```text
shared task queue Worker
+
affinity task queue Worker
```

它们各自都配置了 `maxConcurrentActivityTaskExecutions = maximumConcurrentRuns`，但两者共享同一个 `#activeExecutions` 总槽位。

所以接下来我们可以只搞清楚一件事：

> **这两个 Temporal Worker 会不会导致“Temporal 以为这个 Pod 有 8 个槽，实际上只有 4 个”，从而产生无意义的 deferred/retry？**

这个就很具体了。

## 037 · User · 2026-08-11T11:22:32.568Z

你说temporal worker拿到run，实际上是有部件调用了temporal的api是吗，是谁调用的，还有我记得引入了cell，这个调用是怎么在多个cell里面路由到temporal的，有策略吗

## 038 · Assistant · 2026-08-11T11:23:46.258Z

对。当前链路里，**真正调用 Temporal API 的是 Control Plane 里的 `TemporalRunOrchestrator`**，不是 Pi Worker。

大致是：

```text
用户发消息
  ↓
Control Plane
  ↓
PG：Turn / Run / Command / Outbox
  ↓ commit
TemporalRunOrchestrator
  ↓ 扫描 Outbox
Temporal Client API
  ↓ workflow.start(...)
Temporal
  ↓
某个 Cell 的 Task Queue
  ↓
Pi Worker
```

`TemporalRunOrchestrator` 内部创建了 `@temporalio/client` 的 `Client`，然后对每个 Run 调：

```ts
client.workflow.start(...)
```

而且传入：

```ts
taskQueue: input.taskQueue
```

所以 **Control Plane 是 Temporal 的生产者，Pi Worker 是 Temporal Task Queue 的消费者**。

### Cell 是在 Temporal 之前就选好的

你现在不是每个 Run 临时选择“哪个 Cell 最空”。

而是：

> **Workspace 创建时，就永久绑定一个 execution Cell。**

例如：

```text
Workspace A → Cell 1
Workspace B → Cell 3
Workspace C → Cell 1
```

这个关系存在：

```text
workspaces.cell_id
```

以后 Workspace A 里面所有 Session / Run，正常情况下都继续进 Cell 1。

当前分配算法确实有策略：

```text
只看 state = active 的 Cell

然后计算：

assigned_workspaces / capacity_weight

取最小的 Cell
```

也就是一个**带容量权重的 least-loaded placement**。

比如：

```text
Cell A
assigned_workspaces = 100
capacity_weight = 100
→ score = 1

Cell B
assigned_workspaces = 150
capacity_weight = 300
→ score = 0.5
```

那么新 Workspace 会分到 Cell B。

分完以后：

```text
Cell B.assigned_workspaces += 1
Workspace.cell_id = Cell B
```



注意它平衡的是 **Workspace 数量 / Cell 权重**，不是实时 active Agent Loop 数量。

---

然后当这个 Workspace 的用户发起 Run 时，Outbox relay 会查：

```text
Run
 ↓
Session
 ↓
Workspace
 ↓
workspace.cell_id
 ↓
execution_cells
 ↓
temporal_task_queue
```

当前代码就是 join `workspaces → execution_cells`，得到：

```text
cellId
taskQueue
```

然后：

```ts
workflow.start({
    taskQueue: input.taskQueue
})
```



所以如果有三个 Cell：

```text
Cell 1
Temporal Task Queue:
agent-dock-pi-runs-cell-0001-v1

Cell 2
Temporal Task Queue:
agent-dock-pi-runs-cell-0002-v1

Cell 3
Temporal Task Queue:
agent-dock-pi-runs-cell-0003-v1
```

实际上还是可以共用**同一个 Temporal 集群和 namespace**，只是有不同的 Task Queue。

然后：

```text
Cell 1 的 Pi Workers
只 poll Cell 1 Queue

Cell 2 的 Pi Workers
只 poll Cell 2 Queue

Cell 3 的 Pi Workers
只 poll Cell 3 Queue
```

Pi Worker 自己启动时也配置了：

```text
AGENT_DOCK_EXECUTION_CELL_ID
AGENT_DOCK_TEMPORAL_TASK_QUEUE
```

而且收到 Activity 后还会验证：

```ts
if (
  input.cellId !== this.#cellId ||
  input.taskQueue !== this.#taskQueue
)
  throw ...
```

所以 Cell 路由不是靠约定，而是 Worker 侧也会 fail closed。

### 其实还有第二级路由

整体是：

```text
第一级：Workspace → Cell
          ↓
     Cell Task Queue
          ↓
第二级：优先之前跑过这个 Session 的 Pi Worker
          ↓
      如果不行
          ↓
     Cell 内任意 Pi Worker
```

第二级就是你之前做的 **soft affinity**。

例如 Session 上一次在：

```text
Cell 2 / Worker-17
```

下一个 Run 会先尝试 Worker-17 的私有 affinity queue；2 秒拿不到、Worker 忙了或者 affinity 失效，就退回 **Cell 2 的公共 Task Queue**，不会跑去 Cell 1。

所以你现在实际上是：

```text
Workspace
   │
   │ durable placement
   ▼
  Cell
   │
   │ Temporal Cell Task Queue
   ▼
Pi Worker pool
   │
   ├─ 优先 Session affinity Worker
   │
   └─ 否则 Cell 内任意 Worker
```

我认为这个层次划分是挺合理的。

不过这里已经露出了我们下一步非常值得看的一个问题：**Cell 分配现在根据的是 `assigned_workspaces / capacity_weight`，不是实时 workload。**

这未必是问题，因为 Workspace 数是很稳定的 placement 指标；但我们接下来分析 1000 active loops 时，就应该看看：

> Workspace 分布均匀，是否真的意味着 Agent Loop 压力也能在 Cell 间大致均匀？

这个我们下一步只讨论它。

## 039 · User · 2026-08-11T11:34:21.322Z

嗯，继续

## 040 · Assistant · 2026-08-11T11:34:44.779Z

继续看这一点的话，我的判断是：**你现在按 `assigned_workspaces / capacity_weight` 做 Cell placement，对你的实际 Coding Agent 场景其实比我刚才第一眼想的更合理。**

原因是你这里的基本单位本来就是 Workspace：

```text
程序员 A → Workspace A → Session → Run
程序员 B → Workspace B → Session → Run
程序员 C → Workspace C → Session → Run
```

而且你刚才也明确了，大量 Session 共用一个 Workspace 不是主要场景。这样一来，如果一个 Cell 分到了大约相同比例的 Workspace，它拥有的**潜在活跃用户数量**通常也会比较接近。你当前正是按 `assigned_workspaces / capacity_weight` 给新 Workspace 选择 Cell。

比如 1000 个开发者、4 个等容量 Cell：

```text
Cell A ≈ 250 Workspaces
Cell B ≈ 250
Cell C ≈ 250
Cell D ≈ 250
```

假设某一时刻 20% 的开发者正在跑 Agent，大概率也会接近：

```text
A ≈ 50 active loops
B ≈ 50
C ≈ 50
D ≈ 50
```

所以我**不建议改成每次创建 Run 时实时挑“当前最空 Cell”**。那样反而破坏了 Workspace 固定 Cell 带来的好处：workspace 文件、Cube、cache、Session affinity 都可以保持局部性。

而且你当前每个 Cell 的 Pi Worker 本来就可以根据**这个 Cell 自己的 Temporal backlog 用 KEDA 扩缩容**。所以偶尔出现：

```text
Cell A：80 loops
Cell B：40
Cell C：55
Cell D：25
```

也不一定需要重新搬 Workspace；Cell A 多扩几个 Worker 就行。当前架构就是 Cell-specific Temporal backlog → KEDA → Cell 内 Worker Pool。

真正需要担心的是一种更极端的情况：

```text
Cell A
已经扩到 max Workers
仍然 backlog 很多

Cell B/C/D
还有大量空闲容量
```

这时候由于：

```text
Workspace A → Cell A
```

是固定 placement，Temporal 也只会把它放进 Cell A 的 Task Queue，所以 **B/C/D 的空闲 Worker 帮不了 A**。

因此这一站我会把结论定成：

> **当前 Cell placement 没必要改成实时 workload 调度。**
>
> 对 1000+ active loop，更重要的是确保“单个 Cell 的最大扩展容量”足够大，并监控 Cell backlog 是否长期失衡。

你其实已经有 drained cross-cell Workspace migration，这比较适合作为**运维级重新平衡机制**，而不是每个 Run 的动态调度机制。最近代码里也明确保留了这种跨 Cell migration。

所以这一层我暂时认为**没有明显架构瓶颈**。

接下来就可以进入更关键的一层了：

```text
某个 Cell 的 Temporal Task Queue
        ↓
几十/几百个 Pi Worker
        ↓
谁来拿 Activity？
        ↓
怎么保证只启动实际容量允许的 Agent Loop？
```

也就是刚才提到的 **Temporal Worker polling / capacity / deferred** 问题。这个比 Cell placement 更值得仔细看。

## 041 · User · 2026-08-11T11:38:10.816Z

我们还是讨论一下为什么需要temporal吧

## 042 · Assistant · 2026-08-11T11:38:15.239Z

可以。先不看实现细节，直接从第一性原理问：

> **如果不用 Temporal，你这个 Cloud Coding Agent 最难自己解决的是什么？**

不是“把任务发给 Worker”。这个用 Kafka、Redis Queue，甚至 PostgreSQL 都能做。

真正麻烦的是：**一个 Agent Loop 是一个可能持续几分钟、会经历多次外部调用、而且运行过程中任何机器都可能挂掉的长事务。**

比如一个 Run：

```text
用户提交 Run
  ↓
等 Worker
  ↓
恢复 Pi Session
  ↓
调用 LLM
  ↓
Tool Call
  ↓
Cube 执行 30 秒
  ↓
再调用 LLM
  ↓
checkpoint
  ↓
完成
```

假设执行到中间：

```text
LLM
↓
Tool Call
↓
Worker 突然 SIGKILL
```

这时候系统必须知道：

```text
这个 Run 还没结束
它属于哪个 command
之前尝试执行过几次
什么时候应该重新调度
是否正在取消
Worker 死了以后多久算失联
下一次应该从哪里恢复
```

**这才是 Temporal 的价值。**

---

如果没有 Temporal，你最终大概率会自己写一个这样的东西：

```text
runs 表
run_attempts 表
leases 表
retry_at
retry_count
timeout_at
cancel_requested
worker heartbeat
scheduler
reaper
retry scanner
timer scanner
```

然后后台不停：

```text
SELECT ...
WHERE state = queued

SELECT ...
WHERE lease_expires_at < now()

SELECT ...
WHERE retry_at < now()

SELECT ...
WHERE timeout_at < now()
```

本质上你自己实现了一个简化版 durable workflow engine。

而 Temporal 已经把这一层做了。

所以你的架构里，我认为 Temporal 最核心的职责可以浓缩成一句：

> **保证一个 Run 在机器不断死亡、重启、扩缩容的情况下，最终仍然能继续被调度执行。**

---

例如：

```text
Run 123
↓
Temporal Workflow 123
↓
派给 Worker A
↓
Worker A 崩溃
↓
Activity heartbeat 消失
↓
Temporal 判断 Activity 失败
↓
按照 retry policy
↓
重新投递
↓
Worker B 接手
```

Worker B 不需要知道 Worker A 是谁。

它只需要：

```text
commandId = xxx
```

然后从 PostgreSQL + Pi checkpoint + Workspace checkpoint 恢复。

这非常适合你的架构。

---

而且有一点特别重要：

**Temporal 不负责保存 Agent 的真正业务状态。**

你现在这个划分我认为是正确的：

```text
Temporal
= “这件事还要不要继续执行？”

PostgreSQL
= “这个 Run 现在业务上是什么状态？”

Pi checkpoint
= “模型对话恢复到哪里？”

Workspace checkpoint
= “代码文件恢复到哪里？”

Kafka / Valkey
= “用户已经看到哪些流式事件？”
```

所以 Temporal 挂掉以后，不会意味着你的 Agent Conversation 丢了。

反过来也一样：

Temporal 说：

```text
Activity 要 retry
```

也不代表它知道：

```text
Tool Call 到底执行没执行
用户看到了哪些字
Workspace 哪个版本是 canonical
```

这些还是你自己的 durable state + fencing 来保证。

---

所以我觉得你引入 Temporal 的理由其实不是：

> “我要一个任务队列。”

如果只是任务队列，我甚至觉得 Temporal 太重。

真正的理由是：

> **Cloud Agent 的一个 Run 是长时间、跨多个外部系统、允许 Worker 随时死亡的 durable execution。**

你不想自己实现：

```text
scheduler
retry
timer
heartbeat
cancellation
worker loss detection
workflow recovery
```

所以把这一层交给 Temporal。

这是我认为 Temporal 在 AgentDock 中最不可替代的价值。

下一步其实可以讨论一个很关键的问题：**既然 PostgreSQL 已经保存了这么多 Run/Attempt/Lease 状态，那 Temporal 和 PostgreSQL 有没有职责重叠、是不是做重了。**这个问题我觉得非常值得继续。

## 043 · User · 2026-08-11T13:56:19.345Z

话说你觉得把控制面，temporal,pi worker写成一个整体合适吗，在中型企业部署场景，这三者是分开好还是合在一起好

## 044 · Assistant · 2026-08-11T13:56:30.926Z

我会明确区分两件事：

> **代码可以是一个整体，部署不要是一个整体。**

对于你这个中型企业场景，我最推荐的是：

```text
同一个 agent-dock 仓库
│
├── Control Plane
├── Temporal orchestration client / workflow code
└── Pi Worker
```

但是运行时：

```text
Control Plane Pods
        │
        ▼
独立 Temporal Cluster
        │
        ▼
Cell 1 Pi Worker Pool
Cell 2 Pi Worker Pool
Cell 3 Pi Worker Pool
```

### Control Plane 和 Pi Worker 我非常不建议合

因为两者扩容依据完全不同。

Control Plane 面对的是：

```text
用户 HTTP 请求
创建 Session
提交 Turn
查询历史
取消任务
```

它可能只需要：

```text
3~6 个 Pod
```

但 Pi Worker 面对的是：

```text
真正的 Agent Loop
LLM streaming
Pi SDK
checkpoint
Tool orchestration
```

1000 active loops 时，你可能需要几百个 Worker slot。

如果绑在一起：

```text
为了增加 100 个 Agent slot
↓
被迫多启动一堆 Control Plane
```

完全没有必要。

反方向也一样，如果 Web 请求突然增加，你不应该因此启动更多 Pi runtime。

---

更重要的是**故障域**。

Pi Worker 是明显更危险的进程：

```text
Pi SDK bug
模型 response 解析异常
内存泄漏
OOM
某个 extension bug
native dependency crash
```

都有可能把整个 Worker 干掉。

你现在一个 Worker 甚至允许同时承载几个 Agent Loop。

如果：

```text
Control Plane + Pi Worker
```

在一个进程或者一个 Pod：

```text
某个 Agent 把 Worker 搞 OOM
        ↓
Control Plane 也死
        ↓
用户连提交新任务都受影响
```

这是没必要制造的耦合。

---

### Temporal 更应该独立

Temporal 和前两个又不一样。

它本质上属于：

```text
基础设施
```

跟 PostgreSQL、Kafka 有点类似。

它有自己的：

```text
Frontend
History
Matching
Worker
Persistence DB
```

并且自己的升级、扩容、HA、监控逻辑。

所以我不会把：

```text
Temporal Server
```

塞进 AgentDock Control Plane。

你的 Control Plane 只是：

```text
Temporal Client
```

Pi Worker 则是：

```text
Temporal Worker SDK
```

它们都连接同一个 Temporal 集群。

---

不过这里有一个细微区别。

你现在的：

```text
TemporalRunOrchestrator
```

也就是：

```text
扫 outbox
→ client.workflow.start()
```

这个**可以暂时放在 Control Plane 部署里面**。

因为它本身非常轻。

因此我会建议你中型企业版本保持：

```text
Deployment A
Control Plane
├── REST API
└── TemporalRunOrchestrator

Deployment B
Temporal Cluster

Deployment C1
Cell 1 Pi Worker Pool

Deployment C2
Cell 2 Pi Worker Pool

...
```

未来如果你发现：

```text
REST API scaling
```

和：

```text
Outbox → Temporal relay scaling
```

也开始互相干扰，再把 Orchestrator 单独拆成：

```text
Control Plane API
Temporal Relay
```

现在没必要。

---

所以我会给你的架构定一个很简单的原则：

```text
代码组织：
可以统一

部署：
Control Plane 与 Pi Worker 分离

基础设施：
Temporal 独立

Cell：
只切 execution plane / Pi Worker / Cube 这一侧
```

这对你这种 **1000+ active Agent Loop，但 Control Plane 实际请求 QPS并没有特别夸张** 的系统尤其合适。

而且这里其实顺带解释了为什么你引入 Cell 后，**Cell 应该主要属于执行面，而不是把整个 AgentDock 都复制成 N 份**。Control Plane 和 Temporal 可以继续作为相对全局的服务，真正随着 Agent 并发横向扩张的是 Pi Worker + Sandbox execution plane。

## 045 · User · 2026-08-11T14:01:43.791Z

嗯，你说的对，现在还是挺合理的，那么能给我讲讲temporal具体做了什么吗，他为什么能做到，他提供了什么能力

## 046 · Assistant · 2026-08-11T14:02:48.916Z

可以。Temporal 看起来功能很多，但从第一性原理看，**最核心其实只有四样东西：Workflow、Event History、Activity、Task Queue**。Retry、Heartbeat、Timer、Cancellation 等，基本都是建立在这四样东西之上的。

最关键的是先理解：

> **Temporal 并不是把你的 Node.js 进程内存保存下来。它保存的是“这段流程已经发生过什么”。**

Temporal 官方把这个叫 **Event History**：Workflow 每做出一个重要决定，例如启动 Activity、启动 Timer、Activity 返回结果、收到外部 Signal，都会形成按顺序持久化的 Event。进程崩溃之后，Temporal 可以重新运行 Workflow 代码，并按照 Event History replay，重建到崩溃前的逻辑状态。

比如写一个非常简化的 Workflow：

```ts
async function run() {
    await restoreSession();
    await executeAgent();
    await checkpoint();
}
```

第一次执行可能产生：

```text
WorkflowStarted
Activity restoreSession scheduled
Activity restoreSession completed(result=A)
Activity executeAgent scheduled
Activity executeAgent completed(result=B)
Activity checkpoint scheduled
...
```

假设 Temporal Worker 在这里挂了。

新的 Worker 接手以后，并不是说：

```text
从 JavaScript PC 指针恢复
```

而是重新执行：

```text
run()
```

但是 replay 时看到历史：

```text
restoreSession 已经完成 → 直接使用历史 result A
executeAgent 已经完成 → 直接使用历史 result B
```

于是代码很快重新跑到：

```text
checkpoint()
```

然后从那里继续。

这就是它“durable execution”的根本原理。Temporal 官方也明确说明：恢复不是进程内存 snapshot，而是重新执行 Workflow Definition，通过历史事件把状态恢复出来。

---

这里马上引出第二个重要概念：**Workflow 不能随便做外部副作用。**

例如 Workflow 里直接：

```ts
await fetch("https://openai...")
```

就有问题。

因为 replay 的时候，这行代码可能又执行一次：

```text
第一次：LLM 调一次
崩溃
Replay：LLM 又调一次
```

结果就完全不同了。

所以 Temporal 把系统拆成：

```text
Workflow
= 确定性的控制逻辑

Activity
= 真正做外部事情
```

例如：

```text
Workflow
    ↓
Activity: 调 OpenAI
Activity: 写数据库
Activity: 调 Kubernetes
Activity: 调 S3
Activity: 执行 Agent Run
```

Activity 可以做网络请求、数据库、文件 I/O、LLM 调用等非确定性操作。成功结果会进入 Workflow History；之后 Workflow replay 时复用这个已经记录的结果，而不是因为 replay 再执行一次已完成的 Activity。

这正好对应你现在：

```text
Temporal Workflow
        ↓
executeRunCommand Activity
        ↓
Pi Worker
        ↓
真正跑 Agent Loop
```

所以你现在实际上没有让 Temporal “运行 Pi”。

而是：

> Temporal 负责说“现在应该执行这个 Run 了”；真正的 Run 是 Activity 的业务实现。

---

第三个能力是 **Task Queue**。

Temporal Server 本身**不执行你的 Pi Worker 代码**。它保存状态和任务，外面的 Worker 主动 poll Task Queue；有容量的 Worker拿任务执行，再把结果返回 Temporal。官方文档明确说明 Worker 在 Temporal Service 外部运行，而 Temporal Service 负责状态转换和把任务提供给可用 Worker。

所以：

```text
Temporal Service
    │
    │ Task Queue
    ▼
Worker 1
Worker 2
Worker 3
Worker 4
```

Worker 是主动：

```text
“我还有容量，有活吗？”
```

而不是 Temporal 主动知道：

```text
worker-17 IP 是什么
```

这带来一个特别适合你 Cloud Agent 的特性：

```text
Worker A 挂了
→ 不需要重新注册路由

Worker B 新启动
→ 开始 poll 同一个 Task Queue
→ 自然可以继续处理任务
```

Task Queue 中 Workflow/Activity Task 可以持久化；Worker 不在时任务可以留着，Worker 恢复以后继续消费。多个 Worker poll 同一个 Queue，也天然形成 worker pool。

你现在的 Cell：

```text
Cell 1 → Task Queue 1
Cell 2 → Task Queue 2
Cell 3 → Task Queue 3
```

本质就是在利用这个能力做 execution-plane routing。

---

第四个就是我们之前说的 **失败检测 + retry**。

例如：

```text
Temporal
    ↓
Activity → Pi Worker A
```

Activity 开始以后，Worker 可以持续发送 Heartbeat。

如果 Worker：

```text
OOM
SIGKILL
Node 掉电
网络断开
```

Heartbeat 停了。

Temporal 就能根据 Activity timeout 判断：

```text
这次 Activity attempt 没了
```

然后根据 Retry Policy：

```text
attempt 1 failed
    ↓
等待
    ↓
重新创建 Activity Task
    ↓
Task Queue
    ↓
Worker B
```

Activity 默认就是适合失败和 retry 的执行单元；Retry Policy 可以配置 initial interval、backoff、maximum attempts、哪些错误不可重试等。

这就是为什么你不用自己写：

```text
worker heartbeat table
↓
定时扫描
↓
last_heartbeat < now - 20s
↓
判断 worker 死亡
↓
生成 retry record
↓
重新放队列
```

Temporal 已经把这一整套 durable timer / retry state machine 做掉了。

---

所以压缩成一张图，Temporal 真正提供的是：

```text
                  Temporal Service
                 ┌───────────────┐
Client ─ start → │ Workflow 状态 │
                 │ Event History │
                 │ Durable Timer │
                 │ Retry 状态    │
                 │ Task Queue    │
                 └───────┬───────┘
                         │
                         │ poll
              ┌──────────┴──────────┐
              ▼                     ▼
          Worker A               Worker B
              │
          Activity
              │
         真正业务副作用
```

而它之所以能做到“机器挂了流程还在”，本质不是有什么神奇的进程恢复技术，而是：

> **把流程的决定和结果持久化成 Event History，再用 deterministic replay 重建 Workflow 状态；把会产生副作用的东西放到可重试的 Activity 中；再通过 durable Task Queue 把 Activity 分发给任意可用 Worker。** 

对于你的 AgentDock，我觉得最值得下一步继续搞清楚的是 **Activity 的 retry 语义**。因为这里有一个特别关键的问题：

```text
Pi Worker 已经执行了某件事
↓
但还没来得及告诉 Temporal “成功”
↓
Worker 死了
↓
Temporal retry
```

那么 **Temporal 到底能不能保证 Activity 不执行两次？**

答案其实是：不能简单理解成 exactly-once。这正是为什么你自己的 `commandId + lease + fencing + durable state` 仍然非常重要。这个点和你现在的崩溃恢复架构关系非常大。

## 047 · User · 2026-08-11T14:23:21.995Z

听起来不错哦，temporal就是控制面和pi worker之间的中间层，控制面把需要执行的run推送给temporal，然后worker在temporal这里认领run，你还提到了
Temporal Workflow         ↓ executeRunCommand Activity  
executeRunCommand Activity 这是什么东西

## 048 · Assistant · 2026-08-11T14:23:36.069Z

对，`executeRunCommand Activity` 这个名字容易让人误以为它是 Temporal 内部某个固定组件。其实不是。

它是**你自己定义的一种 Temporal Activity**。Temporal 只是提供 Activity 这种抽象和调度机制。

你现在的链路实际上是：

```text
Control Plane
    ↓ workflow.start(run)
Temporal Workflow
    ↓
“我要执行 executeRunCommand”
    ↓
Temporal 创建 Activity Task
    ↓
放到 Cell 的 Task Queue
    ↓
某个 Pi Worker poll 到
    ↓
执行你注册的 executeRunCommand
    ↓
真正启动 Agent Loop
```

### Workflow 和 Activity 的区别

你可以把 Workflow 理解成：

> **流程控制代码。**

你现在的 Workflow 大致是在说：

```ts
const result = await executeRunCommand(input);

if (result.status === "deferred") {
    await sleep(...);
    再试一次;
}

return result;
```

实际上你当前 `agentDockRunWorkflow()` 就是这么干的：调用 `executeRunCommand`，如果返回 `deferred` 就等待后重新调度，最多一定次数后 `continueAsNew`。

它本身并不跑 Pi。

---

而 `executeRunCommand` Activity 表示：

> **“请找一台真正的 Worker，把这个 Run 执行一次。”**

Temporal 会把这个 Activity 变成 Task，扔到对应 Cell 的 Task Queue。

然后你的 Pi Worker 启动时注册：

```ts
activities: {
    executeRunCommand: (input) =>
        this.#execute(input, "shared")
}
```

也就是说 Temporal 一旦把 `executeRunCommand` Activity Task 分配给这个 Worker，真正进入的是你代码里的：

```text
TemporalPiWorker.#execute()
        ↓
RunCommandExecutor.dispatchCommand()
        ↓
Pi runtime
        ↓
Agent Loop
```



所以有三个容易混淆的东西：

```text
executeRunCommand
```

是 **Activity 名称/定义**；

```text
某个 Run 的 executeRunCommand Activity Task
```

是 Temporal 队列里的一份**待执行任务**；

```text
Pi Worker 实际执行 #execute(...)
```

则是这次 Activity 的**一次执行 attempt**。

---

举个很具体的例子。

用户提交：

```text
Run 123
```

Control Plane：

```text
workflow.start(
    workflowId = run-123
)
```

Temporal Workflow 开始：

```text
Workflow Run-123

我要执行：
executeRunCommand({
    runId: 123,
    commandId: abc,
    cellId: cell-2
})
```

Temporal 不会直接调用 Pi Worker HTTP：

```text
❌ Temporal → POST worker-17/run
```

而是生成：

```text
Activity Task:

type = executeRunCommand
runId = 123
commandId = abc
```

放进：

```text
cell-2 Task Queue
```

然后：

```text
Pi Worker 7 ─┐
Pi Worker 8 ─┼─ 都在 poll
Pi Worker 9 ─┘
```

假设 Worker 8 空闲，它 poll 到：

```text
executeRunCommand(run-123)
```

于是执行：

```text
Worker 8
↓
#execute()
↓
dispatchCommand(abc)
↓
恢复 Pi session
↓
开始 Agent Loop
```

这就是 `executeRunCommand Activity`。

### 为什么中间还要有 Activity？

因为这样 Temporal 才能管理：

```text
Activity 已经调度了吗？
有没有 Worker 接到？
执行多久了？
Heartbeat 还在吗？
超时了吗？
失败后要不要 retry？
Worker 死了以后要不要重新投递？
```

这些都是 Activity 层的能力。Temporal 的定位就是持久化 Workflow 执行状态并把工作调度给 Worker。

所以你可以把你现在三层关系记成：

```text
Run
= AgentDock 的业务概念

Workflow
= 这个 Run 的 durable 调度器

executeRunCommand Activity
= Workflow 发出的“真正执行一次 Run”的命令

Pi Worker
= Activity 的执行者
```

而且这里有个很有意思的点：**你目前基本上是一个 Run 对应一个 Temporal Workflow，而一个 Workflow 最核心的外部动作就是反复尝试 `executeRunCommand` Activity，直到 Run 最终完成。**

这其实已经能解释你为什么同时既有 `Run`、`Workflow`、`Activity`、`RunAttempt` 这几个看起来很像的概念了。

## 049 · User · 2026-08-11T14:34:19.704Z

好吧，我大概懂了，那么这里如果worker失联了，temporal的行为是什么样的

## 050 · Assistant · 2026-08-11T14:34:45.546Z

对。你这个场景可以直接拿 **Pi Worker 突然 SIGKILL** 来理解。

假设现在：

```text
Temporal Workflow: Run-123
        ↓
executeRunCommand Activity
        ↓
Pi Worker A
        ↓
Agent Loop 正在执行
```

你的 Pi Worker 在 Activity 开始时会发 Heartbeat，此后**每 5 秒发一次**。

然后 Worker A 突然死掉：

```text
Worker A
  X SIGKILL
```

Temporal 此时不会马上知道它死了。它看到的是：

```text
0s     最后一次 heartbeat
5s     没有
10s    没有
15s    没有
20s    仍然没有
        ↓
Heartbeat Timeout
```

你当前 `executeRunCommand` Activity 配置的：

```text
heartbeatTimeout = 20 seconds
```

所以大约这个量级以后，Temporal 会判断：

> **这一次 Activity attempt 已经失效。**

 Temporal 的 Activity Heartbeat/Timeout 正是用于检测这种长任务 Worker 丢失的机制。

然后 Temporal 不会把整个 Workflow 判死，而是进入 **Activity Retry**。

你现在配置的是：

```text
maximumAttempts = 3
initialInterval = 2s
backoffCoefficient = 2
maximumInterval = 30s
```



于是大概变成：

```text
Run-123 Workflow 仍然活着

Activity attempt 1
    ↓
Worker A
    ↓
失联
    ↓
Heartbeat Timeout
    ↓
retry
    ↓
Activity attempt 2
    ↓
Cell-2 Task Queue
    ↓
Worker B poll 到
```

注意：**Temporal 不是“重启 Worker A”。**

它做的是：

> 把 `executeRunCommand(Run-123)` 再次变成可执行的 Activity Task，放回对应 Cell 的 Task Queue。

于是 Cell 内任何健康 Worker 都可能接手：

```text
Cell 2 Task Queue
      │
      ├─ Worker B
      ├─ Worker C
      └─ Worker D

Worker C 有空
    ↓
拿到 Run-123
```

这就是你想要的 Cloud Agent 故障恢复行为。

---

但这里马上出现一个非常重要的问题。

假设 Worker A **其实没死**，只是：

```text
Worker A
    ↓
和 Temporal 网络断了 25 秒
    ↓
Temporal 认为它死了
```

于是：

```text
Worker A 还在执行旧 Agent Loop

同时：

Worker B
拿到了 retry Activity
开始恢复 Run-123
```

这时候理论上可能：

```text
Worker A ─┐
          ├─ 同一个 Run
Worker B ─┘
```

Temporal **不能单靠自己保证外部副作用 exactly-once**。

所以你自己的：

```text
RunAttempt
Lease
Fencing Token
commandId
PostgreSQL canonical state
```

就开始发挥作用了。

你的设计实际上是：

```text
Temporal
负责：
“这个任务应该再尝试一次了。”

PostgreSQL Lease/Fence
负责：
“当前到底哪一个 Worker Attempt 有资格提交结果。”
```

Worker B 获得新的合法执行权以后，旧 Worker A 即使后来恢复网络，带着旧 fencing token 去提交：

```text
旧 Worker A
fence = 41

当前 authority
fence = 42
```

就应该被拒绝。

你的 `RunCommandExecutor` 也确实把 lease/fencing authority 放在业务执行路径中，而不是把 Temporal Activity 成功与否直接当成 canonical Run 状态。

所以整个故障恢复链路可以浓缩成：

```text
Worker A 执行 Agent Loop
        ↓
突然失联
        ↓
Heartbeat 停止
        ↓
Temporal Heartbeat Timeout
        ↓
Activity attempt 失败
        ↓
Temporal retry
        ↓
任务重新进入 Cell Task Queue
        ↓
Worker B 接手
        ↓
PG 创建/确认新的 Attempt + Lease + Fence
        ↓
恢复 Pi / Workspace durable state
        ↓
继续执行
```

这里我觉得你现在架构的一个关键设计点就显出来了：

> **Temporal 解决“谁死了以后还要继续调度”；Lease/Fence 解决“两个 Worker 同时认为自己有权执行时，到底听谁的”。**

两者不是重复的。

而我们接下来如果继续往深一点，最值得讨论的就是：**Worker B 接手以后，到底“从哪里继续”？**因为 Temporal 只知道 `executeRunCommand` 要 retry，它并不知道 Agent 已经输出了多少文本、执行了哪个 Tool、Pi `messages[]` 到哪里了。那就是你整个 checkpoint / crash recovery 设计真正开始介入的地方。

## 051 · User · 2026-08-11T14:40:19.090Z

嗯，是的，你说说怎么介入

## 052 · Assistant · 2026-08-11T14:41:08.498Z

对。以你刚才那个 **Worker A 直接失联 / SIGKILL** 的场景来看，AgentDock 的恢复机制是在 Temporal 决定 retry 之后介入的。

可以把它看成两步：

```text
Temporal 负责：
“这个 Run 还得有人继续处理”

AgentDock 负责：
“新 Worker 应该从什么状态开始处理”
```

具体假设：

```text
Run-123
   ↓
Worker A
   ↓
已经输出了一些文字
   ↓
可能还执行过 Tool
   ↓
SIGKILL
```

Temporal 等 Heartbeat Timeout 后重新投递：

```text
executeRunCommand(command-123)
        ↓
Worker B
```

这时候 **Worker B 不会尝试恢复 Worker A 的 Node.js 内存或 Pi AgentLoop 调用栈**。

它重新从 durable state 拼出一个可以继续工作的世界。

第一步是 **重新取得执行权**：

```text
Worker B
  ↓
RunCommandExecutor(command-123)
  ↓
PostgreSQL
  ↓
新的 RunAttempt
新的 Lease
新的 Fencing Token
```

于是：

```text
Worker A：fence = 41   ← 旧
Worker B：fence = 42   ← 当前
```

之后即使 A 只是网络断开、过一会儿“活过来了”，它也不能再把旧结果提交成 canonical state。

所以 PG 这里解决的是：

> **恢复后到底谁说了算。**

---

然后才是第二步：**恢复 Agent 的脑子。**

正常成功 Run 结束后，你会保存完整的 Pi native Session checkpoint：

```text
PostgreSQL checkpoint pointer
        ↓
immutable manifest
        ↓
S3 里的压缩 JSONL segments
        ↓
重建 session.jsonl
        ↓
Pi SessionManager.open()
```



但现在有个麻烦：

Worker A 是直接被 SIGKILL 的，所以它根本来不及：

```text
写新的 Pi checkpoint
写 run_interrupted marker
```

因此 Worker B 最稳定能拿到的 Pi checkpoint，可能还是：

```text
上一轮成功 Run 结束时

user: 上一个问题
assistant: ...
------------------- checkpoint
```

而这一次 Run 中用户已经看到：

```text
user: 帮我重构这个模块

assistant:
我先检查一下相关代码……
Tool: read ...
assistant:
这里主要有三个问题……
```

这些东西不能凭空消失。

所以你现在专门设计了一个 **semantic recovery bridge / suffix**：

```text
旧 Pi checkpoint
        +
这次 Run 中已经 durable 的公开语义
        ↓
构成 Worker B 的恢复上下文
```

当前架构明确规定：SIGKILL、OOM、node loss 时，新 Worker 从最新 committed Pi checkpoint 恢复，然后把 **checkpoint 之后 PostgreSQL 已确认的公开语义**整理成一条隐藏、model-visible 的恢复信息。

里面可以包含：

```text
本次接受的 user prompt

已经 durable 的 assistant text

已经完成并 durable 的 Tool call/result

failure / cancellation 状态
```

如果某个 Tool 恰好：

```text
Tool 开始执行
↓
Worker 死亡
↓
到底有没有完成无法证明
```

那不会骗模型说它成功了，而是：

```text
Tool state = unknown
```

而且 **thinking 不重建**。

所以 Worker B 给 Pi 看到的逻辑状态大概变成：

```text
Pi checkpoint：

user: 之前的问题
assistant: 之前的回答

----------------------------

[hidden recovery context]

刚刚发生过一个中断的 Turn：

user:
帮我重构这个模块

assistant 已经公开输出：
我先检查一下相关代码……
这里主要有三个问题……

Tool:
read foo.ts
result: ...

另一个 Tool:
状态 unknown

----------------------------

然后重新进入 Agent Loop
```

注意这并不是把浏览器上的 HTML 文本强行塞回 `messages[]`。

你这里强调的是：

> **只使用已经成为 durable canonical semantics 的信息。**

浏览器本地显示的东西本身不是 authority。

---

于是整个 SIGKILL 恢复链路就是：

```text
Worker A
执行 Pi Agent Loop
        ↓
文字 / Tool 事件先 durable
        ↓
SIGKILL
        ↓
Temporal heartbeat timeout
        ↓
retry executeRunCommand
        ↓
Worker B
        ↓
PG 新 Attempt + Lease + Fence
        ↓
恢复 latest committed Pi checkpoint
        ↓
补入 checkpoint 之后的 durable semantic recovery context
        ↓
重新进入 Pi Agent Loop
        ↓
模型继续处理
```

所以一个非常重要的结论是：

> **你的“继续”不是 CPU 指令级继续，也不是从半截 LLM stream 原地继续；而是从最近一个可靠 checkpoint，加上崩溃前已经确认的语义事实，重新启动 Agent Loop。**

我觉得这个恢复粒度对 Coding Agent 是比较合适的。真正棘手的下一层其实就是 **Tool**：如果 Worker 死的时候 Bash 已经执行了一半甚至已经修改了文件，我们到底怎样区分 `completed / definitely not executed / unknown`。你现在 Sandbox Manager 的 operation ledger 就是专门在解决这个问题。

## 053 · User · 2026-08-11T14:47:22.446Z

如果worker只是失联了，然后这时候另一个worker接受了它的工作，那这两个worker是会修改同一个沙箱，还是不同沙箱呢，如果修改同一个沙箱，那谁的execute会被接受呢

## 054 · Assistant · 2026-08-11T14:50:29.148Z

这个问题要先区分一句：

> **Worker B 从 Temporal poll 到 retry Activity，不等于 B 已经取得这个 Run 的执行权。**

你这里其实有两道门：

```text id="1wm6ge"
Temporal
决定：谁来尝试执行

PostgreSQL Lease/Fence
决定：谁现在有资格执行/提交
```

所以如果只是 **A 和 Temporal 失联**，但 A 还在正常续 PostgreSQL Lease，那么即使 Temporal 把 Activity 又给了 B，B 也不应该真正接管。它会在 `RunCommandExecutor` 的 transactional admission 这一层被挡住。当前架构明确把 Run/Attempt/Lease/Fence 的 authority 放在 PostgreSQL，而不是 Temporal。

---

如果进一步假设：

```text id="8t66gq"
A 的 Lease 真的失效
↓
B 获得新 Attempt
↓
B fence = 42
A fence = 41
```

这时候才进入你问的 Sandbox 问题。

### 正常情况下，不会出现两个 Sandbox 同时改同一个 Workspace

你当前 Sandbox Manager 明确规定：

```ts id="fy5ccf"
One Workspace must have at most one active or warm process world.
```

并且创建 Sandbox reservation 时，会检查同一个 Workspace 有没有：

```text id="bdv43e"
reserved
materializing
active
warm
cleaning
```

状态的 activation。

如果旧 Sandbox 还处于 active：

```text id="r07x53"
Worker A → Cube X → /workspace

Worker B 想创建 Cube Y
```

B 会直接得到：

```text id="wkmse4"
tool_sandbox_workspace_busy
```

不会再创建第二个 Cube Y。 

所以不会正常出现：

```text id="y95a6x"
Cube X ─┐
        ├→ 同一个 Workspace
Cube Y ─┘
```

两个独立进程世界同时写。

---

如果旧 Sandbox 已经进入 **warm** 状态，而且：

```text id="rqwezo"
同一个 Session
Workspace revision 相同
Environment 相同
```

那么 B 可以复用**同一个物理 Cube**。

大概是：

```text id="5g8p5a"
Worker A
   ↓
Cube X
   ↓
Run 结束/旧 assignment 释放
   ↓
Cube X 进入 warm

Worker B 新 Attempt
   ↓
复用 Cube X
   ↓
rebind 到新的 Attempt/Lease/Fence
```

代码里确实有：

```ts id="jtzgdo"
provider.rebind(handle, activation.assignment)
```



而且重新 reserve 时，会把 durable activation 更新成：

```text id="mg4vw1"
新的 attempt_id
新的 lease_id
新的 fencing_token
新的 capability
新的 attempt_context
```



所以即使物理 Cube 还是那个 Cube，**控制权已经换人了**。

---

这就回答你第二个问题：

> 如果 A 和 B 都继续发 execute，谁的会被接受？

假设已经正式切到 B：

```text id="34p76g"
A:
attempt = 7
lease = old
fence = 41
capability = old

B:
attempt = 8
lease = new
fence = 42
capability = new
```

Sandbox Manager 当前 activation 已经绑定 B。

A 后面再发 Tool execute，请求身份对不上：

```text id="2oqj8n"
attemptContext 不匹配
或者 capability 已失效
或者旧 activation 已不再 executable
```

就应该被拒绝。

当前 `execute()` 明确检查 `attemptContextSha256`，不等于当前 activation 就报：

```text id="6hsec7"
attempt_context_mismatch
```



而 capability 也是每次 reservation 新生成并绑定到 activation 的。

所以简单理解就是：

```text id="kbv5jp"
谁拿着当前 Attempt + Lease + Fence + Capability
谁能继续操作 Sandbox
```

旧 Worker 即使“诈尸”，不能继续取得新的 Tool authority。

---

最棘手的是另一个时间点：

```text id="ocp1uq"
A 已经发出了：

bash "rm ... / mv ... / npm install ..."

Cube 正在执行
        ↓
A 失联
```

这个已经开始的进程**不能靠 fencing token 穿越时空取消掉**。

所以你的正确处理不是：

```text id="v99u53"
B 直接再执行一次相同 bash
```

而是：

```text id="tsfa9c"
operationId
↓
Sandbox Manager operation ledger
↓
已知完成 → 返回原结果
明确失败 → failure
无法确认 → UNKNOWN
```

当前 operation ledger 在开始时就写入 PostgreSQL，并且一个已经存在的 `operationId` 不会再次被当作新的 operation 启动。

这就是你这套设计真正想保证的：

> **不会让 A 和 B 两个 Worker在同一个 Workspace 上随意同时开两个 Sandbox 写；新的 Worker 必须先取得新的 authority，而旧的 Tool 操作如果结果不确定，就标成 UNKNOWN，而不是盲目重放。**

所以你可以把故障接管理解成：

```text id="d3yaqx"
A 失联
↓
Temporal retry 给 B
↓
B 尝试 PG admission
↓
如果 A Lease 还有效
    → B 暂时不能接管

如果 A Lease 已失效
    → B 获得新 Attempt/Fence
↓
旧 Sandbox 仍 active？
    → B 等/返回 busy，不能开第二个

旧 Sandbox 可安全复用？
    → rebind 同一个 Cube 给 B

不能安全复用？
    → 清理旧 Cube
    → 从 committed Workspace checkpoint 创建新 Cube
```

我认为这个设计是比较稳的。真正值得下一步确认的是一个时间窗口：**A 的 PG Lease 多久续一次、Temporal heartbeat timeout 多久，两者怎么配合，避免 Temporal 过早 retry 导致大量 B 只是拿到任务又被 admission 拒绝。**这个和你前面关注的并发/重试风暴直接相关。

## 055 · User · 2026-08-11T15:13:07.215Z

那你确认一下

## 056 · Assistant · 2026-08-11T15:17:03.413Z

确认了。现在这几个时间参数确实存在一个“Temporal 比 PG Lease 更早判失联”的窗口，但 **correctness 没问题，性能上有一点值得优化。**

当前参数是：

```text
Temporal Activity heartbeat：
每 5s 一次

Temporal heartbeatTimeout：
20s

PostgreSQL Session Lease：
60s

PG Lease renewal：
60s / 3 = 每 20s 一次
```

PG 这边当前代码明确是 `DEFAULT_LEASE_DURATION_MS = 60_000`，`heartbeatIntervalMs = leaseDuration / 3`。  
Temporal 这边则是 Worker 每 5 秒 heartbeat，Activity 配置 `heartbeatTimeout = 20 seconds`。 

所以假设 A 在 `t=0` 与 Temporal 断联：

```text
t=0
Worker A 还在跑

t=20s
Temporal：
“这个 Activity attempt 没 heartbeat 了”
→ retry
→ Activity 给 Worker B

但 PG：
A 的 execution lease 可能仍然有效到 t=60s
```

不过这里我刚才有一点需要修正：

**B 甚至不会走到“跟 A 抢 Lease”这一步。**

因为 A 真正开始执行以后，数据库已经是：

```text
command = acknowledged
turn    = running
run     = running
```

而 `RunCommandExecutor.#claimNext()` 只允许：

```text
pending + queued

或者

dispatched + dispatching
```

进入新的执行 claim。`acknowledged + running` 根本不符合条件。 

所以 B 拿到 Temporal retry Activity 后：

```text
B
↓
dispatchCommand(commandId)
↓
发现这个 command 已经 acknowledged/running
↓
拿不到 claim
↓
返回 idle
```

然后 `TemporalPiWorker` 会查 Run 状态。

发现：

```text
run = running
```

于是返回：

```text
deferred
retryAfterMs = 250
```

而不是创建第二个 RunAttempt。

所以实际上：

```text
               Worker A
               仍然拥有 Run
                   │
Temporal retry     │
      ↓            │
Worker B           │
      ↓            │
检查 PG ───────────┘
      ↓
“已经有人在执行”
      ↓
deferred
```

**不会出现两个 Worker 同时进入 Pi Agent Loop。**

这点比我上一条描述得更严谨。

---

更有意思的是，如果只是：

```text
A ↔ Temporal 网络断了

但是：
A ↔ PG 正常
A ↔ Model 正常
A ↔ Sandbox 正常
```

那么 A 甚至可以继续把 Agent Loop 跑完。

最后 A 在 PG 中提交：

```text
run = completed
```

此时某一次 B 的 deferred retry 再进来：

```text
发现 run = completed
↓
直接告诉 Temporal：
这个 Run 已经完成
```

于是 Temporal Workflow 也可以收敛。

所以：

> **Temporal Activity attempt 是否活着，并不是 AgentDock Run 的业务 authority。PostgreSQL 才是。**

这个设计是很好的。

---

如果 A **真的死了**，情况是：

```text
t=20s
Temporal 已经开始 retry

t≈60s
PG Lease 因为没有续约而过期
```

但是你的系统还有一道非常保守的设计：

> **Lease 过期本身不等于允许 B 接管。**

当前设计明确认为：

```text
lease expired
≠
旧 Pi / Tool / Cube 已经消失
```

所以不能：

```text
60s 到了
→ 删除 lease
→ B 直接接管
```

必须经过 reconciliation，确认旧执行边界已经不能继续写、旧 runtime 已被清理/确认不存在，然后才能释放 authority。这个原则在你的 lease/reconciliation 设计里是明确写死的。

这就是防止：

```text
A 只是网络分区
↓
60s lease expired
↓
B 接管
↓
A 又恢复
↓
两个 writer
```

---

所以当前完整时间线实际上是：

```text
0s
A 与 Temporal 失联

20s
Temporal heartbeat timeout
→ 开始把 Activity retry 给 B

20~...
B：
PG 看到 Run 仍 acknowledged/running
→ 不执行
→ deferred

60s 左右
如果 A 连 PG heartbeat 也断了
→ Session Lease expires

但是：
不会仅凭 expires 就让 B 接管

↓
Supervisor / runtime reconciliation
↓
确认旧 A execution boundary 已失效/清理
↓
PG 才允许状态收敛或重新执行
```

### 所以目前有没有问题？

**正确性上我认为很好。**

Temporal 可以“过早怀疑”，但 PG 不会因此让第二个 Worker获得业务执行权。

不过性能上有个比较明确的小问题：

```text
Temporal 20s 就 retry

但 B 每次发现 PG 还不能执行
→ deferred 250ms
→ Workflow sleep
→ 再发 Activity
```

这可能形成没必要的：

```text
Activity
→ B
→ DB read
→ deferred
→ 250ms
→ Activity
→ ...
```

尤其故障规模大，比如一个 Node 同时掉几十个 Worker 时。

所以我的结论是：

> **这里没有 split-brain correctness bug，但存在“Temporal retry 太快以后产生 deferred churn”的潜在效率问题。**

这比我们之前担心的“双 Worker 抢同一个 Sandbox”轻得多。下一步如果继续沿这个点，我会看 **有没有办法让 Temporal 在 Run 已经被其他 authority 持有时，不要每 250ms 空转一次**。这应该是这一层真正值得优化的地方。

## 057 · User · 2026-08-11T15:26:40.729Z

pi worker要调用tool的时候，是交给sandbox manager执行的对吧，那如果有一个新的pi worker接受这部分工作，sandbox manager能知道把tool的执行转发到哪个cubesandbox里面吗

## 058 · Assistant · 2026-08-11T15:27:55.836Z

对。**Pi Worker 调 Tool 时不是直接找 Cube，而是把请求交给 Sandbox Manager。**而且如果换成了新的 Pi Worker，Sandbox Manager 仍然可以知道应该把 Tool 发到哪一个 Cube。

但要加一个前提：**新的 Pi Worker 必须已经真正取得新的 RunAttempt / Lease / Fence。**如果只是 Temporal 提前把 retry Activity 给了 B，而 A 仍然是 PG 中的 current owner，B 根本走不到 Tool 这一步。

真正接管以后，链路是这样的：

```text
Worker B
  ↓
Sandbox Manager reserve/create
  ↓
assignment:
  workspaceId
  sessionId
  turnId
  attemptId
  leaseId
  fencingToken
  ...
  ↓
Sandbox Manager
  ↓
activationId
  ↓
SandboxHandle
  ↓
runtimeId / runtimeName
  ↓
具体 Cube microVM
```

Sandbox Manager 内部的 `ManagedActivation` 本身就保存：

```text
assignment
handle
```

其中 `handle` 就是指向具体物理 Sandbox runtime 的句柄，包括 `runtimeId`、`runtimeName` 等信息。

所以后续 Worker B 调：

```text
tool.execute(
  activationId,
  capability,
  operationId,
  ...
)
```

Manager 根据 `activationId + capability` 找到 activation，然后：

```ts
const handle = await this.#materialize(...)
await this.#provider.exec(handle, request, signal)
```

也就是说，**最终是 Sandbox Manager 拿着 `SandboxHandle` 把请求送到精确的 Cube**。

更有意思的是，如果原来的 Cube 还可以安全复用，比如同一个 Session、Workspace revision 和环境都没变化，那么新的 Attempt 可以继续使用**同一个物理 Cube**。

这时候 Manager 会：

```text
原来的 Cube X
    ↓
SandboxHandle
    ↓
rebind
    ↓
新的 Attempt / Lease / Fence
```

代码里确实有：

```ts
provider.rebind(handle, activation.assignment)
```



于是逻辑上：

```text
Worker A
  ↓
Attempt 7
  ↓
Cube X

发生合法接管

Worker B
  ↓
Attempt 8
  ↓
还是 Cube X
```

但 Cube X 当前的控制身份已经被重新绑定到 Attempt 8。

所以 Worker A 后面再拿旧的：

```text
attemptId = 7
lease = old
fence = 41
capability = old
```

去执行 Tool，不会被当成合法的当前操作。

---

如果不能安全复用，Manager 就不会硬接原 Cube。

例如 Workspace revision 不匹配、环境变了或者旧 runtime 状态有歧义，它会走：

```text
停掉旧 Cube
↓
从 committed Workspace checkpoint 恢复
↓
新建 Cube
↓
新的 handle
```

另外，如果旧 Workspace activation **仍然 active**，新的 Attempt 也不会直接创建第二个 Cube，因为当前代码明确限制：

> 一个 Workspace 最多只有一个 active/warm process world。

这种情况下新 reservation 会得到 `tool_sandbox_workspace_busy`，而不是开两个 Cube 同时写。

所以可以把职责记得很简单：

```text
Pi Worker
= 我想执行 bash/edit/read

Sandbox Manager
= 你现在有没有权执行？
  这个 Workspace 对应哪个 activation？
  activation 对应哪个 Cube？

Cube Provider
= 在这个具体 runtimeId 上真正执行
```

因此 **Pi Worker 可以随便换，Cube 的具体位置不需要跟着 Worker 走**。这是 Sandbox Manager 这一层存在的一个很重要的价值。

不过还有一个不同的问题：如果不是 **Pi Worker 换了**，而是 **拥有这个 Cube 的 Sandbox Manager 自己挂了**，那么“新 Manager 能不能无缝认领旧 Cube”就没这么简单了。你当前这一块是偏 fail-closed/reconciliation 的，这个我们可以接着讨论。

## 059 · User · 2026-08-11T15:29:52.377Z

嗯，可以，接着将

## 060 · Assistant · 2026-08-11T15:30:46.075Z

对，这里和 Pi Worker 换人不一样。**Sandbox Manager 挂掉以后，你当前实现不是“新 Manager 无缝接管旧 Cube”，而是偏保守的 fail-closed。**

原因很直接：具体的

```text
activationId → SandboxHandle → runtimeId
```

虽然有一部分身份落在 PostgreSQL，但 Manager 自己还有本地内存状态。Manager 直接崩了以后，新 Manager 不能确信：

> 旧 Cube 里面现在有没有 Bash 还在跑？某个 Tool 到底执行到哪一步了？

所以你现在做的是下面这套。

旧 Manager 有自己的数据库 ownership lease：

```text
Manager A
heartbeat 每 5s
ownership lease = 15s
```



假设 A 突然死：

```text
Manager A
   X
   │
   └── Cube X 可能还活着
```

等它的 15 秒 lease 过期后，健康 Manager 会把：

```text
Manager A → lost

A 负责的 activation
active / warm / materializing ...
        ↓
unknown

A 正在执行的 Tool operation
running
        ↓
unknown
```

代码就是明确这么处理的。

注意这里非常重要：

> `unknown` 不是 `failed`，更不是 `completed`。

意思就是：

```text
“我现在不能证明这个 Cube / Tool 到底发生了什么。”
```

然后新 Manager B 会认领这些 `unknown activation`，但认领的目的不是继续执行，而是：

```text
unknown
  ↓
Manager B claim
  ↓
cleaning
  ↓
定位旧 Cube
  ↓
destroyActivation(...)
  ↓
确认清理
  ↓
released
```

当前 `claimOrphanedActivations()` 会把 orphan 改成 `cleaning` 并换成新 Manager owner；`ToolSandboxManager` 随后调用 provider 去销毁这个旧 activation。 

所以它不是：

```text
Manager A 死
↓
Manager B：
“哦，runtimeId=123，我接着用吧”
```

而是：

```text
Manager A 死
↓
旧 Cube 状态不可信
↓
Manager B 清掉旧执行边界
↓
之后新的 Attempt
↓
重新 reserve
↓
从 committed Workspace checkpoint 恢复
↓
必要时创建新 Cube
```

我认为这个选择是对的。

因为 Coding Agent 的 Sandbox 可以执行任意：

```text
bash
npm install
git
后台进程
文件写入
```

新 Manager 如果直接 adopt 一个状态未知的 VM，风险很大。甚至可能旧的：

```text
rm / mv / build / script
```

还在后台运行。

所以你现在牺牲了一点故障恢复速度，换取：

> **Manager 故障之后不会冒险制造两个 writer。**

这也说明你的几个故障级别其实不一样：

```text
Pi Worker 挂
→ Sandbox Manager还活着
→ 有机会安全 rebind / 继续使用 Cube

Sandbox Manager 挂
→ Cube 控制状态本身失去可信 owner
→ 不无缝 adopt
→ 清理后重新恢复
```

这一层我觉得逻辑是成立的。

接下来最值得看的就是更棘手的情况：**Manager 挂的时候，Cube 里面恰好有一个 `bash` 正在执行。这个 bash 最终修改了一半文件，新 Manager 清掉 Cube 后，Workspace 到底恢复成什么状态？**这会牵到你的 Kopia checkpoint / Workspace commit boundary。

## 061 · User · 2026-08-11T23:49:23.655Z

等等，我有一个更重要的问题，就是我们现在是吧temporal以下的部件都封装进cell了是吧，是为了弹性伸缩，但是有这必要吗，像temporal和sandbox manager, cube api，这些部件，服务1000+的active run难道算是并发量很高吗，需要弹性伸缩的只有pi worker和cubesandbox的数量

## 062 · Assistant · 2026-08-11T23:49:50.719Z

我基本同意你的判断，而且我觉得这里**确实有一点把 “Cell = 扩展单元” 做得过重的倾向**。

先纠正一个现状：你现在实际上不是：

```text
Cell
├── Temporal
├── Pi Worker
├── Sandbox Manager
└── Cube
```

而更接近：

```text
Global
├── Control Plane
├── PostgreSQL
├── Temporal Cluster
├── Kafka / Valkey
├── S3 / Kopia
└── Cube control/compute cluster

Cell A
├── Temporal Task Queue A
├── Pi Worker Pool A
└── Sandbox Manager / Data Mover A

Cell B
├── Temporal Task Queue B
├── Pi Worker Pool B
└── Sandbox Manager / Data Mover B
```

Temporal 明确是 external global cluster；Cube 也是独立 external cluster。

所以现在真正值得问的是：

> **Sandbox Manager / Data Mover 有没有必要也跟着每个 Cell 复制？**

我觉得答案是：**Sandbox Manager 未必需要。**

---

### 先看谁的负载真正跟 active loop 线性增长

1000 个 active Agent Loop，真正意味着：

```text
1000 个 Pi AgentSession
1000 个 LLM stream
```

所以 Pi Worker 显然必须横向扩展：

```text
Pi Worker
≈ active loop 数量线性增长
```

如果其中例如 30% 正在同时使用 Tool：

```text
≈ 300 个 active Cube
```

那 Cube **compute capacity** 也必须跟着增长。

所以真正重的资源是：

```text
Pi Worker CPU / RAM
Cube vCPU / RAM
```

这两个毫无疑问需要弹性伸缩。

---

### Sandbox Manager 完全不同

Sandbox Manager 自己不执行：

```text
bash
npm test
LLM inference
```

它做的主要是：

```text
鉴权
查 activation
检查 Lease/Fence
路由到 Cube
记录 operation
create/rebind/stop Cube
checkpoint 协调
```

也就是说：

> 1000 active Agent Loop ≠ Sandbox Manager 同时有 1000 个重任务。

它更像控制器。

哪怕有 1000 个 Agent 活跃，大部分时间 Agent 可能正在：

```text
等 LLM
thinking
用户阅读
```

Manager 根本没事干。

只有 Tool Call 出现的时候：

```text
Pi Worker
   ↓
Sandbox Manager
   ↓
Cube
```

Manager 才参与一下。

所以我不认为：

```text
1000 active loops
```

这个规模本身足以要求：

```text
8 Cells × 3 Sandbox Managers
= 24 个 Sandbox Manager
```

这种规模。

**很可能 3～5 个全局 Sandbox Manager 就够了。**

---

而且你最近已经把 Manager 的关键状态外置到 PostgreSQL 了。

当前文档明确写着：

> Manager replicas no longer form a process-local hash ring.

现在任意 Ready Manager 都可以接受 create，请求之后由 PG ownership 确定具体 owner。

这其实意味着：

> **当初“Manager 必须跟 Workspace shard 绑定”的理由已经弱很多了。**

之前 Manager 内存里掌握：

```text
Workspace → Cube
```

所以必须做固定 hash ring。

现在：

```text
activation ownership
runtime identity
operation ledger
```

已经大量进入 PostgreSQL。

那就完全可以考虑：

```text
             Global Sandbox Manager Cluster
                    3~5 replicas
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
   Cube A             Cube B             Cube C
```

而不是：

```text
Cell A → 自己 3 个 Manager
Cell B → 自己 3 个 Manager
Cell C → 自己 3 个 Manager
...
```

---

### Cube 也要分清 control plane 和 compute plane

这里尤其重要。

`CubeSandbox` 本身其实也有两种资源：

```text
Cube control plane
CubeMaster / API / scheduler
```

和：

```text
Cube compute plane
Cubelet / KVM nodes / microVM
```

1000 active Agent 并不意味着：

```text
1000 个 Cube API Server
```

而意味着：

```text
可能几百 / 上千个 microVM
```

所以真正需要横向扩展的是：

```text
Cube compute nodes
```

而不是一定要复制 Cube control plane。

这和 Kubernetes 很像：

```text
一个 K8s control plane
可以管很多很多 Pod

不是：
1000 Pods
→ 就要 10 套 Kubernetes API Server 集群
```

当然 control plane 自己可以做 HA replication，但那是：

```text
3 replicas
```

这种意义上的 HA，不是按照 Agent 数量线性扩展。

---

### Temporal 也是同样道理

Temporal 的角色就是：

```text
1000 Workflow
1000 Activity
几千个 timer / heartbeat / history events
```

对 Temporal 来说，1000 这个量级其实并不是什么特别夸张的规模。

你没必要：

```text
Cell A → Temporal A
Cell B → Temporal B
Cell C → Temporal C
```

当前一个 Temporal cluster：

```text
Task Queue Cell-A
Task Queue Cell-B
Task Queue Cell-C
```

已经很好。

---

所以如果让我现在重新定义 **Cell**，我会让它变得更轻：

```text
                    Global Plane

Control Plane
PostgreSQL
Temporal
Event Gateway
Kafka / Valkey
Sandbox Manager Cluster
Cube Control Plane
Object Storage

                         │
              ┌──────────┴──────────┐
              │                     │
          Execution Cell A      Execution Cell B

          Task Queue A          Task Queue B
          Pi Workers            Pi Workers
          Cube compute          Cube compute
```

甚至 Cube compute 是否一定要跟 Cell 绑定，也可以以后再讨论。

Cell 最核心只需要表达：

> **一组有独立容量上限、独立 backlog、可以独立扩缩的 Agent execution resources。**

这就够了。

---

所以你刚才这个判断我认为是很有价值的：

> **在中型企业、1000+ active loop 目标下，真正需要跟负载弹性增长的是 Pi Worker 和 Cube compute capacity。**

其他组件更多需要的是：

```text
HA
足够吞吐
故障隔离
```

而不是“一 Cell 一套”。

因此我现在甚至倾向认为：**如果每个 Cell 固定放 3 个 Sandbox Manager + Data Mover，你当前 Stage1 的多 Cell 拓扑有一点 over-design。**

Cell 本身我会保留，因为它对：

```text
Temporal backlog 分片
Worker 扩缩容
故障爆炸半径
Workspace placement
```

还是有价值的。

但可以把 Cell 从“微型完整执行平台”收缩成更纯粹的 **Worker/Cube capacity shard**。

这个方向值得继续往下推。

## 063 · User · 2026-08-12T01:55:14.321Z

刚刚又推送了一次代码，你看看现在cell的时间包含什么东西

## 064 · Assistant · 2026-08-12T01:56:47.246Z

看了你刚推的最新 `main`，最新提交是 `e1ef716`：**`refactor: share sandbox domains across execution cells`**。这次改动正好把我们刚才讨论的东西做了收缩。

现在我会把 **Cell** 理解成一个很轻的 **Pi Worker execution shard**。

实际关系大概变成：

```text
Global Plane
├── Control Plane
├── Event Gateway
├── PostgreSQL
├── Temporal
├── Kafka / Valkey
└── Pi checkpoint S3

Sandbox Domain
├── Tool Broker
├── Workspace Data Mover
├── Cube API / Proxy
├── Cube compute
├── RWX Workspace storage
└── Kopia

Execution Cell A
├── Temporal Task Queue A   ← 逻辑队列，不是独立 Temporal
└── Pi Worker Pool A

Execution Cell B
├── Temporal Task Queue B
└── Pi Worker Pool B
```

最新部署文档已经明确写成：一个 **Sandbox Domain 可以服务多个 execution Cells**；Tool Broker 至少 3 个副本，Data Mover 独立扩容。

### Cell 现在具体还保存什么？

数据库里的 `execution_cells` 现在核心就是：

```text
cell.id

temporal_task_queue
    # 这个 Cell 的 Worker 去 poll 哪个 Temporal queue

sandbox_domain_id
    # 这个 Cell 使用哪个共享 Sandbox Domain

supervisor_management_url_template
    # 怎么找到这个 Cell 里的具体 Pi Worker

capacity_weight
assigned_workspaces
    # Workspace placement / 容量权重
```

这次提交明确删除了 Cell 以前直接持有的：

```text
sandbox_manager_base_url
workspace_storage_key
```

改成：

```text
sandbox_domain_id
```



所以 Cell 已经**不再拥有自己的 Sandbox Manager 和 Workspace storage**。

更准确地讲：

> Workspace 仍然固定分配给一个 Cell，但这个 Cell 再引用一个 Sandbox Domain。

即：

```text
Workspace
   ↓
Cell 3
   ├── Task Queue 3
   ├── Pi Workers 3
   │
   └── sandboxDomainId = domain-1
                         ↓
                  Sandbox Domain 1
                  ├── Tool Broker
                  ├── Data Mover
                  └── Cube
```

而且最新设计明确规定 **Tool Broker activation ownership 按 `sandbox_domain_id` 分区，不再按 `cell_id` 分区**。

### Stage 1 现在也已经变成这个样子

8 个 Cell：

```text
8 Cells

每 Cell：
2 ~ 64 Pi Worker Pods
每 Worker：
4 slots
```

但整个 8 Cell 集群共享一个：

```text
sandbox-domain-0001

Tool Broker = 5 replicas
Data Mover = 3 replicas
maximumActiveSandboxes = 2048
```

而不是原来的：

```text
8 × 3 Sandbox Managers
```



所以我觉得你刚才提出的方向已经基本落实了。

现在 **Cell 的核心意义已经很纯粹**：

```text
Workspace placement shard
+
Temporal backlog shard
+
Pi Worker autoscaling shard
```

而：

```text
Tool Broker
Data Mover
Cube control / compute
Workspace storage
```

统一下沉成了 **Sandbox Domain**，可以被多个 Cell 共享并独立扩容。最新代码甚至明确说：“lightweight execution Cells scale Pi Workers from Temporal backlog”。

我觉得这个版本比之前合理很多。下一步我们反而可以讨论：**既然 Cell 已经这么轻了，那 1000+ active loop 到底还有没有必要分成 8 个 Cell，还是一个大 Cell + 大 Worker Pool 就够了。**这个问题现在就很值得重新审视了。

## 065 · User · 2026-08-12T02:12:13.727Z

其实agent loop是很占资源的吗，咱现在的agent loop是通过pi sdk启动的吧，那相当于是调用一个函数，1000+大概占用多少内存，cpu呢

## 066 · Assistant · 2026-08-12T02:14:36.001Z

对，**你现在的 Agent Loop 确实是通过 Pi SDK 嵌入 Pi Worker 进程里运行的**，不是“一条 Run 启一个 Pi 子进程”。生产路径依赖的是 `@earendil-works/pi-coding-agent 0.80.10`，你的 embedded backend 也是直接 `createAgentSessionRuntime(...) → session.prompt(...) → runtime.dispose()`。 

所以从资源角度，它更接近：

```text
一个 Node.js 进程

AgentSession A ── await LLM stream
AgentSession B ── await LLM stream
AgentSession C ── await Tool RPC
AgentSession D ── await LLM stream
...
```

而不是：

```text
1000 Run
=
1000 个 Node 进程
=
1000 个 CPU 核
```

### 你其实已经有一个很有价值的实测

仓库里的 density probe 做过：

```text
1000 logical sessions
10 concurrently active
Pi SDK embedded
0 model calls
```

两次实测中，1000 个 Session 全部 cool 下来以后：

```text
V8 heap 增量：
3.55 ~ 3.59 MB

也就是约：
3.6 KB / idle logical session
```

RSS 虽然增加了 135–168 MB，但你自己的 benchmark 特意注明了，这主要包含 allocator high-water 和 Pi/module cache，**不能当成 1000 个 Session 的真实 live memory**。

这说明一个很重要的事情：

> **冷 Session 几乎不占 Worker 内存。真正要算的是 active AgentSession。**

---

### Active Agent Loop 我会先估这个量级

现在还没有“1000 个真实 LLM AgentSession 同时 active”的实测，所以这里必须是工程估算。

一个 active Session 主要持有：

```text
AgentSession
SessionManager
messages[]
Agent state
Resource/extension state
HTTP/SSE stream
部分 token / event buffer
当前 Tool Call state
```

Pi SDK 代码本身、Node module、模型 provider 实现等是**进程共享的**，不是每个 Session 复制一份。

因此对于正常 Coding Agent 上下文，我会先按：

```text
短 / 中等 Session：
≈ 2 ~ 8 MB / active loop

比较长的 Session：
≈ 10 ~ 30 MB+

极端巨大 context / 大量历史 Tool result：
可能更高
```

来做容量规划。

所以 **1000 active Agent Loops** 的 Pi runtime 本身，我第一版预算会放在：

```text
约 3 ~ 10 GB RAM
```

而不是几十上百 GB。

如果历史都非常长，给到：

```text
10 ~ 30 GB
```

也不奇怪。

关键变量其实不是“Agent Loop 这个函数有多重”，而是：

> **每个 `AgentSession.messages[]` 到底有多大。**

---

### CPU 更轻

这个更明显。

LLM 真正的：

```text
Transformer inference
GPU 计算
采样
```

全部在 OpenAI / Anthropic / DeepSeek 那边。

Pi Worker 干的是：

```text
发 HTTP 请求
↓
await
↓
解析 SSE / WebSocket
↓
维护 messages[]
↓
处理流式 token
↓
产生 event
↓
Tool Call 时发 RPC
↓
await Sandbox
```

所以一个 Agent 在模型思考的十几秒里，本地 CPU 很可能接近：

```text
0.x% ~ 几%
```

大量时间就是 socket `await`。

1000 个同时 active，但绝大部分正在等模型的 Agent，我不会按照：

```text
1000 active → 几百 CPU cores
```

去估。

更像：

```text
steady-state model streaming：

1000 active loops
≈ 几个到十几个 CPU cores
```

例如第一版可以粗略按 **4–16 cores aggregate** 去压测。

CPU 高峰反而是在：

```text
大量 Session 同时 restore
JSONL parse
Pi context reconstruction
compaction
gzip checkpoint
大量 SSE JSON/event 处理
1000 个 Run 同时 settle
```

这些 burst 阶段可能明显高于平时。

---

### 这就暴露了你现在一个挺大的容量设计问题

你目前配置是：

```text
一个 Pi Worker Pod
capacity = 4

resources:
request:
  250m CPU
  384Mi RAM

limit:
  2 CPU
  1Gi RAM
```



1000 active Run：

```text
1000 / 4
≈ 250 Pi Worker Pods
```

那么光 Kubernetes resource request 就是：

```text
250 × 384Mi
≈ 94 GiB requested RAM

250 × 250m
≈ 62.5 CPU cores requested
```

这时候就很可能出现一个很滑稽的结果：

> **真正的 1000 个 Pi Agent Loop 可能只吃几 GB 内存，但为了每 4 个 Loop 起一个 Node Pod，你给 Kubernetes reserve 了接近 100GB。**

所以我现在会重新怀疑：

```text
capacity = 4
```

是不是过于保守。

它更像一个**故障隔离参数**，而不是 Pi SDK 的资源极限。

---

我反而觉得值得认真测试：

```text
8 active / Worker
16 active / Worker
32 active / Worker
64 active / Worker
```

如果最终发现一个 Worker：

```text
16 active
≈ 500MB RSS
CPU 平均不到 1 core
```

那么 1000 active 只需要大约：

```text
63 Worker Pods
```

如果能做到 32：

```text
≈ 32 Pods
```

这和现在的 **250 Pods** 就完全不是一个架构规模了。

所以目前我比较倾向于一个判断：

> **Pi Worker需要弹性伸缩没错，但它的伸缩粒度可能被我们设得太细了。真正重量级、几乎跟活跃 coding workload 线性消耗资源的，反而是 Cube microVM；Pi Agent Loop 本身主要是内存中的状态 + 异步 I/O。**

你这个问题其实很关键，因为如果这一点成立，**我们甚至需要重新审视 8 个 Cell 是否还有必要，以及一个 Cell 到底应该承载多少 Worker。**

## 067 · User · 2026-08-12T02:26:09.531Z

所以听起来pi worker不太需要那么强的扩缩容，也就是说它并不需要和cubesandbox同步扩缩容。如果真到了需要扩缩容的时候，pi worker扩一倍，可能cubesandbox就得扩10倍了，是这样的感觉吗

## 068 · Assistant · 2026-08-12T02:26:11.668Z

对，**方向上就是这种感觉，但不要理解成固定“Pi Worker ×2，Cube ×10”这个比例**。

更准确地说，二者的扩容驱动完全不同：

```text
Pi Worker 容量
≈ active Agent Loop 数量
× 每个 Loop 的内存/CPU开销

Cube 容量
≈ 同时 Tool-active 的 Run 数量
× 每个 Sandbox 的 vCPU / RAM
```

这两个量并不同步。

比如有 1000 个 active Run：

```text
1000 Agent Loops
├─ 700 个正在等 LLM
├─ 100 个正在处理流式消息
└─ 200 个正在跑 Tool
```

Pi Worker 要承载的是 **1000 个 AgentSession**。

但其中 700 个可能基本就是：

```text
await modelStream
```

CPU 很低，内存也只是上下文状态。

而 Cube 那 200 个是真正在：

```text
npm test
mvn test
cargo build
git
python
bash
```

这些是真 CPU / RAM 消费者。

所以一台机器上可能出现：

```text
Pi Worker:
32 个 active Agent Loops
CPU 平均可能不到 1~2 core

Cube:
仅 8 个并发 build
就可能已经要 8~16+ cores
以及很多 GB RAM
```

所以 **Cube 的资源斜率明显比 Pi Worker陡**。

---

这也意味着你的 autoscaling 最好完全解耦。

不要设计成：

```text
Pi Worker × 2
↓
Cube capacity 自动 × 2
```

而应该：

```text
Temporal backlog / active AgentSession
        ↓
Pi Worker autoscaler

Tool reservation backlog / active microVM / CPU / RAM
        ↓
Cube compute autoscaler
```

两条独立反馈回路。

甚至可能出现：

```text
场景 A：纯聊天 / 代码分析

1000 active Agent Loops
只有 50 个 Cube

→ Pi Worker 压力高一些
→ Cube 压力很低
```

也可能：

```text
场景 B：大家都在跑测试 / 编译

1000 active Agent Loops
700 个 Tool-active

→ Pi Worker数量几乎没变
→ Cube compute 需求暴涨
```

所以你说的这句话其实挺准确：

> **Pi Worker 不需要和 CubeSandbox 同步扩缩容。**

而且如果我们最终压测发现一个 Pi Worker Pod 可以安全持有：

```text
32 / 64 甚至更多 active Agent Loops
```

那么 Pi Worker 很可能只是几十个 Pod。

但 Cube 可能同时需要几百个 microVM，并且这些 microVM 每个都有真正的：

```text
vCPU
RAM
PID
filesystem
```

这时它们的资源规模完全不是一个数量级。

我甚至会进一步说：

> **Pi Worker更像连接密集型 / 状态密集型服务；Cube compute 才是计算密集型资源池。**

所以现在这个新架构把：

```text
Cell → Pi Worker scaling

Sandbox Domain → Cube compute scaling
```

拆开，我认为方向是对的。

不过还有一个很关键的变量：**Tool duty cycle**。比如一个典型 Coding Agent Run 有 60% 时间等模型、30% 时间等 Tool、10% 本地处理，和 10% Tool 时间相比，Cube 容量需求会差三倍。这个指标可能比“active Run 总数”更值得以后实测。

## 069 · User · 2026-08-12T03:41:38.858Z

你说得对，这意味着现在的cell设计不太妥是吧

## 070 · Assistant · 2026-08-12T03:41:59.483Z

对，**我觉得现在 Cell 的设计价值已经明显下降了，至少不能再把它当成主要的“资源扩缩容单元”来设计。**

原因就是我们刚刚推出来的这个事实：

```text
Pi Worker
= 轻量、I/O 密集
= 一个进程可以承载很多 Agent Loop

Cube compute
= 重量、CPU/RAM 密集
= 独立按 Tool workload 扩容
```

这意味着原来这种思路：

```text
Cell 1
├─ 64 Pi Worker slots
└─ 一组 Sandbox capacity

Cell 2
├─ 64 Pi Worker slots
└─ 一组 Sandbox capacity
```

背后的假设其实是：

> Agent execution capacity 可以作为一个整体分片。

现在发现并不是这样。

### 但我不建议立刻把 Cell 删除

Cell 还有一个比较明确的作用：

```text
Temporal Task Queue
        ↓
Pi Worker Pool
```

也就是说它现在可以退化成一个 **Worker shard**：

```text
Cell A
= Task Queue A + Worker Pool A

Cell B
= Task Queue B + Worker Pool B
```

这样可以做故障域、版本发布、Worker backlog 隔离。

但是如果目标只是 **1000+ active Agent Loops 的中型企业部署**，我开始觉得：

```text
8 Cells
```

很可能也过重。

假设以后压测出来：

```text
1 Pi Worker Pod
= 32 active loops
```

那么 1000 active：

```text
≈ 32 Pods
```

一个普通 Kubernetes Deployment / StatefulSet：

```text
Pi Worker Pool
min 4
max 48
```

就完全能够解决。

此时再人为分：

```text
8 Cells × 4 Worker
```

反而引入：

```text
Workspace 固定 Cell placement
Task Queue 数量增加
Cell capacity skew
Workspace migration
Cell draining
跨 Cell 运维逻辑
```

这些复杂度。

### 我现在更倾向的架构

把主要拓扑简化成：

```text
Global Plane
├─ Control Plane
├─ Temporal
├─ PostgreSQL
├─ Event Gateway
└─ Model Gateway

Pi Execution Pool
├─ Worker 1
├─ Worker 2
├─ ...
└─ Worker N
       ↑
 Temporal 一个主 Task Queue

Sandbox Domain
├─ Tool Broker
├─ Data Mover
└─ Cube compute pool
      ├─ microVM
      ├─ microVM
      └─ ...
```

然后：

```text
Pi Worker Pool
独立扩缩容

Cube compute
独立扩缩容
```

这是最符合实际资源模型的。

---

Cell 真正值得留下来的场景，我觉得反而不是“1000 active Run”，而是以后出现了更强的**隔离需求**：

```text
Cell US-West
Cell US-East

或者

Cell GPU
Cell CPU

或者

Cell stable-v1
Cell canary-v2

或者

Cell tenant-dedicated
Cell shared
```

这时候 Cell 表达的是：

> **placement / fault / compatibility domain**

而不是：

> **为了撑住几十个 Agent Loop，我再开一个 Cell。**

这两个概念差异很大。

所以目前我会把结论定成：

> **Cell 本身未必错，但把 Cell 当成 AgentDock 的基础水平扩展单位，很可能是设计过头了。**

你最新代码把 Sandbox Domain 从 Cell 里拆出来已经是正确的一步；下一步我甚至会考虑把 **Workspace → Cell immutable placement** 这件事也弱化掉，让绝大多数部署默认只有 **1 个 Cell / Worker Pool**，只有真的需要故障域、地域、版本或租户隔离时才增加 Cell。

这样这个抽象就会合理很多。

## 071 · User · 2026-08-12T05:05:44.755Z

嗯，那具体是怎么弱化呢

## 072 · Assistant · 2026-08-12T05:05:47.512Z

我会分成两层来弱化，而且**先做低风险版本，不要马上把 Cell 整套删掉**。

现在最重的一点其实是：

```text
Workspace
   ↓ 永久绑定
cell_id
   ↓
Temporal Task Queue
   ↓
只能由这个 Cell 的 Pi Worker 执行
```

最新代码里 `execution_cells` 仍然保存 `temporal_task_queue`、`sandbox_domain_id` 等，而 Workspace placement 还是 Cell 级 immutable。

我认为第一步最简单：

> **把 Cell 从“Workspace 的永久归属”弱化成“Pi Worker Pool 的调度标签”。**

也就是说理想上变成：

```text
Workspace
├─ sandbox_domain_id = domain-1
└─ 不关心 Pi Worker 在哪个 Cell

Run
   ↓
选择一个 Worker Pool
   ↓
Temporal Task Queue
   ↓
任意 Pi Worker
```

为什么现在已经可以这么做？

因为真正需要 locality 的东西已经不在 Cell 里了：

```text
Pi Session checkpoint → S3
Workspace durable state → Sandbox Domain / Kopia
Tool execution → Sandbox Domain
Cube → Sandbox Domain
```

而 Pi Worker 本身已经是：

```text
拿 checkpoint
↓
恢复 AgentSession
↓
跑这一轮
↓
dispose
```

任何健康 Worker 理论上都能恢复。你的架构文档本身也明确说 Worker 可以通过 committed Pi checkpoint 恢复 Session。

所以没有很强的理由要求：

```text
Workspace A 永远只能去 Worker Pool 3
```

---

具体数据模型我甚至会从：

```text
workspaces
  cell_id NOT NULL
```

逐渐变成：

```text
workspaces
  sandbox_domain_id NOT NULL
```

然后 Run 创建时：

```text
Run
↓
Placement Policy
↓
选择 worker_pool
↓
task_queue
```

比如默认只有：

```text
worker_pool = shared
task_queue = agent-dock-pi-runs-v1
```

1000 个 Run 全部扔进去。

Temporal 自己做：

```text
Worker 1 poll
Worker 2 poll
Worker 3 poll
...
Worker 40 poll
```

谁空谁拿。

这样 Cell 的大量复杂度就直接消失了：

```text
assigned_workspaces
capacity_weight
Workspace Cell rebalance
drain Cell 后迁 Workspace
新增 Cell 不 remap 老 Workspace
Cell backlog skew
```

这些都不再属于普通部署的核心路径。

---

但我**不会立刻删除 Cell 概念**。

我会把它降级成一个高级 placement constraint。

例如以后真的出现：

```text
美国节点：
cell-us

新加坡节点：
cell-sg
```

或者：

```text
稳定版 Worker：
cell-stable

新 Pi 版本：
cell-canary
```

或者：

```text
共享 Worker：
cell-shared

金融部门专属 Worker：
cell-finance
```

此时 Workspace / Tenant 可以有：

```text
placement_policy = "us"
```

然后：

```text
Run
↓
Placement Resolver
↓
eligible worker pools:
[cell-us-1, cell-us-2]
↓
选一个 queue
```

注意这里已经不是：

> Workspace 属于 Cell。

而是：

> **Workspace 对执行位置有约束，Run 在满足约束的 Worker Pool 里动态调度。**

这个模型会自然很多。

---

所以如果让我改你现在的概念，我甚至会把名字拆开：

```text
现在：
Execution Cell
= Workspace placement
+ Worker Pool
+ Temporal Queue
+ Sandbox Domain route
+ capacity

以后：

Worker Pool
= Pi Worker + Temporal Task Queue

Sandbox Domain
= Cube / Tool / Workspace execution domain

Placement Policy
= 决定 Run 可以去哪些 Worker Pool / Sandbox Domain

Cell
= 可选的更高层故障域/地域域
```

这样职责就干净了。

而且我建议你**先别做大迁移**。最现实的第一版弱化甚至只需要：

```text
默认部署：
cellCount = 1
```

让：

```text
cell-0001
= shared Pi Worker Pool
```

保留现有 schema 和代码。

先把 Worker capacity 从现在的 `4` 压测到：

```text
8
16
32
64
```

如果最后证明一个 Cell 就能轻松承载 1000+ active loop，那么再去掉 `Workspace → Cell immutable` 这条约束。

这比现在立刻重构数据模型风险小很多。

我觉得**真正应该优先验证的不是“Cell 怎么重构”，而是“一个 Pi Worker Pod 到底能安全承载多少 active AgentSession”**。这个数字一出来，Cell 应该弱化到什么程度基本就明朗了。

## 073 · User · 2026-08-12T05:49:47.112Z

我理解workspace就是一个目录，是这样吗？那为什么会有归属呢，归属为cell而不是某一台物理机吗？

## 074 · Assistant · 2026-08-12T05:49:52.405Z

对，**从用户视角看，Workspace 基本就是一个长期存在的 `/workspace` 目录**。不过在你的系统里更精确一点，它是：

```text
Workspace
= 一个逻辑目录身份
+ 当前 committed revision
+ 对应的持久化 checkpoint
```

而不是某台机器上的一个固定物理目录。

你现在的运行方式大致是：

```text
Workspace A
  current revision = R17
  durable bytes = Kopia / object storage

某次 Run 开始
       ↓
找一台 Pi Worker
       ↓
需要 Tool
       ↓
Cube 启动
       ↓
把 Workspace R17 materialize 到
Cube 的 /workspace
       ↓
修改文件
       ↓
Run settlement
       ↓
生成 R18
       ↓
Workspace head → R18
```

所以真正长期存在的是：

```text
Workspace ID + revision history + checkpoint
```

那个 `/workspace` 的 POSIX 目录只是它在某次执行期间的**物化副本**。

---

### 那为什么以前会有 `Workspace → Cell` 归属？

不是因为：

```text
Workspace 目录就在 Cell 3 某台机器硬盘上
```

**完全不是。**

它是一个**逻辑 placement 归属**：

```text
Workspace A
    ↓
cell_id = cell-3
```

表示：

> “这个 Workspace 的 Run 默认由 Cell 3 这一组执行资源处理。”

于是：

```text
Workspace A
  ↓
Cell 3
  ↓
Temporal Task Queue 3
  ↓
Cell 3 任意 Pi Worker
```

所以是绑定**一组机器/一个 Worker Pool**，不是绑定某台物理机。

为什么绝对不能绑物理机其实很简单：

```text
Worker Node 17
    ↓
宕机 / K8s 驱逐 / 升级 / 扩缩容
```

如果 Workspace 真归属于 Node 17：

```text
Node 17 没了
→ Workspace 也没了
```

那 Cloud Agent 就没法做 HA 了。

正确设计一定是：

```text
逻辑 Workspace
≠
物理机器
```

机器随时可以替换。

---

### 而现在最新架构里，这个 `cell_id` 更显得有点奇怪了

因为以前 Cell 同时带着：

```text
Pi Worker Pool
Sandbox Manager
Workspace storage
Cube route
```

所以：

```text
Workspace → Cell
```

还有“数据和执行 locality”的意味。

但你刚刚的最新重构已经把：

```text
Sandbox Manager
Workspace storage
Cube
```

从 Cell 拆出去了，变成共享的 **Sandbox Domain**。

现在实际上是：

```text
Workspace A
   ↓
Cell 3
   ├── Temporal Queue 3
   └── Pi Worker Pool 3

Cell 3
   ↓
Sandbox Domain 1

Sandbox Domain 1
├── Tool Broker
├── Data Mover
├── Workspace storage
└── Cube compute
```

也就是说，**Workspace 的真正文件数据已经不属于 Cell 3 了。**

Cell 3 主要决定：

```text
哪个 Pi Worker Pool 跑它
```

而已。

这正是我们刚才说“Workspace → Cell immutable placement 可以弱化”的根本原因。

---

我现在甚至觉得可以用两个概念把它彻底想清楚：

```text
Workspace home
= Sandbox Domain

Run placement
= Pi Worker Pool
```

例如：

```text
Workspace A
    ↓
sandbox-domain-1
    ↓
这里保存 / 恢复 / 执行它的文件世界
```

但某一轮 Run：

```text
Run 101 → Worker Pool A
Run 102 → Worker Pool B
Run 103 → Worker Pool A
```

理论上都可以。

因为 Worker 本身不保存 Workspace，它只是：

```text
恢复 Pi context
调用模型
需要 Tool 时访问 Sandbox Domain
```

所以现在的问题已经很明显了：

> **Workspace 确实应该有“存储/执行域”的归属，但未必应该有“Pi Worker Cell”的永久归属。**

换句话说，我现在认为：

```text
Workspace → Sandbox Domain
```

很合理；

而：

```text
Workspace → Pi Worker Cell
```

越来越像一个可以去掉的历史设计。

## 075 · User · 2026-08-12T05:56:35.342Z

诶我突然有个问题啊，我们之前因为流式输出文本给前端，做了一个设计，就是流式输出组提交到pgsql，但是咱现在改为kafka+valkey的方式，现在代码里还有组提交吗

## 076 · Assistant · 2026-08-12T06:00:01.232Z

有，而且**现在代码里“组提交”还非常明确地存在**，类名就叫 `GroupedDurableEventIngestor`。不过它和以前的含义已经不完全一样了。

现在大概有三层聚合：

```text
LLM 流式 delta
   ↓
① 文本 coalesce
   最多 50ms / 2KiB
   ↓
Worker WAL
   ↓
② 单 Session batch
   最多 20ms / 64 events / 512KiB
   ↓
event.publish_batch
   ↓
③ 跨 Session group
   默认最多等 4ms / 64 publications / 8 shards
   ↓
一次 ingestGroup(...)
```

架构文档明确保留了前两层：相邻 text delta 先 coalesce，然后 `BatchedEventPublisher` 再把连续 event 批量发送。  
代码里 `BatchedEventPublisher` 默认就是 `20ms / 64 events / 512KiB`，一次 batch 只拿一个 cumulative ACK。

而你之前说的 **“多个 Session 一起 group commit”** 也还在：

```ts
new GroupedDurableEventIngestor({
    store: ...
})
```

默认：

```text
8 shards
maximumGroupSize = 64
maximumDelayMs = 4ms
```

它会把不同 Session 的 publication 聚起来，然后：

```ts
store.ingestGroup([...])
```

一次提交。

### 但现在最大的区别是：PG 不再存流式 payload

以前大致是：

```text
Worker events
   ↓
group
   ↓
PostgreSQL transaction
   ↓
session_events
   ↓
ACK
```

现在生产 Kafka 模式变成：

```text
Worker events
   ↓
batch / group
   ↓
Event Gateway
   ↓
PG transaction:
    锁 Session / cursor / lease
    做 fence + seq 校验
   ↓
Kafka producer.send(...)
acks=all
   ↓
PG 只更新：
last_persisted_seq
acknowledged_through_seq
next_event_seq
   ↓
commit
   ↓
ACK Worker
```

真正的 event payload **只进 Kafka，不再先写 PG payload Outbox，也不再在 ingest 阶段写 `session_events`**。当前迁移甚至直接 `drop table worker_event_outbox`。

当前 `DurableEventStore` 代码非常明确：

```ts
if (!externalWorkerEventLog) {
    INSERT session_events ...
} else {
    await workerEventLog.append(batches)
}
```

然后统一批量更新 PG cursor。

所以准确地说：

> **组提交还在，但从“批量把流式文本写入 PostgreSQL”，变成了“批量做 Kafka durable append + PostgreSQL 轻量 cursor/authority commit”。**

Kafka 后面再：

```text
Kafka
 ↓
Projector
 ↓
Valkey Stream
 ↓
PG 更新 last_projected_seq + Kafka offset
 ↓
SSE 才允许看到
```



---

不过我刚看代码时发现一个值得继续讨论的点：

**当前 `DurableEventStore` 是在 PostgreSQL transaction 里面，持有 Session/cursor/lease 的 `FOR UPDATE` 锁，然后 `await Kafka acks=all`。**

也就是现在实际上：

```text
BEGIN PG TX
↓
锁最多一组 Session
↓
await Kafka
↓
更新 cursor
↓
COMMIT
```

这和之前我们想避免“网络 I/O 卡住 PG transaction”的方向有点冲突。

所以我觉得接下来值得问的已经不是“组提交还在不在”——**确实还在**——而是：**换成 Kafka-first 以后，这个跨 Session `GroupedDurableEventIngestor` 还有没有必要保留，以及 Kafka ACK 到底该不该放在 PG transaction 里面。**这块我感觉现在是可以继续简化的。

## 077 · User · 2026-08-12T06:03:19.126Z

嗯，深入看看既然有kafka了，还需要组提交吗，大量细碎文本会给kafka带来压力吗，但其实我觉得如果1000+active run级别，好像不是太大压力啊，甚至挺轻松的

## 078 · Assistant · 2026-08-12T06:06:12.509Z

我深入看下来，**你的直觉基本是对的：1000+ active run 这个量级，Kafka 本身大概率不是需要“应用层跨 Session 组提交”才能救得动的东西。**

但这里最好把“组提交”拆成三层，因为其中有两层我认为应该保留，只有最后一层值得质疑。

现在实际是：

```text
LLM delta
  ↓
① text coalesce
   50ms / 2KiB
  ↓
Worker WAL
  ↓
② per-Session event batch
   20ms / 64 events / 512KiB
  ↓
event.publish_batch
  ↓
③ cross-Session GroupedDurableEventIngestor
   4ms / 64 publications / 8 shards
  ↓
Event Gateway
  ↓
PG TX + Kafka acks=all
```

前两层和第三层的意义完全不同。当前代码就是这么实现的。  

### Kafka 到底会不会被细碎文本打爆？

先算一个相当激进的上界。

你现在 text delta 最多每 **50ms** 形成一个 event，所以单个正在持续输出模型文本的 Run：

```text
1000ms / 50ms
≈ 20 events/s
```

极端假设 **1000 个 Run 同时都在模型输出**：

```text
1000 × 20
= 20,000 logical events/s
```

实际上 active Run 并不等于正在吐 token：

```text
1000 active
├─ 一部分 await LLM
├─ 一部分 LLM streaming
├─ 一部分 await Tool
├─ 一部分 Tool running
└─ 一部分 settlement
```

所以真实 steady-state 很可能只是几千 event/s。

即使按比较夸张的平均每个 event envelope `0.5~2KB` 粗算：

```text
20k events/s
≈ 10~40 MB/s raw
```

而你 Kafka producer 现在还开了 GZIP。

**这个流量本身并不可怕。**

Kafka 真正不喜欢的是：

```text
大量 tiny record
+
每个 record 单独一次 ProduceRequest
```

而 Kafka producer 本来就专门解决这个问题。Apache Kafka 官方文档明确说明 producer 会按 partition 把相邻 record 合并成 batch；librdkafka 也默认会等待大约 5ms 聚合消息，提高吞吐并减少 Produce Request。

而你用的 `@confluentinc/kafka-javascript` 底层就是 librdkafka 这一套机制。

所以现在：

```text
你自己跨 Session 等 4ms
↓
GroupedDurableEventIngestor

Kafka producer 自己又等/聚合约 5ms
↓
producer batching
```

确实有点：

> **应用层自己又实现了一次 Kafka 已经有的 batching。**

---

### 所以① text coalesce 要不要留？

**强烈建议留。**

因为这不只是为了 Kafka。

如果你把模型原始 delta 全部当 event：

```text
"你"
"好"
"，"
"这"
"里"
...
```

即使 Kafka 扛得住，后面的：

```text
eventId
sequence
JSON encode/decode
WAL
Valkey XADD
SSE
浏览器处理
hash
replay
```

都会被放大。

现在 50ms / 2KiB：

```text
很多 token delta
↓
一个 assistant.text.delta event
```

这是合理的**语义粒度控制**。

我不会删。

---

### ② Worker 的 20ms batch 呢？

我也倾向保留。

因为它解决的是：

```text
Worker WAL
↓
一次 transport
↓
一个 cumulative ACK
```

不是单纯 Kafka throughput。

它让：

```text
seq 101
seq 102
seq 103
...
```

形成一个连续 publication。

Worker 只需要知道：

```text
acknowledgedThroughSeq = 110
```

然后一次删掉 WAL prefix。

这个 durable spool + cumulative ACK 模型很干净。

---

### 真正值得删的是③：跨 Session `GroupedDurableEventIngestor`

我现在比较明确地倾向于：

> **Enterprise Kafka 模式下，最终应该删除这一层。Local PostgreSQL 模式可以继续保留。**

因为它最早是为了这个问题产生的：

```text
Session A event
Session B event
Session C event
...
↓
如果每个都 COMMIT PG
↓
PG fsync / transaction overhead 太高
```

于是：

```text
A + B + C + ...
↓
一个 PG transaction
```

非常合理。

但是现在 payload 已经不写 PG 了。

Kafka 才是第一 durable payload boundary。

更重要的是，你现在第三层 group 造成了一个我认为比“省几个事务”更难看的行为：

```text
BEGIN PostgreSQL TX

FOR UPDATE
Session A
Session B
Session C
...
最多几十个 Session

       ↓

await Kafka acks=all

       ↓

更新 cursor
COMMIT
```

当前代码确实在持有这些 Session/cursor/lease locks 的事务里面调用：

```ts
await this.#workerEventLog!.append(batches);
```

也就是等 Kafka。

这意味着：

```text
Kafka 一次抖 50ms

不只是 Kafka latency +50ms

而是：
几十个 Session 的 PG row locks
一起多占 50ms
```

这才是现在设计里让我最不舒服的地方。

---

所以我觉得真正正确的演进，不是简单：

```text
group commit OFF
```

而是进一步变成：

```text
Worker

50ms text coalesce
↓
20ms per-Session batch
↓
Event Gateway
↓
Kafka producer
    ↓
Kafka 自己跨 Session / partition batching
    ↓
acks=all
↓
ACK Worker
```

然后：

```text
Kafka
↓
Projector
↓
Valkey
+
PostgreSQL last_projected_seq / offset
↓
SSE
```

也就是说：

> **让 Kafka producer 自己负责“跨 Session 的物理 batching”。**

应用层只负责：

```text
一个 Session 内的语义 batching
```

这会非常自然。

Apache Kafka 本身就是这么设计 producer 的：每个 partition 有 buffer，record 接近时自动组成 batch；`linger.ms` 控制最多等待多久积累 batch。

---

这里唯一不能草率删掉的是 **PG fence / sequence 校验**。

你现在 PG transaction 不只是为了 group commit，它还在做：

```text
lease 是否 current
fence 是否 current
command 是否 acknowledged
seq 是否连续
eventId 是否冲突
```



所以如果我们真要进一步简化，应该把问题变成：

```text
Kafka ingest
是否真的需要修改 PG？

还是只需要：
验证 Attempt / Lease / Fence
→ Kafka durable
```

甚至更进一步：

```text
Kafka record 本身携带

commandId
leaseId
fencingToken
sessionId
seq

↓
Projector

根据 durable Attempt history
验证这条 event 是否属于合法 execution
↓
合法
→ Valkey + projected cursor

非法
→ reject / quarantine
```

这样 PG 就完全退出**高频 ingest payload path**。

---

我现在其实更倾向这种最终状态：

```text
                         Hot path

Pi
↓
50ms text coalesce
↓
Worker WAL
↓
per-Session batch
↓
Kafka
↓
Valkey
↓
SSE


                         Control state

PostgreSQL
├─ Run
├─ Attempt
├─ Lease
├─ Fence
├─ last_projected_seq
└─ terminal Turn
```

这比现在：

```text
Worker
↓
跨 Session group
↓
PG locks
↓
Kafka
↓
PG
↓
Valkey
↓
PG
```

要漂亮不少。

---

还有一个很有意思的事情：**Kafka 可能甚至不是这条链上第一个遇到压力的组件。**

你现在 Valkey 是：

```text
一个 logical event
→ 一个 XADD Stream entry
```



所以如果真有：

```text
20,000 logical events/s
```

Kafka producer 可以把很多小 record 装进大的 network batch。

但 Valkey 最终仍然要产生：

```text
20,000 Stream entries/s
```

然后还有：

```text
JSON
SHA256
Lua
XADD
replay
trim
```

所以真正做 1000+ active benchmark 时，我反而会重点盯：

```text
Kafka records/s
Event Gateway CPU
PG transaction/lock wait
Valkey XADD/s + memory
SSE delivery latency
```

而不是先担心 Kafka bandwidth。

你仓库现在那个 Kafka acceptance 只测到了 16,384 logical events、约 2,540 event/s，而且报告自己明确注明 **不是 capacity claim**；所以它不能用来证明 20k/s，但同样也不能说明 Kafka 到 2.5k 就到顶了。测试脚本本身主要是在验证 Session ordering。 

### 我现在的建议

| 层 | 我的判断 |
|---|---|
| 50ms / 2KiB text coalesce | **保留** |
| Worker 20ms per-Session batch | **保留** |
| 4ms cross-Session GroupedDurableEventIngestor | **Enterprise 模式倾向删除** |
| Kafka producer batching | **直接利用** |
| PG payload/event Outbox | **已经删掉是对的** |
| PG 锁内等待 Kafka ACK | **下一步最值得去掉** |

所以我跟你的判断差不多：

> **1000+ active Run 对 Kafka 来说不像是一个需要非常复杂应用层 batching 才能支撑的规模。**

当前这一层组提交的主要价值已经从“保护 Kafka”退化成了“降低 PostgreSQL transaction 次数”。如果进一步让 PG 退出 Worker event ingest 的高频路径，**跨 Session group commit 基本就没有存在的必要了。**

而且从架构整洁度看，我认为这是比继续优化 Cell 更值得改的一处。

## 079 · User · 2026-08-12T06:13:10.167Z

你一下子讲太多了，我看不出重点啊

## 080 · Assistant · 2026-08-12T06:13:14.633Z

重点就两个：

1. **Kafka 不怕 1000+ active run 这个量级。**  
   现在 50ms 一次文本合并、20ms 一次单 Session batch，这两层保留就够了。

2. **真正可以考虑删的是“跨 Session 的 4ms 组提交”。**  
   它以前主要是为了减少 PostgreSQL transaction 次数；现在 payload 已经进 Kafka 了，这层价值明显变小。

所以我现在的倾向是：

```text
保留：
text coalesce
→ per-Session batch
→ Kafka

考虑删除：
跨 Session group commit
```

但有一个前提：**先把现在“PG 事务里等 Kafka ACK”这件事处理掉。**

我们下一步只聊这个问题：为什么现在还要在 PG transaction 里等 Kafka。

## 081 · User · 2026-08-12T06:16:25.691Z

50ms 一次文本合并、20ms 一次单 Session batch ，这两个是干嘛的，还有为什么现在还要在 PG transaction 里等 Kafka 。我之前看到说现在pgsql里有一个游标，游标又是干嘛的，pgsql现在应该只记录完整文本吧

## 082 · Assistant · 2026-08-12T06:16:50.937Z

对，你最后一句理解基本对：**企业 Kafka 模式下，PostgreSQL 已经不存每一小段流式文本了。**它主要存完整 Turn 的最终投影，以及一些“流处理进度数字”。

先把 50ms 和 20ms 区分开：

```text
模型原始输出：
"你" → "好" → "，" → "我" → "是" ...

        ↓ 50ms 文本合并

assistant.text.delta:
"你好，"
"我是..."
```

**50ms 合并是在减少“逻辑 event 数量”**。模型可能一次只吐几个字符，没必要每几个字符都变成一个正式 event。最多等 50ms 或累计到 2KiB 就形成一个 event；遇到 Tool/message 边界立即 flush。

然后：

```text
event 101
event 102
event 103
...

        ↓ 最多等 20ms

event.publish_batch
[101,102,103,...]
```

**20ms batch 是减少网络发送和 ACK 次数。**这些 event 已经是独立逻辑事件，并且已经落进 Worker 本地 WAL；只是一次打包最多 64 个/512KiB 发出去，然后收到一个累计 ACK，例如“已经 durable 到 seq=120”。

所以一句话：

> **50ms 是“把碎字符合成 event”；20ms 是“把多个 event 打包发送”。**

---

然后你问的 **PostgreSQL 游标**。

假设这个 Session 已经产生：

```text
seq 1
seq 2
...
seq 100
```

PG 不需要保存这 100 条流式文本，但它需要记几个数字，例如：

```text
last_persisted_seq = 100
```

意思是：

> Kafka 已经可靠接收到 1~100，所以 Worker 可以认为它们不会丢。

之后 Kafka Projector 把数据写进 Valkey：

```text
last_projected_seq = 97
```

意思是：

> 目前只有 1~97 已经进 Valkey，可以安全给浏览器看；98~100 虽然 Kafka 已经有了，但暂时不能显示。

所以游标本质就是**水位线**：

```text
Kafka durable 到哪里？
Valkey projected 到哪里？
浏览器最多可以看到哪里？
```

这正是你要的那个关键约束：

> **用户看到的文本一定已经 durable。**

当前代码 SSE 只允许读取 `last_projected_seq` 以内的数据。

---

至于为什么现在 **PG transaction 里还要等 Kafka ACK**，原因是当前代码想保证：

```text
Kafka 确实 durable 到 seq=100
+
PG 游标也改成 100
```

两件事情一起成立以后，才 ACK Worker。

所以现在是：

```text
BEGIN PG

锁 Session / cursor
↓
检查 lease / fence / seq
↓
发 Kafka
↓
等待 Kafka acks=all
↓
PG cursor → 100
↓
COMMIT
↓
ACK Worker
```



这样非常保守：PG 绝不会写着“100 已 durable”，实际上 Kafka 只有 95。

但代价就是 **PG transaction 要等 Kafka 网络 I/O**。这也是我们刚才觉得可以继续优化的地方。

---

最后你说“PG 现在应该只记录完整文本吧”，基本正确，但稍微修正一下：

```text
流式过程中：

Kafka
→ 流式 event 的 durable payload

Valkey
→ 给 SSE 用的实时 event

PostgreSQL
→ cursor（水位）
→ Run / Turn / Attempt / Lease / Fence 等业务状态
```

等这一 Turn 完成后：

```text
Valkey 中这一轮完整流式内容
          ↓
组合成完整 Turn transcript
          ↓
PostgreSQL
```

所以 **PG 最终保存完整 Turn，而不保存这一轮过程中每一小块 text delta**。终态提交时还会和 Run/Turn/checkpoint 等一起原子提交。

我觉得理解到这里之后，下一个问题就很明确了：**这个 `last_persisted_seq` 真的还有必要在“每一批流式文本”时都同步写 PG 吗？**我现在觉得这件事非常值得质疑。

## 083 · User · 2026-08-12T06:30:28.540Z

PG 不需要保存这 100 条流式文本，但它需要记几个数字  。
什么叫pg需要记住几个数字，我理解kafka的数据流给valkey，那既然流给了valkey了，那说明数据已经持久化了，为什么还需要pgsql去记住这个数字呢

## 084 · Assistant · 2026-08-12T06:30:35.266Z

对，你这个疑问是成立的。**不是因为 PG 需要知道“文本存到哪了”，而是当前设计把 PG 游标当成了一个“Valkey 已投影到这里”的认证标记。**

比如：

```text
Kafka: 1 ... 100 已持久化
          ↓ projector
Valkey: 1 ... 100 已写入
```

其实到这里，从“文本有没有丢”这个角度，**已经够了**。Kafka 才是真正的 durable source，Valkey 是可重建的实时 read model。

现在又多做了一步：

```text
Valkey 写到 100
↓
PG.last_projected_seq = 100
```

然后 SSE 不是直接相信 Valkey，而是说：

```text
PG 说 projected 到 100
→ 我才允许前端读取 Valkey 的 1~100
```

它本质上是一个 **commit marker / 水位认证**。

### 为什么当初这么做？

主要是为了处理这种崩溃窗口：

```text
Valkey 已写到 100
↓
进程突然挂了
↓
PG 还停在 95
```

当前策略会非常保守：

```text
前端暂时只看 1~95

Kafka projector 重放
↓
Valkey 96~100 幂等确认
↓
PG cursor → 100
↓
前端再看到 96~100
```

这样绝不会出现“PG 认为已经投影好了，但 Valkey 实际没有”的情况。

而且 Turn 最终落 PG 时也会看这个游标：

```text
Worker 说：
这一轮 event 已 durable 到 seq=100

PG：
last_projected_seq 也必须到 100

满足
↓
才能提交完整 Turn
```

所以它其实是在连接两个世界：

```text
Kafka / Valkey 流式世界
       ↕
PG Run / Turn 业务状态世界
```

---

但是你问：

> **既然 Valkey 自己都知道 last_seq=100，为什么还需要 PG 再存一个 100？**

这就是关键。

**从纯数据流角度，不一定需要。**

Valkey 当前自己就维护 `last_seq` metadata。也就是说你完全可以：

```text
Kafka
↓
Valkey
  last_seq = 100

SSE
直接根据 Valkey last_seq 读取
```

PG 不必每批流式文本都跟着：

```text
95 → 98 → 100 → 104 → ...
```

不停更新。

所以我现在会区分：

> PG cursor **有作用**，它不是毫无意义；但在 Kafka + Valkey 已经成为独立 event plane 以后，**它是否值得为了这个作用进入每一批流式 event 的 hot path，是很值得质疑的。**

尤其你真正想要的持久化关系其实已经很简单：

```text
流式中：
Kafka = durable authority
Valkey = live replay/read model

Turn 完成：
PostgreSQL = 完整 Turn + 业务状态
```

从这个模型看，最自然的确实应该是：

```text
Kafka → Valkey → SSE

            Turn settle
                ↓
Valkey/Kafka 已完整
                ↓
PG 保存完整 Turn
```

而不是流式过程中 PG 每隔几十毫秒跟着记一个 `last_projected_seq`。

**所以你的直觉是对的：这个 PG 游标很可能是现在架构里可以继续删减的一层协调状态。**下一步我们可以只分析一个问题：如果把 `last_projected_seq` 从 PG 去掉，崩溃恢复和 Turn terminal commit 会不会真的出现漏洞。

## 085 · User · 2026-08-12T06:38:05.102Z

目前有没有可能出现流式输出已经输出完了，但是完整的message信息还没收到，这时候崩溃了，导致pgsql里面少存了一条完整信息，如果出现这种情况可以恢复吗

## 086 · Assistant · 2026-08-12T06:39:40.784Z

有这种可能，而且**当前设计是可以恢复“用户已经看到的完整文本”的**，但不能把这个 Turn 恢复成“成功完成”。

场景就是：

```text
LLM 的文本已经全部吐完
→ text delta 已进 Kafka
→ 已投影到 Valkey
→ 前端已经全部看见

但 Worker 还没走到：
agent_settled
→ 完整 Turn / checkpoint 提交 PG

这时 Worker 崩了
```

此时 PG 确实可能暂时还没有这条完整 Turn。

但 Kafka/Valkey 里面还有完整的流式事件，所以后面的 `AssignmentReconciler` 会把这个 Turn 判成：

```text
turn.failed
failure = assignment_lost
```

然后当前代码会调用 `TerminalTurnProjectionSource`，**重新从 Valkey 读取这一 Turn 的所有流式事件，拼成完整 transcript，再写进 PostgreSQL。**  

也就是：

```text
Kafka / Valkey
"你好"
"我检查了一下..."
"...问题在这里。"

        ↓ reconstruct

PG conversation_turn_projection
assistant:
"你好，我检查了一下……问题在这里。"

terminal:
turn.failed / assignment_lost
```

`commitTerminalTurnEvent()` 在生产模式下就是把这个重建好的 transcript 和 terminal event 一起落 PG。

所以结论是：

> **前端已经看到的文本不会因为 Worker 在最后一刻崩溃而永久丢失。可以从 Kafka→Valkey 的流式记录重建成 PG 完整 Turn。**

但有一点很重要：它不会被标记成 `turn.completed`。

因为虽然“字看起来已经吐完了”，平台不能证明 Pi 已经真正完成：

```text
agent_settled
checkpoint 成功
Workspace commit 成功
```

所以只能安全地记成：

```text
完整可见文本保留
+
Turn failed
```

我觉得这个语义是对的。

而且这也说明了一个很关键的事情：**Kafka 本身其实已经承担了“崩溃后重建完整 message”的能力。**PG 不需要在流式过程中保存完整文本。

## 087 · User · 2026-08-12T06:47:33.785Z

我可能需要多张信息流转图或者例子才能理解kafka,valkey,pgsql这三者，当发生我所述的情况时，在崩溃恢复时如何恢复完整信息

## 088 · Assistant · 2026-08-12T06:47:39.719Z

可以，先把三者只记成一句话：

```text
Kafka  = 流式事件的“持久化流水账”
Valkey = 给前端快速读取的“实时副本”
PG     = 最终业务事实：这个 Turn 最后是什么、完整消息是什么
```

当前生产链路就是 Kafka 先持久化，Projector 再写 Valkey；Turn 结束时再从 Valkey 组装完整 transcript 写入 PG。

### 图 1：正常流式输出时

假设模型最后回答：

> `文件已经修改完成。`

实际上可能产生：

```text
Pi Worker
│
│  event 101: "文件已经"
│  event 102: "修改完成"
│  event 103: "。"
▼
Kafka
│
│  101 ✓
│  102 ✓
│  103 ✓
▼
Projector
▼
Valkey
│
│  101 ✓
│  102 ✓
│  103 ✓
▼
SSE
▼
浏览器

文件已经修改完成。
```

注意一个非常重要的约束：

> **浏览器能看到 101～103，说明这些 event 已经先进入 Kafka，并且已经成功投影进 Valkey。**

不是 Worker 一吐字，浏览器就直接看见。当前代码明确规定只有已经投影到 live store 的 event 才进入 SSE。

这时候 PG 可能还是：

```text
Turn = running

完整 assistant message：
还没有
```

这完全允许。

---

### 图 2：正常结束时，PG 怎么得到完整消息

模型结束，Pi 完成 `agent_settled`。

此时不是 Worker 再另外给 PG 发一遍：

```text
"文件已经修改完成。"
```

而是系统会做：

```text
Valkey

101 "文件已经"
102 "修改完成"
103 "。"

        ↓
TerminalTurnProjectionSource

读取 101～103
        ↓
拼装

assistant:
"文件已经修改完成。"

        +
turn.completed
        ↓
PostgreSQL
```

也就是说：

```text
Kafka / Valkey 保存的是：

101
102
103
这些流式事实


PostgreSQL 最后保存的是：

assistant message:
"文件已经修改完成。"

Turn:
completed
```

当前 `LiveTerminalTurnProjectionSource` 确实会读取这一 Turn 在 Valkey 中的事件，然后调用 transcript projection 生成完整 Turn。

---

## 图 3：你问的故障窗口

现在就是这个情况：

```text
模型：
"文件已经修改完成。"

          ↓

Kafka
101 ✓
102 ✓
103 ✓

          ↓

Valkey
101 ✓
102 ✓
103 ✓

          ↓

浏览器已经显示：

文件已经修改完成。


          ↓

        💥

Pi Worker 突然 SIGKILL
```

这时候可能恰好：

```text
PostgreSQL：

Turn = running

完整 transcript：
还没有

turn.completed：
还没有
```

所以你担心的情况 **确实存在**。

但数据没有丢，因为真正重要的东西现在是：

```text
Kafka：
101～103 还在

Valkey：
101～103 还在
```

---

### 图 4：崩溃以后怎么补回 PG

Worker 死后，系统最后会发现这个 assignment 丢失。

于是：

```text
AssignmentReconciler

发现：

这个 Turn 已经开始执行
但是 Worker 消失了
而且没有正常 terminal commit

             ↓

判定：

turn.failed
reason = assignment_lost
```

然后它不会凭空制造 assistant message。

它会去调用 Terminal Projection：

```text
                  Valkey

        101 "文件已经"
        102 "修改完成"
        103 "。"

                    │
                    ▼
        TerminalTurnProjectionSource

                    │
             重新读取 101~103
                    │
                    ▼
              拼出 transcript

        assistant:
        "文件已经修改完成。"

                    +
        
        terminal event:
        turn.failed
        assignment_lost

                    │
                    ▼
               PostgreSQL
```

这条恢复路径当前代码里已经存在。Reconciler 会调用 `terminalTurnProjectionSource.prepare(...)`，然后把 prepared projection 交给 terminal commit。 

最终 PG 会变成：

```text
Turn:

assistant:
"文件已经修改完成。"

status:
failed

failure:
assignment_lost
```

而不是：

```text
assistant:
丢失
```

也不会错误地写成：

```text
status:
completed
```

---

### 用一个状态表看最清楚

崩溃发生的瞬间：

| 数据 | 状态 |
|---|---|
| Kafka 101～103 | ✅ 有 |
| Valkey 101～103 | ✅ 有 |
| 浏览器完整文本 | ✅ 已看到 |
| PG 完整 assistant message | ❌ 还没有 |
| PG `turn.completed` | ❌ 没有 |
| Pi 新 checkpoint | ❌ 可能没有 |

恢复之后：

| 数据 | 状态 |
|---|---|
| Kafka 101～103 | ✅ |
| Valkey 101～103 | ✅ |
| PG 完整 assistant message | ✅ 从 101～103 重建 |
| PG terminal state | ✅ `failed / assignment_lost` |
| 成功 checkpoint | ❌ 不会伪造 |

`commitTerminalTurnEvent()` 会把这个重建的 transcript 和 terminal event 一起写进 PG。

所以这里可以把三者想成：

```text
                Kafka
             原始事实账本
                  │
                  ▼
               Valkey
            实时可读的副本
             │         │
             │         └────→ 前端流式显示
             │
             ▼
     Turn 正常结束 / 崩溃恢复
             │
             ▼
        拼成完整 transcript
             │
             ▼
             PG
        最终业务记录
```

最关键的一句话是：

> **PG 里的完整 message 不是唯一副本。只要前端已经看到那段文本，当前设计下对应的流式事实已经在 Kafka/Valkey 里，因此即使 PG 还没来得及生成完整 message，也可以重新拼出来。**

还有一个细节：这能恢复**用户已经看到的完整文本**，但不能假装 Pi 已经正常 `agent_settled`。所以这个 Turn 最终会是 `failed`，下一轮 Agent 再通过恢复机制知道“上一轮中断了”。

## 089 · User · 2026-08-12T07:07:49.846Z

哦理解了，看起来挺合理的。那能讲讲valkey为什么能承担起作为前端读流式数据副本这个角色吧

## 090 · Assistant · 2026-08-12T07:07:54.943Z

可以。你可以先把 Valkey 理解成：

> **Kafka 的一个“专门为前端查询整理好的热缓存”。**

它适合这个角色，主要是因为 Kafka 和前端的读取方式其实不匹配。

假设某个 Session 有：

```text
seq 101  "我检查了"
seq 102  "这个文件"
seq 103  "，问题在..."
```

Kafka 很擅长：

```text
不断追加
长期保存
顺序消费
故障重放
```

但浏览器要的是：

```text
“我上次看到 seq=101，
现在把 102 之后的东西给我。”
```

这正是 Valkey Stream 很方便的地方。

你现在实际上把每个 Session 做成一个 Stream：

```text
agent-dock:live-events:{sessionId}:stream

101-0 → event 101
102-0 → event 102
103-0 → event 103
```

而且代码直接把 AgentDock 自己的 `seq` 当成 Valkey Stream ID，例如 `101-0`。

于是浏览器断线以后带着：

```text
Last-Event-ID: 101
```

Event Gateway 就可以很自然地问 Valkey：

```text
给我 (101, current] 之间的数据
```

本质上就是一次范围读取：

```text
XRANGE
102-0
...
```

这比从 Kafka 给每个浏览器维护 consumer 要简单得多。

---

另外 Valkey 非常快。

典型链路：

```text
Kafka
  ↓
Projector
  ↓
Valkey
  ↓
Event Gateway
  ↓
SSE
  ↓
Browser
```

前端每次连接、重连、翻 replay window，读的是 Valkey 这种内存型数据结构，而不是去扫 Kafka。

所以职责分工很清楚：

```text
Kafka
= 写优化、持久化、重放

Valkey
= 读优化、低延迟、随机范围读取
```

---

还有一个很重要的点：**Valkey 丢了也没关系。**

比如：

```text
Kafka:
1 ... 10000 都在

Valkey:
突然整个挂了
数据没了
```

它不是 authority。

重新启动以后：

```text
Kafka
↓ replay
Projector
↓
重新建立 Valkey Stream
```

即可。

所以 Valkey 承担这个角色风险不大，因为：

> **Valkey 是可重建的 projection，不是唯一副本。**

这和我们平时：

```text
MySQL → Elasticsearch
```

很像。

MySQL 是事实源，Elasticsearch 是为了查询方便建的 projection。

你这里是：

```text
Kafka → Valkey
```

Kafka 是流式事实源，Valkey 是为了 SSE 查询方便建的 projection。

---

你当前实现甚至还专门做了顺序保护。

如果 Valkey 当前：

```text
last_seq = 102
```

突然来了：

```text
104
```

没有 103，它不会直接接受，而是报：

```text
live_event_sequence_gap
```

重复收到 102，也会检查 digest；内容一致才认为是合法重放，否则 fail closed。

所以最终可以把它记成：

```text
             Kafka
        持久化流水账
             │
             │ project
             ▼
            Valkey
       前端实时读取副本
        │            │
     XRANGE       Last seq
        │            │
        └─────┬──────┘
              ▼
        Event Gateway
              ▼
             SSE
              ▼
           Browser
```

**Kafka 解决“不能丢”，Valkey 解决“怎么方便、快速地给前端读”。**

这就是它在当前架构里的核心价值。

## 091 · User · 2026-08-12T07:25:06.715Z

诶，那这样如果我打开一个历史会话，是会从pgsql里读还是从valkey里读呢

## 092 · Assistant · 2026-08-12T07:25:09.437Z

**历史会话主体应该从 PostgreSQL 读，Valkey 只负责“尚未归档成完整 Turn 的实时尾巴”。**

可以这样理解：

```text
打开历史会话
   ↓
PostgreSQL
   ↓
读取已经 terminal 的完整 Turns
   ↓
直接渲染历史消息
```

因为一个 Turn 正常结束后，系统已经把这一轮的完整 transcript 存进 PG 的 conversation projection 里了。Valkey 中那些细碎的流式 event 只是临时 live replay 数据，后面还会按 retention 做清理。当前 terminal commit 就会把完整 transcript 写进 PostgreSQL，并安排 live stream compaction。

Valkey 主要是在这种情况下参与：

```text
你打开会话时
某个 Turn 还正在 running
```

那么页面可能是：

```text
PG
↓
历史完整 Turns
例如：
Turn 1
Turn 2
Turn 3

        +

Valkey
↓
当前 Turn 4 的实时 event
"我正在检查..."
"发现..."
```

也就是说最终 UI 是：

```text
PostgreSQL 历史
+
Valkey live tail
```

这正是当前架构里 `SSE merges the bounded live stream and terminal store` 的意思：Valkey 提供 non-terminal deltas，PostgreSQL 提供已经完成的 terminal Turns。

所以你可以简单记成：

> **已经结束的消息看 PG；正在生成的消息看 Valkey。**

Kafka一般不会直接被“打开历史会话”这条用户请求读取。它是后台 durable log，用来给 Projector 重建 Valkey、做故障恢复。前端正常读路径不会去扫 Kafka。

## 093 · User · 2026-08-12T07:27:03.621Z

这样会不会有问题，例如用户发送了一条消息，此时正在流式输出，然后关闭了浏览器页面，再打开的时候，从pgsql里面读取历史会话，但此时还正在流式输出，你说这个时候还能续上流式输出吗

## 094 · Assistant · 2026-08-12T07:28:56.112Z

对，**当前代码已经专门处理了你说的这个场景，可以续上。**

举个最直观的例子。你关闭页面时：

```text
PG：
历史完整 Turn 到 seq=80

Valkey：
当前正在生成的 Turn
81 "我正在"
82 "检查代码"
83 "，发现..."
```

你关掉浏览器以后，Agent Loop **不会停**，继续输出：

```text
Valkey：
81
82
83
...
100
```

然后你重新打开这个会话。

第一步，前端先：

```text
GET /v1/conversations/{sessionId}
```

从 PG 拿历史，并且服务端会返回一个很关键的：

```text
replayAfterSequence = 80
```

前端当前代码确实会：

```ts
lastSequenceRef.current = detail.replayAfterSequence;
```

然后加载历史。

接着马上建立 SSE：

```text
GET /v1/sessions/{sessionId}/events

Last-Event-ID: 80
```

你前端现在不是浏览器原生 `EventSource`，而是自己用 `fetch` 发 SSE，所以可以显式带这个 header。

Event Gateway 看到：

```text
Last-Event-ID = 80
```

就会从 live stream 补：

```text
Valkey：

81
82
83
...
100
```

然后继续实时等：

```text
101
102
103
...
```

所以页面效果就是：

```text
PG
↓
加载已经完成的历史

seq 1~80

        ↓

Valkey / SSE
↓
补上关闭页面期间错过的

81~100

        ↓

继续实时接收

101...
```

也就是说，**关闭再打开不是“重新开始流式输出”，而是“先 replay 漏掉的部分，再无缝切回 live”。**

而且这个设计还解决了一个竞态。

假设你关闭页面的时候：

```text
PG 到 80
```

但是重新打开之前，当前 Turn 已经彻底完成了。

那重新 `getConversation()` 时，PG 可能已经变成：

```text
完整 Turn 已保存
replayAfterSequence = 105
```

于是页面直接从 PG 得到完整消息，然后：

```text
SSE 从 105 开始
```

不会再重复播放 81～105。

所以 `replayAfterSequence` 其实很好理解：

> **“这个历史快照已经包含到哪个 seq，SSE 从它后面继续。”**

你当前 Web UI 已经按照这个模型实现了。

这也是为什么 **PG + Valkey 两层读取并不会天然造成断层**：它们靠这个 sequence 边界拼接起来。

## 095 · User · 2026-08-12T07:34:23.390Z

不太懂你意思，
pgsql里有完整message，加一个replayAfterSequence = 80
用户可能已经看到流式输出81，82，83，84
而replayAfterSequence = 80只有当收到完整信息才会更新是吗，例如100的时候这条信息完成输出。
然后如果用户在流式输出88的时候关闭浏览器，再打开的时候假设序号已经到90了。那这个时候用户会看到浏览器从81开始从新流式输出到90吗

## 096 · Assistant · 2026-08-12T07:34:43.872Z

对，**你这个理解是对的**。

假设：

```text
PG 历史快照覆盖到 seq=80
replayAfterSequence = 80

当前 Turn 正在流式：
81 82 83 ... 88
```

用户在看到 88 时把整个浏览器页面关掉。此时浏览器内存里的：

```text
lastSequence = 88
```

也没了。

Agent 继续运行，Valkey 又到了：

```text
81 ... 90
```

用户重新打开这个会话时，当前前端会先从 PG 加载历史，然后：

```ts
lastSequenceRef.current = detail.replayAfterSequence;
```

也就是重新变成 `80`。

接着 SSE 请求：

```text
Last-Event-ID: 80
```

于是 Valkey 会把：

```text
81
82
83
...
90
```

**全部 replay 一遍**，然后继续接新的：

```text
91
92
...
```

前端 SSE 代码就是按这个 `last-event-id` 连的。

不过这里有个体验上的区别：**不会按原来的速度重新“打字”81～90。**

通常会是：

```text
打开页面
↓
PG 历史瞬间出现（到80）
↓
Valkey 81～90 很快 replay
↓
当前半截回答瞬间恢复到 seq=90 的状态
↓
91开始继续实时流式
```

所以用户可能感觉就是：

> 页面打开后，刚才那条回答立即恢复到目前已经生成的位置，然后继续往下输出。

而 `replayAfterSequence=80` 可以理解为：

> **“PG 这份完整历史已经包含到哪里。”**

正在流式的 `81~90` 不会让它每次跟着更新；等这一整个 Turn 最终完成并写成 PG 的完整 transcript 后，它才会整体前移到这个 Turn 的 terminal sequence。

还有一个区别：

```text
只是 SSE 短暂断线、页面没关
```

前端内存还知道自己已经看到 `88`，那就直接：

```text
Last-Event-ID: 88
```

只补 `89、90`。

**整个页面关闭再打开**，才会从 PG 的稳定边界 `80` 开始重放。

## 097 · User · 2026-08-12T07:45:33.078Z

瞬间是怎么个瞬间法，是valkey会把80-90的数据组一遍再发给前端吗？我觉得合理的体验应该是用户关闭了浏览器，再开启，然后他拿着sessionid去看valkey和pgsql，把pgsql的完整会话读出来，然后看一下现在最新的valkey seq是多少，把pgsql里面最新一条message和最新seq之间的流式数据组一遍发给前端。目前是这样的吗？还有我有个疑问，pgsql存message的时候会记录这条message对应的最后一个流式片段的seq吗，这个seq号来自llm的流式输出api吗，还是我们自己记录的一个seq号，可靠吗

## 098 · Assistant · 2026-08-12T07:48:47.590Z

对，你设想的体验我也觉得更自然。**但当前代码还不是“后端先把 81～90 拼成当前 message 快照再一次性给前端”**。

现在实际是：

```text
重新打开 session

1. GET conversation
   → PG 返回已经完成的完整 Turns
   → replayAfterSequence = 80

2. 建 SSE，Last-Event-ID = 80

3. Event Gateway 从 Valkey 读取 81~90

4. 按 81、82、83……90 一个个 SSE event 很快发给前端

5. 前端把这些 text.delta 重新拼成当前半截 message
```

`getConversation()` 遇到一个还没生成 canonical transcript 的 active Turn 时，代码会故意把 `replayAfterSequence` 退到**最近一个已经完成的 projection**，让 SSE 重放后面的 Kafka/Valkey events。

而 SSE 服务端当前确实是：

```text
81 → 一个 SSE frame
82 → 一个 SSE frame
...
90 → 一个 SSE frame
```

不是先组合成一条。

所以你说的方案：

```text
PG：完整历史到 80
+
Valkey：81~90

        ↓

后端先拼

当前 assistant message:
"……目前已经生成到90"

        ↓

一次给前端

然后从 91 开始 live streaming
```

**目前不是这样。**

我反而觉得这个体验可以优化，而且不一定非要改后端。前端建立 SSE 时可以知道“我正在 replay 历史尾巴”，先在内存里快速 reduce 81～90，追到当前 high-water 后**一次 render**，然后 91 开始正常逐段渲染。这样协议仍然保持 event replay，UI 又不会出现重新打字的感觉。

---

你第二个问题更关键：**这个 seq 是我们自己的，不是 LLM API 给的。**

LLM 可能吐：

```text
"你"
"好"
"，"
"我"
...
```

经过我们前面的 50ms coalesce 后形成：

```text
assistant.text.delta "你好，"
assistant.text.delta "我..."
```

然后 AgentDock 自己给这些 event 编：

```text
seq = 81
seq = 82
```

不仅 text 有 seq，Tool 等 event 也占同一个序列：

```text
81 assistant.text.delta
82 assistant.text.delta
83 tool.started
84 tool.completed
85 assistant.text.delta
86 turn.completed
```

`seq` 是 `AgentDockEvent` 自己的公共字段，event factory 内部维护递增 sequence。 

所以它不是：

> “LLM 第 81 个 token”

而是：

> **“这个 Session 的第 81 个 AgentDock 公共事件”。**

---

而且 PG 里的完整 message **确实保存了它对应的 seq 范围**。

比如：

```text
81 "文件已经"
82 "修改完成"
83 "。"
84 turn.completed
```

最终 PG transcript 里面的 text item 会是类似：

```text
kind: text
text: "文件已经修改完成。"
firstSequence: 81
lastSequence: 83
```

整个 Turn transcript 则有：

```text
throughSequence: 84
terminalSequence: 84
```

当前 projection 代码就是在不断追加 text 时，同时更新 `lastSequence = event.seq`。

所以这里要区分：

```text
message.lastSequence = 83
```

表示：

> 这段 assistant 文本最后来自哪个流式 event。

而：

```text
transcript.throughSequence = 84
```

表示：

> 整个 Turn 已经处理到哪个 event，包括最后的 `turn.completed`。

---

至于这个 seq **可靠吗？**

我认为可靠，因为它不是只靠 Worker 内存里 `+1`。

整个链路都在检查它：

```text
Worker：
81 → 82 → 83

Kafka：
同 Session 用 sessionId 做 partition key，保持顺序

Valkey：
如果当前是 82
突然来了 84
→ sequence_gap，拒绝

SSE：
如果前端看到 82
下一条直接是 84
→ 认为有 gap，重新恢复

PG：
terminal commit 前也检查 event cursor 必须连续
```

所以它更像数据库里的 **LSN / log sequence number**：

> 我们自己定义的逻辑日志序号，用来把 PG 完整历史和 Valkey 实时尾巴严丝合缝地接起来。

我觉得你刚才提出的重新打开模型其实可以进一步简化成一句：

```text
PG transcript 的 throughSequence
        +
Valkey 当前 high-water sequence
```

这两个数字就足够确定：

> **“哪些已经包含在完整历史里，哪些还是正在生成的 live tail。”**

而且这里我觉得我们可能发现了一个值得改的小体验点：**当前恢复逻辑的数据正确性没问题，但 UI 恢复可以从“逐 event 快速 replay”改成“先聚合 replay tail，一次显示当前状态，再进入 live”。**

## 099 · User · 2026-08-12T07:55:05.275Z

你检查一下目前市面上大多数大模型厂商的llm api，看看他们吐出流式输出的频率是有固定的吗？

## 100 · Assistant · 2026-08-12T07:55:45.002Z

我查了 OpenAI、Anthropic、Gemini、DeepSeek，结论很明确：

> **主流 LLM API 基本都不承诺固定的流式输出频率。**

它们通常只保证“生成过程中持续返回 delta/chunk”，不会规定类似“每 20ms 一次”或“每个 chunk 恰好 1 token”。

比如 Anthropic 最直观。官方示例里的 `text_delta` 有时是 `"Okay"`，有时只是 `","`，有时又是 `" weather"`；而且官方明确说 Tool 参数生成期间可能出现较长的 event 间隔。也就是说 **chunk 大小和时间间隔都是可变的**。

OpenAI 的 Responses / Chat Completions 也是 SSE，描述是 response “as generated” 持续产生事件；它定义了各种 `delta` event 和顺序号，但**没有规定发送周期**。

Gemini 同样是 `streamGenerateContent`，官方定义为“as they are generated”返回 response chunks，也没有固定毫秒周期或固定 token 数。

DeepSeek 也是 SSE streaming；官方还会在等待调度期间发送 keep-alive，但没有给 streaming delta 一个固定 cadence。

所以实际可能长这样：

```text
0 ms    "我"
12 ms   "觉得"
18 ms   "这个"
75 ms   "设计"
78 ms   "是"
81 ms   "合理的"
160 ms  "。"
```

也可能：

```text
0 ms    "我觉得这个"
45 ms   "设计是合理的"
110 ms  "。"
```

甚至 Tool Call / reasoning 边界处暂停几百毫秒再继续，都属于正常现象。Anthropic 的官方文档就明确提醒某些 tool streaming 阶段会出现延迟。

这也意味着我们 AgentDock 里的：

```text
provider 原始 delta
        ↓
最多 50ms coalesce
        ↓
AgentDock assistant.text.delta
```

这个 **50ms 完全是我们自己定义的节流/归一化层**，不是跟着 LLM API 的频率来的。

它其实是在把不同厂商这种：

```text
OpenAI   一会儿碎、一会儿大
Claude   一会儿一个词、一会儿几个字符
Gemini   chunk 粒度自己决定
DeepSeek 同样如此
```

统一成我们自己的事件节奏。

所以你刚才问 seq 的事情也更清楚了：**不能拿 provider 的每个 chunk 当可靠的业务序号单位**，因为 provider chunk 本身就没有稳定粒度。AgentDock 自己 coalesce 后再产生 `seq=81,82,83...` 是更合理的。

## 101 · User · 2026-08-12T08:08:27.223Z

好吧，那咱这么设计还挺合理的

## 102 · Assistant · 2026-08-12T08:08:30.184Z

嗯，这部分我觉得是合理的，而且逻辑挺顺：

```text
厂商不稳定的原始 chunk
→ 50ms coalesce 统一粒度
→ AgentDock 自己编号 seq
→ Kafka 持久化
→ Valkey 做实时读副本
→ PG 保存最终完整 transcript
```

这样就把 **provider 的流式细节** 和 **我们自己的可靠事件协议** 解耦了。

真正还值得继续推敲的，反而是前面提到的那两个点：**跨 Session 的 group commit 是否还需要**，以及 **PG 游标是否还应该留在高频流式路径里**。

## 103 · User · 2026-08-12T08:10:19.343Z

嗯，可以review一下这两个点是否还需要

## 104 · Assistant · 2026-08-12T08:11:20.879Z

我 review 完以后，结论比刚才更保守一些：

**PG cursor：目前需要保留。**  
**跨 Session group commit：不是正确性必需，但目前还有性能价值，不建议现在直接删。**

原因分别是：

### 1. PG cursor 目前确实有用

现在一批 event 进来时：

```text
BEGIN PG

锁 Session / Lease / Cursor
↓
检查 lease + fence + seq
↓
Kafka append
↓
Kafka ACK
↓
更新 PG cursor
↓
COMMIT
```

 

这里最关键的是 **锁 lease/fence**。

否则可能：

```text
检查 Worker A：合法
↓
准备发 Kafka

与此同时 Worker A lease 被撤销
Worker B 接管

↓
Worker A 的旧 event 又进了 Kafka
```

现在因为 PG transaction 一直持锁到 Kafka ACK，这个竞态被堵住了。

所以目前 PG cursor 不只是“多记一个数字”，它是 **Kafka ingest 和 PG lease/fence 世界之间的提交边界**。

而且 Projector 现在也要求：

```text
Kafka event seq <= last_persisted_seq
```

否则它根本不允许写 Valkey。

所以 **现在不能直接删 PG cursor**。

不过里面有冗余：

```text
last_persisted_seq = 100
acknowledged_through_seq = 100
next_event_seq = 101
```

当前代码基本让这三个值绑定在一起。

这一块以后可以简化成类似：

```text
accepted_seq = 100
projected_seq = 98
```

这个我觉得值得改。

---

### 2. 跨 Session group commit 没那么多余

现在它：

```text
最多等 4ms
最多聚 64 个 Session publication
8 个 shard
```

然后一次 `ingestGroup()`。

我之前说“Kafka 自己会 batch，所以可以删”，这句话不够完整。

因为在 Kafka **之前**还有：

```text
HTTP
PG transaction
lease/fence 查询
cursor 更新
```

假设极端情况下 1000 个 Run 都在吐文本，50ms 一个 AgentDock event：

```text
约 20,000 event/s
```

如果每个 Session publication 都单独走一次：

```text
20k HTTP/s
20k PG tx/s
20k Kafka append 调用/s
```

group 以后可能变成几百次大的调用。

所以它还是有现实价值的。

---

但当前 group 有一个缺点：

```text
Session A
Session B
Session C
...
一起 FOR UPDATE

↓
一起等 Kafka ACK
```

Kafka 抖一下，几十个无关 Session 一起被锁住。

所以我长期更喜欢：

```text
保留“跨 Session transport batching”
但弱化“跨 Session 一个大 PG transaction”
```

也就是说 **batch 可以留，group commit 语义可以以后拆掉**。

---

所以现在我的建议是：

```text
50ms text coalesce       → 留
20ms per-session batch   → 留
跨 Session batching      → 暂时留
PG cursor                → 留，但简化字段
```

**目前最值得先动的不是删除它们，而是把 PG cursor 那三个高度重复的序号字段梳理一下。**

等把 cursor 的真正最小状态搞清楚，再判断能不能把 Kafka 从 PG transaction 里面搬出去。这个顺序风险最低。

## 105 · User · 2026-08-12T08:28:43.920Z

我不太懂这个pg cursor啊，难道这是一个流式片段就更新一次cursor吗？

## 106 · Assistant · 2026-08-12T08:28:46.824Z

对，**但不是“LLM 每吐一个原始 chunk 就更新一次 PG cursor”**。

当前链路是：

```text
LLM 原始 chunk
↓
最多 50ms 合并
↓
形成一个 AgentDock event，seq=81
↓
Worker 最多等 20ms 做 batch
↓
发 Kafka
↓
Kafka ACK
↓
PG cursor 从 80 → 81
```

所以如果模型一直输出文本，50ms coalesce 后基本每约 50ms 才产生一个正式 `assistant.text.delta`。因为 20ms batch 比 50ms 还短，纯文本场景下经常会变成：

```text
50ms：event 81 → PG cursor=81
50ms：event 82 → PG cursor=82
50ms：event 83 → PG cursor=83
...
```

也就是说，**是的，持续文本输出时 PG cursor 可能大约每 50ms 更新一次。**

但 Tool 等事件如果短时间连续产生：

```text
81 tool.input.delta
82 tool.started
83 tool.completed
```

可能被 20ms batch 一次发出去，那么 PG 就直接：

```text
cursor 80 → 83
```

而不是更新三次。

另外现在有两个主要 cursor：

```text
last_persisted_seq
```

表示 Kafka 已经 durable 到哪里，例如 `83`；

```text
last_projected_seq
```

表示 Kafka → Valkey 已经处理到哪里，例如 `81`。

所以可能暂时：

```text
Kafka:   到 83
PG:
  persisted = 83
  projected = 81
Valkey:  到 81
```

等 Projector 把 82、83 写进 Valkey，又会：

```text
projected = 83
```

所以你如果觉得“**为了每几十毫秒一小段文本，PG 一直改一个数字，似乎有点重**”，这个感觉是对的。这也是我们现在需要 review cursor 设计的核心问题。

## 107 · User · 2026-08-12T08:31:07.679Z

但你又说去掉这个cursor会影响lease和fencing，具体是怎么影响，能给个例子吗，不要一下子说一大堆，我信息接收能力有限

## 108 · Assistant · 2026-08-12T08:31:10.846Z

对，这里我前面说得不够准确。**不是 cursor 本身保护 lease/fencing，而是“更新 cursor 的那笔 PG transaction”顺便锁住了 lease/fence。**

举一个最简单的例子。

Worker A 当前：

```text
lease = A
fence = 5
PG cursor = 80
```

A 发 `seq=81`。现在代码：

```text
BEGIN PG
↓
锁住 lease 行
检查：A + fence=5 合法
检查：cursor=80，下一条确实是81
↓
发 Kafka seq=81
等待 Kafka ACK
↓
cursor 80 → 81
COMMIT
```

在这期间，如果 Worker A 挂了，系统想让 Worker B 接管：

```text
Worker B
fence = 6
```

它**必须等前面这笔 transaction 结束**，因为 lease 行被锁着。

所以顺序一定是：

```text
A 的 seq=81 确认进 Kafka
↓
cursor=81
↓
COMMIT
↓
B 才能拿到 fence=6
```

这样很干净。

真正危险的是，如果我们为了删 cursor，顺手把这笔 PG transaction 也删了：

```text
A 检查 fence=5 合法
↓
检查结束

        ← 这里 B 接管，fence 变成 6

↓
A 才把 seq=81 发进 Kafka
```

那就出现了：

> **已经过期的 Worker A，在 Worker B 接管以后，仍然成功写入了一条 event。**

所以准确地说：

> **cursor 可以讨论要不要删；但 lease/fence 在 Kafka append 期间的“锁定/原子边界”不能直接删。**

也就是说，我们完全可以继续研究一种设计：**删掉高频 cursor 更新，但保留 fence 安全性。**这两个其实是可以拆开的。

## 109 · User · 2026-08-12T09:04:16.210Z

你直接给我答案吧，这块怎么设计比较优雅

## 110 · Assistant · 2026-08-12T09:04:19.024Z

我会选一个**保守但干净**的方案：**先别试图把 PG 完全移出流式路径，只把现在的状态简化。**

核心设计就这样：

```text
Worker
  ↓  50ms coalesce
per-session event batch
  ↓
Event Gateway

BEGIN PG
  锁 session lease/fence
  检查 fence 是否仍合法
  检查 seq 是否从 accepted_seq + 1 开始
  ↓
  Kafka append + acks=all
  ↓
  accepted_seq = batch最后一个seq
COMMIT

  ↓
ACK Worker
```

PG 对每个 Session 只保留一个真正关键的流式字段：

```text
accepted_seq
```

例如：

```text
fence = 5
accepted_seq = 80
```

Worker A 发 `[81...84]`，Kafka 成功后一次变成：

```text
accepted_seq = 84
```

**不是每个 LLM chunk 更新一次，而是每个 Worker batch 更新一次。**

---

然后 Kafka → Valkey 这边，我会让 **Valkey 自己维护 `last_seq`**：

```text
Kafka
  ↓
Projector
  ↓
Valkey Stream
last_seq = 83
```

这样就没必要 PG 再高频维护一个：

```text
last_projected_seq
```

SSE 直接以 Valkey 的 `last_seq` 为实时 high-water。

所以状态会变得很清楚：

```text
PostgreSQL
  fence = 5
  accepted_seq = 84
  完整 terminal transcript

Kafka
  1...84 durable

Valkey
  1...83 projected
```

---

为什么我保留 `accepted_seq`？

就是为了你刚才问的 fencing：

```text
Worker A, fence=5
要写 81~84
```

它拿着 PG 锁等 Kafka ACK。

在这期间 Worker B 想接管成：

```text
fence=6
```

必须等 A 的事务结束。

于是一定是：

```text
Kafka 已经 durable 81~84
accepted_seq = 84
COMMIT

然后

fence 5 → 6
Worker B 接管
```

不会出现旧 Worker 在新 Worker 接管之后偷偷写 Kafka。

---

至于 **跨 Session group commit**，我会删。

也就是不要：

```text
Session A
Session B
Session C
一起开一个大 PG transaction
一起等 Kafka
```

而是：

```text
Session A → 自己的小 transaction
Session B → 自己的小 transaction
Session C → 自己的小 transaction
```

Kafka producer 自己负责底层网络 batching。

这样一个 Session 的 Kafka/PG 抖动不会把几十个无关 Session 一起锁住。

---

所以最终我推荐：

```text
保留：
50ms text coalesce
per-session Worker batch
PG lease/fence + accepted_seq
Kafka
Valkey

删除：
跨 Session group commit
PG last_projected_seq
PG acknowledged_through_seq 这类重复水位
```

我觉得这是目前最优雅的平衡：

> **PG 只管“谁有资格写、Kafka 已正式接受到哪”；Kafka 管 durable stream；Valkey 管实时读；PG 最后再管完整 Turn。**

而且不会为了追求“PG 完全退出 hot path”引入一套更复杂的分布式 fencing 协议。

## 111 · User · 2026-08-12T09:19:30.180Z

你觉得fencing, lease这两个功能应该在pgsql里面做吗，还是说有更好的独立部件可以做这个事，这两个需求应该挺通用的吧，难道开源解决方案都是把他们做在数据库里面吗

## 112 · Assistant · 2026-08-12T09:19:48.130Z

这两个需求确实非常通用，**并不是大家都塞 PostgreSQL**。专门做这件事的经典组件就是 **etcd / ZooKeeper / Consul**。

它们大概是这样对应的：

- **etcd**：原生有 Lease、CAS Transaction，而且全局 `revision` 单调递增，可以拿来构造 fencing token。
- **ZooKeeper**：经典做法是 `EPHEMERAL_SEQUENTIAL` 节点，session 断开节点自动消失，sequence 可以用于锁/leader 顺序。
- **Consul**：有 Session + Lock，而且 `LockIndex` 每次重新获取锁都会增加，官方就明确说它可以帮助识别 stale request。

所以如果单看：

```text
谁现在拥有 Session？
什么时候租约过期？
新的 owner 是第几代？
旧 owner 还能不能写？
```

**etcd 其实比 PostgreSQL 更“专业对口”。**

但针对你的 AgentDock，我反而建议：

> **现阶段继续用 PostgreSQL。**

原因很简单：你的 lease/fence 和这些东西关系非常紧：

```text
Session
Run
Attempt
Command
lease
fence
terminal commit
```

这些本来全在 PG。

如果换成 etcd：

```text
etcd:
lease + fence

PG:
Run + Attempt + Command

Kafka:
events
```

你反而引入一个新的问题：

> **etcd 说 fence=6，但 PG 还认为旧 Attempt 在 running，怎么办？**

原来一个 PG transaction 能解决的问题，变成了 **PG + etcd 两个一致性域之间协调**。

所以我更倾向这种形态：

```text
逻辑上：
LeaseCoordinator

实现上：
PostgreSQL

内部：
lease_id
owner
expires_at
fencing_token
```

以后真的做到几万、几十万 concurrent session，发现：

```text
lease renew
fence CAS
PG row lock
```

变成了瓶颈，再考虑把 `LeaseCoordinator` 的 backend 换成 etcd。

也就是说：

> **接口上把 Lease/Fencing 独立出来，存储上暂时继续 PG。**

这比现在为了“看起来更分布式”硬塞一个 etcd，我觉得要合理得多。

还有一个很关键的原则：**无论 PG、etcd、ZooKeeper 还是 Consul，fencing token 最终都必须由真正的资源写入端检查。**锁服务只能告诉你“现在是第 6 代”，Kafka/Tool Broker/Workspace 这类接收写操作的地方必须拒绝 `fence=5`；否则 lease 本身不能阻止一个暂停很久后突然恢复的旧进程。Consul 官方也特别强调它的锁是 advisory 的，不会自动阻止不守规矩的客户端写资源。

所以我对你项目的选择会是：

```text
现在：PG-backed LeaseCoordinator   ← 推荐
以后：etcd-backed LeaseCoordinator ← 真遇到规模问题再换
```

这个抽象我觉得比纠结“lease 应该属于 PG 还是 etcd”更重要。

## 113 · User · 2026-08-13T00:43:56.007Z

你再拉取一下看看，codex又推送了，它依据咱两的讨论对目前的架构进行了修改

## 114 · Assistant · 2026-08-13T00:46:22.722Z

我重新拉了 `main`。这次确实有几处是顺着我们前面的讨论改的，而且有一处**几乎就是你刚才提的方案**。

最明显的是“关闭浏览器，再打开正在运行的会话”这块。以前是：

```text
PG 完整历史到 80
→ SSE 从 81 开始
→ 81、82...90 逐个 replay
→ 前端自己重新拼
```

现在增加了 **active Turn snapshot**：

```text
打开会话
   ↓
PG：读取已经完成的历史 Turn
   +
Event Gateway：
读取 PG projected watermark
再从 Valkey 读取当前 Turn 的 81~90
   ↓
后端先拼成当前 transcript
   ↓
一次性给前端
   ↓
SSE 从 90 后面继续
```

新 ADR 0099 就明确写的是：重新打开 active Turn 时，把 Valkey 已经 projected 的连续前缀先 materialize 成一个 catch-up snapshot，浏览器 hydrate 一次，然后 SSE 从返回的 watermark 后继续。

而且代码已经真正接上了，不只是文档。现在前端打开会话会同时：

```ts
const conversation = await api.getConversation(sessionId);
const liveSnapshot = await api.getLiveTurnSnapshot(sessionId);
```

然后用 snapshot 的 `replayAfterSequence` 作为 SSE 起点。

后端 `ValkeyLiveTurnSnapshotSource` 也确实是：

```text
PG → 找 active Turn + last_projected_seq
Valkey → 读取对应 event
→ projectConversationTurnTranscript(...)
→ 返回完整的当前半截 Turn
```



所以**这一块我觉得改得很好**，比我们刚才看到的逐 event replay 体验更合理。

另外还有一个较大的修改：**Pi Worker 的 private affinity queue 被删了。**现在变成一个 Cell 一个 Temporal Task Queue，每个 Worker 只靠 Temporal 的 `maxConcurrentActivityTaskExecutions` 表示容量，不再搞 Worker-specific queue + PG reservation。这个正是之前我们讨论“Pi Worker 很轻，不应该把 Cell/Worker affinity 搞得太复杂”的方向。

Valkey 这边也补强了：现在 Event Gateway 启动会检查“PG 认为 projected 的数据是否真的还在 Valkey”，如果 Valkey 丢了，会从 Kafka 自动 rebuild；修不好就不 Ready。也就是说：

```text
Kafka = durable source
Valkey = 可丢、可重建的 read model
```

这个职责现在落实得更完整了。

不过**我们最后讨论的两个点，Codex 目前还没有改**：

```text
跨 Session GroupedDurableEventIngestor
```

仍然存在，而且还是默认：

```text
8 shards
4ms
64 publications
```



PG cursor 也还在，并且现在 active snapshot 明确依赖 `last_projected_seq`：

```ts
.select([
  "last_projected_seq as projectedThrough",
  "replay_floor_seq as replayFloor"
])
```



所以当前状态可以简单理解成：

> **Codex 已经把我们讨论中比较确定的部分改了：Worker affinity 简化、重新打开 active Turn 用 snapshot、Valkey 自动重建。**
>
> **但 group commit 和 PG cursor 这两个我们还在争论的部分，它没有贸然删。**

这个处理我觉得挺合理。尤其 active Turn snapshot 这个改动，我认为已经比之前的设计明显更好了。

## 115 · User · 2026-08-13T01:08:38.063Z

我们再聊聊pi worker affinity吧，你之前说为了降低复杂度把这个去掉，去掉之后那pi worker每次跑agent loop都要下载jsonl，我想知道这个下载是怎么实现的。一个jsonl可能很长嘛，像我就习惯在一个会话中一直工作，这个jsonl可能会一直积累到上百M甚至几个G。但是实际上在agent loop中跑的messages[]，可能也就是最近一次compaction开始到最新的jsonl差不多几M的大小。目前我们的实现是只下载这几M的大小还是把整个jsonl都下载到pi worker呢。然后你也评估一下在服务1000+activate run的集群中，一个agent loop几M的下载量算高吗（我感觉好像不太高）

## 116 · Assistant · 2026-08-13T01:10:33.509Z

对，我查完当前实现后，答案很明确：

### 1. 现在是下载**整个 `session.jsonl`**，不是只下载 compaction 后那几 MB

虽然 S3 里已经不是一个巨大的单文件，而是：

```text
manifest
├─ segment 1   8 MiB
├─ segment 2   8 MiB
├─ segment 3   8 MiB
...
└─ segment N
```

每个 segment 还会 gzip。这个设计目前主要优化的是**保存**：如果上一版 JSONL 是当前 JSONL 的前缀，旧的 content-addressed segment 可以复用，只上传变化的尾部。

但恢复时当前代码是：

```text
读 manifest
↓
下载 manifest 里的所有 segment
↓
全部 gunzip
↓
拼出完整 session.jsonl
↓
写入 Worker 临时目录
↓
SessionManager.open(...)
↓
Pi 再从完整 JSONL 计算 active context
```

`restorePiSessionManifest()` 明确会按 manifest 的全部 `segments` 下载，并先 `Buffer.allocUnsafe(manifest.totalSizeBytes)` 重建整个文件。

然后 Worker 把完整 bytes 写成 `session.jsonl`，交给 `SessionManager.open()`。 

所以假设：

```text
历史 session.jsonl = 200 MB

但最近一次 compaction 后：
summary + recent entries = 5 MB
```

现在实际还是：

```text
S3 → Worker：下载整个 200 MB 历史
Pi → Model：最终只构造约 5 MB active context
```

这两件事现在确实是脱节的。

---

而且还有一个更大的问题：**现在 Pi Session 最大只允许 512 MiB。**

```ts
MAX_PI_SESSION_SNAPSHOT_BYTES = 512 MiB
```



所以你说那种：

```text
一个会话用几个月
JSONL → 1 GB、2 GB
```

当前 AgentDock 实际上撑不到那里。

这个我认为比 Worker affinity 本身更值得解决。

---

### 2. 如果真的只需要下载几 MB，1000+ active Run 我也觉得不算大

假设以后做到：

```text
每次 restore = 5 MB
```

就算非常极端，**1000 个 Run 同时冷启动**：

```text
5 MB × 1000 = 5 GB
```

如果这 1000 个启动摊在 30 秒内，大概：

```text
167 MB/s
≈ 1.3 Gbps
```

对于一个真正服务 1000+ active Run 的集群，这不是一个离谱的数字。

而且关键是：

> **1000 active Run ≠ 每秒启动 1000 个 Run。**

checkpoint 只在 Run **开始 restore 时下载一次**。Agent Loop 后面可能运行几十秒甚至几分钟，中间 LLM → Tool → LLM 并不会重复下载 JSONL。

所以假设：

```text
1000 active Run
平均一个 Run 30 秒
```

稳态大约是 33 次 restore/s。

如果每次 5MB：

```text
≈ 165 MB/s
```

这个量级我认为完全可以接受。

---

但如果维持现在的**全历史下载**就完全是另一回事。

假设平均长期 Session 已经 100 MB：

```text
1000 次冷 restore
= 100 GB
```

30 秒内启动就是大约：

```text
3.3 GB/s
≈ 27 Gbps
```

更麻烦的其实还不只是网络，而是每个 Worker 要：

```text
下载
→ gzip 解压
→ 分配完整 JSONL Buffer
→ 写临时文件
→ Pi 重新 parse 完整 JSONL
→ 最后才得到几 MB active messages[]
```

所以一个 300MB JSONL 明明模型真正需要的 active context 只有 5MB，却要处理 300MB。

**这才是当前设计真正的问题。**

---

现在虽然还有 Worker-local checkpoint cache，但也解决不了这个根本问题。默认只有：

```text
TTL = 10 min
最大 = 32 MiB
```

而且 cache 的单位也是 immutable manifest/segment。

所以一个 200MB session，即使下一轮恰好又落在同一 Worker，默认 cache 也不可能完整留住它。

这反过来让我更认可 **删掉 Pi Worker affinity**：与其为了避免下载整个巨型 JSONL，构造一套复杂的 Worker affinity，不如直接解决真正的问题：

```text
当前：
200MB full history
       ↓
Worker
       ↓
Pi
       ↓
5MB active context


理想：
5MB 左右的 runtime-resume state
       ↓
Worker
       ↓
Pi
```

完整几百 MB / 几 GB 历史仍然可以在 S3 留着，用于：

```text
session tree
audit
export
branch history
```

但 **Agent Loop restore 不应该每次都把 archive history 全部搬回来。**

所以现在我对这个问题的判断很明确：

> **几 MB / Run 的 restore 流量对 1000+ active Run 集群不是什么大问题；当前真正需要优化的是“Pi compaction 已经把模型上下文压成几 MB，但 AgentDock restore 仍然下载并解析完整 append-only JSONL”。**

下一步真正需要研究的是一个很具体的问题：**Pi 的 `SessionManager.open()` 能不能在不破坏 branch/compaction/tool 等语义的情况下，只用“最近 compaction + suffix”恢复。**如果 Pi 原生支持，那这个问题会很好解决；如果不支持，就需要我们设计 runtime checkpoint 和 archive checkpoint 两层。

## 117 · User · 2026-08-13T01:13:28.671Z

嗯，研究一下这个

## 118 · Assistant · 2026-08-13T01:17:36.400Z

研究完了，结论挺有意思：**Pi 上游已经在朝我们想要的方向改，而且新 Harness 的设计基本就是“只恢复 compaction 后的活跃状态”。**

你现在 AgentDock 锁的是 `@earendil-works/pi-coding-agent 0.80.10`。 在这个版本里，`SessionManager.open()` 确实会把整个 JSONL 顺序读完并解析进内存；哪怕最终 LLM context 只需要最近 compaction 后几 MB，也还是先读取完整文件。

但是 Pi 从 **0.81.0** 开始已经改了 Harness 的 session 模型：compaction 不再只是：

```text
summary
firstKeptEntryId → 指向旧历史
```

而是开始保存：

```text
compaction
├─ summary
└─ retainedTail   ← compaction 时保留下来的 AgentMessage[]
```

也就是说 compaction 自己就变成了一个**自包含 checkpoint**。Pi 的 changelog 明确说 0.81.0 开始把 retained compaction tail 存成 self-contained checkpoint。

到新的 Harness 里，这个规则写得更直接：

> **Context never reads past a compaction.**

它构造下一次 LLM context 的算法就是：

```text
从当前 leaf 往回查
↓
遇到最近 compaction 就停止

得到：

compaction.summary
+ compaction.retainedTail
+ compaction 后的新 entries
```

**更早的数据完全不读取。**

这正是我们刚刚想要的。

---

所以举你的例子：

```text
完整历史：
2 GB

最近 compaction：
summary        50 KB
retainedTail   3 MB

compaction 后：
新消息         2 MB
```

新 Harness 理论上一次 Agent Loop 恢复只需要：

```text
≈ 5 MB
```

而不是：

```text
2 GB
```

更妙的是，新 Harness 连 model/thinking 这种状态也不要求从老历史里扫出来了，它有独立的 `LaneConfiguration`：

```text
model
thinkingLevel
activeToolNames
```

所以旧历史真的可以彻底退出 Agent Loop 热路径。

---

### 那 AgentDock 现在该怎么办？

我不建议我们自己去魔改 `session.jsonl`。

我更倾向：

```text
现在
AgentDock
→ pi-coding-agent 0.80.10
→ legacy SessionManager
→ 整个 JSONL restore

未来
AgentDock
→ 新 Pi AgentHarness
→ SessionRepo / SessionStorage
→ query 到最近 compaction 为止
```

Pi 在 **0.84.0** 已经正式把新的 `Session / SessionStorage / SessionRepo` 变成默认 Harness API，并且明确增加了 bounded branch query。

甚至它的存储接口已经长这样：

```text
SessionStorage
  findEntries(...)
  findEntriesOnBranch(...)
  getEntry(...)
  appendEntry(...)
```

而不是要求：

```text
给我完整 session.jsonl 文件
```



所以将来 AgentDock 完全可以实现自己的：

```text
AgentDockSessionRepo
        ↓
PostgreSQL / S3
```

然后 Pi 要 context 时：

```text
findEntriesOnBranch(
    leaf,
    stopAtType = "compaction"
)
```

只返回几 MB。

---

不过这里有一个比较大的架构问题：

**新 AgentHarness 不只是改 Session，它还开始自己做 durable execution。**

你看它现在已经有：

```text
operation_started
tool_started
operation_finished
retry
resume
writer lease
...
```

甚至文档里已经在讨论“tool 执行一半 crash 后怎么恢复”。

这和 AgentDock：

```text
Temporal
RunAttempt
Lease/Fence
Tool Execution
Durable Recovery
```

开始出现明显重叠。

所以我不建议现在一句：

> “升级到 Pi 0.84，然后全换 AgentHarness。”

这需要单独 review。

但**关于我们眼前这个问题，方向已经可以定了**：

> **不要为了避免下载巨型 JSONL 恢复 Pi Worker affinity。正确方向是让 Pi runtime restore 只读取最近 compaction checkpoint + suffix。**

而且这已经不是我们自己发明的优化了，**Pi 上游自己也已经把 Harness 设计成这样了。**

所以我现在反而更加支持把 Worker affinity 删掉：如果每次随机 Worker 只需要拉几 MB 的 active session，Worker affinity 的收益会非常小，而它带来的调度复杂度明显更大。

## 119 · User · 2026-08-13T01:22:13.737Z

目前最新版本的pi已经做了durable execution ？如果是这样我觉得紧跟pi步伐会好一点啊，我们可以少写很多代码，也少了很多验证的工作，全部交给pi sdk

## 120 · Assistant · 2026-08-13T01:23:50.351Z

对，**方向上我赞成紧跟 Pi**，但现在有个关键事实需要纠正：

> **Pi 已经把 durable execution 的架构设计得很完整了，但当前实现还没有完成。**

当前仓库版本号还是 `0.84.1`。 新 Harness 已经定义了我们非常熟悉的东西：

```text
operation state
effect_pending
tool replay: safe / never
resume
abort
compaction checkpoint
SessionStorage / SessionRepo
```

设计上确实已经是 durable agent runtime 了。

但实际代码里，目前 `AgentHarness.prompt()` 还是：

```ts
return this.unavailable("prompt");
```

`resume()` 也是：

```ts
return this.unavailable("resume");
```

甚至 `AgentHarness.create()` 如果发现已有 operation record，目前直接：

```ts
throw new HarnessNotImplemented("create.restore");
```



所以**今天还不能把 AgentDock 的 durable execution 删除然后交给 Pi**。

不过我非常赞成调整我们的开发策略：

> **从现在开始，不要继续大规模自研 Pi 已经明确准备接管的 harness 能力。**

因为 Pi 上游最近几天一直在密集写 durable Harness spec，8 月 8～11 日大量提交都在做这件事。它明显正在往这个方向推进。

但有一块即使未来 Pi 完成了，我也不会交给它：**我们的流式事件持久化。**

Pi 最新 Harness spec 明确把：

> provider 的 partial stream

列为 non-goal：partial stream 只在进程内，**不会持久化**；只有完整 assistant response 才进入 durable session。

而 AgentDock 的要求更强：

```text
LLM delta
↓
Kafka durable
↓
Valkey
↓
用户才能看到
```

所以未来最漂亮的职责边界，我认为是：

```text
AgentDock
├─ 多租户 / API
├─ Temporal 调度 Worker
├─ lease / fencing
├─ CubeSandbox
├─ Kafka / Valkey / SSE   ← 流式 durable
│
└─ Pi AgentHarness
   ├─ messages/context
   ├─ compaction
   ├─ Agent Loop
   ├─ Tool 状态机
   ├─ crash recovery
   └─ durable operation state
```

这样的话，**我们现在自己写的很多 Run 内部恢复逻辑，未来确实可能整块删除。**

我甚至觉得现在应该采取一个策略：**暂停继续深化 AgentDock 自己的 Agent Harness，把 Pi 当成正在赶来的上游依赖。**等 Pi 的 `prompt → tool → crash → resume` 真正实现并通过测试以后，我们直接迁过去。

这会比我们和 Pi 同时各写一套 durable Agent Loop 划算得多。

## 121 · User · 2026-08-13T01:32:10.668Z

pi社区大概什么时候能完成durable execution的工作？

## 122 · Assistant · 2026-08-13T01:33:35.465Z

我没找到社区给出的正式 ETA。按当前进度，我会估：

**第一版真正能跑的 durable AgentHarness：大概 2～4 周。**  
**成熟到我愿意让 AgentDock 删除自己那套 Run 内恢复逻辑：大概 1～2 个月。**

原因很简单：现在 `main` 里的 `prompt()`、`resume()`、`executeAction()` 仍然直接返回 `HarnessNotImplemented`，`create.restore` 也还没落地，所以不是“差几个 bug”，而是核心 runtime 还在施工。

但速度确实非常快。之前 Harness v2 已经做到过 recovery reducer、indexed recovery query，甚至有人写出了完整的 suspended-operation restore PR，只是后来因为 Harness 又做了一轮更大的 redesign，这个 PR 被关闭没合并。 而且他们的工程计划已经把剩余工作拆得很细，runtime 主线基本是按一串明确的阶段串行收敛，最终验收条件甚至写了“no active harness operation remains scaffolded”。

所以我倾向于：**AgentDock 现在先不要继续深化自己那套 Agent Loop durable recovery，等 Pi 两三个版本。**你现在锁在 `0.80.10`，而 Pi 最近从 `0.81 → 0.84` 的迭代本来就非常快。到大约 **9 月份**，我觉得很值得重新做一次 migration review；如果那时候 `prompt/tool/resume/crash recovery` 都已经通过正式测试，我们就可以开始大规模删 AgentDock 的重复 harness 代码。

## 123 · User · 2026-08-13T01:41:11.108Z

那么compact这一块，我只要用0.84版本，就可以避免下载巨大的jsonl了是吧

## 124 · Assistant · 2026-08-13T01:41:38.182Z

**不完全是。单纯把依赖从 0.80.10 升到 0.84，不会自动避免下载巨大 JSONL。**

原因是你现在 AgentDock 的流程在 **Pi 启动之前**就已经：

```text
S3 所有 JSONL segments
→ 全部下载
→ 拼成完整 session.jsonl
→ 再交给 Pi
```

所以哪怕 Pi 0.84 自己只需要最近 compaction，AgentDock 已经先把 2GB 搬下来了。

0.84 真正提供的是新的能力：

```text
SessionRepo / SessionStorage
        ↓
findEntriesOnBranch(
  stopAtType: "compaction"
)
        ↓
最近 compaction + retainedTail + 后续 entries
```

0.81 开始 compaction 就已经是 self-contained checkpoint，0.84 又正式引入了 bounded branch query。

所以要达到我们想要的：

```text
历史 2GB
最新 active context 5MB

S3/存储 → Pi Worker
只传约 5MB
```

需要的是：

> **升级到新 Pi Session/Harness API + 把 AgentDock 当前“完整 JSONL checkpoint restore”替换掉。**

而不是单纯 `package.json` 改成 `0.84.x`。

我反而建议**别现在专门为 compact 做一次迁移**。等 Pi 新 durable Harness 的 `prompt/resume` 完成，我们一次性把：

```text
完整 JSONL checkpoint
Agent Loop recovery
compaction restore
tool recovery
```

一起迁到新 Harness。这样最省代码，也避免做两轮大重构。

## 125 · User · 2026-08-13T01:46:14.676Z

好吧，那说说pi社区现在正在推进的durable harness，具体是怎么做的，如果pi把durable harness内化了，是不是意味着我外部不需要保持lease， fencing这些状态了，0.84及后续版本的方向是什么，我有没有机会参与（就像我刚刚想到的，从最新一次compact之后的状态开始恢复，没想到pi社区在不久前就做过了，甚至是只在我使用了0.80版本之后）

## 126 · Assistant · 2026-08-13T01:48:59.423Z

有，而且我觉得你**很适合参与 Pi 这波 durable harness**。不过先修正我前面一个说法：我之前把“LLM context 不读 compact 之前的历史”和“Worker 冷启动不用下载完整历史”混到了一起。这两个不是一回事。

Pi 当前的新设计已经保证：构造 provider context 时，从 leaf 向前扫描，**遇到最近一次 compaction 就停止**，然后使用 `summary + retainedTail + compact 后 entries`，更老的历史不读。

但它当前规划里的 **JSONL backend 在 open 时仍然会把整个 JSONL replay 到内存**。所以如果 AgentDock 还是：

```text
S3 上 2GB session
↓
Pi Worker 冷启动
↓
下载整个 JSONL
↓
Pi 再只取最近 5MB context
```

问题依然存在。真正适合 Cloud Agent 的，其实是 Pi 已经留好接口、但还没正式实现的 **Postgres Session backend**。这恰好可能是你参与社区最有价值的切入点。

## Pi 现在的 durable harness 到底怎么做

它现在的思路和 Temporal 很像，但粒度是在 **Agent Loop 内部**。

以前 Pi 大概是：

```text
messages[]
↓
LLM
↓
tool
↓
LLM
↓
结束
```

新 Harness 在旁边维护一个持久化的“程序计数器”：

```text
op.state/{operationId}
```

例如：

```text
checkpoint
↓
assistant.ready
↓
assistant.effect_pending
↓
tools
↓
checkpoint
↓
assistant
...
```

`op.state` 每次都是**完整当前状态**，不是 event sourcing。进程崩了以后不需要回放一大堆日志推断“我刚才执行到哪”，直接读当前 `op.state`。Pi 自己把它称为 durable program counter。

外部 effect 则使用一个很漂亮的模式：

```text
先提交 intent
"我要调用 tool X，结果 id 已经预留为 R"

↓ commit

真正调用 Tool

↓ 完成

提交 result R + 新 op.state
```

也就是：

```text
intent commit
↓
effect
↓
settlement commit
```



这样 crash 的情况就非常有限。

比如：

```text
tool = rm file
replay = never
```

状态已经：

```text
effect_pending
```

但是 Worker 挂了。

恢复以后 Pi 不知道 Tool 到底执行了没有，所以不会重新执行，而是：

```text
tool result = interrupted
```

继续 Agent Loop。

如果 Tool 是：

```text
read file
replay = safe
```

则允许重新调用。

这其实正是我们之前花很多时间讨论的：

```text
Tool Call 发出
↓
Worker 崩溃
↓
到底要不要重新执行？
```

Pi 社区现在准备把这个问题直接吃进 Harness。

---

## 那 AgentDock 的 lease / fencing 能不能删？

**能删掉一部分，但不能全删。**

Pi 自己也明确认为：

```text
一个 Session 同时只能有一个 Writer
```

甚至它规划的 SQLite backend 直接有：

```text
writer_lease
----------------
owner_id
fence
expires_at_ms
```

而且 `open()` 获取 lease，运行期间续租；新 owner 接管时 fence 增长；旧 owner 不能再提交。

所以未来如果 AgentDock 做：

```text
PostgresPiSessionRepo
```

那么：

```text
Session writer lease
Session fencing
op.state
conversation tree
compaction state
tool recovery state
```

我认为**全部应该交给 Pi Session backend**。

也就是说你现在 AgentDock 里的：

```text
SessionLeaseCoordinator
RunAttempt 内部 AgentLoop recovery
很多 fencing/CAS
Pi checkpoint
```

很大一部分可能可以删。

但还有一层不能随便删：

```text
Pi Worker A
     ↓
Tool Broker
     ↓
Cube / Workspace
```

假设 A 的 Session lease 过期了，B 已经接管。

但 A 原来发出去的 bash 还在 Cube 里执行。

Pi 的 storage fence 可以阻止：

```text
A 再写 Session 状态
```

却**不天然阻止**：

```text
A 的旧 Tool 继续修改 Workspace
```

所以在 AgentDock 这种真正分布式系统里，我仍然会保留：

```text
resource fencing
```

但不一定还要维护**第二套独立 Session fence**。

更漂亮的最终形态可能是：

```text
Pi Session writer epoch = 42
          │
          ├── Tool Broker 要求 fence=42
          ├── Workspace write 要求 fence=42
          └── Event Gateway 要求 fence=42
```

新 Worker 接管：

```text
epoch = 43
```

所有：

```text
fence=42
```

的旧请求直接失效。

也就是说：

> **让 Pi 成为 Session ownership authority，AgentDock 只把这个 authority 延伸到外部资源。**

我觉得这个比现在“AgentDock 一套 lease/fence + Pi 以后自己又一套 lease/fence”漂亮得多。

不过这一点目前是我们可以设计的集成方向，**Pi 当前 API 并没有承诺把 writer fence 暴露给外部 Tool Broker 使用。**

---

## 0.84 之后 Pi 到底在往哪走

0.84 其实只是一个过渡点。它已经把旧 session model 换成：

```text
Session
SessionStorage
SessionRepo
Lane
durable operation records
```

并把新的 AgentHarness 提升成正式 API，但 runtime 当时还是 scaffold。

更值得看的其实是 **现在 main 上 8 月 11 日刚定下来的新 Harness spec**。

这个版本甚至准备：

> 把现在 `packages/agent/src/harness/**` 整块删掉，再按新设计重建。

它现在把工程拆成两条线：

```text
Storage Track
  JSONL
  SQLite
  Search
  Client

Runtime Track
  R1 Runtime shell
  R2 no-tool Run
  R3 generation recovery
  R4 Tools
  R5 queue/config
  R6 abort/close
  R7 deferred provider
  R8 manual compact
  R9 auto compact/overflow
  R10 navigation
  R11 migration
  R12 complete
```

Storage 可以多人并行开发；Runtime 是严格 R1 → R12 顺序推进。

所以社区这次不是在“给旧 Pi 加一个 retry”。

他们其实是在把 Pi 从：

```text
Agent Loop library
```

变成：

```text
Durable Agent Runtime
```

这个方向非常明显。

---

## 你有没有机会参与？

我觉得有，而且有一个方向**非常贴你的 AgentDock**：

- **Postgres / Remote Session backend**。Pi 当前正式 shipping 目标只有 Memory、JSONL、SQLite，而 spec 已经专门留了一章 `Future: partitioned retention (Postgres)`，甚至讨论了 partition、repair、external finalization、register CAS。它明确说这还只是 future sketch。
- **Cloud cold restore benchmark / bounded reads**。可以做一个 1GB 历史 Session，最新 compact active context 只有 5MB，要求 Postgres backend 的 Worker restore 只产生几 MB/几十次 point query，而不是搬 1GB。这正是你刚刚独立想到的问题。
- **Cloud fencing integration**。研究怎样把 Pi 的 writer generation 暴露成外部 resource fence，让 Tool Broker / sandbox / event plane 共用，而不是 Cloud host 再维护第二套 Session lease。

我尤其看好第一项。

因为 Pi 当前 spec 自己已经写了：

```text
JSONL / SQLite:
one file per session

Postgres:
could hold every session in one database
```

而且 restore 的理想算法已经是：

```text
lane.config
lane.state
lane.leaf
op.meta
op.state

+ 被这些状态直接引用的少量 entry/register
```

**5 个 register point lookup + bounded hydration，不扫历史。**

这跟 Cloud Agent 简直天然契合：

```text
任意 Pi Worker
↓
Postgres Pi SessionStorage
↓
读取当前 operation state
↓
读取最近 compact 后 context
↓
继续 Agent Loop
```

不需要：

```text
Worker affinity
巨大 JSONL 下载
Worker 本地 Session 状态
```

所以如果让我替你选一个“既能帮助 AgentDock，又可能真正贡献给 Pi 社区”的切口，我会选：

> **研究并参与 Pi 的 Postgres-backed SessionRepo / SessionStorage。**

而且这比单独给 AgentDock 自己做一个类似实现更划算——你实现一次，如果能 upstream，AgentDock 以后直接消费 Pi SDK。

我甚至觉得我们下一步可以先不写代码，**把 Pi 这份最新 `harness.md` 里的 Postgres backend 需求和 AgentDock 当前 PG/lease/fence 架构一项一项对齐**，看看你现有的哪些代码其实已经能变成 Pi 的 `PostgresSessionStorage`。这个对你应该很有价值。

## 127 · User · 2026-08-13T02:04:28.804Z

哇，如果不需要下载完整jsonl，对我有很大诱惑啊，先研究这个吧，durable execution的对齐先放一放。我理解是你说pi已经实现了倒着读jsonl，读到最新一次compaction就加载到messages[]，是这个意思吗？虽然不需要完整读jsonl，但就算我们使用0.84版本的pi，在我们的云环境里我们仍然需要把jsonl完整下载到pi worker节点才能倒着读jsonl

## 128 · Assistant · 2026-08-13T02:04:59.465Z

对，**你的第二个判断是对的，但第一个要纠正一下。**

Pi 0.84 **没有实现“从 JSONL 文件尾部倒着读，读到最新 compaction 就停止”**。

0.84.1 实际上是：

```text
完整 session.jsonl
↓
JsonlSessionStorage.load()
↓
readTextFile(path)        ← 整个文件读进来
↓
split("\n")
↓
从头 replay 所有记录
↓
构造内存 SessionState
↓
找到当前 branch
↓
只把最新 compaction + retainedTail + 后续消息
放进 messages[]
```

源码非常明确，`load()` 第一件事就是：

```ts
const content = await fs.readTextFile(path);
```

然后遍历所有 physical lines，把整个 session replay 到 `SessionState`。

之后构造 context 时，才找到最后一个 compaction：

```text
[compaction, ...compaction之后的entries]
```

而 compaction 自己带 `retainedTail`，最终进入 LLM 的 `messages[]` 才是小的。

所以现在其实是：

```text
假设完整历史 = 2 GB
最新 active context = 5 MB

S3
 │
 │ 2 GB
 ▼
Pi Worker
 │
 │ 完整读取 + replay 2 GB
 ▼
SessionState
 │
 │ 取最后 compact
 ▼
messages[] = 5 MB
```

### 所以对 AgentDock 来说，0.84 本身还没有解决你真正关心的问题

如果继续使用 Pi 的 **JSONL backend**，在我们的 Cloud 环境里仍然要把整个 JSONL 提供给 Worker。

如果 JSONL 在 S3：

```text
S3 → Worker
```

基本还是得搬完整文件。即便做成 S3 mount，Pi 的 `readTextFile()` 也会把它完整读取一遍。

所以目前两个问题要分开：

```text
模型上下文大小
2GB → 5MB       ✅ Pi 已经解决

Worker 冷启动 I/O
2GB → 5MB       ❌ Pi 0.84 JSONL 没解决
```

而我们真正想要的是第二个。

---

这反而让我觉得现在研究这个特别有意义。

Pi 最新 durable harness spec 已经把理想的 **Postgres/数据库 backend** 路铺好了：恢复时不是打开完整历史，而是做：

```text
lane.state
lane.config
lane.leaf
op.state
...
↓
bounded query
↓
最近 compaction
+ retainedTail
+ compact 后 entries
```

这样才能真正变成：

```text
S3 / PG 中历史 = 2 GB

Pi Worker
   ↑
   │ 只查询
   │
5 MB active state
```

也就是你真正想要的：

> **历史可以无限增长，但 Pi Worker 的冷启动成本基本只跟“当前有效上下文”有关，而跟 Session 总历史长度无关。**

所以接下来最值得研究的不是“怎么让 JSONL 倒着读”，而是：

**能不能让 AgentDock 直接给 Pi 实现一个 remote `SessionStorage/SessionRepo`，让 Pi 从 PostgreSQL 按需读取最新 compaction + suffix。**

如果这个能做成，Worker affinity 几乎就更没有保留价值了。

## 129 · User · 2026-08-13T02:12:09.983Z

难道是我想得简单了吗？我理解就是compact了之后，compact前的上下文就没有关系了，llm的推理就只跟最新一次compaction和之后发生的user/assistant messages有关，而在一个jsonl里面，如果倒着找应该挺容易找到最新一次compaction，但为什么pi要replay整个jsonl呢，这么直觉的事情社区想不到吗？还是说compaction之前的内容与上下文的重建，或者和pi的一些内部状态有关吗

## 130 · Assistant · 2026-08-13T02:12:31.111Z

对，你这个直觉对于 **“只重建 LLM 的 messages[]”** 基本是对的；Pi 社区不是没想到，而是 **JSONL 承担的职责比 messages[] 大得多**。

最关键的一点是，0.84.1 的逻辑实际上分两步：

```text
完整 branch
   ↓
先恢复：
model
thinkingLevel
activeTools
   ↓
再找最新 compaction
   ↓
summary + retainedTail + compaction 后 messages
```

代码里 `deriveSessionContextState(pathEntries)` 会先遍历完整 path，恢复 model / thinking level / active tools；然后 `defaultContextEntryTransform()` 才找最后一个 compaction，把更早的消息裁掉。

所以比如：

```text
很久以前：
model_change → GPT-5

... 100MB 历史 ...

compaction

user
assistant
```

如果 compaction 自己没有保存 model 配置，仅仅从 compaction 往后读，你甚至不知道现在应该继续用什么 model。

不过这只是 **0.84.1 的一个原因**。更大的原因是：

> **Pi 的 JSONL 不是“LLM 上下文文件”，而是整个 Session 的持久化数据库。**

里面还有：

```text
conversation tree
branches
lanes
labels / session name
model / thinking changes
operation records
queue state
usage/statistics
...
```

0.84.1 的 JSONL backend 因此选择最简单可靠的实现：

```ts
readTextFile(整个文件)
→ 从头 replay
→ 构造 SessionState
```



### 还有一个很容易忽略的问题：branch

假设：

```text
A ─ B ─ C ─ D ─ compact1 ─ E ─ F   ← 当前 branch
         \
          G ─ H ─ I                 ← 旧 branch
```

`compact1` 只代表：

> 当前这条 branch 在给 LLM 构造上下文时，A~D 可以由 summary 代替。

它**不代表 A~D 可以从 Session 中删除**。

因为以后用户可能 `/tree` 回到 C：

```text
A ─ B ─ C
         \
          新 branch
```

这些历史仍然是完整 conversation tree 的一部分。

最新 Harness 甚至还有 **多个 lane**：

```text
main lane       → compact A
subagent lane   → 可能还指着很老的节点
thread lane     → 另一条 branch
```

因此根本不存在一个全局意义上的：

> “找到 JSONL 最后一个 compaction，前面的都不用读。”

某个 lane 的最新 compaction，并不能代表整个 Session。

---

但这里最重要的是：

**这并不意味着你的想法不可行。**

只是需要把：

```text
Session archive
```

和：

```text
Agent runtime working set
```

分开。

对于 AgentDock 的 Pi Worker，我们真正需要的是后者：

```text
当前 lane config
当前 leaf
最近 compaction
retainedTail
compaction 后 entries
当前 operation state
```

可能就几 MB。

而：

```text
几 GB conversation tree
旧 branches
旧 labels
historical usage
```

完全没必要搬到 Worker。

这也是为什么数据库 backend 比“倒着读 JSONL”更自然：

```text
Postgres
│
├── entries        几 GB，全历史
├── lane_state
├── lane_config
├── op_state
└── branch index
      │
      │ bounded query
      ▼
Pi Worker
只有当前工作集 3~10MB
```

而不是：

```text
2GB JSONL
↓
下载 2GB
↓
Pi 自己再扔掉 1.995GB
```

### 所以你其实没有想简单

你想到的是一个非常正确的 **Cloud Runtime optimization**：

> **Agent 执行节点没必要拥有完整 Session archive，只需要拥有当前 executable state。**

Pi 的本地 JSONL backend 优先考虑的是：

```text
一个文件
简单
可移植
完整 session
/tree / branch 都能工作
```

它不是为：

```text
1000 个无状态 Cloud Worker
远程对象存储
GB 级长期 Session
```

设计的。

而且最新 Pi spec 已经明显开始往你这个方向走了：它把 model/thinking/tools 从历史 entry 里拿出来，变成独立 `lane.config`；恢复 operation 也变成几个 register point lookup，而不是扫描历史。换句话说，**社区自己也在逐步把“当前运行状态”和“历史 conversation tree”拆开。** 

所以我现在觉得真正值得研究的问题已经很具体了：

> **能不能在不等 durable Harness 完工的情况下，单独利用 Pi 新 Session API，做一个“remote/bounded Session backend”，让 AgentDock Worker 从一开始就不碰完整 JSONL？**

这个比研究“怎么倒着读 JSONL”更有价值。

## 131 · User · 2026-08-13T02:23:22.100Z

durable harness和这块有关系吗？我还在想一个问题，就是如果我们是从compact之后开始读，那产生的新message是否还能无缝接在jsonl后面，如果我们使用pi sdk，这些新message的存放是我们控制的吗？形态是否和pi控制的结果一致

## 132 · Assistant · 2026-08-13T02:23:51.258Z

对，而且这里要分成两件事。

**durable harness 和“只读取 compact 后工作集”有关联，但不是前置条件。**durable harness 需要把当前 operation、tool 状态、compaction 状态都持久化，所以 Pi 顺势把 Session 存储抽象得更干净；但单纯解决“Worker 不下载完整 JSONL”，核心依赖的是 `SessionStorage/SessionRepo`，不是 durable execution 本身。

你问的新 message 能不能无缝接上，答案是：

> **如果我们实现 Pi 的 SessionStorage backend，可以，而且这是我现在最看好的方案。**

0.84 的调用关系已经是：

```text
Pi
appendMessage(message)
↓
生成 Pi entry id
↓
storage.appendEntry(entry, lane)
↓
我们的 backend
```

`Session.appendMessage()` 最终就是调用 `this.storage.appendEntry(...)`。

而 Pi 自带 JSONL backend 做的是：

```text
current lane leaf = E100
新 message id = E101

生成：
E101.parentId = E100
E101.seq = ...
E101.timestamp = ...

然后 append 到 JSONL
```

这个 `parentId / seq / timestamp / append` 动作目前就在 `JsonlSessionStorage.appendEntry()` 里完成。

所以如果换成：

```text
AgentDockPostgresSessionStorage
```

逻辑可以完全一样：

```text
Pi：
message 内容 + entry id

AgentDock backend：
查当前 lane leaf
parentId = leaf
分配 seq
INSERT entry
更新 leaf
```

这样产生出来的 **Pi 逻辑 Entry 和官方 backend 是同一种东西**。

区别仅仅是：

```text
官方 JSONL：
append 一行 JSON

我们的 PG：
INSERT 一行
```

也就是说：

> **Pi 控制 Session 的语义，我们控制 Session 的物理存储。**

这其实是非常好的边界。

---

不过你刚才设想的另一个方案：

> 下载“最新 compact + 后面的 JSONL”，然后让 Pi 继续往这个裁剪版 JSONL 后面 append

这个反而有坑。

因为 compaction entry 本身仍然属于完整 conversation tree：

```text
A → B → C → D → COMPACT → E → F
                  ↑
               parentId=D
```

即使 `COMPACT` 内部已经保存：

```text
summary
retainedTail
```

它的 tree parent 仍然可能是 `D`。

如果你只下载：

```text
COMPACT → E → F
```

把 A～D 全扔掉，那么：

```text
COMPACT.parentId = D
```

但 D 不存在。

对于完整 Pi Session 来说，这是一棵**断掉的树**。

所以：

> **“LLM context 可以从 compact 开始”**
>
> 不等于
>
> **“可以直接把 JSONL 文件从 compact 那一行截断”。**

这是我觉得我们刚才讨论里最关键的区别。

---

数据库 backend 就没有这个问题。

完整历史仍然在 PG：

```text
PG:

A → B → C → D → COMPACT → E → F
```

Worker 问：

```text
给我当前执行需要的数据
```

PG 只返回：

```text
lane leaf = F

COMPACT
  summary
  retainedTail

E
F
```

Worker **没有拿到 D**，但数据库知道：

```text
COMPACT.parentId = D
```

等哪一天用户真的 `/tree` 回到 D：

```text
Worker → PG
        给我 D 那条 branch
```

再读取即可。

所以这是：

```text
完整 Session：
PG 保存全部

Pi Worker：
只持有当前 working set
```

而不是：

```text
把完整 Session 裁成一个假的小 Session
```

我觉得这个区分非常重要。

---

因此对于 AgentDock，我现在反而看到了一条很干净的路线：

```text
不要：

S3 full session.jsonl
       ↓
Pi Worker
       ↓
SessionManager.open()


改成：

Pi
 ↓
AgentDockSessionStorage
 ↓
PostgreSQL
```

Pi 要 append：

```text
Pi → storage.appendEntry()
```

Pi 要 context：

```text
Pi → storage.findEntriesOnBranch(...)
```

Pi 要旧历史：

```text
Pi → storage.getEntry()/branch query
```

**Worker 永远不需要拥有完整 JSONL。**

而 JSONL 可以退化成：

```text
export / import / backup format
```

甚至根本不再是运行时 authority。

所以现在我认为，我们真正该研究的已经不是“怎么优化 JSONL 下载”，而是：

> **在不等 durable harness 完工的情况下，0.84 的 SessionStorage 抽象是否已经成熟到足够让 AgentDock 实现一个 PostgreSQL backend，并继续使用 Pi 的 Agent Loop。**

如果答案是能，这个改动对 AgentDock 的价值可能比 Worker affinity 大很多。

## 133 · User · 2026-08-13T02:29:28.595Z

那假如我们实现了一个pgsql backend，是否就不需要下载完整jsonl了？你提的这个问题也可以研究一些

## 134 · Assistant · 2026-08-13T02:31:46.052Z

**从架构上说，是。**如果 PostgreSQL backend 真正成为 Pi 的 `SessionStorage/SessionRepo`，Pi Worker 就不需要下载完整 JSONL；甚至运行时可以**完全没有 JSONL**。

理想链路会变成：

```text
现在
S3: 2GB session.jsonl
        ↓ 下载 2GB
Pi Worker
        ↓
messages[] 5MB


PG backend
PostgreSQL: 2GB 历史
        ↓ SQL bounded read
Pi Worker
        ↓
messages[] 5MB
```

Pi 0.84 的接口其实已经为这种模式留好了形状。`SessionStorage` 暴露的是 `appendEntry()`、`getEntry()`、`findEntriesOnBranch()`、`findRecords()` 等结构化接口，而不是“给我一个 JSONL 文件路径”；`SessionRepo.open()` 甚至明确把 backend writer claim 也纳入了接口语义。

而 Pi 的 `Session.appendMessage()` 也只是生成 entry 后交给 storage：

```text
Pi 生成 message / entry id
        ↓
Session
        ↓
storage.appendEntry(...)
        ↓
PostgreSQL INSERT
```

所以新消息仍然是**原生 Pi Entry 语义**，只是物理存储从 JSONL append 变成 SQL insert。

### 但“现在立刻做”有一个很大的坑

目前 **0.84.1 真正可用的 `pi-coding-agent` Agent Loop 仍然走旧 `SessionManager`**。

比如 resume 时还是：

```ts
SessionManager.open(sessionPath)
```

然后拿一个本地 JSONL。

虽然 0.84 已经有：

```text
AgentHarness
Session
SessionStorage
SessionRepo
```

甚至 coding-agent 已经写了 `createCodingAgentHarness()`，它可以接收任意 `Session`，理论上 PG backend 可以直接塞进去。

但是问题还是我们刚才说的：

```text
AgentHarness.prompt()
AgentHarness.resume()
```

当前还是 scaffold，核心 runtime 尚未完成。

所以现在是：

```text
接口层：    ✅ 已经适合 PG backend
Agent Loop：❌ 还没完全迁过去
```

---

不过我发现一个让我觉得**非常适合现在做 spike** 的地方：

Pi 连第三方 backend 的 conformance suite 都已经公开了：

```ts
createSessionBackendConformance(...)
```



所以我们完全可以先做一个：

```text
PostgresSessionStorage prototype
```

只验证：

```text
appendEntry
findEntriesOnBranch
branch
compaction
fork
seq
并发 writer
```

而**暂时不接 AgentDock production Agent Loop**。

这样能先证明一个核心目标：

```text
Session history = 1 GB

最新 compact working set = 5 MB

cold restore:
PG read ≈ 5 MB
而不是 1 GB
```

如果这个 spike 成功，等 Pi durable Harness 的 R1/R2/R4/R9 等 runtime slice 落地，我们再把它真正接进 AgentDock。

---

而且最新 Pi spec 已经明确把未来运行时 restore 设计成：

```text
lane.config
lane.state
lane.leaf
op.meta
op.state
```

几个 point lookup + bounded hydration，明确要求 **restore without history reads**；构造 provider context 才按 branch 查询到最近 compaction。

所以最终我们想达到的状态很可能是：

```text
PostgreSQL
├── 10GB 历史 conversation tree
├── old branches
├── usage
├── current lane
└── latest compact
        │
        │ 几 MB
        ▼
任意 Pi Worker
```

**Worker affinity、完整 JSONL 下载、512MB Pi checkpoint 上限，这几个问题会一起消失。**

我现在的建议是：可以研究 PG backend，但**先做兼容性/性能 spike，不要现在把 AgentDock production 全迁过去**。因为 Pi `main` 上刚定的新 Harness spec甚至计划把当前 `packages/agent/src/harness/**` 重写，0.84 的 backend API 还有较高概率继续变化。

下一步最有价值的就是把 **0.84 `SessionStorage` 的每个方法映射成一版 PostgreSQL schema/query**，看做到“1GB 历史、5MB cold restore”到底需要哪些索引。

## 135 · User · 2026-08-13T02:37:42.827Z

可以，看看吧，我看pi的仓库0.84.1也发布了，说明这也是一个stable版本吧，我们可以现在这个版本上面做尝试

## 136 · Assistant · 2026-08-13T02:38:15.431Z

可以，我觉得 **0.84.1 很适合现在做这个实验**。

它确实是正式 release：2026-08-07 发布，GitHub 标记 `draft=false`、`prerelease=false`。所以可以把它理解为正式稳定发布版，而不是 nightly/preview。

但“stable”不等于这套 Harness API 已经冻结。`v0.84.1 → main` 现在已经多了 117 个 commit，`SessionStorage`、JSONL backend、conformance 等仍然在改。 所以我建议 **固定死 0.84.1 做一个隔离 spike**，不要马上改 AgentDock 主链。

我们现在完全可以先实现：

```text
@agent-dock/pi-postgres-session

PostgresSessionRepo
        ↓
PostgresSessionStorage
```

先映射 0.84.1 的接口。

最小 PG schema 我觉得先这样就够：

```text
sessions
  session_id
  created_at
  parent_session_id
  next_seq

lanes
  session_id
  lane
  leaf_entry_id

entries
  session_id
  entry_id
  seq
  parent_id
  type
  payload
  timestamp

records
  session_id
  seq
  lane
  type
  payload

facts
  session_id
  kind
  key
  value
```

其中最值得验证的是这个查询：

```text
当前 leaf
   ↓
parent
   ↓
parent
   ↓
...
   ↓
最新 compaction  ← 到这里停止
```

在 PostgreSQL 可以直接 recursive CTE：

```text
leaf F
↓
E
↓
COMPACT
STOP
```

所以即使：

```text
整个 Session = 1 GB / 500,000 entries
```

只要最近 compaction 后：

```text
200 entries
≈ 5 MB
```

PG → Worker 就只返回这 200 条。

**不会存在 JSONL 下载。**

因为这时候：

```text
JSONL = 不存在
```

运行链路直接是：

```text
Pi Session API
      ↓
PostgresSessionStorage
      ↓
PostgreSQL
```

新 message 也是：

```text
Pi appendMessage()
↓
storage.appendEntry()
↓
INSERT INTO entries
```

所以格式语义仍然完全由 Pi 控制。

---

而且 Pi 还已经把第三方 backend 的 conformance suite 暴露出来了：

```ts
createSessionBackendConformance(...)
```



这个非常适合我们。

第一阶段甚至不用碰 AgentDock：

```text
PostgresSessionStorage
        ↓
Pi 官方 conformance suite
        ↓
全部通过
```

然后自己加一个 benchmark：

```text
生成 1 GB Session
↓
中间多次 compaction
↓
最新 working set 5 MB
↓
模拟 Worker cold open
```

测：

```text
PG 查询次数
PG → Worker bytes
恢复耗时
Worker heap
```

这个实验如果最后得到：

```text
1 GB total history

cold working-set read:
5.4 MB
42 ms
~200 entries
```

那就非常有说服力。

---

但现在有一个明确限制：

**0.84.1 暂时只能证明 storage 方案，不能直接替 AgentDock 生产 Agent Loop。**

因为 coding-agent 正式运行路径仍然大量使用旧 `SessionManager`：

```ts
SessionManager.open(sessionPath)
```



而能直接接受任意 `Session` backend 的新：

```text
createCodingAgentHarness()
```

虽然已经存在， 但 `AgentHarness.prompt()` 目前还没实现。

所以我们现在最合理的目标不是：

> “马上把 AgentDock 切 PG。”

而是：

> **先证明 Pi 的 SessionStorage abstraction 能让 Cloud Worker 的 Session I/O 从 O(total-history) 变成 O(active-working-set)。**

我觉得这个 spike 值得做，而且如果结果漂亮，甚至很适合作为后续给 Pi 社区提 Postgres backend 的基础。

## 137 · User · 2026-08-13T02:42:11.645Z

你觉得pi社区这个接收sessionbackend的接口还会变化吗

## 138 · Assistant · 2026-08-13T02:42:32.609Z

会，而且我判断 **大概率会有 breaking change**。

0.84.1 的 `SessionStorage` 目前还是这种风格：

```ts
appendEntry(...)
appendRecord(...)
getEntry(...)
findEntriesOnBranch(...)
findRecords(...)
getLanes(...)
...
```

当前 `main` 的实际代码暂时仍基本保持这个形状，只做了一些字段、查询语义上的调整，所以现在基于 0.84.1 做 prototype 并不会完全白做。

但 Pi 8 月 11 日刚定下来的 durable Harness 新 spec 已经明确准备把底层改成更通用的：

```ts
Storage {
  commit(Transaction)

  getEntries(ids)
  getRegister(...)
  listRegisters(...)

  scanBranch(...)
  scanEntries(...)
  scanUsage(...)

  close()
}
```

也就是说现在这种：

```text
SessionStorage.appendEntry()
SessionStorage.appendRecord()
```

未来很可能变成：

```text
Session
  ↓ 组装 transaction
Storage.commit([
  entry,
  register update,
  usage,
  ...
])
```

而且新 build plan 写得很激进：第一阶段甚至计划删除现有 `packages/agent/src/harness/**` 再按新模型重建。

所以我的判断大概是：

> **“可以插自定义 backend”这个能力基本不会消失，但 backend interface 的具体方法现在还不稳定。**

真正比较稳定的应该是这些**语义**：

```text
Session
  ↓
可插拔 storage backend

entry/tree 持久化
branch bounded query
lane 当前状态
storage 分配 seq/timestamp
单 Session writer
fork
facts / usage
```

具体 API：

```text
appendEntry()
findRecords()
```

还是以后：

```text
commit(Transaction)
getRegister()
scanBranch()
```

就很可能变化。

### 所以我还是支持现在做

但把它定位成：

> **Postgres Session Backend Spike**

而不是现在就写成 AgentDock 的长期生产组件。

代码最好这样隔离：

```text
AgentDock
   ↓
PiSessionBackendAdapter
   ↓
0.84.1 SessionStorage
   ↓
PostgreSQL
```

将来 Pi API 改了，只重写中间这一层：

```text
PiSessionBackendAdapter
```

PG schema、branch 查询、索引、writer fencing、benchmark 这些大量工作仍然可以保留。

尤其我们真正想验证的问题：

> **1GB Session 能不能只读取最近 compaction 后的 5MB working set**

这个结论跟 Pi 最后把接口叫 `findEntriesOnBranch()` 还是 `scanBranch()` 没什么关系。

所以我会说：**现在非常适合做实验，但不适合围绕 0.84.1 的 TypeScript interface 做大量工程化封装。**先把 PG 数据模型和 bounded-read 性能跑通最值钱。

## 139 · User · 2026-08-13T02:51:11.556Z

那这跟pg backend有什么关系，你是说pg不需要变，只要pi变，数据库和pi就能接上吗？

## 140 · Assistant · 2026-08-13T02:51:14.915Z

不是，我刚才那句话说得太轻了。**Pi 接口变，PG 这边有可能也要变，取决于我们现在把 PG schema 设计得多贴 0.84.1。**

比如如果我们现在照着 0.84.1 一比一建：

```text
entries
records
lanes
facts
```

因为 0.84.1 的 `SessionStorage` 本身就是：

```text
appendEntry
appendRecord
findRecords
getLanes
...
```



那 Pi 后面的新 Harness 真落地后，底层模型已经准备变成：

```text
entries
registers
usage_ledger
```

尤其 durable execution 的状态：

```text
lane.state
lane.config
op.meta
op.state
op.tool_args
pending.entry
```

都准备作为 **register 当前值** 存储，而不是不断追加 `record` 再回放。

那我们现在做的：

```text
records
```

表以后就很可能不合适。

所以准确地说：

```text
Pi API 变化
   ↓
Adapter 几乎肯定要改

Pi durable 数据模型变化
   ↓
PG schema 也可能要改
```

### 但有一部分 PG 工作不会白做

比如这些基本可以保留：

```text
entries
---------
session_id
entry_id
parent_id
seq
type
payload
timestamp
```

以及最重要的 branch 查询索引。

因为无论 0.84 还是最新设计，conversation tree 都还是：

```text
Entry
parentId
seq
```

最新设计甚至更明确规定 entry 是 immutable/write-once。

我们真正关心的：

```text
leaf
 ↓
parent
 ↓
...
 ↓
latest compaction
```

这个查询模型也不会因为 TypeScript 接口改名而消失。

---

所以我现在会稍微调整方案。

**不要严格按照 0.84.1 做完整 PG backend。**

先做最值钱的核心：

```text
sessions
entries
lane_heads
```

然后验证：

```text
1GB history
↓
从 leaf 查到最近 compaction
↓
只返回 5MB
```

把：

```text
appendRecord
findRecords
durable operation state
```

先别投入太多。

等 Pi 新 Harness storage contract 定下来以后，再加：

```text
registers
usage_ledger
writer lease
```

这样我们不会为了 0.84.1 写一大套马上被废弃的 `records` 模型。

换句话说：

> **PG backend 不是完全不用变；应该把“数据库中稳定的数据模型”和“Pi 当前版本的接口适配”分开。**

最终大概是：

```text
             Pi 0.84 adapter
            /
Postgres Core
            \
             Pi 0.85/0.86 adapter
```

其中 `Postgres Core` 里的 entry tree、branch bounded-read、索引和性能测试可以长期保留。

所以现在这个 spike 的第一目标甚至不用是“实现完整 `SessionStorage`”，而应该是先证明你最关心的事情：

> **Pi Session 历史再大，Cloud Worker 的冷启动读取量仍然只与 active context 大小有关。**

这个结论一旦证明了，后面的接口适配反而是工程问题。

## 141 · User · 2026-08-13T02:52:54.974Z

等等啊，我理解是如果我们做了session storage backend，那么在运行时pi会自动去这个backend找会话数据吗？还是说仍然需要我们把会话数据找出来喂给pi

## 142 · Assistant · 2026-08-13T02:52:58.225Z

对。**如果我们实现的是 Pi 新 `SessionStorage/SessionRepo` 接口，并把这个 `Session` 交给 `AgentHarness`，那么运行时是 Pi 自己按需调用 backend。我们不需要先把会话数据找出来再喂给 Pi。**

调用关系就是：

```text
AgentHarness
   ↓
Session
   ↓
SessionStorage
   ↓
我们的 PostgreSQL backend
```

例如 Pi 要构造当前 branch，会调用类似：

```ts
session.findEntriesOnBranch(...)
```

`Session` 再委托给：

```ts
storage.findEntriesOnBranch(...)
```

新 message 也是：

```text
Pi
↓
session.appendMessage()
↓
storage.appendEntry()
↓
PostgreSQL
```

这就是 `SessionStorage` 抽象存在的意义。0.84.1 的 `Session` 代码确实就是这么委托的。 

所以理想情况下完全不是：

```text
我们查 PG
↓
拿 5MB messages
↓
手工塞给 Pi
```

而是：

```text
Pi：我要当前 branch，遇到 compaction 停

            ↓

PostgresSessionStorage：
SELECT ...
返回需要的 entries

            ↓

Pi：构造 messages[]
```

这点非常重要，因为这样 **Pi 仍然拥有 Session 语义**，AgentDock 只负责物理存储。

---

比如以后 Pi 内部执行：

```ts
findEntriesOnBranch({
    start: currentLeaf,
    stopAtType: "compaction"
})
```

我们的 PG backend 收到这个调用以后执行 SQL：

```text
leaf
 ↓
message
 ↓
message
 ↓
compaction
 STOP
```

然后只把这些 entry 返回 Pi。

假设完整历史：

```text
1 GB
```

但最近 compaction 后：

```text
5 MB
```

那么理论上的数据流就是：

```text
PostgreSQL
  1 GB history
     │
     │ query result ≈ 5 MB
     ▼
Pi Worker
```

**1 GB 根本不会经过 Worker。**

`SessionStorage` 接口本身已经明确包含 `findEntriesOnBranch()`，并且支持 `stopAtType` / `stopAtId` 这种 bounded branch query。

---

唯一的问题还是我们刚才发现的那个时间点问题：

**0.84.1 的架构已经允许这样做，但真正的新 AgentHarness runtime 还没完成。**

0.84.1 的 `createCodingAgentHarness()` 已经允许调用方直接传：

```ts
session: Session
```

所以以后我们完全可以传：

```text
Session(PostgresSessionStorage)
```

进去。

但是当前 `AgentHarness.prompt()` 还是 `HarnessNotImplemented`，所以 AgentDock 现在使用的可用 Pi coding-agent loop 仍然走旧 `SessionManager + JSONL`。

所以可以这么理解：

```text
Pi 新架构的目标：

Pi 主动访问 PG backend        ✅

需要 AgentDock 手工加载历史     ❌


但 0.84.1 当前生产可用路径：

legacy SessionManager + JSONL   ← 还没切完
```

这也意味着：**一旦新 Harness runtime 完成，PG backend 对 AgentDock 的意义会非常大——不是“帮我们更快下载 JSONL”，而是把 JSONL 从运行链路里彻底拿掉。**

## 143 · User · 2026-08-13T02:55:40.468Z

哦，我懂了，就是类似提供给pi一个storage backend的地址，然后存和取都交给pi

## 144 · Assistant · 2026-08-13T02:55:44.157Z

对，就是这个意思。

更准确一点，不一定是“给 Pi 一个数据库地址”，而是你给 Pi 一个实现了它接口的 backend：

```text
PostgresSessionRepo
   └─ 内部知道 PG 地址、连接池、表结构
```

然后传给 Pi：

```text
Pi AgentHarness
    ↓
Session
    ↓
PostgresSessionStorage
    ↓
PostgreSQL
```

之后：

```text
读历史  → Pi 调 storage.findEntriesOnBranch()
写消息  → Pi 调 storage.appendEntry()
改 lane → Pi 调 storage.moveLane()
```

**存什么、什么时候取、取哪段，由 Pi 的 Session/Harness 逻辑决定；怎么落到 PostgreSQL、SQL 怎么写、索引怎么建，由我们这个 backend 决定。**

所以最终 AgentDock 不需要自己：

```text
查 PG → 拼 messages[] → 喂给 Pi
```

而是 Pi 自己通过 storage abstraction 操作数据库。

这也是为什么我觉得这条路线很适合 Cloud Agent：Pi Worker 可以真正变成接近无状态的执行节点。

## 145 · User · 2026-08-13T02:56:48.969Z

哇，确实，这个设计很棒

## 146 · Assistant · 2026-08-13T02:56:54.275Z

对，这个边界划得很漂亮：**Pi 管“会话语义和执行逻辑”，backend 管“数据怎么存”。**

对 Cloud 场景尤其合适，因为这样 Worker 不需要背着完整会话历史跑，只需要在执行时按需读当前 working set。这样一来，JSONL 更像一种本地/导出格式，而不是云端运行时必须依赖的介质。

我觉得这条线值得继续挖，尤其是 **PG backend + bounded branch read + cold restore**，很可能能直接解决我们前面纠结的巨大 session 下载问题。

## 147 · User · 2026-08-13T02:59:05.292Z

感觉很适合写在简历上，继续挖这条线，你是说pi目前预留了这个接口，但是实际的pi runtime还是只从本地jsonl中读会话数据是吗

## 148 · Assistant · 2026-08-13T02:59:32.454Z

对，**现在可以这么理解，而且这恰恰是这条线有意思的地方。**

当前实际上存在两套路径。

旧的、真正成熟可用的 `pi-coding-agent` runtime 还是：

```text
AgentSession
   ↓
SessionManager
   ↓
本地 session.jsonl
```

当前 `main` 里切换/恢复会话仍然直接：

```ts
SessionManager.open(sessionPath)
```

持久化 session 本质上还是本地 JSONL。

而 Pi **正在建设的新路径**是：

```text
AgentHarness
   ↓
Session
   ↓
SessionStorage / SessionRepo
   ↓
任意 backend
```

`createCodingAgentHarness()` 已经直接接收 `options.session`，再交给 `AgentHarness.create()`；它并不要求这个 Session 后面必须是 JSONL。

所以未来完全可以是：

```text
AgentHarness
     ↓
Session
     ↓
PostgresSessionStorage
     ↓
PostgreSQL
```

问题只是 **Harness runtime 还没填完**。当前 main 的 `AgentHarness.create()` 遇到已有 durable record 仍会抛 `HarnessNotImplemented("create.restore")`，`prompt()` 等核心执行路径也仍是 scaffold。

所以现在的状态非常像：

```text
                     已成熟
Pi coding-agent ─────────────→ SessionManager → JSONL
       │
       │ 正在迁移
       ▼
AgentHarness ────────────────→ SessionStorage → JSONL / SQLite / PG / ...
                              ↑
                         接口已经出现
```

这也是为什么我觉得它**很适合写到你的项目里**。

因为你不是凭空魔改 Pi，而是在提前实现 Pi 自己已经明确走向的一个 Cloud use case：

> 本地 Pi 用 JSONL/SQLite；Cloud Pi 使用 remote PostgreSQL Session backend，实现无 Worker affinity、无需下载完整 Session、按 compaction working set 做 bounded restore。

如果最后能做到例如：

```text
完整 Session     1 GB
最新有效上下文    6 MB

旧方案：
Worker cold start → 下载/恢复 1 GB

PG backend：
Worker cold start → 查询约 6 MB
```

这个简历价值其实挺高。它既不是简单 CRUD，也不是“套一个 Pi SDK”，而是一个明确的 **Cloud Agent runtime / session virtualization** 问题。

不过我建议我们下一步继续挖的重点不是马上写 SQL，而是先把 **Pi 新 Harness 在一次普通 Agent Loop 中到底会对 SessionStorage 发哪些 read/write** 搞清楚。这样我们才能知道 PG backend 真正需要优化的是哪些查询。

## 149 · User · 2026-08-13T03:04:14.916Z

可以，继续挖

## 150 · Assistant · 2026-08-13T03:05:47.838Z

继续挖下来，我觉得这条线已经非常明确了：**Pi 新 Harness 的 storage 模型其实天然更适合 PostgreSQL，而不是 JSONL。**

最关键的是两个不同的读路径。

### 1. Worker 恢复：几乎不读历史

Pi 最新 spec 对 crash/cold restore 写得非常明确：

```text
lane.config
lane.state
lane.leaf
op.meta
op.state
```

最多先做这 **5 个 register point lookup**，然后根据 `op.state` 里直接引用的 entry ID，再批量取少量 entry / tool args / pending entry。

它明确要求：

> recovery 不扫描 history、不 replay journal、不 walk conversation tree。



所以如果后面是 PG：

```text
Worker启动
   ↓
SELECT lane.*
SELECT op.*
SELECT entries WHERE id IN (...)
```

哪怕这个 Session 已经有 **10GB 历史**，恢复成本基本不变。

---

### 2. 真正调用 LLM 时：才读取当前 working set

每次要构造 provider context，Pi 的设计是：

```ts
scanBranch({
  start: leaf,
  order: "newestFirst",
  stopAtType: "compaction"
})
```

一旦遇到最近的 compaction 就停止。

然后：

```text
compaction.summary
+ retainedTail
+ compaction 后的 entries
```

更早的内容明确写着：

> **Nothing earlier is read.**



所以一个实际 Agent Loop 很可能是：

```text
PG
│
├─ 10 GB 完整历史
│
├─ 当前 op.state
│
└─ 最近 compact 后 5 MB
       │
       ▼
    Pi Worker
       │
       ▼
      LLM
```

这已经完全符合我们之前想要的 Cloud Worker 模型。

---

### 一次普通 Agent Loop 对 PG 做什么

假设最简单：

```text
user
↓
LLM
↓
assistant final
```

新 Harness 的逻辑大概是：

```text
① prompt acceptance
PG TX:
  INSERT user entry
  UPDATE lane.leaf
  INSERT op.meta
  UPSERT op.state
  UPSERT lane.state

② 准备 generation
PG TX:
  UPSERT op.state = assistant.ready

③ 构造 LLM context
PG READ:
  scanBranch(leaf → latest compaction)

④ provider intent
PG TX:
  UPSERT op.state = effect_pending
  预留 responseId / usageId

⑤ 调 LLM
不碰 PG

⑥ LLM 完成
PG TX:
  INSERT assistant entry
  INSERT usage
  UPDATE lane.leaf
  UPSERT op.state

⑦ run 结束
PG TX:
  DELETE op.*
  UPSERT lane.lastResult
  UPDATE lane.state = idle
```

这些 transaction shape 都是 Pi 新 spec 直接定义的。

所以你会发现一个很有意思的事情：

**PG backend 不只是解决“大 JSONL 下载”。它其实非常符合 Pi durable Harness 的数据形态。**

因为：

```text
entries       append-only
usage         append-only
registers     current state，反复覆盖
```

Pi 最新 storage model 就明确只剩这三类。

数据库特别适合：

```sql
entries       INSERT
usage_ledger  INSERT
registers     UPSERT / DELETE
```

而 JSONL 为了表示：

```text
op.state=A
op.state=B
op.state=C
DELETE op.state
```

只能不断 append，之后还得做 snapshot compaction。

Pi 自己的 spec 都专门指出了这个问题。

---

### 有 Tool 时更有意思

例如：

```text
user
↓
LLM
↓
bash
↓
tool result
↓
LLM
↓
answer
```

每一个真实 tool 都是：

```text
PG TX
op.tool_args = args
op.state = effect_pending

↓
真正执行 bash

PG TX
INSERT tool result
UPDATE lane.leaf
op.state = completed
```

然后第二次调用 LLM：

```text
scanBranch(
  当前 leaf
  → 最近 compaction
)
```

再构造新的 messages。

所以 **`scanBranch()` 会成为 PG backend 最重要的 read hot path**。

这比 `open()` 还值得优化。

---

### 这给我们 PG schema 的方向也变清楚了

我现在甚至不建议按照 0.84.1 的 `records` 模型做。

直接按照 Pi 刚确定的新 storage model 思考：

```text
sessions

entries
  session_id
  id
  parent_id
  seq
  type
  payload
  timestamp

registers
  session_id
  namespace
  key
  seq
  value

usage_ledger
  session_id
  id
  seq
  entry_id
  payload
```

再加一个 **branch index**。

因为 Pi 自己在 SQLite backend 里都没有简单靠 `parent_id` 每次递归，而是专门设计了：

```text
branch_entries
branch_meta
```

的 segmented branch cache，目的就是保证 runtime `scanBranch()` 不退化成全表扫描或无界 parent walk。

这其实是我们下一步最值得研究的点：

> **PostgreSQL 里 `scanBranch(leaf → latest compaction)` 到底应该用 recursive CTE，还是也应该维护类似 Pi SQLite 的 segmented branch index？**

这个问题就开始真正进入“值得写简历”的技术深度了。

因为如果只是：

```text
JSONL → PostgreSQL
```

没什么特别。

但如果做到：

> **为 Cloud Agent 构建 remote Pi Session backend，使 cold restore 与历史长度解耦，并针对 compaction-bounded context reconstruction 设计 branch index。**

这就很像一个真正的 Agent Runtime 基础设施项目了。

## 151 · User · 2026-08-13T03:16:39.084Z

有点太深奥了，没太懂，能举几个例子吗

## 152 · Assistant · 2026-08-13T03:16:43.127Z

可以，我们先完全不讲那些术语，就看几个具体例子。

假设一个会话已经聊了很久：

```text
1 user: 帮我写登录功能
2 assistant: ...
3 user: 再加 JWT
4 assistant: ...
...
5000 条历史

5001 compaction:
     summary = “之前完成了登录、JWT、权限系统……”
     retainedTail = 最近几条重要消息

5002 user: 现在修这个 bug
5003 assistant: 我先看看代码
```

这时候完整历史可能已经 **1GB**。

### 例子 1：Worker 刚接手这个会话

旧 JSONL 模式基本是：

```text
S3
1GB jsonl
 ↓
全部下载
 ↓
Pi Worker
```

PG backend 模式则可以是：

```text
Pi: 当前会话在哪？
PG: leaf = 5003

Pi: 当前运行状态是什么？
PG: 没有进行中的 tool / operation

Pi: 好
```

这里只查几行数据库。

**1GB 历史完全没读。**

---

### 例子 2：用户又说一句话

用户：

```text
5004 user: 继续修
```

Pi 要调用 LLM，这时候它才需要 messages[]。

于是 Pi 问 PG：

```text
“从 5004 往前找，
找到最近一个 compaction 就停。”
```

PG 返回：

```text
5004 user: 继续修
5003 assistant: 我先看看代码
5002 user: 现在修这个 bug
5001 compaction: 之前完成了登录、JWT、权限系统……
```

假设一共只有 5MB。

于是：

```text
PG 里：1GB 历史
          ↓
       只返回 5MB
          ↓
      Pi Worker
          ↓
        LLM
```

**这就是我们最关心的效果。**

---

### 例子 3：LLM 调了 bash

LLM 返回：

```text
assistant:
我要先运行测试

tool_call:
npm test
```

Pi 在 PG 里先记：

```text
当前状态：
“马上要执行 npm test”
```

然后 Tool Broker 真正执行：

```text
npm test
```

结果：

```text
3 tests failed
```

Pi 再把它存入 PG：

```text
5005 assistant: 我要先运行测试
5006 tool_result: 3 tests failed
```

接下来 Pi 又要调用一次 LLM。

它再次问 PG：

```text
“从 5006 往前，找到最近 compaction。”
```

PG 返回：

```text
5001 compaction
5002 user
5003 assistant
5004 user
5005 assistant/tool_call
5006 tool_result
```

还是大概只有几 MB。

所以一次 Agent Loop 其实大概是：

```text
查最近 context
→ LLM
→ 存 assistant/tool call
→ 执行 tool
→ 存 tool result
→ 再查最近 context
→ LLM
```

而不是每次：

```text
下载整个 1GB 会话
```

---

我刚才提到的 `branch index`，你暂时可以把它理解成一个**加速目录**。

比如你有 100 万条历史，Pi 问：

> 从 5006 往前找到最近 compaction。

最笨的方法：

```text
5006 → 查 parent
5005 → 查 parent
5004 → 查 parent
5003 → ...
```

一次一条往前走。

如果最近 compaction 就在 5001，其实还好。

但假设中间有很多 branch：

```text
100
├─ 101 → 102 → 103
│
└─ 201 → 202 → 203 → 204
```

那数据库要非常清楚：

> 当前 leaf=204 属于哪条路径？

`branch index` 就像提前维护一本目录：

```text
branch B:
100 → 201 → 202 → 203 → 204
```

于是 PG 可以直接知道应该读哪一段，不用临时一点点找。

不过**这个现在可以先不管**。

你目前只需要抓住一句：

> **PG backend 的核心价值，就是 Pi 自己按需从数据库取“当前需要的那几 MB”，而不是 AgentDock 把完整 Session 下载给 Worker。**

这个概念先吃透就够了。

## 153 · User · 2026-08-13T03:20:28.104Z

诶，那现在codex的源码，codex在加载会话的时候也是从头replay吗

## 154 · Assistant · 2026-08-13T03:21:44.229Z

对，但要分成两层看。**Codex 现在比 Pi 旧 JSONL 稍微先进一点，但还没有做到我们刚才说的 PG backend 那种 bounded load。**

当前 Codex resume 时，持久化会话还是一个 rollout，恢复后的结构直接是：

```rust
ResumedHistory {
    history: Arc<Vec<RolloutItem>>,
    ...
}
```

也就是说，**当前实现仍然先把整个 rollout materialize 成 `Vec<RolloutItem>`**。

但接下来构造真正给模型的 history 时，Codex **已经不会傻乎乎从第 1 条一直 replay 到最后**。

它现在会：

```text
完整 rollout
1
2
3
...
5000
5001 COMPACTION + replacement_history
5002
5003
5004
```

先从**后往前扫描**：

```text
5004 ←
5003 ←
5002 ←
5001 COMPACTION
       找到 replacement_history
       ↓
       可以停
```

源码注释写得很明确：

> 找到最新仍有效的 replacement-history checkpoint 后，更老的 rollout items 不再影响 rebuilt history。

然后真正重建 context 时：

```text
replacement_history
+
5002
5003
5004
```

而不是重新处理 1～5000。

所以：

```text
              Codex 当前
磁盘读取      ❌ 仍偏全量
内存 materialize ❌ 整个 rollout Vec
history 重建  ✅ 从尾部找 checkpoint
LLM context   ✅ checkpoint + 后续
```

最有意思的是，Codex 开发者**已经意识到这个问题了**。

源码里直接写：

```text
future lazy reverse loader
```

而且还说当前：

> `history materialization still uses an eager bridge`

以及未来应该：

> 从 resumable reverse source 驱动，而不是 eagerly loaded `&[RolloutItem]`



也就是说，他们想做的未来版本其实就是：

```text
现在：

rollout 1GB
   ↓
先读 1GB
   ↓
倒着找到 compact
   ↓
实际只用 5MB


未来：

rollout 1GB
   ↓
直接从尾部倒着读
   ↓
找到 compact
   ↓
只读取 5MB
```

这和我们刚才讨论 Pi + PG 的思路**高度相似**。

区别在于 PG backend 会更自然：

```text
Codex future:
JSONL / rollout
     ↓ reverse lazy reader
最近 checkpoint + tail


Pi + PG:
PostgreSQL
     ↓ bounded branch query
最近 compaction + tail
```

所以你刚才问的这个问题其实挺有价值：**Codex 当前也还存在“完整持久化历史先 materialize”的问题，而且源码已经明确准备消灭它。**

这反而说明你给 AgentDock 做 **remote Session backend + bounded restore** 不是一个很偏门的优化，而是 Coding Agent runtime 正在实际面对的问题。

## 155 · User · 2026-08-13T03:37:32.765Z

是啊，那说明倒着读是可行的，但是如果可以只读出需要的那部分，那甚至都不需要倒着读了，我可以理解为jsonl这种文件格式不适合快速找出切点吗？

## 156 · Assistant · 2026-08-13T03:37:37.556Z

对，你可以这么理解。

**JSONL 的问题不是“不能倒着读”，而是它本身没有索引，不知道切点在哪。**

比如：

```text
1   user
2   assistant
...
5000 assistant
5001 COMPACTION
5002 user
5003 assistant
...
9000 assistant
```

你问：

> 最近一次 compaction 在哪？

JSONL 本身只是一串字节：

```text
[file beginning] ......................... [file end]
```

它没有一个东西告诉你：

```text
latest_compaction_offset = 783,442,901
```

所以最原始的办法就是：

```text
从文件尾部往前找
→ 9000
→ 8999
→ 8998
→ ...
→ 找到 COMPACTION
```

这就是 Codex 想做的 lazy reverse reader。

---

但 PostgreSQL 不一样。

我们可以直接有索引：

```sql
entries(
  session_id,
  seq,
  type,
  ...
)
```

并建：

```sql
INDEX(session_id, type, seq DESC)
```

于是想知道最近 compaction：

```sql
SELECT seq
FROM entries
WHERE session_id = ?
  AND type = 'compaction'
ORDER BY seq DESC
LIMIT 1;
```

数据库可以几乎直接定位到：

```text
5001
```

然后：

```sql
SELECT *
FROM entries
WHERE session_id = ?
  AND seq >= 5001
ORDER BY seq;
```

就把需要的部分读出来。

所以你说得很准确：

```text
JSONL
“不知道切点”
↓
只能扫描 / 倒着找

数据库
“切点可以被索引”
↓
直接定位
↓
只读需要的数据
```

不过还有一个小细节：Pi 有 branch，所以不能永远简单写成 `seq >= latest_compaction`。例如：

```text
      100
     /   \
   101   201
   102   202 COMPACT
   103   203
```

当前 leaf 如果是 `103`，你不能取另一条 branch 上的 `202 COMPACT`。

所以真正的问题是：

> **“当前这条 branch 上最近的 compaction 是哪个？”**

但本质仍然一样：**数据库允许我们为这个查询设计索引/branch metadata，从而直接定位；JSONL 天生更接近顺序日志，需要扫描才能知道。**

这也是为什么我现在觉得 PG backend 的价值不只是“网络存储”。

它其实把：

```text
session = 一个巨大顺序文件
```

变成了：

```text
session = 一个可查询的数据结构
```

这个区别才是最核心的。

## 157 · User · 2026-08-13T03:43:06.162Z

哇，感觉要是这个能做成的话，那agent dock架构里的mino S3是不是可以拿掉了

## 158 · Assistant · 2026-08-13T03:43:09.674Z

**不能整个拿掉，但可以拿掉其中“Pi Session 持久化”这一块。**

你现在 AgentDock 里 S3/MinIO 大概承担两类完全不同的东西：

```text
S3 / MinIO
├─ Pi session.jsonl checkpoint   ← PG Session Backend 可以干掉
└─ Workspace checkpoint / Kopia ← 还需要
```

如果 PG backend 真接进 Pi：

```text
现在：
Pi Worker
  ↓
S3 下载 session.jsonl
  ↓
Pi restore


以后：
Pi Worker
  ↓
PostgreSQL Session Backend
  ↓
按需读取 entry / register
```

那么这些东西都可以删：

```text
Pi session manifest
Pi session segments
S3 session checkpoint
512MB session snapshot limit
restorePiSessionManifest()
完整 JSONL 下载/解压/重建
```

这会让 AgentDock 架构明显简单一截。

但 **Workspace 不一样**。比如用户让 coding agent：

```text
修改 20GB repo
npm install
编译
生成大量文件
```

这些不是 Session 数据，不能合理地塞 PostgreSQL。

所以 Workspace 仍然需要：

```text
Cube microVM
   ↓ checkpoint
Kopia
   ↓
S3 / MinIO
```

也就是说未来很可能变成：

```text
PostgreSQL
├─ Run / Turn / business state
└─ Pi Session
   ├─ entries
   ├─ registers
   └─ usage

S3 / MinIO
└─ Workspace checkpoint
```

我反而觉得这个架构**比现在干净很多**：

> PG 管结构化 Agent 状态，S3 管大块文件系统状态。

而不是现在：

> PG 一部分状态 + S3 一份 Pi Session + S3 又一份 Workspace。

所以如果这条线做成，**MinIO/S3 不会消失，但职责会大幅收窄。**这对 AgentDock 是个挺实质性的架构简化。

## 159 · User · 2026-08-13T03:47:51.998Z

我记得现在agent dock存储完整对话的时候是不是在pgsql存了一份，在mino s3存了一份。然后pgsql里面还用了内容寻址，如果我们用session storage backend，这一块是不是都重新设计。还有一个问题，workspace，我理解就是存储挂载是吗？cubesandbox难道没提供方案怎么管理这些workspace吗？像我平时在k8s里面起一台虚拟机，挂载存储盘，存储盘也是k8s管理的呀

## 160 · Assistant · 2026-08-13T03:50:37.899Z

对，这两块都应该重新看，而且我发现你对 Workspace 的理解是对的。

先说会话。**当前 AgentDock 确实保存了两份“语义上重叠、用途不同”的完整会话数据。**

```text
PostgreSQL
conversation_turn_projections
→ 每个 terminal Turn 保存完整 transcript JSONB

S3 / MinIO
Pi session manifest + segments
→ 保存 Pi 原生 session.jsonl checkpoint
```

PG 的 `conversation_turn_projections.transcript` 确实直接保存完整 JSONB。

而 S3 那份 Pi Session 才是明显的内容寻址：每个 segment 有 SHA-256，整个 session 也有 SHA-256，manifest 引用这些 segment。

所以你记忆里“PG 也做了内容寻址”这里稍微有点偏差：**PG 的 transcript 本身不是 content-addressed storage；PG 更多是在保存投影和 S3 artifact 的引用/哈希元数据。**

如果以后切到 Pi 的 PostgreSQL Session backend，我觉得这部分确实应该重构成：

```text
PostgreSQL

AgentDock 业务状态
├─ session / turn / run
│
Pi Session Backend
├─ entries
├─ registers
└─ usage
│
UI Read Model（可选保留）
└─ conversation_turn_projections
```

这时候：

```text
S3 Pi session.jsonl
Pi session manifest
Pi session segments
pi_session_snapshot_key
```

这一整条都可以消失。

但 `conversation_turn_projections` **不一定马上删**。它可以降级成纯 UI/read model：

```text
Pi Session = Agent 真正的会话 authority
conversation_turn_projections = 给前端快速显示的投影
```

这样就合理了，不再是“两套 authority”。

---

然后是 Workspace。

你说：

> Workspace 不就是挂载存储盘吗？

**是。**

而且我刚查你的当前代码，AgentDock **已经这么干了**。

你现在已经有：

```text
Cube Volume
     ↓
agentdock-posix Volume Plugin
     ↓
共享 POSIX filesystem
     ↓
/workspace
     ↓
Cube microVM
```

你的 `agentdock-posix` plugin 在 `attach` 时直接返回宿主侧 `workspace_path`，Cube 再把它挂进 microVM。

而 README 也明确写着：

```text
physical Volume
└── workspace/
        ↓
   /workspace
```



所以你说的：

> 我在 K8s 起 VM，挂一块盘，盘是平台管理的。

这个类比基本正确。

CubeSandbox 0.6 已经正式提供 Volume 生命周期：

```text
Volume.create()
Volume.destroy()

Sandbox.create(
    volume_mounts={"/workspace": volume}
)
```

Volume 生命周期独立于 Sandbox，同一个 Volume 甚至可以挂给多个 Sandbox。

而它的架构跟 Kubernetes CSI 非常像：

```text
CubeMaster
  Create / Destroy

Cubelet
  Attach / Detach

Storage Plugin
  NFS / Object Storage / Distributed FS / ...
```

官方文档也明确说这个设计受 Kubernetes CSI 启发。

---

那为什么 AgentDock 现在还有 Kopia？

关键区别其实只有一句话：

> **Persistent Volume 解决“文件别丢”；Kopia checkpoint 解决“我要恢复到某一个确定版本”。**

例如：

```text
Turn 1
/workspace
A.java = v1

checkpoint X
```

下一轮：

```text
Turn 2
Agent 把 A.java 改坏了
又删了 20 个文件
然后 Worker / Tool 崩了
```

只有一个普通持久 Volume 的话：

```text
/workspace = 已经改坏的状态
```

它不会自动告诉你：

> 给我恢复到 Turn 1 完成时的 Workspace。

而 Kopia 给你的其实像：

```text
Workspace

commit X ← Turn 1
commit Y ← Turn 2
commit Z ← Turn 3
```

所以你的当前 README 才会做：

```text
Cube Volume = 当前可写 Workspace

          ↓ snapshot

Kopia = immutable Workspace versions

          ↓

PostgreSQL
current_workspace_version = X
```



---

不过现在有一个**很值得继续挖的地方**。

Cube 自己其实也有：

```text
Snapshot
Clone
Rollback
```

CubeCoW 能做 filesystem + memory snapshot，并支持从 snapshot clone/rollback。

所以问题变成了：

```text
我们真的还需要：

Cube Volume
   ↓
Data Mover
   ↓
Kopia
   ↓
S3
```

还是可以变成：

```text
Cube Volume / snapshot-capable backend
   ↓
snapshot X
snapshot Y
snapshot Z
```

如果后者能满足：

```text
跨节点恢复
immutable checkpoint
clone / fork
rollback
fencing
长期持久化
宿主机挂掉数据不丢
```

**Kopia 这一整层就可能删掉。**

但现在还不能直接下结论说 CubeCoW 已经能替代，因为 Cube 当前 roadmap 仍把 **Cross-Node Pause/Resume** 和 **Cross-Node Snapshot-Based Sandbox Launch** 列为后续能力。

所以我觉得下一步特别值得研究的是：

> **CubeSandbox 0.6 的 Volume + CubeCoW，到底能不能直接满足 AgentDock 的 Workspace durable checkpoint 语义。**

如果也能满足，那这次重构会非常大：

```text
现在：

PG
S3 Pi Session
S3 Kopia Workspace
Cube Volume


未来可能：

PG
├─ AgentDock state
└─ Pi Session

Cube Storage
└─ Workspace + snapshots
```

那 **MinIO/S3 甚至真有可能从 AgentDock 主运行链路里彻底消失**，只作为备份/灾备可选项。这个方向我觉得比单纯优化 Kopia 更值得继续挖。

## 161 · User · 2026-08-13T05:11:27.872Z

例如：

```
```

```
Turn 1
/workspace
A.java = v1

checkpoint X
```

下一轮：

```
```

```
Turn 2
Agent 把 A.java 改坏了
又删了 20 个文件
然后 Worker / Tool 崩了
```

只有一个普通持久 Volume 的话：

```
```

```
/workspace = 已经改坏的状态
```

它不会自动告诉你：

> 给我恢复到 Turn 1 完成时的 Workspace。

你举的这个例子，其实我不太懂，什么时候会要求说给我恢复到turn 1完成时的workspace。虽然这是codex实现的，但也可能是我表达我对崩溃恢复需求时表达得太重了。所以我们需要讨论一下这种级别的恢复在cloud环境里是不是必要的。毕竟在local环境里，我平常使用codex的时候，还偶尔会出现wsl宕机了的情况，然后我重启后也就是轻飘飘地说一句，刚刚宕机了，你继续。只要会话数据都保留了，workspace是否需要turn级别的恢复呢。如果不需要turn级别的恢复，现在的harness是否有告知llm刚刚发生过中断

## 162 · Assistant · 2026-08-13T05:14:26.030Z

对，我现在反而倾向于：**我们之前把 Workspace 的恢复语义设计重了。**

Coding Agent 更自然的崩溃恢复，可能不是：

```text
崩溃
→ Workspace 回滚到上一个 Turn
→ 重新执行
```

而是：

```text
崩溃
→ Workspace 保留宕机现场
→ 新 Worker 接手
→ Agent 知道“刚才有操作中断”
→ 检查当前文件状态
→ 继续
```

这和你本地用 Codex 的体验更一致。

比如：

```text
Turn 2
A.java 改了一半
npm test 刚执行
↓
Pi Worker 挂了
```

我现在觉得合理的恢复应该是：

```text
Persistent Volume
A.java = 改了一半的状态     ← 保留

PG Session
tool = effect_pending       ← 记得刚才工具没确定完成

新 Worker
↓
重新挂这个 Volume
↓
Pi 恢复 Session
↓
LLM 检查 git diff / 文件
↓
继续
```

**完全没必要自动恢复到 Turn 1。**

而且自动回滚甚至可能是坏事：Agent 花了十分钟改了 20 个文件，第 21 个文件时 Worker 崩了，你把前 20 个文件的有效工作全撤销了。

---

至于你问的关键问题：**Pi 新 Harness 会不会告诉 LLM“刚刚中断了”？**

答案是：**对于某些中断，会，而且设计得比简单塞一句“刚崩了”更精确。**

例如 tool 已经开始执行：

```text
assistant
→ tool: rm / edit / bash
→ Harness 写下 effect_pending
→ tool 执行到一半
→ CRASH
```

如果这个 tool 标记为：

```text
replay: "never"
```

Pi 恢复后不会重新执行，而是生成一个 synthetic tool result，大意就是：

```text
tool_result:
interrupted
```

然后继续 Agent Loop。

这样下一次 LLM 实际看到的是：

```text
assistant:
我来修改这些文件

tool_call:
...

tool_result:
interrupted

← LLM 从这里继续
```

所以模型天然知道：

> 刚才这个操作的结果不确定，我应该看看 Workspace 现在是什么状态。

这恰好非常适合**保留 crash-site Workspace**。

---

但 Pi 并不是所有崩溃都会硬塞一句“系统刚才崩溃了”。

比如 LLM 正在生成：

```text
provider request
→ effect_pending
→ Worker crash
```

恢复后如果 retry policy 允许，Pi 会直接开始 attempt 2；只有不能继续 retry 时才会落 synthetic error。

如果只是：

```text
Turn 1 完成
↓
Worker 挂了
↓
用户发 Turn 2
```

这种中间根本没有 uncertain effect，也就没必要告诉模型“Worker 曾经挂过”。

所以 Pi 的设计其实是：

> **不告诉 LLM“机器发生了什么”，而告诉它“哪个 Agent effect 的结果现在不确定”。**

我觉得这个语义更好。

---

这会直接改变我们对 Workspace 的设计。

我现在倾向于把：

```text
每个 Turn
→ Kopia immutable checkpoint
→ PG 发布 Workspace head
→ 失败就 rollback
```

从 **crash correctness 必需品** 降级为 **可选版本能力**。

真正的 crash correctness 可能只需要：

```text
Cube Persistent Volume
+
writer fencing
+
Pi durable Session
+
uncertain effect recovery
```

Workspace snapshot 仍然可以用于：

- 用户明确点“回滚”
- fork 一个历史 Workspace
- 灾备/宿主机磁盘损坏
- 重要 checkpoint

但**不用每个 Turn 都 checkpoint**。

最后还有一个当前 AgentDock 的细节：我确认你现在确实专门有 `pi_interrupted_session_snapshot` artifact 类型， 但这个只是“保存中断 Pi Session”的 artifact，**不能等同于 LLM 一定能看到“刚发生中断”**。这一点我们现有 legacy Pi 路径还应该再检查。

如果最终采用 Pi 新 Harness，上面那个 `synthetic interrupted tool result` 反而已经给了我们一个很干净的机制。

我现在越来越觉得新的恢复目标应该写成一句很简单的话：

> **崩溃后不回滚 Workspace；保留最后落盘状态，并让 Agent 从明确标记的 uncertain effect 继续。**

这个比“每 Turn 事务化 Workspace”更像真正的 Coding Agent。

## 163 · User · 2026-08-13T05:23:47.716Z

不不，我觉得按这么想的话，workspace snapshot完全可以拿掉呀

1. 用户明确点“回滚” 
2.  fork 一个历史 Workspace 
3.  灾备/宿主机磁盘损坏 
4.  重要 checkpoint

你提的这4个点，我觉得就灾备/宿主机磁盘损坏需要防备一下，但这个能不能交给k8s来做，而不是我们自己做一个上传mino s3，照这个想法，是不是mino s3可以完全拿掉了

## 164 · Assistant · 2026-08-13T05:24:57.983Z

对。按照你现在重新定义的恢复目标，**MinIO/S3 很可能可以从 AgentDock 的核心架构里完全拿掉。**

关键变化在于，我们不再要求：

```text
每个 Turn
→ Workspace snapshot
→ immutable version
→ S3
→ 出错时 rollback
```

而只要求：

```text
Workspace = 一块可靠的持久盘

Cube 挂了      → 盘还在
Pi Worker 挂了 → 盘还在
节点挂了       → 换节点重新挂盘
下一轮 Agent   → 看到宕机时留下的真实现场
```

这其实更接近你本地用 Codex 的体验。

### 但有一个术语需要卡准

不是：

> Kubernetes 帮我保存数据。

而是：

> **Kubernetes/Cube 帮我管理 Volume 生命周期，底层存储系统负责数据持久性和副本。**

Kubernetes 的 PVC / StorageClass 本来就是为这种事情设计的：Pod/计算实例消失后，持久卷可以继续存在，并由 CSI 存储系统重新挂载。

例如：

```text
Cube microVM A
      │
      ▼
 /workspace
      │
      ▼
Persistent Volume
      │
      ▼
CephFS / Longhorn / 云盘 / NFS / ...
```

A 挂掉：

```text
Cube microVM A  ✕


Persistent Volume   ← 仍然存在
      │
      ▼

Cube microVM B
      │
      └──重新挂 /workspace
```

CubeSandbox 0.6 自己的 Volume Framework 就是为了这个目的存在的，而且官方明确支持把 **NFS、分布式文件系统、对象存储等任意 backend** 接进 Cube Volume。Volume 生命周期也独立于 Sandbox。

所以我们的架构甚至可以变成：

```text
Pi Worker
    │
    │ tool
    ▼
CubeSandbox
    │
    ▼
Cube Volume
    │
    ▼
distributed persistent storage
```

### 那宿主机硬盘坏了怎么办？

如果你现在这样：

```text
Cube Volume
↓
/data/local-disk/workspace
```

那当然不行：

```text
node disk 坏
→ workspace 没了
```

但如果 Volume 后面是：

```text
CephFS / replicated block storage / NFS HA / 云盘
```

那：

```text
Node A
  disk ✕

        ↓

存储系统有副本

        ↓

Node B
重新挂载
```

这已经属于**存储基础设施的职责**，AgentDock 自己没必要再：

```text
tar/kopia
→ 上传 MinIO
→ 保存 snapshot id
→ 自己 restore
```

Cube 官方文档自己也建议多节点场景使用 shared storage，让不同 sandbox node 能看到同一个持久文件系统。

---

这样重新看 AgentDock，MinIO 当前最重要的两条理由都会消失：

```text
MinIO
├─ Pi session.jsonl        → PG Session Backend 替代
└─ Kopia Workspace snapshot → Persistent Volume 替代
```

于是核心架构可以变成非常漂亮的：

```text
PostgreSQL
├─ AgentDock control state
├─ Pi Session Backend
└─ conversation/read models

Kafka
└─ durable live event log

Valkey
└─ live SSE projection

CubeSandbox
└─ Persistent Workspace Volume

Temporal
└─ orchestration
```

**没有 MinIO，没有 Kopia，没有 Pi JSONL checkpoint，没有 Workspace checkpoint pipeline。**

我觉得这个版本明显更合理。

---

不过我再提醒一个区别：**“宿主机损坏”和“灾备”不是完全一回事。**

如果你说的灾备只是：

```text
一台 Cube node 挂了
一块本地盘坏了
```

那 replicated storage 足够。

如果所谓灾备是：

```text
整个 Kubernetes 集群炸了
整个机房丢了
Ceph 集群一起没了
```

那还是需要 backup。

但那个 backup 应该是：

```text
Infrastructure backup
```

例如存储平台自己定期做：

```text
VolumeSnapshot / remote backup
```

Kubernetes 本身也有标准的 `VolumeSnapshot` API，由 CSI driver 实现。

**这不应该进入 AgentDock 的 Turn execution protocol。**

也就是说：

```text
错误设计：

AgentDock 每 Turn
→ Kopia
→ MinIO
→ PG workspace version
```

可以换成：

```text
AgentDock：
“给这个 Session 一个 persistent workspace volume”
          ↑
          就到这里


运维层：
CSI / storage backend
→ replication
→ backup
→ disaster recovery
```

我觉得这是一次很重要的职责边界修正。

还有最后一个小尾巴：你现在 `artifacts` 里还有 `tool_output / patch / report / crash_bundle` 这些带 `object_key` 的通用 artifact 类型，所以**代码层面现在还不能直接删掉整个 object-store abstraction**。

但这些并不是 Agent runtime 必须依赖 S3 的理由。以后完全可以分别处理：

```text
大 tool output → Kafka/PG retention 或 Volume
patch          → PG/Git
report         → PG
crash bundle   → observability/storage backend
```

所以我现在的判断已经变成：

> **从 AgentDock 核心运行架构看，MinIO/S3 很可能可以完全移除；Workspace durability 下沉给 Cube Volume + 底层持久存储，Session durability 下沉给 Pi PostgreSQL backend。**

而且这不是“为了简化而简化”，是把两个本来就应该由基础设施负责的职责还回去了。

## 165 · User · 2026-08-13T05:46:19.510Z

我们现在还有cell的概念吗

## 166 · Assistant · 2026-08-13T05:47:11.966Z

**现在还有。**当前 main 里 Cell 仍然是正式概念：

```text
Execution Cell
= Temporal Activity Task Queue
+ Pi Worker Pool
```

多个 Cell 可以共享一个 Sandbox Domain。

但它已经不是：

```text
Session → 固定 Cell → 固定 Worker
```

Worker affinity 已经删了；Cell 内任意 Worker 都能接这个 Run。现在 Cell 更像一个**容量分片 / 部署分片**，Cell queue backlog 还能拿来做 autoscaling。

不过结合我们刚才的新方向，我觉得 **Cell 本身也值得重新质疑**。

因为之前 Cell 还有一个很强的理由：

```text
Workspace 属于某个 Cell
跨 Cell → 要迁 Workspace checkpoint
```

当前文档甚至还有专门的 cross-cell workspace migration。

但如果以后变成：

```text
Pi Session → PostgreSQL
Workspace → 共享持久 Volume
Pi Worker → 完全无状态
```

那就会自然产生一个问题：

> **为什么还要把 Pi Worker 切成 Cell？**

有可能最后只需要：

```text
一个全局 Temporal task queue
        ↓
一个可水平扩展的 Pi Worker Pool
```

而真正需要隔离的只是：

```text
Sandbox Domain
→ Cube cluster
→ Workspace storage
→ compliance / fault domain
```

所以：**现在代码里 Cell 还存在；但按我们正在讨论的简化方向，它已经开始显得可疑了。**我觉得这个可以作为下一个要砍的概念来审查。

## 167 · User · 2026-08-13T05:56:15.645Z

对，是的，review一下在我们讨论了这么多的情况下，cell这个概念还有必要存在吗

## 168 · Assistant · 2026-08-13T05:58:12.100Z

对。按我们现在讨论出来的新前提，我的 review 结论是：

> **Execution Cell 作为 AgentDock 的一等架构概念，已经没有足够理由继续存在了。可以删。**

但要区分一件事：**删掉 Cell，不等于只能有一个 Worker Deployment。**以后仍然可以按需把 Worker 分成多个 pool / task queue，只是不再把这种“算力分片”建模成一个 Workspace 永久归属的业务实体。

### Cell 原来为什么有意义？

ADR-0089 最初给 Cell 的核心职责其实是：

```text
Workspace
   ↓ 永久绑定
Cell
├─ Temporal Task Queue
├─ Pi Worker Pool
└─ → Sandbox / Workspace storage
```

这样一个 Cell 挂了，可以 drain；Workspace 想换 Cell，要走 migration。

所以现在代码里才会有这么重的一套东西：

```text
execution_cells
workspaces.cell_id
workspace_cell_migrations
assigned_workspaces
cell drain
cell → sandbox_domain
per-cell Temporal task queue
per-cell Worker deployment
```

甚至迁 Cell 时还要检查 Run、Cube activation、Workspace version，然后修改 `workspace.cell_id`。 

### 但我们刚才已经把它的基础拆掉了

现在我们设想：

```text
Pi Session
→ PostgreSQL Session Backend

Workspace
→ Persistent Volume
→ Sandbox Domain 的存储基础设施

Pi Worker
→ 无本地持久状态
```

那么 Worker 在哪里已经**不决定数据在哪里**。

也就是：

```text
以前：

Workspace A
   ↓
Cell 3
   ↓
Worker 3-x
   ↓
Sandbox Domain 1


现在：

Workspace A
   ↓
Sandbox Domain 1 / Persistent Volume

任何 Pi Worker
   ↓
Tool Broker
   ↓
Sandbox Domain 1
```

这时候 Workspace 绑定 `Cell 3` 就变得很奇怪了。

真正应该绑定的是：

```text
Workspace
   ↓
Sandbox Domain
```

因为 **Sandbox Domain 才真正决定 Cube cluster、Volume/storage locality、failure domain、compliance boundary**。你现在的 ADR-0095 其实已经把这些职责从 Cell 拿走交给 Domain 了。

---

剩下 Cell 唯一真正做的事情就是：

```text
Cell
= 一个 Temporal Task Queue
+ 一批 Pi Worker
```

但这没有必要成为业务实体。

Temporal 本来就允许**很多 Worker poll 同一个 Task Queue**；一个 Task Queue 可以承载多个 Workflow Execution 的任务。

而且 AgentDock 当前 `TemporalPiWorker` 已经用了：

```ts
workerDeploymentOptions
buildId
useWorkerVersioning: true
defaultVersioningBehavior: "PINNED"
```

也就是说，“不同 Worker 版本安全发布”本来就已经交给 Temporal Worker Deployment 体系了。 Temporal 当前 Worker Deployment API 也已经 GA。

所以完全可以变成：

```text
Temporal
   │
   │ agent-run task queue
   ▼
Pi Worker Deployment
├─ worker
├─ worker
├─ worker
├─ ...
└─ worker
```

K8s 根据 backlog 扩：

```text
20 workers
↓
100 workers
↓
500 workers
```

**不需要先人为切：**

```text
Cell 1  50 workers
Cell 2  50 workers
Cell 3  50 workers
...
```

---

所以我建议新的结构直接变成：

```text
                     PostgreSQL
                   ┌─────────────┐
                   │ Agent state │
                   │ Pi Session  │
                   └──────┬──────┘
                          │
                       Temporal
                          │
                    agent-run queue
                          │
                 ┌────────▼────────┐
                 │ Pi Worker Pool  │
                 │ stateless       │
                 └────────┬────────┘
                          │
                      Tool Broker
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
       Sandbox Domain A        Sandbox Domain B
       Cube + Volume           Cube + Volume
```

Workspace 只需要：

```text
workspace
├─ id
└─ sandbox_domain_id
```

甚至如果早期永远只有一个 Sandbox Domain，连 `sandbox_domain_id` 都可以先不暴露成复杂的 placement system。

### 那以后真到一万、十万并发怎么办？

到时候如果实测一个 Worker queue 不够，可以再：

```text
pi-run-0
pi-run-1
pi-run-2
...
```

但这只是 **execution sharding**：

```text
Run → 某个 Worker Pool
```

而不是：

```text
Workspace → 永久属于某个 Cell
```

两者差别很大。

前者是可随时调整的算力调度；后者会引入数据归属、migration、drain、数据库状态、运维 API，一下子复杂很多。

所以我现在会直接把 Cell 定性为：

> **一个之前为了同时解决 Worker scaling + Workspace locality + failure isolation 而引入的聚合抽象；现在后二者已经正确地下沉到 Sandbox Domain / Persistent Storage，Cell 只剩 Worker capacity sharding，因此已经不值得作为一等领域概念存在。**

如果真按这条路线重构，`execution_cells + workspace_cell_migrations + workspaces.cell_id + per-cell Helm release + cell routing` 这一大片代码都可能删掉。这个简化幅度其实比去掉 MinIO 还挺可观。

## 169 · User · 2026-08-13T06:06:59.407Z

现在还需要多个temporal task queue/pi worker pool吗？其实我对pi worker pool扩缩容的想象是我更新pi worker的yaml，然后k8s就增加一个pi worker节点，我其实有点搞不懂，我只是想增加pi worker节点，为什么要随之增加temporal task queue

## 170 · Assistant · 2026-08-13T06:07:38.551Z

对，你这个理解是对的。**如果目的只是扩 Pi Worker 算力，就完全没有理由同时增加 Temporal Task Queue。**

正常模型应该就是：

```text
Temporal

agent-run  ← 一个 Task Queue
   │
   ├── Pi Worker Pod 1
   ├── Pi Worker Pod 2
   ├── Pi Worker Pod 3
   ├── ...
   └── Pi Worker Pod 100
```

Temporal 官方架构本来就是：**多个 Worker process 持续 poll Task Queue；一个 Task Queue 里可以放很多 Workflow Execution 的任务。** 

所以你想象中的扩容方式完全成立。严格说在 K8s 里通常不是“增加一个节点”，而是增加 `Pi Worker Deployment` 的 **Pod replica**：

```yaml
replicas: 10
```

变成：

```yaml
replicas: 20
```

然后：

```text
原来：
10 个 Pi Worker
都 poll "agent-run"

扩容后：
20 个 Pi Worker
仍然都 poll "agent-run"
```

甚至不需要你手改 YAML，KEDA/HPA 可以根据 backlog 自动把 replica 从 10 扩到 20、50、100。AgentDock 当前文档其实已经写了 KEDA 根据 Temporal backlog 扩 Pi Worker。 Temporal 自己现在甚至也有专门根据 Task Queue workload 自动扩 Worker 的项目。

---

那什么时候才需要**多个 Task Queue**？

不是为了：

```text
Worker 太多
```

而是为了：

```text
这些 Worker 本来就不一样
```

例如：

```text
cpu-worker queue
→ 普通 Pi Worker

gpu-worker queue
→ 有 GPU 的 Worker
```

或者：

```text
us-worker queue
eu-worker queue
```

因为数据合规要求美国任务只能跑美国。

Temporal 官方 samples 里的“worker-specific task queue”也是这种思路：**只有当某些任务必须落到特定 Worker/机器时，才单独建 queue。** 

而我们现在讨论的新 AgentDock：

```text
Pi Session → PG
Workspace → Persistent Volume / Sandbox Domain
Pi Worker → 无状态
```

Pi Worker 之间基本同质化。

那最自然的结构就是：

```text
                Temporal
                   │
            "agent-run" queue
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
     worker      worker      worker
        ... K8s 水平扩缩容 ...
```

**一个 Pi Worker Pool + 一个 Temporal Task Queue 就够了。**

实际上你当前代码里的：

```ts
cellId
taskQueue
```

是一一绑定的，而且 Worker 收到任务还专门检查：

```ts
if (input.cellId !== this.#cellId ||
    input.taskQueue !== this.#taskQueue) {
  throw ...
}
```



一旦 Cell 删除，这层路由也就没有什么必要了。

我现在会建议 AgentDock 直接收敛成：

```text
K8s Deployment: pi-worker
replicas: N

        ↓

Temporal Task Queue:
agent-run

        ↓

N 个同质 Pi Worker 竞争取任务
```

这其实比现在的：

```text
Cell1 → Queue1 → Worker Pool1
Cell2 → Queue2 → Worker Pool2
Cell3 → Queue3 → Worker Pool3
```

简单很多，而且**更符合你原本“我要扩容，就多起几个 Pi Worker”的直觉。**

## 171 · User · 2026-08-13T06:23:19.078Z

嗯，可以，接下来我们讨论一个更重要的问题，temporal的必要性，temporal真的有必要存在吗？

## 172 · Assistant · 2026-08-13T06:23:58.558Z

我现在倾向于一个比较明确的结论：

> **按我们刚刚重新设计后的方向，Temporal 很可能也可以拿掉。**

原因不是 Temporal 没用，而是 **AgentDock 已经不再需要它最有价值的那部分能力了**。

你看现在的 Temporal Workflow，实际上已经薄成这样：

```text
executeRunCommand()
      ↓
如果 deferred
      ↓
sleep()
      ↓
再 executeRunCommand()
```

没有什么复杂的：

```text
LLM
→ tool
→ LLM
→ tool
→ recovery
```

这些都不在 Temporal Workflow 里。

而当前 ADR 也写得很清楚，真正重要的业务状态一直都在 PG：

```text
same-session FIFO
tenant quota
Run / Attempt
lease / fence
events
usage
checkpoint
```

Temporal 负责的是：

```text
任务派给哪个 Worker
Worker 挂了重新派
heartbeat
retry timer
cancel delivery
```



问题就在这里。

---

我们现在的新架构下：

```text
Pi Session durable execution
→ Pi Harness + PostgreSQL

Workspace durability
→ Persistent Volume

Run / lease / fence
→ PostgreSQL

Worker
→ 无状态，可随时换
```

那么 Worker 挂掉：

```text
Worker A
  ↓ crash

PG:
Run 还没完成
lease 超时

Worker B
  ↓
claim Run
  ↓
Pi Harness 从 PG 恢复
  ↓
继续
```

这里其实**根本不需要 Temporal 知道 Agent Loop 执行到哪里**。

Pi Harness 已经知道。

---

那任务分发怎么办？

最简单可以直接：

```text
PostgreSQL

runs
┌────────────┬──────────┐
│ run_id     │ state    │
├────────────┼──────────┤
│ 001        │ queued   │
│ 002        │ queued   │
└────────────┴──────────┘

        ↑
        │ poll / claim
        │
Pi Worker 1
Pi Worker 2
Pi Worker 3
...
```

Worker 用非常经典的：

```sql
SELECT ...
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

抢一个 `queued Run`。

然后：

```text
queued
  ↓ claim
running
  ↓
lease_expires_at = ...
```

Worker 定期续 lease。

如果 Worker 死了：

```text
lease expired
↓
另一个 Worker claim
```

我们**本来就已经有 lease + fencing 这一套东西**。

所以 Temporal 原来帮我们解决的 Worker-loss 问题，其实会和已有 PG lease/fence 重叠。

---

我觉得最关键的变化是这个：

### 以前

AgentDock 自己必须解决：

```text
Agent Loop 跑到一半崩了怎么办？
```

所以 Temporal 很有吸引力。

### 现在

这个问题变成：

```text
Pi Harness：
我知道 Agent Loop 跑到哪了。

PG：
我知道哪个 Run 没完成。

Persistent Volume：
我保留 Workspace 现场。

AgentDock：
只需要找一个 Worker 继续跑。
```

那么 Temporal 就从：

> durable execution engine

降级成：

> 一个很高级的 distributed job queue。

这时候为了它，我们却还要维护：

```text
Temporal Server
Temporal schema
Temporal Worker
Workflow history
Workflow versioning
Task Queue
Activity heartbeat
Temporal deployment/upgrade
Outbox → Temporal handoff
```

而 ADR 当初自己也承认 Temporal 会引入额外 production dependency、schema upgrade、retention、metrics、backup、deterministic workflow versioning 等运维成本。

所以现在成本收益比已经变了。

---

我现在会把未来 AgentDock 想成：

```text
             PostgreSQL
          ┌──────────────┐
          │ Run Queue    │
          │ Lease/Fence  │
          │ Pi Session   │
          └──────┬───────┘
                 │ claim
                 ▼
          Pi Worker Pool
          worker worker worker
                 │
                 ▼
            Tool Broker
                 │
                 ▼
           CubeSandbox
                 │
          Persistent Volume
```

**Temporal 整块消失。**

而且很有意思，我们一路砍下来：

```text
Cell              → 可能删
多个 Task Queue    → 删
MinIO             → 可能删
Kopia             → 删
Pi JSONL checkpoint → PG backend 替代
Temporal          → 现在也开始没有必要
```

最后 AgentDock 反而越来越像一个很干净的 Cloud Agent runtime。

不过这里有一个我暂时不会跨过去的点：

> **PG job queue + lease 到底够不够可靠，还是我们会不知不觉重新造一个劣化版 Temporal？**

我觉得这个应该是下一步只讨论的一个问题。因为如果答案是“只需要 200 行左右很简单的 claim/lease/requeue”，那我会支持直接删 Temporal；如果最后又要造出 timers、signals、retries、workflow history 一大套，那就应该留 Temporal。

## 173 · User · 2026-08-13T06:28:17.237Z

嗯，可以研究一下。我以为造一个分发任务的队列复杂度应该不会很高，但感觉我可能想简单了。

## 174 · Assistant · 2026-08-13T06:29:16.633Z

你确实**没有想得太简单**。研究下来，我反而更确信：如果我们把边界守住，AgentDock 自己的任务分发层可以很小，**没必要重新造 Temporal**。

PostgreSQL 官方甚至明确写了：`FOR UPDATE SKIP LOCKED` 虽然不适合普通一致性查询，但很适合“多个 consumer 访问 queue-like table”这种场景。成熟的 pg-boss、Graphile Worker、River 也都是直接拿 PostgreSQL 做可靠任务队列。

我们的最小模型其实就这样：

```text
runs

run_id   state     lease_owner   lease_expires_at   fence
001      queued
002      running   worker-7      14:32:00           8
003      queued
```

Worker 做的事情只有：

```text
Pi Worker
   ↓
PG 抢一个 queued Run
   ↓
running + lease + fence++
   ↓
Pi Harness.run/resume()
   ↓
定期续 lease
   ↓
completed / failed / cancelled
```

抢任务核心就是类似：

```sql
SELECT id
FROM runs
WHERE state = 'queued'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

多个 Worker 同时执行，锁到某条 Run 的 Worker拿走它，其他 Worker 自动跳过。

真正需要认真处理的只有 **5 个问题**：

1. **Worker 挂了**：lease 过期，另一个 Worker 接手。
2. **旧 Worker 又活了**：靠 `fence` 拒绝它继续提交结果。
3. **取消**：PG 写 `cancel_requested`，当前 Worker停止 Pi；如果 Worker 已死，新 Worker看到 cancellation 就不继续。
4. **空队列别狂刷 PG**：低频 polling + `LISTEN/NOTIFY` 做 wake-up；任务本体仍然以 PG 表为准。PostgreSQL 官方也把 `NOTIFY` 定位成进程间通知，并建议真正的数据放表里。
5. **same-session FIFO / tenant quota**：claim 时只拿当前真正 eligible 的 Run。

而且这里特别关键的是：**第 1、2 项 AgentDock 其实已经写了相当一部分。**

你现在已有：

```text
session_leases
lease_id
valid_until
fencing_token

run_attempts
claim_expires_at
last_heartbeat_at
fencing_token
```

当前 `SessionLeaseCoordinator` 已经在做续租、过期检查、fence 递增和 stale Worker 防护。 

所以我们并不是从：

```text
什么都没有
→ 自己写 distributed queue
```

而更像：

```text
现在：

PG lease/fence
+
Temporal task distribution
+
Temporal heartbeat/retry


以后：

PG claim
+
PG lease/fence
+
Pi Harness durable state
```

### 什么时候会开始“重新造 Temporal”？

这条边界要守得很死。

如果以后我们开始往 queue 里加：

```text
步骤 A 完成后等 3 天
→ 同时启动 B/C/D
→ 等其中两个完成
→ 收到 signal 再继续
→ workflow version migration
→ child workflow
...
```

那就应该**立刻停手，保留/重新引入 Temporal**。

因为这才是 Temporal 真正擅长的 durable workflow orchestration；Temporal 官方自己定位也是让长时间业务流程在 crash 后继续执行。

但 AgentDock 当前 Workflow 根本没有这些东西。它实际上就是：

```text
executeRunCommand()
→ deferred ?
→ sleep
→ executeRunCommand()
```



所以我现在会把判断改成：

> **“自己实现队列”并不危险；危险的是不知不觉让这个队列承担 workflow engine 的职责。**

而 AgentDock 有 Pi Harness 之后，Agent Loop durable execution 已经有人负责了。我们只需要一个 **Run ownership / dispatch layer**。

下一步我觉得可以直接画一个非常小的 **“无 Temporal AgentDock Run Queue”状态机**，看看是不是真的只需要 `queued → leased → terminal` 这么几步。如果画出来仍然很简单，那删 Temporal 就基本可以定了。

## 175 · User · 2026-08-13T06:42:42.543Z

可以。还有我理解去任务队列抢任务，是不是意味着要轮询pg，如果我们有1000个pi worker，这是不是意味着1000次轮询呢，这个量级算大吗

## 176 · Assistant · 2026-08-13T06:43:05.564Z

对，**最朴素的实现就是轮询 PG**。而且你算得对：如果真有 1000 个 Pi Worker 进程，每个都独立 poll，那么每个 polling interval 都会产生最多 1000 次查询。

例如：

```text
1000 workers

每 1 秒 poll 一次   → ~1000 query/s
每 500ms poll 一次  → ~2000 query/s
每 100ms poll 一次  → ~10000 query/s
```

`FOR UPDATE SKIP LOCKED` 本来就是 PostgreSQL 官方认可的多 consumer queue-like table 用法。

但我**不太担心 1000 QPS 本身**。如果查询非常窄：

```sql
SELECT id
FROM runs
WHERE state = 'queued'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

并且有合适的 partial index，比如：

```sql
CREATE INDEX runs_queued
ON runs(created_at)
WHERE state = 'queued';
```

这种查询很轻。

我更担心两个东西：

```text
1000 Worker
↓
1000 个长期 PG connection

以及

空队列时
1000 个 Worker 不停查询“有任务吗？”
```

尤其第一点，**1000 个直接数据库连接比 1000 QPS 更值得注意**。通常要通过 PgBouncer 一类连接池控制实际 PG backend connection 数。

---

不过这里还有一个更重要的认识：

### 我们可能根本不会有 1000 个 Worker Pod

假设一个 Pi Worker process 可以同时跑：

```text
16 个 active Agent Loop
```

那：

```text
1000 active Agent Loops
÷ 16 slots
≈ 63 Pi Worker Pods
```

这时候甚至只有大约 63 个 poller。

我们之前已经讨论过，目前 `capacity=4` 很保守，后面应该 benchmark 8/16/32 等。也就是说：

> **Agent Loop 数量 ≠ Pi Worker 进程数量。**

这一点会让 polling 问题小很多。

---

### 我建议先用一个极简单的策略

不要一开始上 `LISTEN/NOTIFY`、dispatcher 等复杂东西。

Worker 空闲时：

```text
尝试 claim
   ↓
没任务
   ↓
sleep 500ms
   ↓
再 claim
```

连续几次没任务，可以退避：

```text
500ms
1s
2s
2s
2s...
```

再加一点随机 jitter，避免所有 Worker 同时醒：

```text
1800ms
2130ms
1950ms
...
```

而**一旦抢到任务**：

```text
claim
↓
执行
↓
还有空 slot？
↓
立即继续 claim
```

所以：

```text
有 backlog 时 → Worker 尽可能快地吃任务
没 backlog 时 → PG 查询频率很低
```

假设真的有 1000 个完全 idle 的 Worker，平均每 2 秒一次：

```text
≈ 500 query/s
```

这个量级对于一条有索引的简单 claim 查询通常不是什么离谱的负担；实际容量当然应该 benchmark，而不是直接拍板。

---

`LISTEN/NOTIFY` 可以以后作为优化，但我反而**不建议第一版用它解决 1000 Worker 唤醒**。

因为 PostgreSQL 的 `NOTIFY` 是广播给所有监听该 channel 的 session。

如果：

```text
来了 1 个 Run
↓
NOTIFY agent_run
↓
1000 Worker 全醒
↓
1000 个 Worker 去抢 1 个 Run
```

就产生了经典 **thundering herd**。

所以它不是天然比 polling 更漂亮。

---

至于我们刚才说的无 Temporal 状态机，我觉得第一版真的可以只有这么小：

```text
           user creates Run
                  │
                  ▼
               QUEUED
                  │
             Worker claim
                  │
                  ▼
               RUNNING
          lease + fencing_token
            ┌─────┴─────┐
            │           │
         success      Worker dies
            │           │
            ▼       lease expires
        COMPLETED        │
                         ▼
                      QUEUED
                         │
                    new Worker
```

再加：

```text
RUNNING
   │
user cancel
   ▼
CANCELLING
   │
   ▼
CANCELLED
```

我目前觉得**这还远远没有走到“重新造 Temporal”的程度**。

甚至我会建议第一版就坚持：

> **PG `SKIP LOCKED` + lease/fence + adaptive polling，先做到这里。**

如果压测发现 1000/5000 Worker polling 真成瓶颈，我们再讨论 dispatcher / dedicated queue。不要为了一个尚未出现的问题，提前重新引入一套复杂基础设施。

## 177 · User · 2026-08-13T07:06:56.972Z

pgsql是任务队列的最佳实践吗？我从来没写过任务队列相关的代码，但总觉得去数据库里取任务怪怪的。难道用户发送一条用户信息，我们往数据库里写一条用户信息，还要写一条任务吗？而且这条任务也属于消费品，而不是会持久化的东西

## 178 · Assistant · 2026-08-13T07:07:30.927Z

对，你这个感觉是对的。**PostgreSQL 不是“任务队列的通用最佳实践”**，它只是一个很常见、很实用的方案。纯从语义上看，RabbitMQ / SQS 这种系统确实更像你脑子里的“任务队列”。

而且这里有一个很重要的概念需要纠正：

> **任务是消费品，不等于任务不能持久化。**

例如 SQS 的消息被 consumer 取走后并不会马上消失，而是进入一段 visibility timeout；处理成功后 consumer 再显式删除。如果 consumer 挂了，没有删除，消息重新变得可见。  
RabbitMQ 也是类似的：consumer 没 ack 就挂了，消息会重新入队；重要任务通常还会使用 durable queue + persistent message。

所以：

```text
queued
  ↓ consumer 接走
in-flight
  ↓ success + ack
deleted
```

这其实就是标准任务队列语义。

---

### 那为什么 PostgreSQL 也能做？

这里我之前有一点容易让你误解：

**不一定需要额外建一张 `tasks` 表。**

AgentDock 本身就存在一个业务事实：

```text
Run 123
state = queued
```

这个 `Run` 不是“消费品”，而是一个应该永久保存的业务记录：

```text
Run 123
queued
→ running
→ completed
```

因此可以把：

```sql
WHERE state = 'queued'
```

理解成一个**逻辑队列**。

也就是说用户发一句：

```text
user:
帮我修这个 bug
```

PG 里可能是：

```text
Pi Session entry
└─ user message

Run
├─ id = 123
├─ session_id = xxx
└─ state = queued
```

并不需要再：

```text
Task
└─ run_id = 123
```

Worker 就直接 claim `Run 123`。

PostgreSQL 的 `SKIP LOCKED` 官方文档也明确指出，它可以用于多个 consumer 访问 queue-like table 的场景。

所以 **PG queue 真正漂亮的地方是：业务状态和待执行状态天然在同一个事务里。**

---

### 如果换 RabbitMQ，会发生什么？

反而会多出一个经典问题：

```text
用户发消息
   ↓
PG 写 Run 123
   ↓
RabbitMQ publish { runId: 123 }
```

假设：

```text
PG commit 成功
↓
进程突然挂了
↓
RabbitMQ publish 没发生
```

那就出现：

```text
PG:
Run 123 = queued

RabbitMQ:
没有这个任务
```

所以一般还得做：

```text
一个 PG transaction：

Pi Session / Turn
Run 123
Outbox { publish run 123 }
```

然后：

```text
Outbox relay
   ↓
RabbitMQ
   ↓
Worker
```

这里的 `Outbox` **才是纯粹的消费品**，可以发布成功后 GC。

于是架构变成：

```text
PostgreSQL
├─ Session
├─ Run
└─ Outbox
      │
      ▼
RabbitMQ
      │
      ▼
Pi Worker
```

而 PG queue 是：

```text
PostgreSQL
├─ Session
└─ Run(state=queued)
      │
      ▼
Pi Worker
```

一下就能看出为什么很多系统在规模没那么夸张时会说：

> 算了，直接拿 PG 做 queue 吧。

它把 **DB → broker 的可靠投递问题整个消灭了。**

---

### 所以我现在会这样评价

不是：

> PostgreSQL 是任务队列最佳实践。

而是：

> **如果任务本身对应数据库里一个需要永久保存的业务实体，直接把这个实体的 `queued` 状态作为任务队列，是一个非常合理的模式。**

AgentDock 恰好特别符合这个条件，因为：

```text
Run 本来就必须保存

queued
running
completed
failed
cancelled
```

这些状态你无论用不用 RabbitMQ，都得在 PG 存。

所以我们实际上没有在数据库里存一个“本来不应该存的消费品”。

我们只是：

> **让 Worker 从 durable Run state 里找待处理的 Run。**

---

当然，如果未来是这种东西：

```text
每天 5 亿个小任务
每个任务 10ms
处理完完全没有业务价值
不需要保存 task 历史
```

那我绝不会推荐把每个 task 都往 PostgreSQL 塞。

RabbitMQ、SQS 或其他专门的 broker 会自然得多。RabbitMQ 本身就会把多个 consumer 做 work queue 分发，并利用 ack/redelivery 处理 consumer failure。

但我们的 Agent Run：

```text
一个可能运行几十秒、几分钟甚至几十分钟的任务
+
本身必须有 durable Run record
```

性质完全不同。

所以我觉得 **PG queue 在 AgentDock 这里并不“怪”**。真正需要决定的是下面这两个模型哪个更合适：

```text
A. PG 本身就是 Run queue
   简单，没有 dual-write

B. PG 是 authority
   RabbitMQ/SQS 只是 delivery queue
   queue 语义更专业，但多一个 broker + outbox
```

我目前偏 **A**，不是因为 PG 是专业 MQ，而是因为 **AgentDock 的 Run 本来就是 durable business state，拿它直接做调度源可以少掉一整个一致性问题。**

## 179 · User · 2026-08-13T07:11:54.594Z

一个进阶问题，pgsql能作为100万级activate run的任务队列吗

## 180 · Assistant · 2026-08-13T07:13:01.482Z

可以，但要非常精确地区分：

> **PostgreSQL 可以轻松承载“100 万条 Run 状态”；但我不会直接相信“单 PG + 每个 active Run 高频续 lease”能优雅承载 100 万个同时 active Run。**

`SKIP LOCKED` 本身不是问题。PostgreSQL 官方明确支持它用于多个 consumer 消费 queue-like table。

真正的问题是**写放大**。

假设有 100 万 active Run，每 30 秒续一次 lease：

```text
1,000,000 / 30
≈ 33,333 row updates / second
```

这还没算：

```text
claim
completion
cancel
retry
event cursor
Pi Session writes
```

而 PostgreSQL 的 `UPDATE` 在 MVCC 下会产生新的 row version；高频更新意味着更多 WAL、dead tuples 和 vacuum 压力。PostgreSQL 官方文档明确说明，频繁更新的表尤其需要 vacuum；HOT 可以减少部分 index update，但并不能让这些更新“免费”。

所以如果目标真是 **100 万 simultaneous active Runs**，我不会设计成：

```text
runs
├─ run1  lease_expires_at 每30秒 UPDATE
├─ run2  lease_expires_at 每30秒 UPDATE
├─ ...
└─ run1,000,000
```

### 更合理的办法：lease Worker，不要 heartbeat 每个 Run

例如：

```text
worker_leases

worker-1   heartbeat_at
worker-2   heartbeat_at
...
```

Run 只记录：

```text
run-123
worker_id = worker-7
fence = 81
state = running
```

Worker 每隔一段时间只更新**自己的一条 heartbeat**：

```text
worker-7 heartbeat_at = now()
```

而不是把它拥有的 16 个 Run 全部 UPDATE 一遍。

这样：

```text
Worker 活着
→ 它拥有的 Runs 默认都还归它

Worker lease 超时
→ 找出 worker-7 的所有 nonterminal Runs
→ 标为可恢复
→ 新 Worker claim
→ fence++
```

于是 heartbeat 写压力从：

```text
O(active_runs)
```

变成：

```text
O(worker_processes)
```

这个差别非常大。

成熟的 PostgreSQL queue River 其实也说明了一个类似思想：它不是让每个执行 goroutine 独立疯狂查 PG，而是一个 client 管理一批 worker，并结合 `LISTEN/NOTIFY` 和低频 polling；它单个 queue client 配置甚至允许最多 10,000 个 worker goroutine。 这不能证明“Postgres 已验证支持 100 万 active jobs”，但说明成熟实现会**聚合调度和数据库访问**，而不是一 worker 一 poller 一 heartbeat。

### 所以我的尺度判断是

```text
100 万 total Runs
→ 完全正常

100 万 queued Runs
→ PG queue 可以认真考虑

几千～几万 active Runs
→ PG 很有希望，benchmark 即可

100 万 simultaneous active Runs
→ 不能用朴素 PG queue 设计
```

到最后这个量级，我仍然**不一定马上引入 Kafka/RabbitMQ/Temporal**。

我会先把 AgentDock 设计成：

```text
PostgreSQL
├─ Runs          durable authority
├─ assignments   worker ownership + fence
└─ worker_leases worker liveness

Pi Worker process
├─ slot 1 → Run A
├─ slot 2 → Run B
├─ ...
└─ slot N → Run N
```

然后 **batch claim + worker-level lease + coarse run progress**。

这样即使未来朝 100 万 active Run 设计，PG 承担的也不是“100 万个不断 heartbeat 的消息”，而是**100 万条相对稳定的业务状态 + 数量远少于 Run 的 Worker liveness**。

而且说实话，真到 **100 万同时 active Agent Loop**，我怀疑 PostgreSQL queue 已经不是 AgentDock 最先爆的地方了——Pi Worker 内存、模型并发、provider rate limit、Cube 数量和 Workspace storage 都会先进入非常夸张的规模。

所以目前没有必要因为“未来可能 100 万 active”就否掉 PG queue；但我们应该从一开始就避免 **per-Run 高频 heartbeat** 这个设计。

## 181 · User · 2026-08-13T07:31:23.673Z

你说的对，如果只是中型企业部署，那么pgsql看起来还凑活。那么接着考虑如果pgsql宕机了，系统表现和temporal宕机了表现一致吗

## 182 · Assistant · 2026-08-13T07:31:48.822Z

**不一致，而且 PG 宕机的影响会更大。**

先说一个容易忽略的现状：AgentDock 当前 self-hosted Temporal 的 `temporal` / `temporal_visibility` schema 本来就在现有 PostgreSQL 服务里。 所以**今天如果是整个 PostgreSQL 实例挂了，Temporal 实际上也跟着挂**。

但为了讨论架构，我们假设它们是两个独立故障：

```text
A. Temporal 挂，PG 正常
B. PG 挂，Temporal 正常
```

区别很明显。

### Temporal 挂了，PG 正常

大概是：

```text
用户发消息
   ↓
PG：可以正常持久化
Run：可以创建 queued
Outbox：可以写
   ↓
Temporal ✕
   ↓
暂时没人把新 Run 派给 Worker
```

所以用户看到的更像：

> 消息已经收到了，但任务排队不动。

已经跑起来的 Worker，本地 Activity 甚至可能继续执行一段时间，只是 Temporal 的 heartbeat、completion、cancel delivery 等协调能力会受阻。Temporal 本身的价值就是在服务/网络恢复后继续其 durable execution。

---

### PG 挂了就完全不同

按我们现在设想的新架构：

```text
PostgreSQL
├─ user message / Pi Session
├─ Run
├─ queue state
├─ lease / fence
└─ Agent state
```

PG 一挂：

```text
用户发消息
   ↓
不能 durable commit
   ↓
不能接受
```

Worker 也会变成：

```text
正在运行的 Worker
   │
   ├─ 不能更新 Pi Session
   ├─ 不能续 lease
   ├─ 不能提交 Run 状态
   └─ 不能 claim 新 Run
```

所以**正确策略应该是 fail closed：暂停继续推进 Agent，而不是硬着头皮跑。**

特别是我们一直坚持：

> 浏览器已经看到的 Agent 输出必须先 durable。

那么 PG unavailable 时，新的 assistant/tool 状态无法进入权威存储，理论上就不应该继续向用户输出。

所以用户体验更接近：

```text
PG down
→ 整个 Agent control plane 暂停
```

而不是：

```text
Temporal down
→ 调度暂时暂停
```

---

不过这并不意味着“所以必须留 Temporal”。

因为 PostgreSQL 本来就已经是 AgentDock 的**核心 authority**。即使保留 Temporal：

```text
Temporal 正常
PG 挂了
```

Worker 拿到 Activity 以后照样执行不了，因为它需要 PG 读取 Run、拿 lease/fence、持久化业务状态。当前 ADR 也明确规定这些权威状态属于 PostgreSQL，而不是 Temporal。

所以 Temporal **没有给我们解决 PostgreSQL outage**。

这一点挺关键：

```text
有 Temporal：

PG down
→ AgentDock 基本不可用


没 Temporal：

PG down
→ AgentDock 基本不可用
```

因此从这个角度看，**删掉 Temporal 并没有明显扩大 PG 故障的 blast radius——PG 原本就是必须在线的核心依赖。**

---

而 PostgreSQL 自己 crash 后的恢复语义其实很好理解：

```text
已经 COMMIT
→ WAL 保证恢复后仍然存在

还没 COMMIT
→ rollback
```

正常 durability 配置下，PostgreSQL 明确保证成功提交的事务在 crash 后持久。

所以比如：

```text
Run 123
state = running
worker = A
lease_until = 15:30
COMMIT ✓

PG crash

15:32 PG recovery
```

恢复后还是：

```text
Run 123 = running
lease_until = 15:30
```

reaper/下一个 Worker 一看：

```text
lease 已经过期
↓
fence++
↓
Worker B 接手
↓
Pi Harness 从 PG Session 恢复
↓
继续
```

这其实相当干净。

---

所以现在真正值得讨论的已经不是：

> **PG 挂了怎么办？Temporal 能不能救？**

Temporal救不了。

真正应该问的是：

> **PostgreSQL 作为整个 AgentDock 的核心单点，我们要做到什么级别的 HA？**

比如：

```text
Primary PG
   │ streaming replication
   ▼
Standby PG
```

Primary 挂：

```text
自动 failover
→ Standby promote
→ Worker/Control Plane 重连
→ expired lease 恢复执行
```

PostgreSQL 原生就支持 streaming replication / standby promotion。

这反而可能比：

```text
PG HA
+
Temporal HA
+
Temporal persistence
+
Temporal Worker
```

更符合我们现在想要的简化方向。

所以这一轮我会给一个比较明确的判断：

> **Temporal outage 和 PG outage 的表现不完全一致；PG outage 更严重。但由于 PG 无论如何已经是 AgentDock 的不可缺核心 authority，Temporal 并没有消除这个风险。删掉 Temporal 后，真正应该加强的是 PostgreSQL HA，而不是再维护第二套 durable orchestration 系统。**

## 183 · User · 2026-08-13T07:42:50.470Z

好像也挺合理的，pgsql挂了确实agent loop不应该再推进了，卡住就行了，等pgsql恢复之后继续也挺符合逻辑的

## 184 · Assistant · 2026-08-13T07:42:54.537Z

对，而且这个故障语义其实非常自然：

```text
PG 正常
→ Agent Loop 正常推进

PG 不可用
→ Agent Loop 停在当前位置
→ 不再产生新的用户可见输出
→ 不主动回滚 Workspace

PG 恢复
→ 重新读取 durable Session / Run 状态
→ 重新取得 lease + fence
→ 从中断点继续
```

这里唯一要小心的是 **PG 宕机期间正在执行的外部 effect**。例如：

```text
tool call: git commit
        ↓
执行过程中 PG 挂了
        ↓
git commit 可能已经成功
但 tool result 没来得及持久化
```

这个不能简单重跑。正好由我们之前讨论的 Pi Harness `effect_pending → effect result` 机制处理：恢复后把它视为 uncertain effect，检查现场或者给模型一个 interrupted tool result。

另外 PG 恢复后，旧 Worker 和新 Worker 理论上可能同时醒，所以必须继续保留：

```text
lease
+
monotonic fencing token
```

旧 Worker拿着 `fence=7`，新 Worker取得 `fence=8` 后，旧 Worker后续提交全部拒绝。

所以我觉得甚至可以把它写成 AgentDock 一个很核心的 invariant：

> **Persistence unavailable means execution unavailable. AgentDock never advances observable Agent state beyond its durable authority.**

这和我们的另一个原则完全一致：

> **用户看到的内容，必须已经持久化。**

这样一来，PG 故障恢复反而比“Temporal 在一边继续编排、PG 在另一边挂掉”更容易推理。整个系统就只有一个非常明确的 durability boundary。

## 185 · User · 2026-08-13T07:47:16.464Z

那讨论到这，temporal也可以拿掉了？

## 186 · Assistant · 2026-08-13T07:47:19.622Z

对。**按我们现在重新收敛出来的架构，Temporal 可以拿掉。**

因为现在它剩下的职责基本只有：

```text
Run 分发
Worker 崩溃检测
retry / lease timeout
cancel delivery
```

而这些都可以被更简单地覆盖：

```text
PostgreSQL
├─ Run durable state
├─ claim / SKIP LOCKED
├─ lease
├─ fencing token
└─ cancel_requested

Pi Harness
└─ Agent Loop 内部 durable recovery

Persistent Volume
└─ Workspace crash-site state
```

所以新的核心路径可以直接变成：

```text
用户请求
   ↓
PostgreSQL
创建 Run = queued
   ↓
Pi Worker Pool
claim Run
   ↓
Pi Harness
执行 / 恢复 Agent Loop
   ↓
Tool Broker
   ↓
CubeSandbox + Persistent Volume
```

PG 挂了：

```text
Agent Loop 停
```

PG 恢复：

```text
lease 失效
→ 新 Worker claim
→ fence++
→ Pi Harness 恢复
→ 继续
```

这个故障模型是完整的。

我会保留一个非常明确的“重新引入 Temporal”条件：

> **只有未来 AgentDock 出现真正的 durable workflow orchestration 需求时，才重新考虑 Temporal。**

比如：

```text
等待审批 3 天
→ 并行执行 A/B/C
→ 等两个完成
→ 定时唤醒
→ signal 驱动
→ child workflow
→ 跨服务长期业务编排
```

这种才是 Temporal 的主场。

但现在的 Agent Run 本质上只是：

```text
durable job
→ 找一个 Worker
→ Pi Harness 自己跑完
```

为了这个维护 Temporal Server、Workflow history、Activity heartbeat、Task Queue、Worker versioning、outbox→Temporal handoff，确实已经显得过重。

所以到这里，我会把结论定成：

> **AgentDock 当前目标架构可以删除 Temporal，并用 PostgreSQL Run Queue + lease/fence 替代其调度职责。**

而且这不是降级，而是把 durable execution 的责任放回真正拥有 Agent 状态的 Pi Harness，把调度降回它本来应该有的复杂度。

## 187 · User · 2026-08-13T07:52:58.619Z

等待审批 3 天
→ 并行执行 A/B/C
→ 等两个完成
→ 定时唤醒
→ signal 驱动
→ child workflow
→ 跨服务长期业务编排
诶，为什么这种才是temporal的主场

## 188 · Assistant · 2026-08-13T07:53:16.536Z

因为这些场景的共同点不是“任务很多”，而是：

> **控制流本身需要跨很长时间、跨进程故障，被可靠地保存下来。**

这才是 Temporal 最核心的价值。官方对 Temporal 的定位就是：Workflow 即使经历进程崩溃、网络故障或基础设施故障，也能在几秒、几天甚至几年后继续执行。

举个最简单的例子：

```text
创建订单
→ 等用户付款，最多等 3 天
→ 付款后同时：
    A. 扣库存
    B. 创建物流单
    C. 发优惠券
→ 等 A 和 B 都成功
→ 发货
```

普通代码很好写：

```ts
await waitForPayment();

await Promise.all([
  reserveInventory(),
  createShipment()
]);

await ship();
```

真正麻烦的是——**进程随时可能死。**

假设运行到：

```text
waitForPayment() ✓
reserveInventory() ✓
createShipment() ← 执行到这里机器炸了
```

机器重启以后，你怎么知道：

```text
付款已经发生了吗？
库存已经扣了吗？
物流单创建了吗？
应该从哪一行继续？
三个并行任务谁完成了？
谁还没完成？
```

如果不用 Temporal，你就得自己把“程序执行到了哪里”建模进数据库：

```text
workflow_instance

id
state = WAITING_SHIPMENT

payment_received = true
inventory_done = true
shipment_done = false

next_timer_at = ...
```

然后写恢复逻辑。

---

再看“等待审批 3 天”：

```text
申请
 ↓
等待经理审批
 ↓
3 天没回复则升级
```

程序当然不能：

```ts
await sleep(3 days)
```

然后指望这个 Node.js 进程三天都不挂。

所以你自己实现的话就得：

```text
PG:
workflow_state = waiting_approval
timeout_at = 2026-08-16 10:00
```

然后还需要一个 scheduler：

```text
不停找：

timeout_at < now()
AND state = waiting_approval
```

审批突然在第二天来了：

```text
signal: approved
```

又要解决：

```text
审批和 timeout 同时发生怎么办？
重复 signal 怎么办？
服务正好宕机怎么办？
```

Temporal 把这种 **durable timer + external signal + state transition** 当作 Workflow 本身的一部分处理。它保存的是 Workflow 的执行历史，因此 Worker 挂了以后可以重建控制流，而不是要求原来的进程一直活着。

---

再看并行：

```text
       ┌→ A
start ─┼→ B
       └→ C

等任意两个完成
      ↓
继续
```

这看起来只是一个：

```ts
Promise.any / Promise.all
```

但跨机器故障之后，实际要保存：

```text
A = completed
B = running
C = completed

join condition:
completed >= 2
```

于是你又开始自己造：

```text
workflow_steps
workflow_dependencies
workflow_events
workflow_timers
workflow_signals
```

再继续下去，就会发现：

> 你不是在写任务队列了，你正在写一个 durable state machine engine。

这正是 Temporal 的地盘。

---

而我们现在的 AgentDock **不是这种情况**。

我们的逻辑更像：

```text
Run
 ↓
找一个 Worker
 ↓
Pi Harness.run()
 ↓
一直跑到 terminal
```

内部：

```text
LLM
→ tool
→ LLM
→ tool
→ compact
→ ...
```

虽然也很复杂，但这个复杂状态机已经被：

```text
Pi AgentHarness
```

接管了。

所以 AgentDock 外面不需要再次保存：

```text
现在执行到第几个 tool
上一个 model call 有没有完成
下一步该干什么
```

Pi Harness 自己就是 Agent Loop 的 durable execution engine。

因此我们只剩：

```text
这个 Run 谁来跑？
```

这是 queue 问题。

而不是：

```text
这个业务 Workflow 执行到哪一步了？
```

这是 Temporal 问题。

我觉得可以用一句话区分得非常清楚：

> **Queue 保存“谁还没被处理”；Temporal 保存“一个长期程序已经执行到了哪里”。**

所以对于 AgentDock，现在我们有：

```text
PostgreSQL Run Queue
→ 谁来跑

Pi Harness
→ Agent 程序跑到哪里
```

这两层已经把 Temporal 原本要解决的问题拆完了。

## 189 · User · 2026-08-13T08:03:24.789Z

ok, 我们再往下看，那么sandbox manager呢

## 190 · Assistant · 2026-08-13T08:04:12.688Z

这个和 Cell、Temporal 不太一样。我的判断是：

> **Sandbox Manager 这个“Manager”概念可以拿掉，但它里面有一小块能力不能直接消失。**

你现在的 main 其实已经往这个方向走了一半：ADR-0095 已经把 Sandbox Manager 缩成了 **Tool Broker**，Cube 自己负责 sandbox scheduling/lifecycle。

原来的 Sandbox Manager 大概混了这些职责：

```text
Sandbox Manager
├─ 选择 / 创建 / 销毁 Sandbox
├─ Workspace restore / snapshot / CAS
├─ 校验 Run / lease / fence
├─ Tool operation 记录
└─ 调 Cube 执行 bash/read/write...
```

经过我们前面的讨论：

```text
Sandbox 调度
→ Cube 自己做

Workspace snapshot / restore / CAS
→ 删掉，Persistent Volume

Tool uncertain effect
→ 很大一部分交给 Pi Harness
```

于是前三大块已经被砍掉很多。

但还剩一个真正麻烦的问题。

假设：

```text
Worker A
fence = 7
正在跑 Run

PG 暂时断连 / lease 超时

Worker B
claim Run
fence = 8
```

这时候 A 不一定真的死了。

如果 A 可以直接：

```text
Pi Worker A
→ Cube API
→ bash "rm -rf xxx"
```

那么即便 PG 已经认定：

```text
fence=7 失效
```

**Cube 根本不知道 fence 是什么。**

于是可能发生：

```text
Worker B(fence=8) 正常修改 Workspace

同时

旧 Worker A(fence=7) 还在修改同一个 Workspace
```

这是真正的 split-brain writer。

---

所以当前 Tool Broker 最有价值的职责其实可以压缩成一句话：

> **在 external effect 真正进入 Sandbox 之前，执行 fencing。**

也就是：

```text
Pi Worker
   │
   │ tool call
   │ runId + attemptId + fence=8
   ▼
Tool Gateway
   │
   ├─ 查/验证：
   │     当前 fence == 8 ?
   │
   ├─ yes → forward
   └─ no  → reject
            │
            ▼
        CubeSandbox
```

旧 Worker：

```text
Worker A
fence=7
   ↓
Tool Gateway
   ↓
PG current fence=8
   ↓
REJECT
```

这样 fencing 才真正落在 **effect boundary** 上。

---

所以我现在甚至不太想叫它 `Sandbox Manager`。

更准确可能叫：

```text
Tool Gateway
```

或者继续：

```text
Tool Broker
```

它应该非常薄：

```text
Tool Broker
├─ authenticate Worker
├─ validate Run / attempt / fence
├─ resolve active Sandbox
└─ forward tool call
```

**不要：**

```text
✕ 调度 Sandbox
✕ 管 Workspace version
✕ snapshot
✕ restore
✕ Data Mover
✕ 自己做复杂 scheduler
✕ 保存 Agent state
```

这样它就只是一个安全边界。

---

不过还有一个更有意思的问题：

> 能不能连这个 Tool Broker 都删掉？

**有可能，但必须找到另一种 effect fencing 方案。**

例如 Cube 将来如果能够接受：

```text
activation-scoped credential

credential:
workspace = A
fence = 8
expires = 16:30
```

新 Worker 获得 fence=9 后：

```text
fence=8 credential
→ 自动失效
```

那么：

```text
Pi Worker
   ↓ direct
Cube
```

就成立了。

但如果 Cube 本身不理解 AgentDock 的 lease/fence，而 Pi Worker 又持有一个长期的 Cube 管理凭据，那么我不会删除 Broker。

因为你不能只在 Worker 自己做：

```text
check PG fence
↓
Cube.execute()
```

中间存在 race：

```text
Worker A:
check fence=7 ✓

        ← 此时卡住

Worker B:
fence → 8

Worker A:
恢复
→ Cube.execute()   ← 已经是 stale writer
```

所以 fence 必须尽可能在**执行 effect 的边界**检查，而不能只是调用方自觉检查。

---

因此我们目前砍下来以后，我会画成：

```text
                PostgreSQL
              authority/fence
                    │
                    │
             Pi Worker Pool
                    │
                tool call
                    ▼
              Tool Broker
              很薄、无状态
                    │
                    ▼
               CubeSandbox
                    │
                    ▼
           Persistent Workspace
```

所以目前结论不是：

> Sandbox Manager 保留。

而是：

> **Sandbox Manager 删除；留下一个极薄的 Tool Broker / effect-fencing gateway。**

我觉得接下来最值得讨论的恰恰就是：**这个 Tool Broker 是否真的必须独立成一个服务，还是能把 fencing 更优雅地下沉到 Cube/activation credential，从而连 Broker 都砍掉。**这应该是它唯一值得继续存在的理由。

## 191 · User · 2026-08-13T08:11:44.267Z

这个fence,lease还真是可恶，从上到下贯穿，我记得你之前说过pi社区有意将fence,lease内化是吗？如果内化了，我们还有必要在外部搞一套fence,lease吗？如果可以内化，是不是意味着我们可以自己动手做这个内化到pi呢

## 192 · Assistant · 2026-08-13T08:14:29.146Z

对，但我先纠正一下我之前说法：**“Pi 社区准备把分布式 lease/fence 内化”这个说法太强了。**

我刚重新核了当前 Pi upstream。现在 `AgentHarness` 明确在做的是 **operation locking、Session persistence、durable recovery 设计**；durable harness 也明确在研究 unfinished provider/tool call 的恢复。但目前我没有看到 upstream 已经承诺实现“跨机器 Worker ownership lease + monotonic fencing token”。

不过你的第二个想法非常成立：

> **我们完全可以自己把这套 distributed ownership 内化进 Pi Harness。**

而且我觉得这可能是 AgentDock 很漂亮的一步。

### “内化”不是把 lease/fence 消灭

而是从现在这种：

```text
AgentDock Run
   fence
     ↓
Pi Worker
   fence
     ↓
Tool Broker
   fence
     ↓
Sandbox
   fence
     ↓
Workspace
```

变成 Pi 内部只有一个：

```text
ExecutionAuthority
```

例如概念上：

```ts
interface ExecutionAuthority {
  epoch: bigint
  signal: AbortSignal

  renew(): Promise<void>
  assertCurrent(): Promise<void>
  release(): Promise<void>
}
```

AgentHarness 启动一次 durable operation：

```text
AgentHarness
   ↓
acquire authority
   ↓
epoch = 8
```

然后后面所有东西拿到的不是一堆：

```text
leaseId
fencingToken
runAttemptId
claimExpiresAt
...
```

而只是一个 opaque capability：

```text
authority
```

这才是真正意义上的“内化”。

---

而且 Pi 现在已经给了一个非常好的切入点：

**它的新 built-in `read/write/edit/bash` 全部通过 `ExecutionEnv` 执行。**

所以我们甚至不用在每个 tool 里面塞 fence：

```text
createBashTool()
createWriteTool()
createEditTool()
       │
       ▼
FencedExecutionEnv
       │
       ├─ authority.assertCurrent()
       │
       ▼
      Cube
```

这个接口设计非常适合 Cloud Pi。

---

SessionStorage 也一样：

```text
AgentHarness
      │
      ▼
PostgresSessionStorage
      │
      └─ 写入时：
         WHERE current_epoch = 8
```

Worker A：

```text
epoch=7
→ 写 Session
→ reject
```

Worker B：

```text
epoch=8
→ write success
```

这样 **Pi Session 本身也被 fence 保护**。

---

但有一个特别关键的地方：

### 不能只在 Pi 进程里检查 fence

否则还有我们刚才说的 race：

```text
Worker A
assertCurrent(epoch=7) ✓

        ← 暂停

Worker B
epoch → 8

Worker A
        ↓
Cube bash
```

所以最终 effect boundary 还是必须验证 authority。

最理想是：

```text
Pi AgentHarness
     │
ExecutionAuthority(epoch=8)
     │
     ▼
ExecutionEnv
     │
     ▼
Cube execution endpoint
     │
     └─ 验证 epoch=8
```

这样 Tool Broker 才真的有机会删除。

---

所以我觉得我们甚至可以**不马上 fork Pi 改一大堆代码**。

第一阶段可以利用 Pi 现在已有的 extensibility：

```text
AgentDock
├─ PostgresSessionStorage
├─ PostgresExecutionAuthorityProvider
└─ FencedCubeExecutionEnv
```

Pi：

```text
AgentHarness
├─ Session
└─ ExecutionEnv
```

如果跑通了，再给 Pi upstream 提一个很小的通用抽象：

```ts
AgentHarness({
  executionAuthorityProvider
})
```

Pi 自己完全不需要知道 PostgreSQL、K8s、Cube。

它只知道：

> “我正在执行一个 operation，我拥有一个可失效的 execution authority。”

这样设计很符合 Pi 本身“通用 harness”的定位。

---

如果这个方向做彻底，我希望 AgentDock 最后只有**一套 ownership**：

```text
PostgreSQL

session/run
└─ execution_epoch = 8
```

而不是现在：

```text
RunAttempt fence
Session fence
Sandbox lease
Tool operation owner
Workspace CAS fence
...
```

然后：

```text
Pi Harness
      │
      └── ExecutionAuthority(epoch=8)
                 │
        ┌────────┴────────┐
        ▼                 ▼
SessionStorage       ExecutionEnv
        │                 │
        ▼                 ▼
       PG               Cube
```

这就真的把那个“从上到下都在传 fence”的恶心问题收敛掉了。

我觉得这里有一个很有意思的判断：

> **我们现在不应该继续完善 AgentDock 自己那套 lease/fence plumbing，而应该尝试把 distributed execution ownership 做成 Pi Harness 的一等 capability。**

而且 Pi 当前正在大改 AgentHarness、durability、Session、ExecutionEnv，这个时间点其实非常适合做这件事。当前 durability 部分仍被官方标为 planned/spike 阶段。

下一步我建议我们只研究一个问题：**这个 `ExecutionAuthority` 最小接口到底应该长什么样，才能同时解决 Session stale writer 和 Sandbox stale effect。**这个一旦设计顺了，Tool Broker 是否还能删基本也就清楚了。

## 193 · User · 2026-08-13T08:17:49.232Z

可以，研究一下

## 194 · Assistant · 2026-08-13T08:20:54.424Z

可以。研究下来，我觉得这个方向是成立的，而且可以把接口做得比我们刚才想的还更干净。

当前 Pi 已经有两个非常合适的切入点：`AgentHarness` 本身负责 operation locking、Session persistence 和 save-point；而内置的 `read/write/edit/bash` 又全部只通过 `ExecutionEnv` 访问外部环境。Pi 的 durable recovery 目前仍处于 planned/spike 阶段，并且官方明确意识到 unfinished tool call 不能随便重试。

所以我建议 **不要让 Pi 认识 `leaseId`、`expiresAt`、PostgreSQL 这些概念**。Pi 只认识一个：

```ts
interface ExecutionAuthority<TProof = unknown> {
  readonly epoch: bigint;

  // authority 一旦失效就 abort
  readonly signal: AbortSignal;

  // 给外部 effect boundary 使用的 opaque proof
  readonly proof: TProof;

  release(): Promise<void>;
}

interface ExecutionAuthorityProvider<TProof = unknown> {
  acquire(input: {
    scope: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<ExecutionAuthority<TProof>>;
}
```

注意我甚至**不建议暴露 `renew()`**。

应该是：

```text
ExecutionAuthorityProvider
        │
        ├─ 自己续 lease
        ├─ 自己和 PG 打交道
        └─ 一旦续租失败
              ↓
        authority.signal abort
```

这样 Pi 根本不知道自己底下用的是：

```text
PostgreSQL
etcd
Consul
Hazelcast
...
```

---

### 在 AgentHarness 里怎么工作

一次 Run：

```text
AgentHarness.prompt()
       │
       ▼
authorityProvider.acquire()
       │
       ▼
authority epoch = 42
       │
       ▼
Agent Loop
       │
       ├─ provider
       ├─ Session writes
       └─ tools
```

如果 Worker 卡死或者失联：

```text
Worker A
epoch = 42

lease expires

Worker B
acquire()
epoch = 43
```

这就是标准 fencing token 模型：新 owner 获得更大的 monotonically increasing token，真正访问共享资源时由共享资源拒绝旧 token。Hazelcast 的 FencedLock 官方设计就是这么做的。

---

## 第一条边界：SessionStorage

这部分最容易。

Worker A：

```text
epoch = 42
```

写 Pi Session：

```sql
INSERT INTO pi_entries (...)
SELECT ...
WHERE EXISTS (
    SELECT 1
    FROM execution_authority
    WHERE scope = $scope
      AND epoch = 42
      AND expires_at > now()
);
```

Worker B 已经拿到：

```text
epoch = 43
```

那么 A 再写：

```text
epoch=42
→ 0 rows
→ AuthorityLost
```

所以：

```text
Pi Harness
      │
      ▼
PostgresSessionStorage
      │
      └── authority epoch
```

**Session stale writer 被彻底堵住。**

而且 Pi 当前已经把 Session persistence 放在 Harness 生命周期里的确定边界，例如 `message_end` 和 save point，所以这里非常适合加 fencing。

---

## 第二条边界：Tool effect

这里更有意思。

Pi 当前内置工具：

```text
read
write
edit
bash
```

都不会自己操作文件系统，而是：

```text
Tool
 ↓
ExecutionEnv
```



所以我们可以做：

```ts
class AuthorityBoundCubeEnv implements ExecutionEnv {
    constructor(
        private cube: CubeClient,
        private authority: ExecutionAuthority<CubeProof>
    ) {}

    async exec(...) {
        return this.cube.exec({
            ...,
            authority: this.authority.proof
        });
    }
}
```

Pi 内置：

```text
bashTool
   ↓
ExecutionEnv.exec()
```

完全不用知道：

```text
fence
lease
Cube
PG
```

非常干净。

---

但是这里有一个**必须解决的坑**。

仅仅这样：

```text
Worker A:
assert epoch=42 ✓

Worker B:
epoch → 43

Worker A:
Cube.exec()
```

是不安全的。

这就是我们之前讨论的 TOCTOU。

所以 authority 必须一直到：

> **真正执行 effect 的地方**

例如：

```text
Worker
  │ epoch=42
  ▼
ExecutionEnv
  │
  ▼
Cube execution endpoint
  │
  ├─ current epoch = 43
  │
  └─ reject 42
```

这也是 fencing token 的标准要求：token 要传到共享资源，让共享资源拒绝 stale owner。

---

### 还有一个更隐蔽的问题

假设：

```text
Worker A epoch=42

bash:
npm test && some-long-running-script
```

命令已经**开始执行**。

然后：

```text
A lease 失效
B 获取 epoch=43
```

即使我们从此拒绝 A 的新 tool call：

```text
42 → reject
```

那个**已经启动的 bash 进程仍可能继续修改 Workspace**。

所以 takeover 真正正确的流程应该是：

```text
A authority lost
      ↓
停止 / fence A 的 ExecutionEnv
      ↓
kill old process / terminate old sandbox activation
      ↓
确认旧 execution domain 已 quiesced
      ↓
B 才拿到可用的 epoch=43 environment
```

这一点非常重要。

因此 `acquire()` 其实语义应该是：

> **不是仅仅从 PG 拿一个数字，而是获得一个已经确保前任无法继续产生 effect 的 execution authority。**

Apache BookKeeper 的 fencing 协议也是同样思想：新 writer 接管前，必须先确保旧 writer 后续写入无法再被共享存储接受。

---

所以最终架构我会设计成：

```text
                 PostgreSQL
             execution authority
              scope → epoch=43
                    │
          ┌─────────┴─────────┐
          │                   │
          ▼                   ▼
 PostgresSessionStorage   CubeExecutionEnv
      epoch=43                epoch=43
          │                   │
          ▼                   ▼
      Session DB          Sandbox effect
```

Pi Harness 中：

```text
AgentHarness
     │
     └─ ExecutionAuthority
           epoch=43
           signal
           proof
```

**一份 authority，两个 enforcement point。**

这才是真正意义上的“内化”。

---

至于 Tool Broker，我现在的判断是：

**内化 ExecutionAuthority 后，Tool Broker 的大量逻辑可以删除，但暂时还不能保证整个服务都删。**

如果 Cube 本身能够做到：

```text
Cube/envd
接受 authority proof
→ 验证 current epoch
→ stale epoch reject

并且 takeover 时：
→ kill/fence previous activation
→ 再允许新 activation 使用 Workspace
```

那么：

```text
Pi Worker
   ↓
Cube
```

Tool Broker 就真可以删掉。

但 Cube 如果完全不知道 AgentDock authority：

```text
Pi Worker
   ↓
Tool Broker   ← 验证 epoch / kill stale activation
   ↓
Cube
```

那 Broker 还得保留，只不过会变成一个**非常薄的 authority enforcement adapter**。

---

还有一个挺好的消息：

**第一版甚至不需要马上 fork Pi。**

因为 Pi 已经允许应用提供 `toolContext`，并且这个 context 每个 turn snapshot 会解析一次；内置工具又全部走 `ExecutionEnv`。

我们完全可以先做：

```text
AgentDockAuthority
        │
        ├─ PostgresSessionStorage
        │
        └─ AuthorityBoundCubeExecutionEnv
```

然后 Worker：

```text
claim Run
↓
acquire authority
↓
create AgentHarness
↓
run
```

authority lost：

```text
authority.signal
↓
harness.abort()
```

先验证整个模型。

验证成功以后，再向 Pi 内部推进：

```ts
new AgentHarness({
    session,
    executionAuthorityProvider,
    toolContext: ({ authority }) => ({
        env: createCubeEnv(authority)
    })
})
```

---

所以我现在对这个方向的判断是：

> **可以自己做，而且很值得做。**

但目标不是：

> 把 AgentDock 的 lease/fence 代码原封不动搬进 Pi。

而应该是：

> **让 Pi Harness 原生拥有“本次 execution 当前是否仍有权继续”的概念，把 lease/fence 彻底隐藏到 provider 后面。**

那最后 AgentDock 外面可能只剩：

```text
PG Run Queue
      ↓
Pi Worker
      ↓
Pi AgentHarness
  ├─ SessionStorage → PG
  └─ ExecutionEnv   → Cube
```

`RunAttempt fence`、`Session lease`、`Tool Broker operation owner`、`Workspace CAS fence` 这些现在到处传播的概念，就有机会大面积消失。

## 195 · User · 2026-08-13T08:52:58.742Z

哇，那简洁很多了，感觉想当不错，少了很多部件。我们讨论了这么多，砍掉了这么多东西，你能总结一下现在agent dock的架构长什么样子吗（我们讨论的终极版架构）

## 196 · Assistant · 2026-08-13T08:53:03.789Z

可以。按我们这几轮讨论出来的**目标态**来看，AgentDock 已经从原来一个偏“企业级 durable orchestration 平台”，收敛成了一个很干净的 **Cloud Coding Agent Runtime**。

先强调一下：下面是我们讨论出的**终极目标架构，不是现在 main 已经实现的状态**。

## 最终形态

```text
                         Browser
                            │
                            │ HTTP / SSE
                            ▼
                    ┌──────────────┐
                    │ Web / API    │
                    │ Control Plane│
                    └──────┬───────┘
                           │
                           ▼
                 ┌───────────────────┐
                 │    PostgreSQL     │
                 │                   │
                 │ Business State    │
                 │ Run Queue         │
                 │ Pi SessionStorage │
                 │ ExecutionAuthority│
                 │ Conversation      │
                 └───────┬───────────┘
                         │
                  claim queued Run
                         │
                         ▼
                ┌───────────────────┐
                │   Pi Worker Pool  │
                │   stateless       │
                │                   │
                │ AgentHarness      │
                │ + Authority       │
                └────────┬──────────┘
                         │
                         │ tool call
                         ▼
                ┌───────────────────┐
                │ Cube ExecutionEnv │
                │ authority enforced│
                └────────┬──────────┘
                         │
                         ▼
                   CubeSandbox
                  KVM microVM
                         │
                         ▼
                    /workspace
                         │
                         ▼
               Persistent Volume
               CSI / distributed
                    storage
```

核心其实只剩下 **4 层**：

```text
PostgreSQL
    ↓
Pi Worker + Pi Harness
    ↓
CubeSandbox
    ↓
Persistent Workspace
```

---

## 1. PostgreSQL 成为唯一 durable authority

这是整个新架构最大的变化。

PG 负责：

```text
PostgreSQL
├─ 用户 / Project / Workspace / Session / Run
│
├─ Run Queue
│   ├─ queued
│   ├─ running
│   ├─ completed
│   └─ cancelled / failed
│
├─ Pi SessionStorage
│   ├─ entries
│   ├─ registers
│   └─ usage
│
├─ Execution Authority
│   └─ current epoch / ownership
│
└─ conversation projections / audit
```

也就是说：

> **AgentDock 只有一个真正的 durable truth：PostgreSQL。**

PG 挂：

```text
Agent execution pause
```

PG 恢复：

```text
Worker reacquire
→ Pi Harness restore
→ continue
```

非常容易推理。

---

## 2. Pi Worker 变成真正的无状态 Worker

不再有：

```text
Session → Cell
Session → fixed Worker
Worker-local checkpoint correctness
```

而是：

```text
Pi Worker 1 ─┐
Pi Worker 2 ─┤
Pi Worker 3 ─┤
...          ├→ PostgreSQL Run Queue
Pi Worker N ─┘
```

每个 Worker：

```text
空闲 slot
   ↓
claim queued Run
   ↓
acquire ExecutionAuthority
   ↓
AgentHarness restore Session
   ↓
执行
```

K8s 扩容就是你最开始想象的那个样子：

```yaml
replicas: 20
```

改成：

```yaml
replicas: 100
```

就多了 80 个 Pi Worker。

**没有 Cell，没有“增加 Worker 就增加 Task Queue”。**

---

## 3. Durable Agent Loop 彻底交给 Pi Harness

这是为什么 Temporal 可以删除。

原来 AgentDock 自己试图知道：

```text
LLM 执行到哪了？
tool call 完了吗？
崩溃以后怎么恢复？
checkpoint 在哪？
```

以后：

```text
Pi AgentHarness
       │
       ├─ provider effect state
       ├─ tool effect state
       ├─ operation state
       ├─ compaction
       └─ Session persistence
```

AgentDock 不再自己实现第二套 Agent state machine。

AgentDock 只管：

```text
这个 Run 需要执行
↓
找个 Worker 给 Pi Harness
```

所以：

```text
PG Run Queue
→ 调度问题

Pi Harness
→ Agent durable execution 问题
```

两层职责非常清楚。

---

## 4. lease / fence 内化成 ExecutionAuthority

这是我们刚才讨论出来非常漂亮的一点。

外面不再到处传：

```text
leaseId
fencingToken
attemptId
claimExpiresAt
workspaceFence
...
```

Pi Harness 只持有：

```text
ExecutionAuthority
├─ epoch
├─ signal
└─ proof
```

例如：

```text
AgentHarness
     │
     └── Authority(epoch=43)
              │
        ┌─────┴─────┐
        ▼           ▼
 SessionStorage   ExecutionEnv
      │               │
      ▼               ▼
 PostgreSQL          Cube
```

Worker A：

```text
epoch = 42
```

Worker B 接管：

```text
epoch = 43
```

以后：

```text
A 写 Session → reject
A 执行新 tool → reject
```

所以 distributed single-writer semantics 被收敛进 Harness。

这比现在：

```text
Run fence
Session fence
Sandbox lease
Tool ownership
Workspace CAS
```

一层层往下传，干净太多。

---

## 5. CubeSandbox 只干它真正应该干的事

Cube 不再被 AgentDock 外面再套一个复杂 Sandbox Manager。

Cube 负责：

```text
microVM lifecycle
sandbox scheduling
isolation
resource limits
network
volume mounting
tool execution environment
```

Pi：

```text
bash / read / write / edit
      ↓
ExecutionEnv
      ↓
Cube
```

理想终态是在 Cube 的真正 effect boundary 验证：

```text
authority proof
```

那么旧 Worker 即使诈尸，也不能继续操作 Workspace。

这样：

> **Sandbox Manager 可以删。**

当前所谓 Tool Broker 如果只是为了 fence，可以最终变成 Cube-side 的一个很薄 authority enforcement adapter，甚至随着 Cube 集成进一步消失。

---

## 6. Workspace 回归“一块云盘”

这个也是一次很大的思想变化。

不再：

```text
每个 Turn
↓
Workspace snapshot
↓
Kopia
↓
MinIO
↓
Workspace version
```

而就是：

```text
Cube microVM
     │
     ▼
 /workspace
     │
     ▼
Persistent Volume
```

Sandbox 挂：

```text
Volume 还在
```

Worker 挂：

```text
Volume 还在
```

Node 挂：

```text
底层 replicated storage
→ 新 Node 重新 mount
```

所以：

```text
Kopia        ✕
MinIO/S3     ✕
Data Mover   ✕
Turn snapshot✕
Workspace CAS✕
```

灾备属于：

```text
CSI / storage infrastructure / backup
```

而不是 Agent Turn protocol。

---

## 我们目前砍掉的东西

放一起看会非常明显：

```text
原架构

Cell
├─ Temporal Task Queue
├─ Pi Worker Pool
└─ Workspace placement

Temporal
├─ Workflow
├─ Activity
├─ heartbeat
├─ retry
└─ cancellation

Sandbox Manager / Tool Broker
├─ sandbox scheduling
├─ fence
├─ workspace CAS
└─ operation ownership

MinIO
├─ Pi JSONL
└─ Kopia snapshots

Kopia
└─ Workspace checkpoint

Data Mover
└─ snapshot restore/capture
```

现在：

```text
Cell                 → 删除
Temporal             → 删除
Temporal Task Queue  → 删除
Pi session.jsonl     → 删除
MinIO                → 删除
Kopia                → 删除
Workspace snapshot   → 删除
Data Mover           → 删除
Sandbox Manager      → 删除
复杂 Tool Broker      → 尽量删除
多套 lease/fence      → 收敛为 ExecutionAuthority
```

这确实砍掉了一大片。

---

## 还没有被我们 review 的两个东西

这里我不想顺手替它们判死刑：

```text
Kafka
Valkey
```

目前它们仍然承担：

```text
Pi Worker
   ↓
durable streaming events
   ↓
Kafka
   ↓
Valkey live replay
   ↓
SSE
   ↓
Browser
```

我们之前的核心要求还是：

> **用户已经看到的内容必须 durable。**

所以现在可以暂时画成：

```text
                         PostgreSQL
                       durable authority
                             ▲
                             │
Browser ← SSE ← Valkey ← Kafka ← Pi Worker
                             │
                             ▼
                       Pi AgentHarness
                             │
                             ▼
                        CubeSandbox
                             │
                             ▼
                    Persistent Volume
```

**Kafka / Valkey 是否也可以继续砍，是我们还没有系统 review 的下一块。**

---

如果把我们目前已经确定的设计压成一句话，我觉得现在的 AgentDock 是：

> **PostgreSQL 保存 Agent 的持久状态与待执行 Run；无状态 Pi Worker 从 PG 领取 Run，由具有分布式 ExecutionAuthority 的 Pi AgentHarness 负责 durable Agent Loop，并通过 CubeSandbox 在持久 Workspace 上执行工具。**

这已经是一个相当完整、而且边界很清楚的 Cloud Coding Agent 架构了。原来很多“企业级”部件其实是在重复解决 Pi、Cube、PostgreSQL、K8s 本身已经应该解决的问题。

## 197 · User · 2026-08-14T00:41:39.501Z

你再拉取一下，我昨天让codex根据咱们的讨论内容进行了大重构

## 198 · Assistant · 2026-08-14T00:44:08.717Z

我重新按当前 `main` 看了一遍。现在的**实际生产架构**已经非常接近我们昨天讨论的版本：

```text
Browser
   │ REST / SSE
   ▼
Control Plane
   │
   ├── transaction ───────► PostgreSQL
   │                       ├─ Product state
   │                       ├─ Run / RunAttempt
   │                       ├─ Run queue
   │                       ├─ lease / fence
   │                       ├─ canonical conversation
   │                       └─ Pi Session state
   │
   ▼
shared Pi Worker Pool
   │  PG LISTEN/NOTIFY + polling
   │
   ▼
Pi SDK / Agent Loop
   │
   ▼
Tool Broker
   │
   ▼
CubeSandbox KVM
   │
   ▼
Persistent Cube Volume
   └─ /workspace

Worker event
   ↓
Kafka
   ↓
Valkey
   ↓
SSE
```

README 现在已经明确写死：**Temporal、Execution Cell、MinIO/S3 conversation checkpoint、Kopia Workspace copy 都不在当前 product path 里了。**

### 已经真正砍掉的

**Temporal / Cell 已经不是“计划删除”，而是代码层面删了。**ADR-0101 明确规定 PostgreSQL 是唯一 Run scheduling authority，所有 Pi Worker 竞争一个共享队列；Temporal、Cell、Worker affinity 全部移除。

现在 Worker 确实已经变成了我们讨论的：

```text
PostgresPiWorker 1 ─┐
PostgresPiWorker 2 ─┤
PostgresPiWorker 3 ─┤
                    ├──► same PG queue
PostgresPiWorker N ─┘
```

`PostgresPiWorker` 已经真实实现：默认每秒 fallback poll 一次，同时 `LISTEN agent_dock_run_queue`；通知只是降低延迟，丢通知不会丢任务。Worker 按自己的空闲 slot 数量扫描任务。

这里还有个细节：现在所谓“Run queue”实际是：

```text
ready command Outbox rows
```

而不是另造一张 `job_queue` 表。`RunCommandExecutor` 仍然负责真正的 transactional claim。这个设计我觉得是合理的。

---

**MinIO + Kopia 也已经真正退出默认拓扑。**

现在：

```text
Workspace bytes
      ↓
Persistent Cube Volume
```

Cube 死掉：

```text
process / memory 丢
files 不丢
```

Workspace revision 只保存：

```text
identity
hash
file index
Git baseline / patch
```

而不再保存整个 Workspace archive。

原来的 Data Mover 现在也已经变成了 `Workspace Volume Gateway`，不再干 Kopia upload/restore，主要只负责初始化 Volume、校验 identity、生成 file/hash index、Git patch 和给 UI 安全读取文件。

所以我们昨天说的：

```text
Workspace ≈ 一块持久云盘
```

已经落地了。

---

### Pi Session 这块非常有意思

这部分 Codex 比我预期做得还快。

现在已经有正式 package：

```text
@agent-dock/pi-session-postgres
```

Pi 官方 `SessionStorage` 已经实现到 PostgreSQL，存：

```text
entries
lanes
operation records
labels
append log
compaction boundary
```

而且 restore active branch 已经改成一个 bounded recursive CTE，不再整个 JSONL 下载回来。

更重要的是，我们昨天刚讨论的：

```text
ExecutionAuthority
```

Codex **已经做了 executable prototype**。

现在 prototype 是：

```text
DurableAgentHarness
       │
       └── DurableAgentExecutionAuthority
                 │
           ┌─────┴─────┐
           ▼           ▼
    Session mutation   Tool effect
```

它会：

- acquire 一份 opaque authority；
- Session 写之前检查；
- Tool effect 前后检查；
- authority revoke 后 abort Agent Loop；
- Worker 恢复时处理 unfinished operation；
- 从最新 compaction boundary 恢复。

也就是说昨天我们只是说：

> “这个东西似乎值得自己做。”

结果仓库里现在已经有 prototype 了。

---

### 但有两个地方还没到“终极版”

第一个非常重要：

**生产 Agent Loop 现在还没有切到新的 `DurableAgentHarness`。**

原因不是 Codex 没写，而是它刻意没硬切。

Pi 0.84.1 当前公开的 `AgentHarness.prompt/resume` 还是 incomplete，生产路径仍然使用稳定的 coding-agent SDK / JSONL entrypoint。

区别是 JSONL 现在：

```text
以前：
S3 session.jsonl

现在：
PostgreSQL immutable object table
```

所以：

```text
S3
已经没了
```

但：

```text
JSONL compatibility path
暂时还在
```

而新的 PostgreSQL-native Harness 已经可以运行，只是还差：

```text
automatic compaction parity
interruption/world-state
Workspace settlement
steer
sampling identity
production event mapping
real Cube/model parity
```

这些迁完以后才会正式切。这个迁移边界在研究文档里写得非常清楚。

所以现在是：

```text
                ┌─ Production
Pi Worker ──────┤  Pi SDK JSONL compatibility
                │  JSONL 存 PG
                │
                └─ Prototype
                   DurableAgentHarness
                   Pi SessionStorage → PG
                   ExecutionAuthority internalized
```

这点以后讨论时我们要一直记住。

---

第二个是 **Tool Broker 还没有删**。

当前 Tool Broker 仍然承担：

```text
validate Tool authority
resolve Sandbox Domain
Cube lifecycle reconcile
protect Cube management credentials
```



也就是说我们昨天最后推导出的：

```text
Pi Harness
   │ ExecutionAuthority
   ▼
Cube ExecutionEnv
   │
   ▼
Cube-side authority enforcement
```

**还没有做到足以把 Tool Broker 完全拿掉。**

现在仍然是：

```text
Pi Harness / Worker
       │ opaque authority
       ▼
Tool Broker
       │ concrete lease/fence enforcement
       ▼
Cube
```

研究文档甚至明确写了：

> Harness/provider 持有 opaque authority；PG 和 Tool Broker 仍然在真正 effect boundary 验证具体 claim/fence。

所以这一块正好还是我们接下来可以继续研究的。

---

### Kafka / Valkey 没动

这一点也和昨天总结一致。

现在仍然明确是：

```text
Worker local WAL
      ↓
Kafka  ← durable before visibility
      ↓
Valkey ← bounded rebuildable projection
      ↓
SSE
```

terminal Turn 最终进 PostgreSQL。

所以目前是 **三个 durable authority**：

```text
PostgreSQL
→ business / Run / Pi / canonical conversation

Kafka
→ high-frequency live event log

Persistent Cube Volume
→ Workspace bytes
```

Valkey不是 authority，可以从 Kafka rebuild。

---

还有一个挺不错的结果：这次重构不是只跑 unit test。

最新 real-token acceptance 已经做到了：

```text
真实 coding Turns × 11
        ↓
context ~120,984 tokens
        ↓
Pi native compaction
        ↓
~23,524 tokens
        ↓
继续 coding
        ↓
杀掉 owning Worker
        ↓
另一个 Worker restore
        ↓
继续 coding
```

整个过程仍然绑定同一个 persistent Cube Workspace；总共 150 次真实 model attempts，其中 3 次 transient upstream failure 被恢复。

这个验证含金量比之前那种简单两三轮测试高很多。

所以我现在对当前仓库的心智模型已经更新成：

```text
                 PostgreSQL
          ┌──────────┼──────────┐
          │          │          │
       Run Queue   Pi State   Business
          │
          ▼
     Pi Worker Pool
          │
     Pi Agent Loop
          │
          ▼
      Tool Broker      ← 目前主要还剩的可疑层
          │
          ▼
     CubeSandbox
          │
          ▼
   Persistent Volume


Worker Events
     │
     ▼
   Kafka
     │
     ▼
   Valkey
     │
     ▼
    SSE
```

**Cell、Temporal、MinIO、Kopia 这些我们之后可以直接当作已经不存在了。**

接下来最值得继续 review 的，我觉得正好就是两个：

```text
1. Tool Broker 能不能继续砍
2. Kafka + Valkey 这套 event plane 有没有简化空间
```

而 `ExecutionAuthority → Pi Harness` 这一块，现在已经不是纯理论讨论了，仓库里已经有可以继续演进的 prototype。

## 199 · User · 2026-08-14T00:48:44.591Z

对，是的，我让codex实现了session storage backend, 它尝试实现了但是没有在实际链路中切换，说是pi预留了这些接口但还没有实现。我想问自己实现这些接口难度大吗？codex提到了compact,resume，prompt这些都得自己实现，但是这些原agent loop里面应该也有这些逻辑吧，照着抄按照语义对齐复现，会有很大难度吗，具体难在哪呢

## 200 · Assistant · 2026-08-14T00:49:18.546Z

可以自己实现，而且**不是“从零重写 Pi”那种难度**。你的直觉基本正确：模型调用、Tool Loop、消息转换、steer/follow-up、compaction 算法这些核心能力原来的 Pi 里都已经有，正确做法不是重写，而是把它们包进一个 durable state machine。

Pi 当前 `agent-loop.ts` 已经提供 `runAgentLoop()` / `runAgentLoopContinue()`，负责 provider 请求、Tool call、Tool result、steering/follow-up 以及事件流；compaction 的准备、summary、token 估算等 helper 也已经单独导出了。 所以你真正需要自己实现的是上面这一层：

```text
          你需要实现的 Harness

SessionStorage
      │
      ▼
load durable state
      │
      ▼
决定“下一步应该干什么”
      │
      ├── runAgentLoop()
      ├── compaction helpers
      └── Tool reconciliation
      │
      ▼
persist new durable state
```

这和“自己重写 Agent Loop”差别非常大。

### `prompt()` 其实不算难

普通 `prompt()` 大概就是：

```text
acquire ExecutionAuthority
        ↓
读取当前 Session branch
        ↓
append operation_started
        ↓
append user message
        ↓
runAgentLoop()
        ↓
message_end 时 persist
        ↓
append operation_finished
```

你现在仓库里的 `DurableAgentHarness` prototype 已经基本这么做了：恢复 active compacted branch、写 `operation_started`、调用 Pi 的 `Agent`/low-level loop、增量保存 message/tool records，并用同一个 opaque authority 包住 Session 和 Tool。

所以 **`prompt()` 我会给难度 3/10 左右**。

而且有一个新情况：Pi 当前 `main` 已经比你昨天 Codex 使用的 `0.84.1` 往前走了。现在 upstream `AgentHarness` 普通 turn lifecycle 已经实现了不少，官方文档明确说 Harness 现在直接拥有 run lifecycle，并直接调用 `runAgentLoop()`；普通 `prompt` 已经按照 `createTurnState() → executeTurn()` 组织。

所以未来你甚至可能不断从 upstream 抄回实现，而不是自己维护一套完全独立逻辑。

---

### `compact()` 也没有想象中那么可怕

**compaction 算法本身不用重写。**

Pi 已经有：

```text
prepareCompaction()
findCutPoint()
generateSummary()
compact()
calculateContextTokens()
...
```

而 coding-agent 现在本身也使用这些 compaction primitives。

你要补的是 durable wrapper：

```text
operation_started(compaction)
        ↓
读取当前 branch
        ↓
prepareCompaction()
        ↓
调用模型生成 summary
        ↓
原子 append compaction entry
        ↓
移动 branch / leaf
        ↓
operation_finished
```

真正需要小心的是：

```text
summary 已经生成
↓
Worker crash
↓
compaction entry 到底 commit 了没有？
```

恢复时不能再随便 compact 第二次。

不过这是一个相对清晰的事务状态机，所以我大概给 **5/10**。

Pi 当前 Harness 文档也明确说 manual compaction/tree navigation 已经存在，但 **auto-compaction 和 retry decision points 还没有完全迁进 AgentHarness**。

这部分你需要把旧 `AgentSession` 的行为补回来。

---

## 真正困难的是 `resume()`

这是整个事情的核心。

因为 `resume()` 不是：

```ts
await agent.continue();
```

Worker crash 以后：

```text
JS call stack
Promise
Agent object
局部变量
```

全没了。

所以：

> `resume()` 的真正含义是：**根据持久化记录重新推断 Agent 程序执行到了哪个 safe boundary。**

例如下面这几种 crash：

```text
① user message persisted
   ↓
   crash
   ↓
   provider 还没调用


② provider request started
   ↓
   crash
   ↓
   不知道 provider 有没有生成结果


③ assistant message 完整
   ↓
   tool_started
   ↓
   bash 实际执行成功
   ↓
   crash
   ↓
   tool_result 没持久化


④ tool_result 已持久化
   ↓
   crash
   ↓
   下一次 provider call 没开始


⑤ compaction summary 已经生成
   ↓
   compaction entry 刚好 commit
   ↓
   crash
```

这五种情况，恢复动作完全不同。

理想的 durable records 最后其实会自然变成：

```text
operation_started

step_started
provider_pending
provider_completed

tool_started
tool_completed / tool_interrupted

compaction_started
compaction_completed

operation_finished
```

`resume()` 干的事情就是：

```text
读取 open operation
       ↓
检查最后 durable record
       ↓
恢复状态机
```

例如：

```text
最后记录 = tool_completed
→ 不执行 Tool
→ 继续下一次 LLM

最后记录 = tool_started
→ effect uncertain
→ 根据 Tool replay policy 处理

最后记录 = provider_pending
→ 开一个新的 generation attempt

最后记录 = operation_finished
→ 根本不需要 resume
```

这才是难点。

Pi 自己新的 durable Harness v2 设计也是这么定义 `resume()` 的：恢复 open operation 后，根据 run / compaction / navigation 类型继续相应 procedure；run recovery 还需要处理 unresolved tool batch、deferred state 和 missing initial messages。

而且 upstream 当前明确把 **semi-durable harness/session recovery** 列为 Planned，剩余工作包括 durable queues、pending writes、operations、provider requests、tool calls，以及 unfinished turn/provider/tool/compaction/navigation 的保守恢复策略。

所以 **`resume()` 我会给 8/10**。

不是因为代码算法复杂，而是 crash matrix 多。

---

还有一个很容易低估的东西：**“什么时候 Agent 真的结束了？”**

比如模型不再调用 Tool：

```text
agent_end
```

你可能觉得结束了。

但实际上旧 coding-agent 可能接着：

```text
auto retry
auto compaction
continue()
steer
follow-up
extension 回调又触发新的 turn
```

Pi 社区甚至专门有人提过 `agent_settled`，因为 `agent_end` 之后还可能立即重新进入 Agent Loop。这个 issue 总结出的 race 包括 queued messages、retry/compaction continuation、extension re-entry、async timer/microtask 和 session switching。

这就是为什么 Codex 提到：

```text
compaction
resume
prompt
steer
event mapping
sampling identity
```

都要 parity，不是在故意把事情说复杂。你仓库里的研究文档现在也把这些明确列成 production switch 前的剩余 gate。

---

不过这里有一个很重要的好消息：

**AgentDock 根本没必要实现 Pi 通用 Harness 的 100% 功能。**

Pi upstream 想支持的是：

```text
extensions
hooks
tree navigation
lanes
parallel operations
skills
prompt templates
steer
follow-up
nextRun
branch summary
different Session backends
...
```

它要做一个通用 framework，所以难度非常高。Pi 的新 v2 甚至设计了多 lane、durable queue、navigation、subagent 等完整语义。

AgentDock 现在需要的其实窄得多：

```text
一个 Session
一个 active Run
    │
    ├─ prompt
    ├─ LLM
    ├─ tool
    ├─ LLM
    ├─ compact
    └─ terminal

crash
↓
resume
```

再加：

```text
cancel
steer
ExecutionAuthority
```

就已经足够一个 Cloud Coding Agent。

因此我不会建议：

> fork Pi，然后把完整 `AgentHarness` 实现完。

而会建议继续沿 Codex 现在走的路线：

```text
Pi public primitives
├─ Session / SessionStorage
├─ runAgentLoop
├─ compaction helpers
├─ message conversion
└─ AgentTool

          ↓

AgentDock DurableAgentHarness
├─ prompt
├─ resume
├─ compact
├─ steer
├─ authority
└─ crash recovery policy
```

也就是说，**复用 Pi 的“算法和单进程 Agent Loop”，自己只实现“durable orchestration”。**

这其实也是 Pi 新 harness-v2 文档自己的实现思路：它明确要求以现有 `agent-loop.ts`、`agent.ts` 和 coding-agent `AgentSession` 为参考，把原有行为“preserve in spirit”，再拆成 durable step primitives。

所以你说的：

> “原 Agent Loop 有这些逻辑，照着抄，语义对齐复现不就行了？”

我的答案是：

**对，大方向完全正确。**

只是要把它改成一句更准确的话：

> **普通执行逻辑照着复用；crash recovery 逻辑不能照抄，因为旧 Agent Loop 从来不需要面对“自己的内存和 call stack 已经消失”这个问题。**

真正需要我们自己设计的，就只有这一小块：

```text
             durable record
                  │
                  ▼
        ┌─────────────────┐
        │ recovery driver │
        └────────┬────────┘
                 │
        最后一次 safe boundary
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
   provider    tool     compaction
   resume      reconcile   resume
```

而你现在 Codex 写出来的 `DurableAgentHarness`，其实已经把这个方向证明了一半：multi-round PG restore、compaction boundary restore、authority revoke 阻止 Tool、terminal authority close 都已经有 automated evidence。

所以我现在反而倾向于：**可以继续自己做，不需要因为 upstream `AgentHarness` 尚未完成就卡住整个 AgentDock。**只要保持在 Pi public primitives 上实现，不魔改 `agent-loop.ts`，以后 upstream Harness 真正成熟时，再把这层 adapter 替换掉就行。

## 201 · User · 2026-08-14T00:58:10.077Z

没太听懂，其实我只是想要从pgsql里面取出运行需要的session数据（当然就像我们讨论的那样，是只要尾部的那一段，而不是全量下载），然后产生新的session数据时写会pgsql（这里我们应该已经能做到了吧？），怎么会这么复杂呢？

## 202 · Assistant · 2026-08-14T00:58:16.177Z

对，你说得对。**如果你的目标只是“把 Pi 的 Session 存储从 JSONL 换成 PostgreSQL”，事情本来没有我上一条说得那么复杂。**

我上一条把两个问题混在了一起：

```text
A. SessionStorage backend
B. Durable AgentHarness / mid-turn crash recovery
```

你现在问的其实只是 **A**。

而 A 已经基本做成了。

当前仓库里的 `@agent-dock/pi-session-postgres` 已经可以：

```text
PostgreSQL
   │
   ├─ 按当前 branch 读取
   │  并在最近 compaction 停止
   │
   ▼
只拿模型真正需要的 active context

运行 Agent

新 message / tool result / compaction entry
   │
   ▼
增量 append 回 PostgreSQL
```

而且现在 branch restore 已经不是一层层 N+1 query，而是一个 recursive CTE，一次查询拿到“最近 compaction + 后面的尾巴”。

所以**你脑子里这个目标没有问题，而且存储层已经基本实现了。**

---

真正卡住的地方其实只有一句话：

> **Pi 现在稳定的 coding-agent 运行入口还不接受 `SessionStorage`。**

现在生产使用的旧入口大概是：

```text
Pi coding agent
      │
      ▼
SessionManager / session.jsonl
```

而你想要：

```text
Pi coding agent
      │
      ▼
Session
      │
      ▼
SessionStorage
      │
      ▼
PostgreSQL
```

Pi 已经把下面这个接口设计出来了：

```text
SessionStorage
```

但**还没有把原来 coding-agent 那整套运行入口完全改成从这个接口启动**。

所以现在 AgentDock 才尴尬地处于：

```text
已经有：

PostgresSessionStorage ✓

但是生产入口：

coding-agent → JSONL
```

因此当前生产路径只能先：

```text
PostgreSQL
   │
   ▼
存一个 Pi-native JSONL object
   │
   ▼
旧 Pi coding-agent
```

README/架构文档现在也明确写的是这个 temporary compatibility path。

---

### 那为什么 Codex 提到 `prompt / resume / compact`？

因为它选择了一条更激进的路线：

> 既然 Pi 上层还没接好 `SessionStorage`，那我自己实现一个 `DurableAgentHarness`，直接绕开旧 coding-agent SessionManager。

于是它就必须补：

```text
prompt()
resume()
compact()
...
```

但**这不是 Postgres SessionStorage 本身所要求的东西。**

可以这么看：

```text
我们真正想换掉的：

┌───────────────┐
│ session.jsonl │
└───────────────┘
        ↓
┌──────────────────────┐
│ PostgresSessionStorage│
└──────────────────────┘
```

理论上 Agent Loop 上层完全不用变。

最理想就是 Pi upstream 自己完成：

```text
AgentSession / Coding Agent
          │
          ▼
       Session
          │
          ▼
    SessionStorage
```

那我们只需要传：

```ts
sessionStorage: postgresStorage
```

结束。

---

所以你问：

> “产生新的 session 数据时写回 PG，这里应该已经能做到了吧？”

**是的。**

当前 prototype 已经证明了：

- multi-round Session 能直接从 PG 恢复；
- 新 user/assistant/tool-result 可以增量 append；
- compaction 后只恢复 compaction 后有效上下文；
- branch query 只取 active compacted branch。

**存储技术本身已经不是问题。**

现在差的是：

```text
旧 Pi coding-agent runtime

从：
JSONL SessionManager

改成：
SessionStorage
```

---

而且我现在反而觉得，我们下一步应该把问题简化，不要一上来做“大而全的 DurableAgentHarness”。

可以先问一个非常窄的问题：

> **能不能拿现有 `runAgentLoop()`，给它喂从 PostgreSQL SessionStorage 恢复出来的 messages，然后在 `message_end/tool_result` 时 append 回 SessionStorage？**

如果可以，实际链路可能就是：

```text
PG SessionStorage
      │
      ▼
buildSessionContext()
      │
      ▼
messages[]
      │
      ▼
runAgentLoop()
      │
      ├─ assistant message
      ├─ tool result
      └─ ...
      │
      ▼
Session.appendEntry()
      │
      ▼
PostgreSQL
```

这就跟你想象的一样简单。

`resume()` 那些复杂东西，是我们**以后想做到“Agent Loop 跑到一半 Worker 死了还能精确从 step 恢复”**才需要面对的。

但按照我们前面已经形成的想法：

```text
Worker crash
→ Workspace 保留现场
→ Session 保留已落盘内容
→ 下一次 Agent 看现场继续
```

甚至未必需要把 `resume()` 做成一个很复杂的 durable program counter。

所以我现在觉得你这个质疑是对的：

> **我们可能把“换 Session backend”过度升级成了“重做整个 durable Harness”。**

这两件事应该拆开。

## 203 · User · 2026-08-14T01:13:52.772Z

你这个问题凝练得很精确，那么，难吗？

## 204 · Assistant · 2026-08-14T01:14:10.577Z

对，**严格按你刚刚凝练出来的目标，我认为不难。大概 3～4/10。**

因为现在 Pi 的底层边界其实已经非常适合这么接了。当前 `runAgentLoop()` 的输入就是：

```ts
runAgentLoop(
  prompts,
  context,   // 里面直接有 messages[]
  config,
  emit,
  signal,
  streamFn
)
```

它不关心这些 `messages[]` 是从 JSONL 来的、SQLite 来的，还是 PostgreSQL 来的；而且执行结束会返回本次产生的 `AgentMessage[]`，中间还会发 `message_end` 事件。

所以最小实现真的就是：

```text
PostgreSQL SessionStorage
        │
        │ 读取当前 branch
        │ stop at latest compaction
        ▼
  AgentMessage[]
        │
        ▼
   runAgentLoop()
        │
        │ message_end
        ▼
 Session.appendEntry()
        │
        ▼
   PostgreSQL
```

而且**上下两头你现在其实都已经做好了**。

读取：

```text
PG
→ recursive CTE
→ 当前 branch
→ 最近 compaction 截止
→ buildSessionContext()
→ messages[]
```

写入：

```text
user message
assistant message
tool result
compaction entry
→ SessionStorage
→ PG
```

Codex 的 prototype 已经验证了 multi-round restore、compaction 后只恢复有效 branch、增量写 entry。

所以剩下的本质是**胶水代码**。

### 我认为实际只需要四步

第一步：

```ts
const entries = await session.findEntriesOnBranch({
  stopAtType: "compaction"
});

const context = buildSessionContext(entries);
```

得到：

```text
context.messages
```

第二步：

```ts
await runAgentLoop(
  [newUserMessage],
  {
    messages: context.messages,
    systemPrompt,
    tools
  },
  config,
  onEvent,
  signal,
  streamFn
);
```

Pi 当前 loop 自己负责：

```text
LLM
→ tool calls
→ tool results
→ LLM
→ ...
```

你不用重写。

第三步，在事件边界写 PG：

```ts
onEvent(event) {
    if (event.type === "message_end") {
        session.appendEntry(event.message)
    }
}
```

当然真实代码要做 Pi Entry 转换、parent/leaf 等，但这些 API 现在也已经存在。

第四步，Turn 完成后更新 leaf / operation state。

结束。

---

真正稍微需要注意的是 **不要在 `message_update` 时写 SessionStorage**。

模型 streaming：

```text
h
he
hel
hell
hello
```

这些属于实时 event stream，继续走：

```text
Kafka → Valkey → SSE
```

SessionStorage 只在：

```text
message_end
```

写一次完整 message。

也就是说：

```text
streaming durability → Kafka
Agent history durability → PG SessionStorage
```

这两件事情不要混。

---

`compact()` 也没有想象得很复杂，因为 Pi 已经把 compaction primitive 拆出来了；当前 upstream 还明确把现有 `runAgentLoop` 保留为底层组合，而 Harness 负责在这些执行 phase 之间插 durability write。

所以我们不用自己发明“怎么总结上下文”。

大概就是：

```text
context 太大
   ↓
Pi prepare/compact helper
   ↓
得到 compaction entry
   ↓
append 到 PG
   ↓
新的 active branch 从这里开始
```

你仓库最新真实测试甚至已经证明 Pi 的原生 compaction 能把约 120k token context 压到约 23k，然后继续 coding、再跨 Worker 恢复。

所以算法风险也很低。

---

### 那为什么 Codex 会显得那么谨慎？

因为它想做的是：

> **完全替换现在生产的 `AgentSession/coding-agent runtime`。**

这和：

> **把 `runAgentLoop` 接到 PG SessionStorage。**

不是同一个规模。

现在 coding-agent 上面还附带着：

```text
auto compaction
retry
steer
follow-up
extensions
world-state markers
sampling identity
event mapping
...
```

如果要求：

> “换完以后每一个行为和旧 production runtime 100% 一样”

那 parity 工作当然不少。

但如果我们的目标是：

> **保留现有 Pi Agent Loop；只把它的上下文输入改成 PG，产生的完整消息写回 PG。**

这个实现本身我认为**相当直接**。

甚至 Pi upstream 当前方向本身就在做同样的事：新 Harness 直接调用现有 `runAgentLoop()`，Session 负责构建 context，而不是重新实现一个 Agent Loop。

所以我现在会建议把任务明确拆成：

```text
第一阶段

PG SessionStorage
       ↓
build context
       ↓
runAgentLoop()
       ↓
message_end
       ↓
PG SessionStorage
```

**先把这条真实 production 链路切通。**

不要把 `durable resume / exact mid-tool crash recovery / 完整 Harness parity` 绑在这次切换上。那些是另外的问题。

所以回答你的“难吗”：

> **单纯完成 PG SessionStorage → Pi Agent Loop → PG SessionStorage 的闭环，我认为不难，而且现在基础代码已经完成大半。难的是你如果坚持“一次切换顺便把 Pi 尚未完成的整个 durable Harness 也实现完”。这两件事应该拆开。**

## 205 · User · 2026-08-14T01:18:14.003Z

那么codex为什么会想完全替换现在生产的 `AgentSession/coding-agent runtime`  ，难道是因为我跟它说过想将lease，fencing这些东西内化在pi里面？

## 206 · Assistant · 2026-08-14T01:18:18.554Z

对，**很大一部分原因就是这个**，但不完全是。

你当时实际上同时给 Codex 了两个目标：

```text
1. SessionStorage → PostgreSQL
2. lease / fencing → 尽量内化进 Pi Harness
```

如果只有第 1 个目标，完全可以走我们刚才说的轻量方案：

```text
PG SessionStorage
    ↓
build context
    ↓
现有 runAgentLoop()
    ↓
message_end
    ↓
写回 PG
```

没必要替换整个 `AgentSession/coding-agent runtime`。

但第 2 个目标会改变问题。

因为你希望最终做到：

```text
             一份 ExecutionAuthority
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   SessionStorage write    Tool effect
          │                   │
          ▼                   ▼
          PG                 Cube
```

也就是说 **authority 必须成为 Agent 执行生命周期的一部分**。

而旧的 coding-agent runtime 本来不是按这个抽象设计的。它更接近：

```text
AgentSession
├─ JSONL SessionManager
├─ agent loop
├─ compaction
├─ tool execution
├─ steer
├─ retry
└─ extensions
```

很多东西已经揉在一起了。

如果 Codex硬在这里塞：

```text
ExecutionAuthority
```

就会变成到处 patch：

```text
AgentSession.prompt()
→ 加 fence

save message
→ 加 fence

tool call
→ 加 fence

compact
→ 加 fence

resume
→ 加 fence
...
```

这正是我们最讨厌的：

> lease/fence 从上到下贯穿整个系统。

所以 Codex 选择了另一个方向：

```text
Pi public primitives

SessionStorage
Agent
runAgentLoop
Tool
compaction primitives
        │
        ▼
DurableAgentHarness
        │
        └── 一份 opaque ExecutionAuthority
```

你仓库里的研究文档其实直接写明了它的目标：

> “Can AgentDock stop restoring a complete `session.jsonl` for every Run, **and can the Run lease/fence become an internal Harness concern instead of application plumbing?**” 

所以你的猜测基本命中。

---

而且 Codex 实现的 prototype 也明显是冲着这个目标去的。

`DurableAgentHarness` 做的不是单纯：

```text
PG → messages → Agent → PG
```

而是：

```text
acquire one DurableAgentExecutionAuthority
        │
        ├─ Session mutation 前检查
        ├─ Tool execution 前后检查
        └─ authority 丢失 → abort agent loop
```

研究文档明确列出了这一点。

这显然已经超出了“SessionStorage backend adapter”的范围。

---

但还有第二个原因：

**Pi 新的 `SessionStorage` 架构和旧 coding-agent `AgentSession` 并不是直接插拔关系。**

Pi 0.84 已经有：

```text
Session
SessionStorage
entries
lanes
operation records
compaction boundaries
```

但旧 production coding-agent 仍然从 JSONL/session-file 那套入口跑。当前 AgentDock 文档也明确写着：

> PostgreSQL `SessionStorage` 已经实现，但 production coding adapter 暂时仍使用旧 Pi SDK/session-file entrypoint。

因此 Codex 面临两个选择：

```text
方案 A
魔改旧 AgentSession
让它支持 SessionStorage + Authority

方案 B
直接用 Pi public primitives
拼一个新的薄 Harness
```

它选了 B。

从架构洁净度来说，这个选择其实没错。

---

**但我们现在发现的是：它可能一步走得太远了。**

你的真正近期需求其实可以拆成两阶段：

```text
阶段 1
先把 JSONL 干掉

PG SessionStorage
→ runAgentLoop
→ PG SessionStorage
```

先证明生产链路可以不依赖 JSONL。

然后：

```text
阶段 2
再把 ExecutionAuthority
正式内化到 Harness
```

这样风险小很多。

Codex 当时把：

```text
Session backend migration
+
Harness redesign
+
distributed authority internalization
+
crash recovery
```

一次绑在了一起，所以它才突然冒出：

```text
prompt
resume
compact
steer
...
```

一大堆 parity 工作。

所以回答你的问题：

> **是的，你提出“把 lease/fencing 内化进 Pi”是 Codex 走向完整 `DurableAgentHarness` 的主要原因之一。其次是 Pi 当前旧 coding-agent runtime 本身没有直接消费新 SessionStorage 的干净插槽。**

如果我们现在重新安排优先级，我会把它拆开：**先实现最小 PG SessionStorage 闭环，不要求这次同时完成整个 Harness 替换；ExecutionAuthority 的完整内化放下一步。**这会简单很多。

## 207 · User · 2026-08-14T01:27:07.965Z

嗯，确实。我还有一点不太懂，假如真的能把lease和fencing内化进pi的harness，我们真的可以避免lease和fencing贯穿整个系统的糟糕设计吗？因为我考虑到一点，我们现在pi的agent loop和tool的执行环境，其实是分开的，就算lease和fencing内化进了pi的harness，是不是还是意味着我们要在agent loop和tool的执行环境传递lease和fencing？

## 208 · Assistant · 2026-08-14T01:27:13.370Z

对，你抓到关键点了。

**把 lease/fencing 内化进 Pi Harness，并不能让“执行权限”凭空消失。**  
因为 Agent Loop 和 Tool execution environment 是两个独立故障域：

```text
Pi Worker
   │
   │ network
   ▼
Tool Broker / Cube
   │
   ▼
Workspace
```

所以某种“我现在仍然有权执行这个 effect”的信息，**一定要跨过这条网络边界**。

但我们能消灭的是现在这种糟糕设计：

```text
Run
  leaseId
  fence
    ↓
Worker
  leaseId
  fence
    ↓
Pi
  leaseId
  fence
    ↓
Tool Call
  leaseId
  fence
    ↓
Tool Broker
  leaseId
  fence
    ↓
Workspace
```

换成：

```text
             ExecutionAuthority
                    │
              Pi Harness 持有
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   SessionStorage         ExecutionEnv
          │                   │
          ▼                   ▼
          PG                 Cube
```

注意区别：

> **权限语义还是贯穿系统，但 lease/fence 这些具体实现细节不再贯穿系统。**

这两件事情差很多。

---

例如 Harness 拿到的可以只是：

```ts
interface ExecutionAuthority {
    signal: AbortSignal
    proof: AuthorityProof
}
```

Pi Agent Loop 根本不知道：

```text
leaseId = xxx
fencingToken = 42
expiresAt = ...
```

它只知道：

```text
authority 还有效吗？
```

然后 Pi 调：

```ts
bash("npm test")
```

Tool 本身也不知道 fence。

内部自动变成：

```text
bash tool
   ↓
ExecutionEnv.exec()
   ↓
AuthorityBoundCubeClient
   ↓
Cube
```

只有最底层 adapter：

```text
AuthorityBoundCubeClient
```

知道怎么把 `authority.proof` 带过去。

---

甚至还可以更进一步。

### 不一定每个 Tool RPC 都传 fence

例如 Worker 开始一个 Run 时：

```text
PG
↓
acquire epoch=42
↓
创建 Cube activation
```

建立一次：

```text
activation:
workspace=A
authority=epoch42
```

然后返回：

```text
activationHandle = abc
```

之后整个 Agent Loop：

```text
bash
read
edit
write
```

都只是：

```text
exec(activationHandle, ...)
```

而不是：

```text
exec(
  leaseId,
  fencingToken,
  runId,
  attemptId,
  workspaceId,
  ...
)
```

Cube/Tool Broker 内部知道：

```text
activation abc
→ authority epoch=42
```

新 Worker 接管：

```text
epoch=43
↓
旧 activation abc 被 revoke / terminate
↓
创建 activation xyz
```

那么：

```text
旧 Worker
→ activation abc
→ rejected
```

这就非常干净了。

---

所以最终最好是三层：

```text
PostgreSQL
    │
    │ concrete ownership
    │ lease / epoch
    ▼
ExecutionAuthorityProvider
    │
    │ opaque authority
    ▼
Pi Harness
    │
    │ opaque capability
    ▼
ExecutionEnv
    │
    │ activation/capability
    ▼
Cube effect boundary
```

只有两端知道真实的 fence：

```text
PostgreSQL authority provider
Cube authority enforcement
```

中间：

```text
Control Plane
RunCommandExecutor
Pi Agent
Tool definitions
Session logic
业务代码
```

都不需要知道 `fencingToken` 是什么。

---

### 但有一个无法消灭的事实

如果 Cube 是独立服务，那么 **effect boundary 必须参与 fencing**。

否则：

```text
Worker A
epoch=42
↓
开始 bash
↓
网络卡住

Worker B
epoch=43

Worker A 恢复
↓
继续修改 Workspace
```

所以无论抽象得多漂亮，总要有：

```text
Pi side:
“I hold authority X”

Cube side:
“X is still valid / X has been revoked”
```

只是这个 X 可以是：

- opaque token；
- activation capability；
- signed credential；
- connection/session handle；
- epoch；
- 其他 capability。

**它不需要是裸 `leaseId + fencingToken`。**

---

还有一个更重要的地方：**已经启动的 Tool。**

假设：

```text
epoch=42
↓
bash 长任务已经启动
↓
epoch=43 takeover
```

这时候仅仅：

```text
拒绝 epoch=42 的下一次 RPC
```

还不够。

因为之前启动的 bash 可能仍然在写 Workspace。

所以 takeover 必须有：

```text
epoch=43 获取 authority
        ↓
revoke old activation
        ↓
kill / fence old Cube processes
        ↓
确保旧 execution world quiesced
        ↓
新 activation 开始
```

因此最终我觉得最漂亮的抽象不是：

```text
每个 Tool Call 带 fence
```

而是：

> **一个 Pi Run 持有一个 authority-bound execution activation。**

也就是：

```text
DurableAgentHarness
        │
        ├── PG Session authority
        │
        └── Cube Activation authority
```

Harness authority 丢失：

```text
abort Agent Loop
+
revoke Cube activation
```

新 Harness 接管：

```text
new authority
+
new/rebound activation
```

---

所以回答你最开始的问题：

**是的，物理意义上的 authority 信息仍然必须从 Agent Loop 这一侧传播到 Tool execution boundary。这个无法避免。**

但我们可以把：

```text
lease/fence 到处作为业务参数传播
```

变成：

```text
ExecutionAuthority
→ 自动绑定 ExecutionEnv
→ 自动绑定 Cube activation
```

这样对于整个上层系统来说，lease/fencing 就从“横穿所有模块的协议字段”，变成了**底层 execution runtime 的实现细节**。

我觉得这才是真正值得追求的“内化”。

## 209 · User · 2026-08-14T01:41:03.867Z

现在我们的lease和fencing是不是得写到pgsql，如果按照你这套说法，是只需要在pi worker以下传递就可以了？还是executionAuthority只是另一种形式的lease和fencing，最终还是要写道pgsql?

## 210 · Assistant · 2026-08-14T01:41:09.695Z

对，**`ExecutionAuthority` 本质上仍然是 lease + fencing 的抽象，不是把 lease/fencing 从物理上消灭。**

而且在我们现在这套架构里，我仍然认为**具体的 ownership 状态应该写在 PostgreSQL**。当前 main 也是这么做的：PostgreSQL 仍然是 Run/Attempt/lease/fence 的 authority。

区别在于“谁需要知道这些东西”。

现在比较像：

```text
PostgreSQL
  lease_id
  claim_owner
  expires_at
  fencing_token
       │
       ▼
RunCommandExecutor
       │
       ▼
Pi Worker
       │
       ▼
Pi runtime
       │
       ▼
Tool RPC
       │
       ▼
Tool Broker
       │
       ▼
Cube
```

很多层都在显式认识：

```text
leaseId
fencingToken
attemptId
...
```

这才是我们觉得恶心的地方。

内化以后应该是：

```text
PostgreSQL
┌─────────────────────────┐
│ owner = worker-B        │
│ epoch = 43              │
│ expires_at = ...        │
└────────────┬────────────┘
             │
             │ acquire
             ▼
   ExecutionAuthorityProvider
             │
             ▼
    ExecutionAuthority
       （opaque object）
             │
       ┌─────┴─────┐
       ▼           ▼
SessionStorage   ExecutionEnv
       │           │
       ▼           ▼
      PG          Cube
```

所以 **PG 还是会存 `epoch=43`、lease expiry、owner 之类的东西。**

只是 Pi Harness 看到的是：

```ts
authority.signal
authority.assertCurrent()
authority.proof
```

而不是：

```ts
leaseId
fencingToken
expiresAt
claimOwnerId
```

---

你说的：

> “是不是只需要在 Pi Worker 以下传递？”

基本接近，但我会稍微改一下：

> **具体 lease/fence 只需要存在于 ownership 的两端，不需要贯穿整个业务系统。**

两端是：

```text
1. PostgreSQL
   → 谁现在拥有 execution authority

2. 真正产生副作用的地方
   → Session write / Cube Tool effect
```

中间绝大部分代码都不需要知道。

比如：

```text
Control Plane
→ 不需要懂 fence

Run Queue
→ 只负责找可执行 Run

Pi Agent Loop
→ 不需要懂 fence

bash tool
→ 不需要懂 fence

write tool
→ 不需要懂 fence
```

只有：

```text
PostgresAuthorityProvider
PostgresSessionStorage
CubeAuthorityAdapter
```

知道具体怎么 enforce。

---

举一个完整例子。

Worker A claim：

```text
PG:

run-123
owner = A
epoch = 42
expires = 10:00:30
```

Worker A 得到：

```text
ExecutionAuthority A
```

它并不知道：

```text
epoch = 42
```

或者至少业务层不应该依赖这个值。

然后：

```text
Harness
  ↓
session.append(...)
```

`PostgresSessionStorage` 内部自动做：

```sql
UPDATE / INSERT ...
WHERE current_epoch = 42
```

同样：

```text
Harness
  ↓
bash("npm test")
  ↓
ExecutionEnv
```

底层自动带：

```text
authority.proof
```

去 Cube effect boundary。

---

Worker B 接管：

```text
PG:

owner = B
epoch = 43
```

于是：

```text
A 的 Session write
→ rejected

A 的新 Tool call
→ rejected

B
→ accepted
```

所以**真正的 fencing token 仍然存在**。

只是你在代码里不会看到：

```text
function executeTool(
  runId,
  attemptId,
  leaseId,
  fencingToken,
  workspaceId,
  ...
)
```

而可能只是：

```ts
env.exec(command)
```

因为 `env` 在创建时已经绑定好了：

```text
ExecutionAuthority
```

---

所以我觉得可以用一句话概括：

> **ExecutionAuthority 不是替代 lease/fencing，而是把 lease/fencing 从“业务协议”降级成“runtime implementation detail”。**

这才是我们想要的。

最终 PostgreSQL 里甚至可以把现在散落的：

```text
session lease
run attempt claim
workspace fence
tool owner
...
```

继续收敛成一套更统一的：

```text
execution_authority

scope_id
owner_id
epoch
expires_at
```

然后 SessionStorage 和 Cube 都围绕**同一个 epoch** 做 enforcement。

这会比现在“每个子系统自己发明一套 lease/fence”干净很多。

## 211 · User · 2026-08-14T01:47:58.117Z

你再拉取一下，codex又推送了一个commit

## 212 · Assistant · 2026-08-14T01:48:49.189Z

拉到了，最新 commit 是 **`c83b6df` — `feat(pi-runtime): implement durable AgentHarness surface`**。这次改动很大，而且基本把我们刚才讨论的那个问题做实了。

现在 `DurableAgentHarness` 已经不只是昨天那个 prototype 了。Codex 宣称并实现了 Pi 0.84.1 的完整公开 Harness surface，包括：

```text
prompt / run
resume / abort
queue
deferred provider response
manual drive
compaction
navigation
multiple lanes
hooks / events
skills / templates
configuration
close
```

并且全部是**组合 Pi 已公开的 `Agent / SessionStorage / compaction / branch-summary / model` primitives**，没有 patch Pi，也没有 fork Pi。新 ADR-0102 就专门把这个决定固定下来了。

更关键的是，`ExecutionAuthority` 也真的按我们讨论的方式做进去了：

```text
DurableAgentHarness
        │
        └── opaque ExecutionAuthority
                 │
        ┌────────┴────────┐
        ▼                 ▼
 SessionStorage       Tool effect
        │                 │
        ▼                 ▼
       PG             Tool Broker/Cube
```

Harness 本身不暴露 `leaseId / fencingToken`；同一份 authority 在 Session mutation 和远程 Tool effect 前后检查。Tool 如果中断，只有显式标为 `safe` 的才能 replay；不安全 Tool 会生成一个“副作用未知”的 synthetic error，让模型自己检查现场，而不是盲目重跑。

当前实现文件已经相当大，直接实现了 `AgentLane`，而且引入了 Pi 的 `prepareCompaction`、`compact`、`generateBranchSummary`、queue/lane/hook 等公开 primitives。也就是说 Codex 确实是在**复用 Pi 原逻辑，而不是重新发明 Agent Loop**。

测试也明显扩充了。现在 `durable-agent-harness.test.ts` 已经有约 35KB，仓库记录的 deterministic tests 覆盖了：

```text
PG Session restore
compaction boundary
authority revoke
deferred response 跨 Harness 恢复
hooks
lane-local config
queue persistence
manual execution
multi-lane
unsafe tool recovery
```



### 但生产链路仍然没有切

这是现在最重要的状态。

当前还是：

```text
Production
    ↓
旧 Pi coding-agent / session-file entrypoint
    ↓
JSONL compatibility object
    ↓
PostgreSQL
```

新的：

```text
DurableAgentHarness
    ↓
Pi SessionStorage
    ↓
PostgreSQL
```

目前仍然是 **staged adapter**。

这次 commit 说得比昨天更明确：**Pi runtime surface 本身已经补齐了**，现在阻止 production cutover 的主要已经不是 `prompt/resume/compact`，而是 AgentDock 外面的产品语义：

```text
1. Workspace terminal settlement
2. conversation terminal commit parity
3. production Kafka/Valkey/SSE event mapping
4. model sampling identity
5. real model + Cube acceptance
6. cross-Worker acceptance
```



所以我们刚才讨论的问题现在可以进一步更新：

> **“自己实现 Pi Harness 难不难”这件事，Codex 已经基本替你回答了：可以做，而且已经做出来了。**

现在更值得 review 的已经不是“能不能实现 `prompt/resume/compact`”，而是：

> **这个新 `DurableAgentHarness` 的实现是否靠谱，以及生产链路还剩的那几个 parity gate 到底有没有必要，还是 Codex 又过度保守了。**

我觉得下一步应该直接 review **production 为什么还不能切到它**。这比继续讨论 Harness API 本身更有价值。

顺便一提，GitHub 当前这个 commit 没返回 combined CI status，所以我现在不能说它已经 CI green。

## 213 · User · 2026-08-14T01:50:37.498Z

可以，那你好好review一下现在的实现能不能切吧

## 214 · Assistant · 2026-08-14T02:17:34.368Z

## 结论

**现在还不能把默认生产链路切到新的 `DurableAgentHarness`。**

但这不是因为它只是一个玩具 prototype。相反，这次实现已经相当完整，我会给出这样的评审结论：

| 部分 | 结论 |
|---|---|
| PostgreSQL `SessionStorage` | 基本可用 |
| `DurableAgentHarness` 的功能面 | 已经相当完整 |
| 作为独立 staging runtime | 可以接入 |
| 替换当前 production coding-agent runtime | 暂时不批准 |
| 通过 feature flag 给新 Session 做 canary | 修完几个 P0 后可以 |

Codex 保持它为 staged adapter 是正确的，不算过度保守。commit 本身也明确说，API completeness 已完成，但默认生产切换仍受 Workspace settlement、事件映射和真实模型/Cube 验收约束。

---

## 已经做得比较可靠的部分

### 1. PostgreSQL SessionStorage 不是空壳

现在已经能够：

```text
PostgreSQL
    ↓
读取当前 branch
    ↓
遇到最新 compaction 停止
    ↓
buildSessionContext()
    ↓
Pi Agent Loop

Agent 产生完整 message / tool result
    ↓
Session.appendEntry()
    ↓
PostgreSQL
```

Session 写入和 execution authority 检查也放进了同一个数据库事务，不是先检查 fence、再隔着一个竞态窗口写数据。这个边界是正确的。 

### 2. Tool 恢复策略总体合理

实现里已经有类似：

```text
Hook 转换参数
    ↓
校验参数
    ↓
持久化 tool intent
    ↓
再次验证 authority
    ↓
执行 Tool
    ↓
再次验证 authority
    ↓
持久化 result
```

而且只允许显式标记为 `safe` 的 Tool 在恢复时重放；`bash/write/edit` 这类不安全 Tool 中断后，会给模型一个“副作用未知”的 synthetic result，而不是盲目重跑。

这符合我们之前确定的 Workspace 恢复语义：**保留现场，让模型检查，而不是自动回滚或重复执行。**

### 3. 测试覆盖已经不是只有 happy path

当前测试覆盖了：

- 多轮 PG Session 恢复；
- compaction 后的 context 截断；
- authority revoke；
- Tool intent 到 effect 之间失去 authority；
- deferred response 跨 Harness 恢复；
- queue、manual drive、hooks、lane；
- 不安全 Tool 中断后的处理。

测试文件已经达到相当规模，不是几个简单 mock case。

这个 commit 的 GitHub Actions CI 也已经成功。

---

# 阻止现在切换的几个问题

## P0-1：最重要的目标——只读取 active context——目前还没有完全实现

正常调用模型时，代码确实会：

```ts
findEntriesOnBranch({
  stopAtType: "compaction",
  order: "newestFirst"
})
```

这部分是正确的。

但 Harness 初始化时还需要恢复：

```text
model
thinking level
active tools
```

当前实现会分别从当前 branch 头到尾执行 `oldestFirst` 查询，用历史 entry 重建这些配置。自动 compaction 路径也还有不带 compaction 截止点的完整 branch 查询。

于是可能出现：

```text
Session 总历史：2 GB
最近 compaction 后 active context：5 MB

构造 provider context：读 5 MB       ✓
恢复 model/thinking/tools：读完整 branch ✕
自动判断 compaction：可能再读完整 branch ✕
```

也就是说：

> **虽然不再下载一个 2GB JSONL 文件，但仍可能把 2GB 结构化 entries 从 PG 查询到 Worker。**

这会直接削弱你做 PG backend 的首要价值。

### 应该怎么改

不要再从历史 entry replay 当前配置。直接给 lane 增加当前状态，例如：

```text
pi_lane_state
├─ current_model
├─ thinking_level
├─ active_tools
├─ current_leaf
└─ latest_compaction_id
```

或者使用 Pi 新设计里的 register 模型。

Worker 冷启动应该只需要：

```text
读取 lane current state       几行
读取 compaction + suffix      几 MB
```

而不是扫历史。

这个问题修掉前，我不会批准生产切换。

---

## P0-2：单条写入是事务性的，但一个 durable operation 的多个步骤不是原子收口

例如 compaction 当前大致是：

```text
1. append compaction entry
2. append usage
3. append operation_finished
```

这是三个独立的持久化动作。

假设发生：

```text
append compaction entry ✓

Worker crash

append operation_finished ✕
```

此时：

```text
branch 已经移动到 compaction entry
但 operation 仍然显示 open
```

新 Worker `resume()` 时，如果没有先检查预留的 `resultEntryId` 是否已经存在，就可能再次生成或插入同一个 compaction entry；轻则唯一键冲突，重则把一个已经成功的 compaction 标成失败。

Navigation 也有类似窗口：

```text
moveLane() ✓
Worker crash
append summary / set label / operation_finished ✕
```

恢复时当前 leaf 已经变了，但实现又重新读取当前 leaf 作为 `oldLeafId`，恢复语义可能不再等同于原操作。

这不是说实现一定立刻出错，而是：

> **目前没有足够证据证明每一个持久化步骤之间崩溃后都能幂等恢复。**

### 应该怎么改

两个方向任选其一。

更干净的是让 storage 支持一次事务：

```text
append result entry
append usage
settle operation
move lane/register
```

一起提交。

或者把每一步做成严格幂等：

```text
resume
  ↓
resultEntryId 已存在？
  ├─ 是：不要重新执行，只补 usage / operation_finished
  └─ 否：继续原 effect
```

同时：

- navigation 的原始 source leaf 必须持久化后重复使用；
- usage/finish 使用确定性 ID；
- 每个 durable write 后都做一次 fault-injection test。

Pi 新 durable Harness 设计之所以强调完整 `op.state` 和事务提交，就是为了消除这种“从一串 records 猜执行到哪里”的窗口。

---

## P0-3：Pi operation 完成，还不等于 AgentDock 的 Run 完成

这是我认为最重要的产品级阻塞项。

当前 production 路径在 Pi Agent Loop 结束之后，还会：

```text
Pi Agent Loop settled
    ↓
确认事件已经进入 durable event plane
    ↓
获取当前 Workspace revision
    ↓
生成 file/hash index、Git patch
    ↓
保存 canonical conversation
    ↓
在 PG transaction 中：
  Run completed
  Attempt completed
  Turn completed
  Session idle
  lease release
```

现有 `RemoteToolSandboxTurnRunner` 和 `RunCommandExecutor` 正在承担这段收口。 

而新的 Harness 当前只知道：

```text
operation_finished
```

它不知道 AgentDock 的：

```text
Workspace revision 已捕获了吗？
canonical Turn 已提交了吗？
Kafka terminal sequence 已投影了吗？
Run/Attempt/Session 是否一起进入终态？
```

考虑这个故障：

```text
Harness:
operation_finished ✓

Worker crash

AgentDock terminal transaction ✕
```

恢复后：

```text
Pi Session：没有 open operation
Run：仍然 running/checkpointing
Workspace revision：可能还未捕获
canonical Turn：可能未提交
```

这时新 Worker到底应该：

```text
重新运行 prompt？
还是只执行 terminal finalization？
```

目前没有一个明确、持久化的状态回答这个问题。

### 应该增加一个外部 finalization 阶段

例如：

```text
Pi operation:
running
    ↓
awaiting_external_finalization
    ↓
AgentDock terminal transaction
    ↓
completed
```

或者提供一个确定性的：

```text
finalizeRun(runId, operationId)
```

reconciler，可以在 Worker 崩溃后反复调用且不会重复产生副作用。

在这个问题解决前直接切换，最容易出现：

> 模型已经回答完了，但 Run 永远卡在 running；或者重试时把同一个用户 prompt 又执行一遍。

---

## P0-4：新的 Harness API 完整，不代表现有 production 行为已经等价

当前 production adapter 不只是调用 Agent Loop。它还包含：

```text
model sampling identity
provider request budget
transient model retry
context overflow / auto compaction
steer
interruption/world-state marker
delta coalescing
Kafka event mapping
SSE terminal event
settlement verification
Cube activation/capability
Workspace capture
```

新的 Harness 虽然有通用的：

```text
events
hooks
retry options
compaction
steer
```

但还没有接成 AgentDock 当前正式协议。

尤其是 Kafka/Valkey/SSE：

```text
Pi AgentEvent
    ↓
AgentDock semantic event
    ↓
Kafka durable batch
    ↓
Valkey projection
    ↓
SSE
```

当前有专门的 `PiAgentEventAdapter` 和 settlement gate。新 Harness 的 raw event 还没有证明能够完全产生相同的 sequence、terminal event、usage 和 Tool lifecycle。 

这次 commit 自己也承认，production event mapping、Workspace/conversation terminal commit 和真实 Cube/model 验收仍未完成。

---

## P0-5：已有 Session 怎么从 JSONL authority 切到结构化 SessionStorage，还没有明确协议

现在存在两种 authority：

```text
旧 production Session
→ PostgreSQL 中的 Pi JSONL compatibility object

新 Harness Session
→ pi_entries / lanes / records / usage
```

至少在这次 commit 中，我没有看到一套明确的：

```text
JSONL → structured SessionStorage
一次性 import
+
runtime version pin
```

不能让同一个 Session 出现：

```text
Turn 1：旧 JSONL runtime
Turn 2：新 PG Harness
Turn 3：又回旧 JSONL runtime
```

否则会形成两套会话历史，哪一套是 authority 会变得含糊。

### 最安全的方案

给 Session 增加不可随意回退的 runtime 版本：

```text
sessions.runtime_version

pi_jsonl_v1
pi_pg_harness_v1
```

切换策略：

```text
已有 Session
→ 保持 pi_jsonl_v1

新建 Session
→ canary 使用 pi_pg_harness_v1
```

后续再写一次性 importer。切换完成后，同一 Session 不允许在两个 adapter 之间漂移。

---

# 我建议的切换路线

## 第一阶段：修三个硬问题

必须先完成：

1. **所有冷启动热路径都只读 current register + compact suffix**；
2. **compaction/navigation/run recovery 具备事务或严格幂等语义**；
3. **增加 durable external finalization 阶段**。

这三个不是“再多写点测试”可以代替的，是数据模型和状态机问题。

## 第二阶段：实现正式的 `PostgresHarnessTurnRunner`

不要让新 Harness直接绕开现有产品组件，而是做一个新的 runner：

```text
PostgresHarnessTurnRunner
├─ 复用现有 Model Gateway
├─ 复用 trusted remote tools
├─ 复用 Kafka event adapter
├─ 复用 settlement gate
├─ 复用 Workspace capture
└─ 接入 RunCommandExecutor terminal transaction
```

这样你只替换：

```text
旧 Pi session-file Agent Loop
```

而不是同时重写整个 AgentDock 产品结算协议。

## 第三阶段：故障注入

至少要在这些点强制 kill Worker：

```text
user entry 写入后
provider intent 后
assistant entry 写入后
tool_started 后
Tool 执行后、result 写入前
compaction entry 写入后
moveLane 后
Workspace capture 后
terminal transaction 前
```

每个点都验证：

```text
不会重复用户 prompt
不会盲目重跑 unsafe Tool
不会产生两个 assistant message
不会丢 Workspace 现场
最终 Run 一定能进入 terminal
```

## 第四阶段：真实 canary

顺序建议：

```text
新 Session + pure chat
    ↓
新 Session + read-only tools
    ↓
新 Session + full coding tools
    ↓
Worker kill / PG reconnect
    ↓
默认开启
```

最近那次 11 轮、约 120k token 压缩到约 23k token 的真实验收很有价值，但报告明确使用的仍是：

```text
Pi SDK 0.84.1 JSONL compatibility path
```

它证明了旧生产路径和 persistent Workspace，不证明新的 Harness 已经能生产切换。

---

## 最终评审意见

我会正式给出：

> **批准把新的 `DurableAgentHarness` 接入 staging 和 feature-flag canary；不批准现在删除旧 JSONL production adapter，也不批准默认切换。**

核心实现方向是对的，SessionStorage 和 authority 设计也已经过了“值不值得继续”的阶段。现在剩下的不是重新实现 Pi Agent Loop，而是把三个真正的分布式一致性边界补齐：

```text
bounded restore
operation crash idempotence
AgentDock terminal finalization
```

这三个完成，再通过一次新 Harness 专属的真实模型 + Cube + 跨 Worker 故障验收，我会支持正式切换。

## 215 · User · 2026-08-14T03:48:37.287Z

其实我在想fence, lease真的重要吗？能给我讲讲fence和lease是干嘛的

## 216 · Assistant · 2026-08-14T03:52:12.059Z

可以把它们拆成两个完全不同的问题：

> **Lease 解决“什么时候可以换人”。**  
> **Fence 解决“换人以后，旧的人还能不能继续动手”。**

在你的 Cloud Coding Agent 场景里，这两个概念非常关键，但它们解决的并不是“恢复到最新 Tool”本身。

---

## 1. Lease：临时所有权

Lease 就是一个带有效期的锁，例如：

```text
Session S
当前执行者：Agent Loop A
lease_expires_at：11:30:30
```

Agent Loop A 每隔几秒续租：

```text
11:30:10 renew
11:30:20 renew
11:30:30 renew
```

只要它正常续租，上层就认为：

```text
这个 Run 仍然由 A 负责
其他 Worker 不要接手
```

假设 A：

- 进程崩溃；
- 节点断电；
- 网络断开；
- 长时间 GC pause；
- 与控制面失联。

它无法续租，Lease 到期。控制面随后允许 Agent Loop B 接手。

所以 Lease 主要解决的是：

```text
旧 Worker 联系不上时，系统不能永远卡住
```

它提供的是 **liveness，也就是系统继续向前运行的能力**。

### 为什么不能只用普通锁

因为分布式系统里，你无法准确判断：

```text
A 是真的死了
还是只是暂时失联
```

如果一定要等 A 明确释放锁，A 真崩溃时锁可能永远不释放。

因此通常使用：

```text
有期限的所有权 + 定期续租
```

事实上，你现在的 PostgreSQL command claim、claim expiry、heartbeat，只要存在“超时后可以重新领取”，本质上就是 Lease，只是未必叫这个名字。

---

## 2. Fence：挡住旧执行者

问题在于：

> Lease 过期，并不代表旧 Worker 真的已经停止运行。

看这个时间线：

```text
T1：Agent Loop A 获得 Lease
T2：A 与控制面网络断开
T3：控制面看不到 A，Lease 到期
T4：Agent Loop B 接手
T5：A 网络恢复，继续运行
```

此时就可能同时存在两个 Agent Loop：

```text
Agent Loop A：认为自己还在执行
Agent Loop B：认为自己已经接管
```

两者都可能向同一个 Cube 发 Tool：

```text
A → write_file("a.ts", old content)
B → write_file("a.ts", new content)
```

仅有 Lease 无法阻止 A，因为 A 可能根本不知道自己的 Lease 已经过期。

这就是 Fence 要解决的问题。

---

## 3. Fencing token 怎么工作

每次获得新 Lease，同时分配一个单调递增的版本号：

```text
Agent Loop A
lease = L1
fencingToken = 41
```

A 的所有操作必须携带 `41`：

```json
{
  "sessionId": "S",
  "attemptId": "A",
  "fencingToken": 41,
  "toolCallId": "tool-7"
}
```

A 失联后，B 接手：

```text
Agent Loop B
lease = L2
fencingToken = 42
```

共享资源现在记录：

```text
当前有效 fencingToken = 42
```

之后 A 即使恢复，又发送旧请求：

```text
A → Tool Broker，token = 41
```

Tool Broker 检查后直接拒绝：

```text
41 < 42
拒绝：stale execution authority
```

B 的请求：

```text
B → Tool Broker，token = 42
```

可以执行。

所以 Fence 提供的是：

```text
旧执行者即使还活着，也失去修改共享状态的权力
```

它解决的是 **safety，也就是不能出现两个执行者同时产生有效副作用**。

---

## 4. 一个很好理解的类比

把 Lease 想象成酒店房卡的入住期限：

```text
A 的房卡有效到中午 12 点
```

但如果酒店只是告诉前台“房卡过期了”，旧房卡本身仍然可能开门，那就不安全。

Fence 相当于重新编码门锁：

```text
旧卡版本：41
新卡版本：42
门锁只接受 42
```

于是即使 A 还拿着旧卡，也进不了门。

---

## 5. 为什么 Lease 单独不够

假设代码是这样：

```ts
await lease.assertCurrent();
await executeTool();
```

看起来已经检查了 Lease，但仍然有竞态窗口：

```text
A 检查 Lease：有效
           ↓
A 在这里暂停 10 秒
           ↓
Lease 到期，B 接手
           ↓
A 恢复，继续 executeTool()
```

这就是典型的 TOCTOU：

```text
检查时有效
实际使用时已经失效
```

因此 Fence 必须在**真正产生副作用的资源边界**检查，而不能只在 Agent Loop 里检查一次。

例如：

```text
Agent Loop
    ↓ token=41
Tool Broker
    ↓ 检查当前 token
Cube Tool Service
    ↓ 执行命令
Workspace
```

至少 Tool Broker 或 Cube Tool Service 必须知道当前代际。

数据库写入也一样：

```sql
UPDATE session_state
SET ...
WHERE session_id = ?
  AND fencing_token = 42;
```

旧 Worker 携带 `41` 时，更新行数为零。

---

## 6. 对你的 AgentDock 来说，Fence 应该挡在哪里

你的结构是：

```text
Agent Loop Worker
        ↓
Trusted Remote Tool / Tool Broker
        ↓
Session-resident Cube
        ↓
Persistent Workspace
```

如果旧 Agent Loop A 和新 Agent Loop B 有可能访问同一个 Cube，那么 Fence 至少应该覆盖：

### SessionStorage 写入

旧 Worker 不能继续写：

```text
assistant message
tool_started
tool result
operation_finished
```

否则旧 Worker 可能污染 Pi Session 历史。

### Tool Broker 请求

每次 Tool 请求携带：

```text
attemptId
leaseId
fencingToken
toolCallId
```

Broker 只接受当前 attempt 的 token。

### Workspace capture 和最终提交

旧 attempt 不得把自己的 Workspace revision 提交成当前版本。

### Run terminal settlement

旧 attempt 不得把一个已经被新 attempt 接管的 Run 标记为 completed 或 failed。

---

## 7. 一个很重要的限制：Fence 不能撤销已经开始的副作用

假设 A 在 Fence 仍有效时已经启动：

```bash
python migration.py
```

然后：

```text
Lease 到期
B 接手
token 从 41 变成 42
```

Fence 可以阻止 A 再发新的 Tool，也可以阻止 A 提交旧结果，但它不能自动撤销已经启动的进程。

尤其是同一个 Cube、同一个可写 Workspace：

```text
A 的 bash 进程仍在后台修改文件
B 同时开始操作 Workspace
```

这时仅仅在 Tool 请求开始前检查 Fence 仍然不够。

你需要三种方案中的一种：

### 方案 A：接管前强制停止旧 activation

```text
Lease 到期
    ↓
停止旧 Cube 内所有进程
    ↓
确认旧 activation 已终止
    ↓
B 才能接手
```

### 方案 B：Cube 感知 generation 变化并杀掉旧命令

每个运行中的 Tool 都绑定 token：

```text
command token = 41
current token = 42
→ kill command
```

### 方案 C：不同 attempt 使用隔离 Workspace

```text
A → workspace copy A
B → workspace copy B
```

最终通过 fenced CAS，只允许一个 attempt 提交为正式 Workspace head。

对于你现在的 **session-resident Cube + 共享可写 Workspace**，通常需要 A 或 B，而不仅是简单地在 Agent Loop 里调用 `assertCurrent()`。

---

## 8. Lease 和 Fence 不负责识别“最新 Tool”

这三个问题需要分开：

| 机制 | 解决的问题 |
|---|---|
| Lease | 当前应该由哪个 Worker 负责 |
| Fence | 旧 Worker 的操作还能不能生效 |
| Tool ledger / 幂等键 | 同一个 Tool 是否已经执行过、是否应该重跑 |

例如：

```text
toolCallId = tool-7
fencingToken = 42
```

Fence 只能说明：

```text
发出 tool-7 的 Worker 是当前合法 Worker
```

它不能说明：

```text
tool-7 之前是否已经执行成功
```

要避免重复 Tool，还需要持久化：

```text
toolCallId
effectiveArgs
status
result
effect certainty
workspace revision before/after
```

恢复时查询：

```text
tool-7 已完成
→ 返回已有结果

tool-7 明确未执行
→ 可以执行

tool-7 已开始但结果未知
→ 不自动重跑 unsafe Tool，让 Agent 检查现场
```

所以你真正需要的是三件套：

```text
Lease
  负责接管

Fence
  负责排除旧执行者

Tool operation ledger
  负责副作用恢复和去重
```

---

## 9. 在什么情况下可以不要它们

### 可以不需要 Lease/Fence

系统永远只有：

```text
一个 Agent Loop 进程
不做自动故障接管
进程崩溃后人工处理
```

或者每个 attempt 完全隔离：

```text
独立 Sandbox
独立 Workspace
旧 attempt 无法访问新 attempt 的状态
最后只有一个 CAS 提交点
```

这种情况下 Fence 可以集中在最终提交点，不必覆盖每个 Tool。

### 你的架构里很难省掉

一旦满足下面几个条件：

```text
多个 Agent Loop 节点
Worker 失联后自动接管
新旧 Worker 可能短暂共存
两者能够操作同一个 Cube / Workspace
```

那么：

> **Lease 基本不可避免，Fence 是真正防止 split-brain 副作用的安全边界。**

不过不需要让 Fence 渗透到每一层业务代码。比较合理的设计是：

```text
PostgreSQL 原子分配 Lease + token
        ↓
SessionStorage 写入验证 token
        ↓
Tool Broker 验证 token
        ↓
Workspace/terminal commit 验证 token
```

Agent Loop 内部的 abort signal 和 `assertCurrent()` 用于尽快停止旧执行，但它们只是辅助；真正保证正确性的，是共享资源边界对旧 token 的拒绝。

## 217 · User · 2026-08-14T05:55:28.715Z

看这个时间线：

```
T1：Agent Loop A 获得 Lease
```

T2：A 与控制面网络断开

T3：控制面看不到 A，Lease 到期

T4：Agent Loop B 接手

T5：A 网络恢复，继续运行

此时就可能同时存在两个 Agent Loop：

```
Agent Loop A：认为自己还在执行
```

Agent Loop B：认为自己已经接管

这个地方可以设计成一旦lease过期，agent loop A就不能继续运行吗？而且要早于pgsql可以派任务给agent loop b

## 218 · Assistant · 2026-08-14T05:58:59.868Z

可以设计成：

> **先撤销 A 的执行权并确认它不能再产生副作用，然后 PostgreSQL 才允许 B 领取任务。**

但有一个关键区别：

> **“A 的进程一定已经停止”很难保证；“A 的任何后续操作都不会生效”可以严格保证。**

## 为什么 Lease 过期本身不能让 A 立刻停止

假设 A 与 PostgreSQL 断网了：

```text
A ──×── PostgreSQL
```

PostgreSQL 知道：

```text
A 没续租
→ lease 过期
```

但 A 未必知道。

甚至 A 可能正处于：

```text
长时间 GC
操作系统暂停
网络分区
进程冻结
```

等它恢复时，原来的 JavaScript 调用栈还在：

```ts
await modelCall();
await executeTool();
```

它可能继续往下跑。

所以 PostgreSQL 不能只靠修改一行：

```text
lease_expired = true
```

就从物理上杀死另一台机器上的进程。

---

## 可以先做一层“主动自杀”

例如 PostgreSQL 发给 A 的 lease 到期时间是：

```text
12:00:30
```

但规定 A 必须在：

```text
12:00:20
```

之前续租成功。

如果没有成功，A 本地立刻：

```text
abort model call
停止 Agent Loop
停止发送新 Tool
请求停止 Cube activation
```

而 PostgreSQL 直到：

```text
12:00:35
```

才允许 B 接管。

时间线变成：

```text
12:00:20  A 本地停止期限
12:00:30  authority 正式失效
12:00:35  B 最早接管
```

这样正常情况下，A 会比 B 接管早很多就停止。

但这仍然只是优化，不是严格保证。因为 A 可能在 `12:00:15` 被操作系统冻结，到 `12:00:40` 才恢复；它的本地 timer 根本没有机会准时运行。

---

# 真正安全的方案：两阶段接管

不要直接：

```text
RUNNING(A)
   ↓ lease expired
RUNNING(B)
```

而是增加一个中间状态：

```text
RUNNING(A)
   ↓ lease expired
REVOKING(A)
   ↓ 确认旧 execution domain 已停止
CLAIMABLE
   ↓
RUNNING(B)
```

完整流程如下。

## 第一步：PostgreSQL 先撤销 A

例如：

```text
原来：

owner = A
epoch = 42
state = running
```

Lease 到期后，事务更新成：

```text
owner = null
epoch = 43
state = revoking
```

从这个事务提交开始：

```text
A 的 epoch=42
→ SessionStorage 写入被拒绝
→ 新 Tool 请求被拒绝
→ terminal commit 被拒绝
```

此时 A 的进程可能还活着，但它已经失去合法执行权。

## 第二步：停止旧 Cube activation

系统向 Cube/Tool Broker 发出：

```text
revoke activation(epoch=42)
```

Cube 负责：

```text
停止旧 bash 进程
停止后台子进程
终止旧 activation
确认 Workspace 不再有旧 writer
```

只有 Cube 返回类似：

```text
activation 42 quiesced
```

PostgreSQL 才更新：

```text
state = claimable
quiesced_at = ...
```

## 第三步：B 才能领取

Worker 的 claim 查询必须只选择：

```sql
WHERE state = 'claimable'
```

于是 B 不可能在旧 activation 停止前接手同一个 Workspace。

时间线就变成：

```text
A lease 过期
    ↓
PG 立即 fence A
    ↓
Tool Broker / Cube kill A 的旧 activation
    ↓
确认旧进程已经停止
    ↓
PG 标记 claimable
    ↓
B 接手
```

这确实满足你说的：

> **旧执行环境的撤销发生在 PostgreSQL 将任务派给 B 之前。**

---

## 但要注意“Agent Loop 停止”和“Tool 停止”是两回事

Agent Loop A 可能只是继续在内存里计算：

```text
继续等 LLM response
继续跑 JavaScript
```

只要它不能：

```text
写 Pi Session
执行新 Tool
提交 Run
修改 Workspace
```

从正确性上讲，它已经是无害的。

真正危险的是已经启动的 Tool：

```text
A 已经启动 bash
↓
bash 仍在后台修改 Workspace
```

所以 B 接管前，真正需要确认的不是：

> A 的 Node.js 进程一定退出了。

而是：

> **A 所绑定的 Cube activation 已经 quiesced，不可能再写 Workspace。**

这是更准确、也更容易实现的安全条件。

---

## 如果旧 Cube 所在节点失联怎么办

这是最棘手的情况：

```text
控制面联系不上旧 Cube
但无法证明旧 Cube 已经停止
```

这时不能安全地直接让 B 写同一个 Workspace。

系统只能选择：

```text
等待 Cube/节点恢复并确认停止
```

或者依赖更底层的强制隔离：

```text
存储层 revoke / detach
虚拟机强制销毁
节点级 fencing
旧 RW volume 权限撤销
```

如果这些都做不到，就应该把 Run 卡在：

```text
recovery_blocked
```

而不是冒险让 B 同时写同一块 Workspace。

---

## 对 AgentDock 最合理的 invariant

我不建议把正确性定义为：

> A 的 Agent Loop 进程必须在 B 接手前物理死亡。

更合理的是：

> **B 获得执行权之前，A 必须已经被逻辑 fence；B 获得 Workspace 写权限之前，A 的旧 Cube activation 必须已经 quiesced。**

也就是：

```text
PG revoke authority
        ↓
旧 Session 写入失效
旧 Tool 请求失效
        ↓
Cube stop old activation
        ↓
确认 Workspace 无旧 writer
        ↓
PG 允许 B claim
```

本地 lease watchdog 可以让 A 尽早主动停止，减少浪费的模型 token 和计算资源；真正的正确性则由 **PG fencing + Cube activation revocation + 接管前 quiescence barrier** 保证。

## 219 · User · 2026-08-14T06:17:06.186Z

所以你的意思是如果agent loop A失联了，等到lease到期把cube也一起干掉？

## 220 · Assistant · 2026-08-14T06:18:58.934Z

**基本是，但更准确地说：不是一定把整个 Cube 干掉，而是把 A 在 Cube 里的“执行上下文”干掉。**

例如：

```text
Agent Loop A 失联
    ↓
lease 到期
    ↓
PG 撤销 A 的 authority
    ↓
Tool Broker / Cube 停止 A 的 activation
    ├─ 停掉正在运行的 bash
    ├─ 杀掉其子进程
    ├─ 拒绝 A 后续 Tool 请求
    └─ 保留 /workspace 数据
    ↓
确认没有 A 的旧进程继续写 Workspace
    ↓
Agent Loop B 接手
```

这里最好区分三个东西：

```text
Cube VM / Sandbox 本体
A 的 activation / Tool 进程
Persistent Workspace Volume
```

通常我们只想干掉第二个：

```text
A 的 activation ✕
Workspace 保留 ✓
Cube 本体可以复用 ✓
```

而不是：

```text
Cube 整台销毁
Workspace 也清空
```

## 为什么要停掉 A 的 activation

假设 A 已经执行了：

```bash
npm test && python long_running_script.py
```

随后 A 与 PG 失联。即使 PG 已经把 fence 从 `42` 升到 `43`，这个已经启动的 Python 进程仍可能继续修改文件。

所以不能只做：

```text
拒绝 A 后续的新 Tool 请求
```

还必须处理：

```text
A 已经启动、目前仍在运行的 Tool
```

因此接管流程应该是：

```text
fence A
→ stop A 的活跃命令
→ 确认旧命令停止
→ B 接手
```

## 什么时候真的需要销毁整个 Cube

如果 Cube 没有提供可靠的 activation 隔离和进程清理能力，例如无法保证：

- 杀掉该 activation 的全部子进程；
- 清除后台进程；
- 撤销旧连接；
- 确认没有旧 writer。

那最简单、最保险的实现就是：

```text
lease 到期
→ 销毁旧 Cube
→ 保留 Persistent Volume
→ 创建新 Cube
→ 挂载相同 Workspace
→ B 接手
```

也就是：

```text
旧 Cube ✕
Persistent Workspace ✓
新 Cube ✓
```

这个方案启动成本高一点，但故障语义最容易证明正确。

所以我的准确结论是：

> **A 的 lease 到期后，必须终止 A 对 Workspace 的执行能力。能精确停 activation，就不必销毁整个 Cube；不能精确证明停干净，就销毁旧 Cube，但保留 Workspace Volume。**

## 221 · User · 2026-08-14T12:16:03.250Z

那如果A失联的同时cube也失联呢？ 我们现在有3种情况吧，A失联cube不失联，A不失联cube失联，A失联cube失联，这三种情况分别怎么处理呢

## 222 · Assistant · 2026-08-14T12:20:59.717Z

对，基本就是这三种。先把两个“所有权”分开看，会容易很多：

```text
A 对 Agent Run 的所有权
→ PostgreSQL lease + fence

Cube 对 Workspace 的写入能力
→ activation revoke / Cube 终止 / 存储层 fencing
```

这两层故障不能完全混成一个 lease。

## 1. A 失联，Cube 没失联

这是**最好处理**的一种。

```text
A 失联
   ↓
A 无法续 PG lease
   ↓
lease 到期
   ↓
PG 提升 execution epoch，fence A
   ↓
通知 Cube 停止 A 的 activation
   ↓
Cube 杀掉 A 启动的 bash 和子进程
   ↓
Cube 返回 quiesced
   ↓
Run 重新变为 claimable
   ↓
B 接手
```

Cube 还在线，所以控制面能明确命令它：

```text
停止 activation-A
保留 /workspace
```

B 可以：

- 复用同一个 Cube，创建新的 activation；
- 或销毁旧 Cube，再挂载同一块 Workspace Volume 创建新 Cube。

这是最容易做到自动恢复的情况。

---

## 2. A 没失联，Cube 失联

这时**不需要因为 Cube 失联立刻把任务交给 B**，因为 A 本身仍然是合法 owner。

A 应该立即暂停 Agent Loop：

```text
A 正常
Cube 失联
   ↓
A 停在当前 Tool 边界
   ↓
不继续调用下一次 LLM
不伪造 Tool result
不提交 Turn completed
```

然后分两种情况。

### Cube 失联时没有 Tool 正在执行

比较简单：

```text
A 保持 Run lease
   ↓
重新创建 Cube
   ↓
挂载相同 Workspace Volume
   ↓
建立新 activation
   ↓
A 继续运行
```

不需要换 Worker。

### Cube 失联时 Tool 正在执行

例如：

```text
bash("npm test && python modify_files.py")
```

Cube 突然失联，那么 Tool 的结果是：

```text
可能没执行
可能执行了一半
可能已经执行完
```

此时应该持久化为：

```text
tool_started
effect = uncertain
```

不能自动重跑不安全 Tool。

恢复后：

```text
新 Cube 挂载现有 Workspace
   ↓
给 Agent 一个 interrupted / uncertain Tool result
   ↓
Agent 自己检查 git diff、文件和进程状态
   ↓
决定下一步
```

但这里有一个前提：

> 必须确认旧 Cube 已经不能继续写 Workspace。

如果能通过 Cube 控制面、Kubernetes、CSI 或节点 fencing 证明旧 Cube 已终止，就可以自动创建新 Cube。

如果无法证明：

```text
旧 Cube 只是网络分区
但里面的进程可能仍在运行
```

那就不能直接让新 Cube 同时挂载并写同一块 Volume。Run 应该进入：

```text
sandbox_recovery_blocked
```

等基础设施确认旧执行环境被终止后再恢复。

如果恢复耗时较长，A 没必要一直占一个 Worker slot。可以：

```text
A 持久化 suspended 状态
→ 释放 Run authority
→ 释放 Worker slot
→ 环境恢复后由 A 或 B 重新领取
```

所以这一种的结论是：

> **Cube 失联不必立即换 Worker；先暂停 Run，恢复或重建 Sandbox。**

---

## 3. A 和 Cube 同时失联

这是最麻烦的一种。

```text
A 失联
Cube 也失联
   ↓
PG lease 到期
   ↓
PG fence A
```

到这里，Session 侧已经安全：

```text
A 恢复后写 PG
→ 被旧 epoch 拒绝
```

但 Workspace 侧仍然不一定安全。

因为控制面联系不到 Cube，无法确认：

```text
Cube 已经死了
还是只是网络分区
里面的 bash 是否仍在修改 Workspace
```

所以不能立刻：

```text
B 接手
→ 新 Cube 挂同一个 Workspace
```

正确流程是：

```text
A lease 到期
   ↓
PG fence A
   ↓
尝试 fence 旧 Cube / 旧节点 / 旧 Volume writer
   ↓
确认旧 Cube 不再能写 Workspace
   ↓
重新挂载 Persistent Volume
   ↓
创建新 Cube
   ↓
B claim Run
   ↓
从 PG SessionStorage 恢复
   ↓
处理 unfinished Tool
```

如何确认旧 Cube 已经不能写，取决于基础设施能力：

```text
CubeSandbox API 确认 VM terminated
Kubernetes 确认 Pod/VM 删除
CSI 确认旧 Volume attachment 已撤销
云平台执行 node fencing / power-off
存储系统撤销旧 writer lease
```

如果这些都无法确认，就只能：

```text
recovery_blocked
```

而不能冒险启动 B。

---

## 三种情况放一起

| 故障情况 | Agent Loop | Cube/Workspace | 是否立即换 B |
|---|---|---|---|
| A 失联，Cube 正常 | PG fence A | 停止旧 activation | Cube quiesced 后换 B |
| A 正常，Cube 失联 | A 暂停 | 重建 Cube；处理中断 Tool | 通常不需要，A 可继续 |
| A、Cube 都失联 | PG fence A | 必须做基础设施级 fencing | 确认旧 Cube 无写能力后才能换 B |

最重要的原则是：

> **B 可以在 A 被 PG fence 后接管 Session，但 B 只有在旧 Cube 被确认 quiesced 后，才能接管同一个 Workspace。**

所以实际上有两个接管屏障：

```text
屏障 1：PG authority barrier
→ 防止旧 A 写 Session 和提交 Run

屏障 2：Workspace quiescence barrier
→ 防止旧 Cube 与新 Cube 同时写文件
```

第一种情况两个屏障都容易满足；第二种通常不需要更换 Agent Worker；第三种最依赖 Kubernetes、CubeSandbox 和存储层是否提供可靠的旧 writer fencing。

## 223 · User · 2026-08-14T12:27:19.408Z

这种链式调用不可用的场景应该有人研究过吧，调研一下有没有解决方案

## 224 · Assistant · 2026-08-14T12:28:22.043Z

有，而且你现在碰到的这个问题其实已经被研究了很多年，只是它通常不叫“链式调用不可用”，而是分散在几个经典主题里：

> **gray failure / partial failure + lease/leader failover + fencing + shared-storage failover。**

你这个：

```text
Agent Loop A
    ↓
Cube
    ↓
Workspace Storage
```

恰好是一个典型的**分层执行链**：上面某层可能失联，但下面那层不一定真的死了。微软把这种“有些组件认为它坏了、有些组件仍然能和它交互”的情况称为 **Gray Failure / differential observability**，这也是云环境里最难处理的故障之一。

### 成熟系统一般不是靠一个 Lease 解决，而是“分层 fencing”

我查下来，最接近我们 AgentDock 场景的成熟方案其实是这套：

```text
            control-plane lease
                    │
                    ▼
            current epoch = 43
                    │
          ┌─────────┴──────────┐
          │                    │
          ▼                    ▼
      Agent Worker       Sandbox activation
          │                    │
          │                    ▼
          │              Workspace storage
          │
          └──── fencing ───────┘
```

第一层是 **Lease / failure detector**，回答：

```text
“旧 owner 已经多久没响应了，
现在是否允许开始接管？”
```

Chubby、etcd 这些系统都是这个思路。etcd 的 lock 基于 Lease，官方的 Jepsen 说明甚至专门强调：**Lease 过期本身还不够，如果旧 holder 暂停或断网后恢复，它可能和新 holder 同时访问资源，因此需要用 revision 做 fencing token。**

Google Chubby 很早就提供了一种叫 **sequencer** 的机制，本质上就是 fencing token：持锁者把 sequencer 带到真正的服务端，服务端检查它是不是当前最新的；这样延迟很久才到达的旧请求就会被拒绝。Chubby 甚至还设计了 `lock-delay`：旧 owner 因失联而丢锁后，不立刻允许新 owner 抢，而是等待一段时间，降低旧请求仍在路上的风险。

这和我们前面自己推出来的东西几乎一模一样：

```text
A lease expires
↓
epoch 42 → 43
↓
旧请求 42 全部无效
```

---

### 但 Sandbox 失联时，就要进入第二层：STONITH / resource fencing

这也是你刚才问的：

```text
A 失联
Cube 也失联

Cube 到底死没死？
```

成熟 HA 系统的回答非常干脆：

> **如果无法证明旧执行者已经停止，就不能启动新的 writer；先把旧执行者 fence 掉。**

Pacemaker 把它叫做 **STONITH / fencing**。它官方给 fencing 的定义就是：即使一个节点已经无法响应集群命令，也要有办法确保它**不能再运行资源**。常见手段不是发一个“请你退出”的 RPC，而是直接断电、切网络，或者切断它对共享磁盘的访问。Pacemaker 明确说，没有 fencing，某些 unresponsive-node 故障不能安全恢复，因为可能形成 split brain。

所以成熟系统其实有个“升级链”：

```text
soft revoke
   ↓
让进程自己停

不成功
   ↓
kill activation / VM

还无法确认
   ↓
node fencing / power off

还涉及共享存储
   ↓
storage fencing
```

这正是我们 AgentDock 应该借鉴的，而不是自己发明一个全新的理论。

---

### 更妙的是：存储层本身已经有现成的 fencing 技术

Ceph RBD 的实现和你的问题几乎一模一样。

旧 Client A 获得 exclusive lock，然后失联：

```text
Client A
    ↓
Ceph RBD
```

新 Client B 想接管。

Ceph 文档明确指出：**不能仅仅把旧锁 break 掉**。因为 A 可能只是网络暂时断开，等恢复以后 A/B 就会同时写，造成灾难。

所以 Ceph 的流程是：

```text
B 要接管
   ↓
先 blocklist A
   ↓
OSD 全部确认：
以后拒绝 A 的 I/O
   ↓
再 break A 的 lock
   ↓
B 获得 lock
   ↓
B 才开始写
```

Ceph 官方直接称这为 **storage-level resource fencing**。

这个顺序非常重要：

```text
不是：

B 获得锁
→ 再想办法干掉 A


而是：

确保 A 不可能再写
→ B 才获得写权限
```

这就是我们前面一直说的 `quiescence barrier`。

AWS EBS 也有同样机制。Multi-Attach `io2` 支持 NVMe Reservations，AWS 官方就称其为**行业标准的 storage fencing protocol**，可以让一个 instance 抢占 reservation 并阻止其他实例继续写共享 Volume。

---

### Kubernetes 其实也正在解决你问的第三种场景

还记得我们的：

```text
A 失联
Cube 失联
Volume 还在
```

Kubernetes 的 StatefulSet + PersistentVolume 遇到 Node 突然失联，问题完全一样：

```text
旧 Node 联系不上
↓
VolumeAttachment 还在旧 Node
↓
新 Node 不敢 attach
↓
Pod 卡住
```

Kubernetes 官方的 **Non-Graceful Node Shutdown** 文档明确说明，它默认不会轻易把这个 Volume 给新节点，因为旧节点可能仍然拥有 Volume。只有确认旧 Node 已经 shutdown / power-off 后，才能打 `node.kubernetes.io/out-of-service`，强制删除 Pod、detach Volume，然后让新节点接管。

甚至 Kubernetes 文档还专门警告：如果在无法确认旧节点状态时强行 detach，旧 workload 仍可能访问 Volume，可能造成数据损坏。

这和我们刚才推出来的逻辑是完全一致的：

```text
不能证明旧 Cube 已死
        ↓
不能让新 Cube 获得相同 Workspace RW
```

所以你刚才觉得：

> “这个问题应该有人解决过吧？”

答案是：**不仅有人解决，而且 Kubernetes / Ceph / Pacemaker 都在解决同一个基本问题。**

---

## 那么 AgentDock 可以直接采用什么模式？

我现在认为可以把我们的设计正式叫成：

> **hierarchical fencing / layered fencing**

而不是给 A、Cube、Workspace 每个地方自己设计一套复杂 Lease。

整个恢复状态机可以非常清晰：

```text
RUNNING
  Agent A
  Cube X
  Workspace W
     │
     │ Agent lease lost
     ▼
REVOKING
     │
     ├─ PG epoch++
     │   → A 不能再写 Session
     │
     ├─ revoke Cube activation X
     │
     └─ ensure Workspace writer X fenced
             │
             ▼
          QUIESCED
             │
             ▼
         CLAIMABLE
             │
             ▼
          Agent B
          Cube Y
          same W
```

根据故障情况，`REVOKING → QUIESCED` 用不同的方法：

- **A 失联，Cube 正常**：Cube API kill activation。
- **A 正常，Cube 失联**：A suspend；K8s/Cube 恢复或重建 Cube，确认旧 execution domain 不再写。
- **A、Cube 都失联**：升级到 Node/VM/Storage fencing；确认旧 writer 被隔离后才 failover。

其中真正应该成为系统 invariant 的不是：

> “必须知道 A / Cube 到底死没死。”

而是：

> **“新 writer 开始前，必须有可验证的证据证明旧 writer 已经不能产生有效副作用。”**

这也是 Pacemaker、Ceph、Kubernetes 这些系统共同采用的思路。

---

还有一个和 Agent 特别相关的第四层：**in-flight effect 不确定性**。

即使旧 Cube 已经成功 fence：

```text
tool_started
↓
Cube 失联
↓
fence Cube
```

你仍然不知道：

```text
这个 Tool 执行了 0%
50%
还是 100%
```

这不是 fencing 能解决的，而是 **idempotency / operation ledger** 的问题。微软关于 idempotence 的研究就是专门处理“请求可能已经执行，但响应丢失，重试会产生 duplicate effect”这一类故障。

所以最终成熟方案其实是四层：

```text
Failure detector / Lease
    ↓
判断何时开始 failover

Fencing token
    ↓
阻止旧 Agent Worker 的新操作

Execution / Storage fencing
    ↓
保证旧 Cube 真的不能再写 Workspace

Operation ledger + idempotency
    ↓
处理已经启动但结果未知的 Tool
```

这套东西和我们前面一路推出来的 AgentDock 架构非常吻合。

而且这次调研让我对一个方向更确定了：**不要试图让 AgentDock 自己负责判断 Cube/Node/Volume 是否真正死亡。**AgentDock 最多负责：

```text
PG execution authority
→ Run = REVOKING
```

然后把“旧 Sandbox/Volume writer 是否已经被安全 fence”交给 **CubeSandbox + Kubernetes + CSI/底层存储**。只有它们返回 `quiesced/fenced`，AgentDock 才把 Run 重新设为 `claimable`。

这样你的应用层不会重新造一套 HA 集群系统。

## 225 · User · 2026-08-14T12:48:44.831Z

我讲下我的理解，lease是agent loop和pgsql的契约，fence是agent loop和cube的契约，是这样吗？这样听起来貌似lease和fence不会贯穿系统？

## 226 · Assistant · 2026-08-14T12:48:48.642Z

你的理解**已经非常接近了**，但我会修正一个小地方：

> **Lease 是 Agent Worker 和 PostgreSQL 之间关于“谁现在拥有执行权”的契约。**  
> **Fence 是这份执行权在“真正产生副作用的边界”上的证明。**

所以 Fence 不只是 `Agent Loop ↔ Cube`。

更准确是：

```text
                  PostgreSQL
             ownership / lease
                    │
                    │ 产生 authority / epoch
                    ▼
               Pi Worker
                    │
             ExecutionAuthority
             ┌──────┴──────┐
             ▼             ▼
      SessionStorage      Cube
           PG             Tool
             \             /
              \           /
              fence check
```

### Lease 管“谁来干”

例如：

```text
Run 123

owner = Worker A
expires_at = 12:00:30
epoch = 42
```

A 不续租：

```text
lease expired
→ 允许进入 takeover 流程
```

所以 Lease 基本只需要存在于：

```text
Worker
  ↕
PostgreSQL
```

Agent Loop 本身甚至可以不知道什么叫 `leaseId`。

---

### Fence 管“你的操作还能不能生效”

A 原来拿的是：

```text
epoch = 42
```

B 接手之后：

```text
epoch = 43
```

那么 A 即使复活：

```text
A → 写 SessionStorage
epoch 42 → reject

A → bash/write/edit
epoch 42 → reject

A → terminal commit
epoch 42 → reject
```

所以 Fence 真正对应的是：

```text
ExecutionAuthority
        ↓
所有 shared mutable effect boundary
```

主要就是两类：

```text
1. PostgreSQL durable state
   Session / Run terminal state

2. Cube / Workspace
   bash / write / edit
```

---

这也正好回答你后半句：

> 这样听起来貌似 lease 和 fence 不会贯穿系统？

**对，这才是我们真正想达到的设计。**

不应该是：

```text
Control Plane
 ↓ leaseId fence
RunCommandExecutor
 ↓ leaseId fence
Worker
 ↓ leaseId fence
Agent
 ↓ leaseId fence
Tool
 ↓ leaseId fence
Broker
 ↓ leaseId fence
Cube
```

而应该是：

```text
PostgreSQL
    │
    │ lease / epoch
    ▼
AuthorityProvider
    │
    ▼
ExecutionAuthority
    │
    ├──────── SessionStorage
    │
    └──────── ExecutionEnvironment
```

上层只看到：

```ts
authority.assertCurrent()
authority.signal
```

甚至理想状态下 Agent Loop 连这两个都不直接调用，而是 Harness 管。

Tool 也只是：

```ts
bash(...)
write(...)
edit(...)
```

底层 `ExecutionEnvironment` 自动绑定 authority。

---

所以有一个很漂亮的职责划分：

```text
Lease
= ownership protocol
= Worker ↔ PostgreSQL

Fence
= effect authorization protocol
= ExecutionAuthority ↔ effect boundary
```

而不是：

```text
Lease + Fence
= 每个函数都带的两个参数
```

这也是我现在越来越觉得 `ExecutionAuthority` 这个抽象有价值的地方。

不过有一点要特别注意：**不能把 Fence 只做到 Cube。**

否则会发生：

```text
A 被 B 接管
A 不能再操作 Cube ✓
但 A 还能往 PG SessionStorage 写 assistant/tool result ✕
```

所以 PG SessionStorage 本身也必须做 fence check。

因此最终不是“Fence 是 Agent Loop 和 Cube 的契约”，而更准确地说：

> **Fence 是当前执行者和所有可持久化副作用之间的契约。**

这样一来，lease/fence 的**语义**贯穿正确性边界，但它们的**字段和实现**不会贯穿整个软件架构。这个区别很关键。

## 227 · User · 2026-08-14T12:50:46.080Z

我懂了，确实，session storage也需要fence，不然旧agent loop会污染会话数据

## 228 · Assistant · 2026-08-14T12:50:50.220Z

对，就是这个点。

如果没有 SessionStorage fencing，最典型的坏情况就是：

```text
A 失联
↓
lease 到期
↓
B 接手并继续生成新消息
↓
A 又恢复
↓
A 把旧 assistant / tool result 写回 PG
```

最后会话可能变成：

```text
user
assistant(B)
tool(B)
assistant(B)

assistant(A)   ← 过期写入
tool(A)       ← 污染历史
```

那后续 context 构建就已经不可信了。

所以真正需要 fence 的至少有三个地方：

1. `SessionStorage` 写入；
2. Cube / Workspace Tool 副作用；
3. Run/Turn terminal commit。

这三个地方本质上都是“共享可变状态”的边界。

所以我们现在可以把整个设计压缩成一句话：

> **Lease 决定谁拥有执行权，Fence 保证只有当前拥有者的副作用能落地。**

这样理解就很清楚了。

## 229 · User · 2026-08-14T12:52:13.532Z

那讨论到这，似乎我们不需要完整的实现0.84.1 pi的agent harness，只需要将session storage backend接入agent loop，然后lease，fencing还是我们自己做？

## 230 · Assistant · 2026-08-14T12:52:17.181Z

对，我现在也更倾向这个结论。

**如果你的目标是把 AgentDock 生产链路从 JSONL 切到 PostgreSQL SessionStorage，那么没必要先完整复刻 Pi 0.84.1 的整个 `AgentHarness`。**

真正必须做的其实只有这一条：

```text
PostgreSQL SessionStorage
        ↓
恢复 active context
        ↓
Pi runAgentLoop()
        ↓
完整 assistant / toolResult
        ↓
PostgreSQL SessionStorage
```

然后 lease / fencing 仍然由 AgentDock 自己负责。

但这里有两个小修正。

第一，lease/fencing 虽然是“我们自己做”，最好仍然封装成一个很薄的 `ExecutionAuthority`，而不是让 `leaseId/fencingToken` 到处传：

```text
RunCommandExecutor
        ↓
acquire lease / epoch
        ↓
ExecutionAuthority
        │
   ┌────┴────┐
   ▼         ▼
PG Session   Tool Env
fenced write fenced effect
```

也就是说：

```text
Lease：
AgentDock PG Run runtime 自己管

Fence：
AgentDock SessionStorage adapter + Tool execution adapter 自己 enforce
```

Pi 本身完全不需要理解：

```text
leaseId
fencingToken
attemptId
```

第二，虽然不用实现完整 `AgentHarness`，**生产上现有那些真正用到的行为还是得保留**，例如：

```text
auto compaction
model retry
active steer
stream/event mapping
tool execution
```

但这些完全可以按需复用 Pi primitive 或现有 coding-agent 代码，而不是为了兼容一个抽象接口，把：

```text
multiple lanes
navigation
manual drive
deferred provider
templates
skills registry
完整 hooks surface
queue API
...
```

全都重新实现一遍。

---

所以我现在会把目标从之前的：

```text
实现一个完整 DurableAgentHarness
→ 替代 Pi coding-agent AgentSession
```

改成：

```text
实现一个非常薄的 Cloud Agent Runtime
```

可能就长这样：

```text
AgentDockRunRuntime
│
├─ Postgres SessionStorage
│    └─ fenced writes
│
├─ Pi runAgentLoop()
│
├─ Pi compaction primitive
│
├─ existing retry / steer behavior
│
├─ RemoteToolEnvironment
│    └─ fenced Tool effects
│
└─ existing Kafka/SSE settlement
```

甚至它未必应该叫 Harness。

---

这也解释了为什么我现在觉得 Codex 那个 `117KB DurableAgentHarness` **有点走远了**。

它解决的是：

> “我要在 AgentDock 里重新提供 Pi 0.84.1 完整的 Harness API。”

但我们真正的问题其实只是：

> “Pi 的 conversation authority 不要再是 JSONL，而是 PG；然后 Cloud 环境下的 execution ownership 由 AgentDock 保证。”

这两个需求并不要求完整重写 Harness。

所以我现在更建议的生产切换路径是：

```text
旧：
coding-agent AgentSession
    ↓
JSONL
```

变成：

```text
新：
AgentDock thin runtime
    ↓
Pi runAgentLoop
    ↓
PG SessionStorage
```

而不是：

```text
AgentDock
    ↓
自己重新实现完整 Pi AgentHarness
    ↓
PG SessionStorage
```

我甚至觉得我们下一步应该让 Codex **停止继续扩展 `DurableAgentHarness`，重新收缩成最小 production bridge**。这样架构会明显简单很多。

## 231 · User · 2026-08-14T12:53:25.972Z

嗯，同意，这就让codex开始施工
