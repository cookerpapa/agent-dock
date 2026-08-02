# Codex Agent Harness 对 Cloud Agent 的启示

- 调研日期：2026-08-02
- 上游版本：`openai/codex`
  `2b5bdcf67547860f2e5c5a605009a70026796b2b`
- 结论：参考 Codex 的控制层不变量，不复制它的本地进程、Rollout 或
  Compaction 实现。

## 1. 这里的 Harness 是什么

Codex 源码中没有一个叫 `Harness` 的单体模块。本文用 Agent Harness
指包围模型调用的宿主控制层：它决定一次 Turn 如何开始、如何接收模型输出、
如何执行 Tool、何时允许重试、如何取消、什么内容进入模型上下文，以及崩溃后
如何恢复。

```text
用户输入
  -> Turn / Task 生命周期
  -> 构造本次模型请求的上下文与 Tool 集合
  -> 模型采样
  -> Tool 路由、执行与结果归一化
  -> 继续采样或结束
  -> 持久化、事件发布和恢复
```

模型能力决定 Agent 能想到什么；Harness 决定它做过什么、还能相信什么，以及
失败后会不会把不确定的副作用当成已经完成或安全重试。

## 2. Codex Harness 的核心层次

### 2.1 Session 中只有一个 Active Task

Codex 将普通对话、Compaction、Review 等实现为 `SessionTask`。每个活动任务都
持有取消 Token；替代任务会中止旧任务。取消时，宿主先发出取消信号，给任务一个
很短的收敛窗口，再强制终止并执行 Task 自己的清理逻辑。

关键不是 100ms 这个具体数值，而是四个明确阶段：

```text
revoke/cancel
  -> bounded graceful settlement
  -> forced abort and cleanup
  -> durable terminal boundary
```

参考：
[tasks/mod.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/tasks/mod.rs)、
[session.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/session.rs)。

### 2.2 中断是模型可见的事实边界

Codex 不尝试伪造一个完整的失败 Assistant 回答，也不向下一轮注入一套固定恢复
步骤。它只写入一个有类型、很短的 `<turn_aborted>` 片段，说明上一轮被中断、
命令可能部分执行、后台进程可能仍存在。随后先 flush Rollout，再向客户端发出
终态事件。

这形成三个彼此分离的事实：

- UI 知道 Turn 已中断；
- 恢复后的模型知道前一轮不完整；
- 运行时不声称命令没有执行，也不盲目重放命令。

参考：
[turn_aborted.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/context/turn_aborted.rs)、
[handlers.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/handlers.rs)。

### 2.3 Agent Loop 按 Step 固化请求视图

Codex 的主循环仍然是：模型响应、执行 Tool、记录 Tool 结果、继续模型采样，直到
模型不再要求后续操作。值得参考的细节是 `StepContext`：同一次采样所看到的上下文、
对外声明的 Tool 和真正执行 Tool 时使用的配置来自同一请求快照。

这避免了长 Run 期间管理员修改模型、权限或网络策略后，出现“模型看到旧规则，Tool
却按新规则执行”的撕裂。

参考：
[turn.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/turn.rs)、
[step_context.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/step_context.rs)。

### 2.4 Steer 在安全边界进入循环

Codex 使用 Session 级 `InputQueue` 保存进行中的补充输入。Steer 不会在任意一行
Tool 代码中间直接改写 Prompt，而是在 Agent Loop 的采样边界被取出，并作为正式
输入进入后续上下文。

因此 Steer 不是简单 WebSocket 消息，而是：

```text
durable/idempotent user intent
  -> 定位 Active Turn
  -> 排队
  -> Agent Loop 在合法边界吸收
```

参考：
[input_queue.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/input_queue.rs)。

### 2.5 Tool 有统一的生命周期和效果边界

Codex 将 Tool 解析、注册、生命周期事件、执行和结果回送集中在 Tool Router / Registry
中。一次 Tool 调用带有 call id、精确的 StepContext 和取消 Token，并且最终只产生一个
终态结果。Tool 输出和参数在进入模型上下文前有硬上限。

`ToolOrchestrator` 的重试也不是通用的“失败就再跑一次”。它只对可解释的沙箱拒绝
路径做特定升级；任意 Shell 的含糊失败不能因为模型请求可重试就自动执行第二次。

参考：
[registry.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/tools/registry.rs)、
[orchestrator.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/tools/orchestrator.rs)、
[executed_tool_calls.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/tools/executed_tool_calls.rs)。

### 2.6 模型传输重试与 Tool 重放是两件事

Codex 只在模型流错误被标记为 retryable 时执行有界退避；必要时从 WebSocket 回退到
HTTPS。同一 Turn 会复用请求会话，并将已经执行过的 Tool 元数据以有界方式附回请求，
避免模型传输重试后遗忘刚才的副作用。

这给 Cloud Agent 一个非常重要的重试矩阵：

| 失败位置 | 可以做什么 |
| --- | --- |
| Tool 尚未执行前的模型传输失败 | 有界重试模型请求 |
| 已知只读 Tool 失败且结果明确 | 按 Tool 策略决定是否重试 |
| Bash 已开始但结果不明 | 标记 `UNKNOWN`，禁止盲目重放 |
| Worker 崩溃 | 用 checkpoint、Fence 与中断事实恢复新的 Attempt |

参考：
[responses_retry.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/responses_retry.rs)。

### 2.7 模型上下文是有类型、有限且增量的

Codex 将权限、环境、模型、Tool、AGENTS.md 等运行事实建模为独立的 World State
section。每个 section 保存比较快照，只在事实变化时渲染模型可见 diff，而不是每轮
重复注入整份环境说明。

根仓库的开发约束也强调：上下文只能增量构造、必须有硬上限，大块注入需要更严格
审查，注入片段应由有类型的 `ContextualUserFragment` 定义。

这比“往 messages[] 里临时拼字符串”更重要，因为后者会产生重复提示、Prompt Cache
失效、Compaction 后语义漂移和操作元数据泄漏。

参考：
[world_state/mod.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/context/world_state/mod.rs)、
[context_manager/history.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/context_manager/history.rs)、
[AGENTS.md](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/AGENTS.md)。

### 2.8 Rollout 与 Compaction 都是显式状态转换

Codex 使用 append-only Rollout 保存 ResponseItem、生命周期事件和 World State；恢复时
按记录重放。Compaction 不是从 UI 文本重新拼装 `messages[]`，而是安装一份明确的
replacement history，再继续保留后续尾部记录和 World State 基线。

AgentDock 不应复制这个格式，因为 Pi 原生 Session JSONL 已经是 Agent 上下文的权威
表示。但 Codex 的不变量值得保留：

- 对话恢复必须使用 Agent Runtime 的原生记录；
- Compaction 必须作为一等 checkpoint，而不是 UI 投影；
- Compaction 后必须重新建立动态环境事实的基线；
- Tool call/result 不能因截断或重放而失配。

参考：
[rollout_reconstruction.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/rollout_reconstruction.rs)、
[compact.rs](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/compact.rs)。

## 3. 对 AgentDock 的映射

| Harness 能力 | AgentDock 当前状态 | 判断 |
| --- | --- | --- |
| 单 Session 串行与 Active Run 所有权 | Temporal + PostgreSQL Run/Attempt/Lease/Fence | 已具备，云端边界比本地 Task 更复杂但合理 |
| 中断模型可见 | Pi 原生 `<turn_aborted>` checkpoint + hard-crash bridge | 已具备 |
| 进程环境丢失模型可见 | `<sandbox_reset>`，仅确认 Cube 冷恢复时写入一次 | 已具备，属于 Codex 本地语义之外的云端补充 |
| UI 事件先持久化后可见 | Worker WAL、PostgreSQL durable event、SSE replay | 已具备，且强于本地 UI Rollout 的部署边界 |
| 原生 Session/Compaction 恢复 | Pi Session JSONL + Pi 原生 Compaction | 已具备；不应自建第二套 messages[] |
| Steer | 幂等 API、Worker Control Channel、Pi `steer()` | 已具备；需要继续验证跨重连顺序 |
| Tool 身份与执行权限 | Tool Lease、Fencing Token、Cube KVM | 已具备，适合多 Worker 场景 |
| 不确定 Tool 结果 | 后端可标记 `unknown` 并销毁不确定 Cube | 语义已具备，浏览器表达仍待补齐 |
| Step 级一致请求快照 | RunAttempt/Fence 已有，尚无明确的模型-Step 配置快照 | 值得补齐，但不应侵入 Pi Agent Loop |
| Typed World State diff | 目前只有中断和 Sandbox continuity 的定向实现 | 值得抽象为很小的运行时事实层 |
| 效果感知的重试规则 | 多处分散约束“Shell 不可盲重放” | 应整理成统一矩阵与契约测试 |
| Harness conformance test | 已有中断、恢复和 Tool 隔离测试 | 应补 Compaction、跨 Worker 与重试组合测试 |

## 4. 最值得继续吸收的四件事

### P0：建立 Harness 合同测试，而不是继续堆中间件

增加一组从“下一次真实模型请求”观察上下文的测试，证明：

1. 中断后只出现一次 `<turn_aborted>`；
2. Cube 冷恢复后只出现一次 `<sandbox_reset>`；
3. 两个片段都不包含 Run ID、Pod 名、内部地址或错误堆栈；
4. Pi Compaction 和跨 Worker 冷恢复后事实仍然正确；
5. 已启动但结果不明的 Tool 不会自动执行第二次；
6. 终态事件不会先于对应的语义 checkpoint 对用户可见。

### P0：完成 Tool `UNKNOWN` 的产品表达

`UNKNOWN` 不是普通失败。它表示“系统无法证明命令是否产生过副作用”。UI 应显示
这一事实，并允许用户让 Agent 检查状态；不应提供自动 Retry 按钮。

### P1：增加小型 Runtime World State 层

不要另造 Conversation Store。继续以 Pi custom entry 为持久化载体，只把少量会影响
模型判断的运行事实做成有类型、有限、仅变化时注入的 fragment：

- Sandbox continuity generation；
- Workspace committed revision；
- Tool 执行结果为 `UNKNOWN`；
- 当前模型可见的网络/权限策略发生变化。

该层保存语义事实，不保存 Kubernetes、Cube 或数据库操作细节。

### P1：冻结一次模型步骤的执行视图

在不修改 Pi Agent Loop 的前提下，为每次模型调用/Tool 调用绑定同一版本的：

- RunAttempt 与 Fence；
- Workspace base revision；
- 模型配置版本；
- Tool policy 与网络策略版本。

热配置只影响下一个合法边界，避免正在执行的 Tool 与模型看到的规则不一致。

## 5. 不应照搬 Codex 的部分

- 不复制 Codex Rollout；AgentDock 的 PostgreSQL 事件是 UI/审计权威，Pi JSONL 是
  模型上下文权威。
- 不复制 Codex Compactor；Pi 原生 Compaction 必须继续作为真实会话语义。
- 不假设本地 unified-exec 进程能在 Worker/Cube 崩溃后继续存在。
- 不因为 Codex 有本地权限升级而重新引入 AgentDock 已明确暂缓的审批产品面。
- 不把每个 Codex 内部事件都跨网络持久化；只保留恢复、安全和用户可见性所需语义。
- 不把“Harness”实现成新的大型服务；它应主要体现为 Runtime 边界、状态机和合同测试。

## 6. 对简历表述的建议

中断语义值得写，但不适合单独占一整条，也不应写成“实现了 Codex Harness”。更准确的
位置是“持久执行与会话恢复”中的一个有辨识度细节：

> 完善 Agent 中断恢复语义：参考 Codex 的 model-visible abort boundary，在取消、
> Worker 异常及 Cube 冷恢复后向 Pi 原生会话写入最小事实标记，使跨 Worker 恢复后的
> 模型能够识别未完成副作用与运行环境重置。

面试中可以进一步解释：

```text
durable UI event != model-visible conversation
committed workspace != live process state
interrupted != definitely not executed
retryable model transport != retryable shell side effect
```

这四个区分比“我加了一条提示词”更能体现 Cloud Agent Runtime 的工程判断。
