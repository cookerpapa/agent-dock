# 实施记录

这是一份方便复习的简短记录，不写成流水账。每次只记：目标、实现、原因、
验证结果和下一步。

## 2026-07-18 — Pi RPC extension 兼容性实验

- 目标：在开发云端控制面之前，先证明一个独立的 TypeScript 监督器可以
  启动 Pi，并保留 extension 中有价值的人机交互能力。
- 实现：精确锁定 Pi `0.80.10`；启动 `pi --mode rpc --no-session` 子进程；
  加载 `/cloud-check` extension；按 ID 关联 JSONL 请求与响应；转发
  `confirm` 并返回用户确认；接收 `notify`；为等待设置超时；隔离 Pi 配置
  目录；过滤真实凭据；验证 `abort` 回执并优雅回收进程。
- 为什么先做它：Web 页面本身不能证明 agent 已经云化。这个实验先验证
  Pi runtime 与未来控制面之间最关键、也最容易踩坑的协议边界。
- 学到的边界：浏览器可以表达 Pi RPC 提供的确认、输入、通知等请求；但
  terminal 专属的 custom UI、快捷键和主题不会自动迁移到 Web。
- 验证：clean-install 场景下 `npm ci` 与 `npm run check` 均已通过，覆盖
  命令发现、确认往返、通知、`abort` 回执和干净退出。基线从本机旧版
  `0.79.3` 升到当前 `0.80.10` 后，`npm audit --omit=dev` 报告 0 个漏洞。
- 环境限制：Docker Desktop 尚未对当前 WSL 发行版启用 integration，因此
  非 root 容器运行还没有实测；Dockerfile 和加固后的运行命令已经准备好，
  backlog 中仍保持未完成。
- 额外发现：本机经过修改的 `0.79.3` workspace build 被 Node pipe 启动时，
  会把 stdin 识别为 EOF，并在第一个 RPC 响应前退出；锁定的正式发布包
  没有这个问题。在查清本机构建差异前，不把它当作云端基线。
- 下一步：Docker 可用后补做容器验收，然后定义 AgentDock 自己的事件
  envelope，避免未来控制面直接依赖原始 Pi RPC 消息格式。

## 2026-07-18 — 公共事件 envelope 与 Pi 适配器

- 目标：让数据库、控制面和浏览器只依赖 AgentDock 自己的稳定事件，而不
  直接认识 Pi RPC 的内部消息形状。
- 实现：建立 npm workspace；新增 TypeBox `AgentDockEvent v1` 闭合联合类型，
  统一携带 `eventId/sessionId/turnId/agentId/seq/occurredAt`；覆盖 turn、
  session state、文本增量、工具、审批、通知和失败事件；新增 Pi RPC
  adapter，把 `confirm/select/input/editor/notify` 显式转换成公共事件。
- 数据流：Pi 的私有 UI request ID 只保存在 supervisor 的 pending map；Web
  侧只看到新的 `approvalId`。用户决策到达后，adapter 再用 pending map
  还原 Pi 所需的 `extension_ui_response`。
- 失败行为：未知 Pi 消息返回 `unsupported`，畸形消息返回 `invalid`，两者
  都不会作为 raw event 发布；重复审批、非法 select 值和错误响应形状会被
  拒绝；事件校验成功后才提交序号，所以失败事件不会制造 `seq` 空洞。
- 架构约束：只有 session-level state 事件允许 `turnId = null`；turn、工具、
  审批、文本和通知事件必须归属具体 turn。协议决定记录在 ADR-0002。
- 验证：从 lockfile 执行 `npm ci` 后，三组 workspace 均通过严格类型检查；
  13 个协议/适配器测试通过；真实 Pi `0.80.10` 再次完成
  `approval.requested -> approval.resolved -> ui.notification` 的 1/2/3 顺序
  往返、`abort` 回执和干净退出；`npm audit --omit=dev` 为 0 个漏洞。
- 环境说明：当前 Codex 受限执行环境会静默阻止 Node 再启动 Node 子进程，
  所以真实 Pi spike 使用获准的本地主机执行；同一代码在该边界外通过。
  Docker 仍因 WSL integration 未启用而保持未验证。
- 下一步：定义 supervisor 与 control plane 之间的注册、命令、事件、ACK 和
  heartbeat 消息。原因是目前事件只在单进程内有序；先定义网络传输、确认
  和重连语义，后续数据库持久化与 SSE 才不会各自发明一套不兼容协议。

## 2026-07-18 — Supervisor wire protocol 与 ACK/replay

- 目标：让 supervisor 与未来 control plane 对命令交付、事件持久化、断线
  重放、租约和存活检测拥有同一套可执行语义。
- 决策：ADR-0003 明确 PostgreSQL、Pi JSONL、对象存储、workspace 和本地
  spool 的唯一职责；ADR-0004 明确命令/事件使用 at-least-once、session 级
  连续序号、累计 durable ACK，以及 lease ID + 单调 fencing token。
- 协议：新增双向 TypeBox 闭合消息联合。Supervisor 发送注册、command ACK、
  `event.publish` 和 heartbeat；control plane 发送注册确认、执行/取消 turn、
  审批决策、`event.ack` 和带续租结果的 heartbeat ACK。错误方向和附加 raw
  Pi 字段都会被拒绝。
- Spool：新增单 session、容量有界的 `InMemoryEventSpool`。它要求连续 seq，
  拒绝错误 session、旧 lease/fence、冲突重复事件、倒退/越界 ACK；重复的
  当前 ACK 幂等；只删除累计 ACK 覆盖的事件，并按顺序重放未确认后缀。
- 为什么先做内存版：它用于固定并测试状态机，不冒充生产持久化。等真实
  WebSocket 和 sandbox 生命周期存在后，再用磁盘实现替换相同接口，避免
  现在过早选择 LevelDB/SQLite 等存储。
- 真实链路：Pi extension 的 confirm/notify 已实际经过
  `Pi RPC -> adapter -> AgentDockEvent -> event.publish -> spool`。模拟断线时
  重放 1/2/3；累计 ACK 到 2 后只剩 3；最终 ACK 后 spool 为空。
- 验证：协议与 supervisor 共 27 个测试通过，覆盖消息方向、闭合 schema、
  heartbeat 交叉约束、累计 ACK、重放、fencing、冲突和 backpressure；真实
  Pi `0.80.10` spike 同时通过 wire、ACK/replay、abort 和干净退出检查。
- 下一步：实现 session、turn、sandbox、approval 和 agent-node 的显式状态机。
  原因是数据库和 API 必须共享同一组合法转换，先建表再补状态规则容易产生
  双 turn 并发、过期 approval 被接受、sandbox 已失效却继续写入等漏洞。

## 2026-07-18 — Agent 云化调研与 Embedded Pi rehydrate 实验

- 目标：回答“逻辑会话是否必须永久占用 Pi 进程”，并厘清应用状态恢复、
  workspace 恢复和完整进程休眠的能力边界。
- 调研：核对 OpenClaw、Microsoft Agent Framework、Flink Agents、
  LangGraph、OpenHands、agentserver、E2B、Agent Substrate、Kubernetes Agent
  Sandbox 和 Google AX 的源码。结论是没有单一项目覆盖完整 Agent 云化；
  AgentDock 应把会话控制面与执行后端解耦。详细证据保存在
  `docs/research/2026-07-18-agent-cloud-runtime-landscape.md`，决策记录在
  ADR-0005。
- 实现：新增 `spikes/pi-embedded-rehydrate/`。同一个 Node worker 内，每轮
  创建并 dispose Pi `AgentSessionRuntime`；session lane 保证同会话 FIFO，
  fair semaphore 限制跨会话全局 activation；checkpoint path 必须属于后端
  session 目录，且不能被两个逻辑 session 复用。
- portable extension：counter closure 每次 activation 都重新从 0 创建；
  `session_start` 扫描自定义 entries，命令通过 `pi.appendEntry()` 写回状态，
  `session_shutdown` 记录清理。fresh backend instance 只拿 JSONL checkpoint
  就把 counter 从 2 恢复到 3，之后继续到 5。
- 关键发现：Pi 返回 `sessionFile` 不代表文件已经存在。没有 assistant
  message 时，Pi 会延迟 JSONL 创建；因此稳定 checkpoint 必须位于 settled
  assistant 边界。无模型实验用一个明确标记的零 token synthetic assistant
  message 触发公开落盘机制，生产 turn 不使用这个标记。
- 验证：3 个逻辑 session 共用一个 Node PID；同 session 活跃峰值为 1，
  跨 session 峰值为配置上限 2；8 次 activation 全部触发 shutdown 并释放；
  3 个 Vitest 用例覆盖恢复、串行/并发、非法 checkpoint 和失败后释放；
  model call 与 Pi child process 都为 0。
- 密度探针：两次实际完成 1000 个逻辑 session 的首次 activation 和冷却，
  用时 2701–2875 ms；随后 10 个 session 同时唤醒，runtime 峰值为 10，
  结束后为 0。强制 GC 后 heap 相比基线增加约 3.55–3.59 MB（约
  3.55–3.59 KB/session）。RSS 增量为约 135–168 MB，但它包含 allocator
  high-water 和模块缓存，不作为空闲 session 活跃内存结论。该数据只代表
  当前本机、无模型和无真实工具的结构探针。
- 边界：这只证明 trusted portable extension 的低成本 rehydrate。任意用户
  extension、heap/子进程/socket 和 in-flight tool call 仍需隔离进程、
  sandbox 或完整 hibernation。
- 下一步：回到显式 domain state machine。原因是实验已经证明执行后端
  可以替换，接下来必须让 session/turn/lease 状态独立于具体 backend，才
  能把 RPC 和 embedded 两条路径接入同一个可靠控制面。
