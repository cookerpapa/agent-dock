# Agent 云运行时开源方案调研

调研日期：2026-07-18

## 1. 结论

Agent 云化不是给 CLI 增加 Web 页面，也不是为每个会话永久保留一个
Agent 进程。更准确的目标是：大量逻辑会话以持久状态存在，只在执行时
获得有界的 runtime 或隔离环境，并能在断线、故障、迁移和扩缩容后按
明确的语义恢复。

目前没有一个成熟的开源项目同时完整提供以下能力：

1. Pi 式会话和 Agent Loop 恢复；
2. 同一会话串行、跨会话有界并发和水平扩展；
3. Coding Agent 的 workspace、shell 和工具隔离；
4. 任意 extension 的进程内存、子进程和连接恢复；
5. 多租户认证、配额、审计和安全升级。

因此 PiCloud 不应复制某一个项目，而应组合三类设计：

- OpenClaw、Microsoft Agent Framework 和 Flink Agents 的逻辑会话与调度；
- OpenHands 和 agentserver 的 Coding Agent 产品/控制面分层；
- E2B、Agent Substrate 和 Kubernetes Agent Sandbox 的隔离与休眠能力。

## 2. 评估维度

本次调研把“云化”拆成以下独立维度，避免把 Docker、Web UI 或 SDK
误认为完整云运行时：

- 持久会话：消息、模型、thinking、扩展自定义状态；
- 调度：同会话串行、全局并发、背压和公平性；
- 持久执行：步骤 checkpoint、失败重试、幂等和中途恢复；
- 环境：workspace、依赖、shell、artifact 和网络；
- 进程：heap、子进程、文件描述符和 RAM snapshot；
- 多租户：认证、授权、配额、密钥和审计；
- 水平扩展：lease、fencing、分布式所有权和迁移；
- 可移植性：版本升级、冷恢复和快照兼容；
- extension：原生发现、生命周期和不可信代码隔离。

## 3. 代表性项目

### 3.1 OpenClaw：最直接的 Pi 多会话参考

OpenClaw 的单个 Gateway 实例不是每个 session 永久对应一个 Pi 进程。
它为同一 session 建立串行 lane，再经过全局并发 lane；每轮创建 Pi
`AgentSession`，结束后释放 session lock 并 dispose。下次根据持久化
transcript 重建语义状态。

这证明了低成本 Pi 云化的一条实际路径：逻辑会话数量可以远大于活跃
AgentSession 数量。但是它不会恢复 extension 的 JS heap、长期子进程、
socket 或浏览器实例。

源码依据：

- [同会话 lane](https://github.com/openclaw/openclaw/blob/94e1cc9a4e4b4d4b6dbcc9ee7fdc202f025817d0/src/agents/embedded-agent-runner/run/lane-controller.ts)
- [创建 AgentSession](https://github.com/openclaw/openclaw/blob/94e1cc9a4e4b4d4b6dbcc9ee7fdc202f025817d0/src/agents/embedded-agent-runner/run/attempt-session.ts)
- [一轮结束后的清理](https://github.com/openclaw/openclaw/blob/94e1cc9a4e4b4d4b6dbcc9ee7fdc202f025817d0/src/agents/embedded-agent-runner/run/attempt.subscription-cleanup.ts)

### 3.2 Microsoft Agent Framework：持久 virtual actor

Durable Agents 将一个 agent session 映射为 Durable Entity。会话历史在
外部存储中持久化，同一 entity 的访问自动串行，worker 重启或扩缩容后
可以由其他 worker 接管。它还可以 checkpoint 多 Agent orchestration，
已经完成的 agent call 不必全部重做。

它解决的是可序列化应用状态和工作流步骤，不会保存 Pi 的 Node heap、
workspace 或工具进程。

源码依据：

- [Durable Agents 文档](https://github.com/microsoft/agent-framework/blob/1036fa7438141d1fb927dbbe651b718ad16003d4/docs/features/durable-agents/README.md)
- [Durable agent state](https://github.com/microsoft/agent-framework/blob/1036fa7438141d1fb927dbbe651b718ad16003d4/python/packages/durabletask/agent_framework_durabletask/_durable_agent_state.py)

### 3.3 Flink Agents：每个 key 有状态，不是每个 key 一个进程

Flink `keyBy` 后，一个 operator subtask 承载很多 key。每个 key 拥有独立
keyed state，同一 key 的 action 排队执行，不同 key 共享固定异步线程池。
这与“很多逻辑 Agent 复用少量 worker”非常接近。

但 Flink Agents 的 ReActAgent 不会自动把任意 Pi `messages[]`、extension
heap 或文件系统转换成 keyed state。它适合事件驱动 Agent 应用，不是通用
Coding Agent 沙箱。

源码依据：

- [同 key action 排队](https://github.com/apache/flink-agents/blob/ad0a935df7f9ea7fd85e47331522d32736e50e17/runtime/src/main/java/org/apache/flink/agents/runtime/operator/ActionExecutionOperator.java#L214-L279)
- [固定异步线程池](https://github.com/apache/flink-agents/blob/ad0a935df7f9ea7fd85e47331522d32736e50e17/runtime/src/main/java/org/apache/flink/agents/runtime/operator/ContinuationActionExecutor.java#L41-L46)
- [ReActAgent](https://github.com/apache/flink-agents/blob/ad0a935df7f9ea7fd85e47331522d32736e50e17/agents/src/main/java/org/apache/flink/agents/react/ReActAgent.java#L105-L170)

### 3.4 LangGraph：graph state checkpoint

LangGraph OSS checkpointer 在 graph superstep 后保存 thread state，支持
pending writes 恢复、time travel 和 fork。它适合能显式建模和序列化的
Agent workflow，不能 checkpoint 任意 Pi JS 对象、工具进程和 workspace。
生产 Agent Server 也不是 OSS core 的同一个边界。

源码依据：

- [LangGraph README](https://github.com/langchain-ai/langgraph/blob/49ae27c2ae983cfb92091b0dea9f7bc37a716479/README.md)
- [Checkpoint library](https://github.com/langchain-ai/langgraph/blob/49ae27c2ae983cfb92091b0dea9f7bc37a716479/libs/checkpoint/README.md)

### 3.5 OpenHands：Coding Agent 产品分层

OpenHands 的 app server 将 conversation、event 和 sandbox service 分开。
process sandbox 为 sandbox 启动 agent-server 子进程；Docker sandbox 的
pause 使用 container pause，因此停止 CPU 但仍保留内存。远程 sandbox
可以有不同实现。

它是有价值的 Coding Agent 产品参考，但 OSS core 没有解决“数千个空闲
会话以 RAM snapshot 形式高密度休眠”。

源码依据：

- [App server](https://github.com/OpenHands/OpenHands/blob/11d4ecf21fc144d10a614ddba63b84de5c90bfd4/openhands/app_server/README.md)
- [Process sandbox](https://github.com/OpenHands/OpenHands/blob/11d4ecf21fc144d10a614ddba63b84de5c90bfd4/openhands/app_server/sandbox/process_sandbox_service.py)
- [Docker pause/resume](https://github.com/OpenHands/OpenHands/blob/11d4ecf21fc144d10a614ddba63b84de5c90bfd4/openhands/app_server/sandbox/docker_sandbox_service.py)

### 3.6 agentserver：直接的 Codex 云壳参考

agentserver 的 Codex gateway 为一个 workspace 启动一个 `codex app-server`，
而 app-server 内部承载多个 thread。空闲 reaper 结束进程前，将 `CODEX_HOME`
上传到对象存储；下次下载后重新启动。

这是文件和应用状态 rehydrate，而不是 RAM snapshot。进程崩溃时，正在
执行的 turn 仍可能丢失；当前 supervisor 所有权主要是单 gateway 进程内
状态，尚不能证明完整的分布式接管语义。

源码依据：

- [Supervisor](https://github.com/agentserver/agentserver/blob/2892d63388e5a61548ae9169c0a3311637370392/internal/codexappgateway/supervisor/supervisor.go)
- [Idle reaper](https://github.com/agentserver/agentserver/blob/2892d63388e5a61548ae9169c0a3311637370392/internal/codexappgateway/supervisor/reaper.go)
- [`CODEX_HOME` 上传/下载](https://github.com/agentserver/agentserver/blob/2892d63388e5a61548ae9169c0a3311637370392/internal/codexappgateway/codexhome/codexhome.go)

### 3.7 E2B：完整 sandbox 基础设施

E2B 为每个活跃 sandbox 运行一个 Firecracker microVM。暂停时保存内存和
root filesystem 差异，快照上传到对象存储；恢复时可以优先回到原节点，
也可以从快照在其他位置恢复。它还提供 filesystem-only cold boot 模式。

E2B 解决的是“可恢复的隔离电脑”，不负责 Agent 会话、同 session 排队、
消息日志、LLM turn 和工具副作用幂等。自托管还需要云资源、Terraform、
Nomad/Consul、PostgreSQL、Redis、ClickHouse、对象存储和 nested
virtualization，不适合作为个人项目的第一阶段。

源码依据：

- [E2B infra architecture](https://github.com/e2b-dev/infra/blob/8f6798504c5e8cf502a4304fb521dbecf2fc09e9/docs/ARCHITECTURE.md)
- [Self-hosting requirements](https://github.com/e2b-dev/infra/blob/8f6798504c5e8cf502a4304fb521dbecf2fc09e9/self-host.md)

### 3.8 Agent Substrate：高密度 actor 休眠

Agent Substrate 将大量逻辑 actor 复用到较小的 worker pod 池，并用
gVisor checkpoint/restore 或 Kata/Cloud Hypervisor 保存 RAM 和文件系统。
其 demo 展示约 250 个 actor 复用 8 个 pod。

它最接近“任意 Agent Runtime 高密度休眠”，但仍处于早期阶段。认证、
worker autoscaling、mTLS、审计、快照保留、数据局部性、分片、升级和
Codex/Claude 集成都仍在 roadmap 中。

源码依据：

- [Architecture](https://github.com/agent-substrate/substrate/blob/a2d55e99e02e5763d964cc1801cc77bd19e20739/docs/architecture.md)
- [Roadmap](https://github.com/agent-substrate/substrate/blob/a2d55e99e02e5763d964cc1801cc77bd19e20739/docs/roadmap.md)
- [Claude Code multiplex demo](https://github.com/agent-substrate/substrate/blob/a2d55e99e02e5763d964cc1801cc77bd19e20739/demos/claude-code-multiplex/README.md)

### 3.9 Kubernetes Agent Sandbox：稳定的 sandbox 对象

核心 Sandbox CRD 当前对应一个有稳定身份和 PVC 的 singleton Pod。核心
suspend 删除 Pod 但保留 PVC 和 Service，因此是磁盘恢复；完整 RAM
snapshot 目前依赖 GKE Autopilot/gVisor 的特定实现。

它适合作为未来 Kubernetes sandbox 生命周期接口，但不应该被误解为已经
提供通用的多 session/process 内存休眠。

源码依据：

- [Sandbox README](https://github.com/kubernetes-sigs/agent-sandbox/blob/5811b645de7632505c6b620dc7f38343a6b38d89/README.md)
- [Suspend/resume KEP](https://github.com/kubernetes-sigs/agent-sandbox/blob/5811b645de7632505c6b620dc7f38343a6b38d89/docs/keps/694-kep-for-suspend-and-resume-for-beta/README.md)
- [Pod snapshots](https://github.com/kubernetes-sigs/agent-sandbox/blob/5811b645de7632505c6b620dc7f38343a6b38d89/site/content/docs/sandbox/snapshots/_index.md)

### 3.10 Google AX：控制面与休眠环境的连接尝试

AX Controller 保存事件日志并实施单 writer 约束，Harness 可以通过
Agent Substrate 创建或恢复 actor、执行一轮，然后再次 suspend。这个方向
同时覆盖会话控制和环境，但当前源码仍有未完成的 execution resume 逻辑，
认证和生产化能力也不完整。

源码依据：

- [AX README](https://github.com/google/ax/blob/5d0e245e8340bfd5c945104ea24300960bc78694/README.md)
- [Controller](https://github.com/google/ax/blob/5d0e245e8340bfd5c945104ea24300960bc78694/internal/controller/controller.go)
- [Agent Substrate adapter](https://github.com/google/ax/blob/5d0e245e8340bfd5c945104ea24300960bc78694/internal/harness/substrate/substrate.go)

## 4. 五种恢复等级

1. **事件重放**：浏览器断线后继续收到已产生的 token/tool event；
2. **语义会话恢复**：重建 messages、model、thinking 和自定义持久状态；
3. **步骤恢复**：知道 LLM/tool/workflow 执行到哪一步，避免重做已确认步骤；
4. **环境恢复**：恢复 workspace、依赖、文件和 artifact；
5. **进程恢复**：恢复 heap、子进程和 RAM。

这些等级不是自动包含关系。例如 E2B 可以恢复进程，却不知道一个 Pi turn
是否已在控制面中被确认；LangGraph 可以恢复步骤，却不能恢复 shell 进程。

即使完整恢复 RAM，也不能自动承诺外部副作用 exactly-once。暂停前已经
发送邮件、创建工单或写入远程系统，但完成回执尚未持久化时，恢复后仍有
重复执行风险。系统仍需 idempotency key、工具执行账本和 reconciliation。

## 5. Pi extension 兼容边界

Pi 已提供可移植状态的官方路径：extension 使用 `pi.appendEntry()` 写入
自定义 session entry，并在 `session_start` 时扫描 session entries 重建状态；
`session_shutdown` 用来释放资源。

依据：

- [Pi extension lifecycle/state 文档](https://github.com/earendil-works/pi-mono/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/packages/coding-agent/docs/extensions.md)
- [Pi SDK session creation](https://github.com/earendil-works/pi-mono/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/packages/coding-agent/src/core/sdk.ts)
- [Extension loader](https://github.com/earendil-works/pi-mono/blob/3da591ab74ab9ab407e72ed882600b2c851fae21/packages/coding-agent/src/core/extensions/loader.ts)

建议按以下等级声明兼容性：

| 等级 | extension 状态 | 可用执行后端 |
| --- | --- | --- |
| portable | 无状态，或通过 session entry 完整重建 | SDK rehydrate、RPC、RAM snapshot |
| workspace | 状态保存在 workspace 文件中 | workspace cold restore、RAM snapshot |
| process-bound | 依赖 heap、子进程、socket 或浏览器 | 长驻隔离进程、兼容的 RAM snapshot |
| untrusted | 任意第三方代码 | 只能进入独立 container/microVM，不能共享 worker |

任意 extension 原样兼容、空闲时完全 scale-to-zero、跨机器/跨 Pi 版本轻松
迁移构成工程上的三角约束：应用状态重建擅长后两项；内存快照擅长前两项，
但升级兼容弱；长驻进程最兼容，却不能释放空闲内存。

## 6. PiCloud 建议架构

PiCloud 应让 session 独立于执行进程存在，并提供可插拔执行后端：

```text
Web / API
    |
    v
Session control plane
durable command/event log + FIFO mailbox + lease/fencing + quotas
    |
    v
ExecutionBackend
    |-- EmbeddedPiBackend       trusted portable extensions
    |-- IsolatedProcessBackend  native Pi RPC and stronger isolation
    `-- HibernateBackend        optional E2B/Substrate-style snapshot
    |
    v
PostgreSQL + workspace/object storage
```

默认的 SDK rehydrate 后端让进程数量跟 worker 和活跃并发相关，而不是跟
历史会话数相关。RPC 后端保留原生 Pi 行为和进程隔离。RAM snapshot 后端
只作为高兼容模式，不应成为第一阶段的基础设施依赖。

现有 Pi RPC adapter、PiCloud event envelope、wire protocol、fencing 和
event spool 都可以保留；Pi RPC supervisor 只是一个 ExecutionBackend，
不再定义整个系统的会话模型。

## 7. 需要用实验回答的问题

下一步不直接上 Kubernetes，而先验证以下假设：

1. 一个 Node worker 能否交替承载多个 Pi 逻辑会话；
2. 每轮 dispose 后，Pi JSONL 是否足以重建 messages 和 portable extension；
3. `appendEntry + session_start` 是否能跨 worker instance 保持状态；
4. 同一 session 是否可以严格串行，同时限制全局活跃数；
5. SDK 嵌入相对 RPC 的内存、升级和 extension 兼容差异；
6. 哪些故障点只能回到 settled turn，不能安全地恢复 in-flight tool call。

实验通过不代表可以在共享进程运行不可信 extension。安全隔离和恢复强度
是两个独立维度。

## 8. Embedded Pi 实验结果

同日完成的 embedded-runtime Spike 已在生产 SDK 路径稳定后从工作树移除，
其实现仍可从 Git 历史查阅。
该实验固定 Pi SDK `0.80.10`，不调用模型，也不启动 Pi 子进程。

实测结果：

- 一个 Node PID 交替承载 3 个逻辑 session；
- 同一 session 并发提交时，活跃峰值严格为 1；
- 不同 session 的全局活跃峰值达到配置上限 2；
- 每轮重新创建 Pi `AgentSessionRuntime`，8 次 activation 都触发
  `session_shutdown` 并在结束后释放；
- 一个全新的 backend instance 仅接收 session JSONL checkpoint，就能恢复
  Pi session ID、assistant messages，以及 extension 的计数状态；
- portable counter 的进程内 closure 每次都从 0 创建，但通过
  `pi.appendEntry()` 和 `session_start` 依次恢复到 1、2、3，之后继续到 5；
- 外部 session path 被拒绝，extension 失败后 semaphore 和 session lane
  仍能释放。

实验还发现一个必须进入持久化语义的细节：Pi 即使已经返回
`sessionFile` 路径，也会刻意等到 session 中出现 assistant message 才真正
创建 JSONL。这意味着 `sessionFile != undefined` 不是 durable checkpoint；
PiCloud 只能在 assistant 已落盘的 settled-turn 边界发布稳定 snapshot。

因为本实验只执行 extension command，不花模型 token，它为每个新 session
写入一个明确标记的零 token synthetic assistant message，以触发 Pi 的公开
落盘机制。生产 LLM turn 自然产生真实 assistant message，不能使用这个
实验标记。

这次实验支持 `embedded-rehydrate` 作为可信 portable extension 的低成本
后端，但没有改变安全结论：任意用户 extension、进程内状态和 in-flight
tool call 仍需隔离进程、sandbox 或完整 hibernation。

### 8.1 1000 idle / 10 active 密度探针

另外执行了 opt-in density probe，而不是只根据 3 个会话推断资源行为。
在当前 WSL/Node 环境的两次独立本地运行中：

- 1000 个逻辑 session 的首次 activation、持久化和 dispose 共耗时
  2701–2875 ms，即并发 10 时每个 session 摊销 2.70–2.88 ms；
- 1000 个 session 冷却后，`activeActivations = 0`，活跃 lane 也为 0；
- 再同时唤醒 10 个不同 session，实测活跃 runtime 峰值为 10；完成后重新
  回到 0；
- 强制 GC 后，heap used 增量为 3,548,960–3,588,520 bytes，约为每个
  逻辑 session 3,549–3,589 bytes；
- RSS 增量在两次运行中为 134,742,016–167,510,016 bytes，但 RSS 包含 V8、原生
  依赖、allocator high-water pages 和 Pi 模块缓存，且不会稳定地随 GC
  下降，不能把约 135 KB/session 当成仍存活的 Agent Runtime 内存。

这是一次无模型、无真实 tool workspace 的本机结构验证，不是生产容量
承诺。它证明了进程/runtime 数量可以跟活跃并发而不是会话总数相关；真实
模型流、工具、extension 和 workspace 的容量仍需独立 benchmark。
