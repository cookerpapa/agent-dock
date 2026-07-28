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

## 2026-07-18 — v0 产品边界与模型策略

- 目标：明确“Pi 云化”第一版究竟交付什么，并避免把模型下拉框误当作云化
  核心能力。
- 决策：ADR-0006 把 v0 定为单用户、自托管；页面先使用一个由部署者配置
  的默认 model profile，不要求模型选择 UI，但 session 保存期望 profile，
  每个 turn 固化实际 provider/model/thinking/credential-binding 版本。模型只
  能在 settled turn 之间显式切换。
- 凭据边界：refresh token 不进入 Pi JSONL、workspace、浏览器事件或普通
  session/turn 数据；生产目标是可信 credential broker/model gateway 给执行
  边界提供 request-scoped auth。Phase 0 读取本机 Pi 登录的探针只用于显式
  启用的集成验证，不代表生产方案。
- 探针：embedded backend 默认仍拒绝普通模型 prompt；只有同时提供显式
  model 配置和 opt-in 标志时才允许真实调用。探针禁用 tool/extension，使用
  临时 transcript，设计为真实首轮落盘、fresh backend 恢复和第二轮 nonce
  验证，并且不进入 `npm run check`。
- 当前实测：原有 OAuth access 已过期；受限 Node 进程未采用主机 HTTP
  proxy，refresh 在模型请求前失败，因此尚未得到真实 token usage 结果。
  用户暂停了带代理的重试；没有遗留探针进程。这里不把未完成实验记为通过。
- 下一步：实现 domain state machine。原因是 Web/API 必须先共享 session、
  turn、sandbox 和 approval 的合法转换，否则命令接受、取消和恢复会被多个
  handler 分散实现并产生竞态。

## 2026-07-18 — Domain 状态机与 model profile

- 目标：在数据库和 API 之前，把 session、turn、sandbox、approval、
  agent-node 的合法状态变化写成唯一、可执行的规则。
- 实现：新增 `@agent-dock/domain`。状态集合是闭合 union，所有 transition
  都经过纯函数；非法跳转、自跳转和终态复活抛出带 entity/from/to 的
  `DomainTransitionError`。approval 只能从 pending 离开一次；sandbox 失败后
  只能清理，不能重回池中；agent-node 显式表达 waiting/cancelling/terminal。
- 崩溃语义：runner 尚未确认执行时允许 `dispatching -> queued`；一旦进入
  running 就禁止回队列，只能 completed/failed/cancelling。原因是 shell 和
  外部副作用不能靠重新发送伪装成 exactly-once。
- 模型策略：`ModelProfileSchema` 只接受 allowlisted provider/model/thinking
  和 opaque credential binding；额外的 token、baseUrl 等字段会被闭合 schema
  拒绝。每个 turn 由 profile 解析出独立 snapshot，不依赖以后修改的默认值。
- 验证：domain package 严格类型检查通过；18 个测试覆盖完整 session/turn
  路径、四个取消入口、失败恢复、approval 终态、sandbox 清理、agent 等待、
  model profile 解析和 secret 字段拒绝。
- 下一步：创建 PostgreSQL/Kysely schema 和 migration。原因是状态、模型
  快照、幂等键、lease/fence 与 event seq 规则已经固定，现在可以让数据库
  约束承担持久化层的不变量，而不是只依赖应用代码。

## 2026-07-18 — PostgreSQL/Kysely 初始持久化模型

- 目标：把 ADR-0003/0004/0006 和 domain 状态机中的不变量落实为可执行的
  PostgreSQL schema，而不是只画 ER 图。
- 实现：新增 `@agent-dock/database`，包含 typed Kysely `Database`、`pg`
  runtime client、静态 migration provider、up/down CLI 和一份初始 migration。
  18 张表覆盖 ownership、workspace、credential binding metadata、model
  profile、session/turn/agent、sandbox/lease、command、approval、event/cursor、
  outbox、artifact 和 usage ledger。
- 核心约束：数据库拒绝跨 tenant 关联、重复 idempotency key、重复 session
  seq、第二个非 queued active turn、ACK 超过 durable seq、非正 fencing token、
  越界 sandbox capacity、错误 approval outcome/timestamp 和负 token/cost。
  queued turn 可以有多个，保留 mailbox 能力。
- 凭据边界：普通表只有 opaque `secret_ref`/binding version，没有 access、
  refresh、API key 列；turn 和 agent-node 保存的是模型/credential binding
  snapshot，不是凭据值。
- 验证方式：当前 WSL 没有 Docker/psql，因此加入 test-only PGlite。测试先用
  Kysely PostgreSQL dialect 编译 DDL，再在内存 PostgreSQL 引擎真实执行、插入
  合法/非法数据，最后执行 down。10 个 migration/constraint 测试通过；PGlite
  不进入生产运行依赖。
- Web 方向：只读审查 Pi `0.80.10` `/export` template 和现有 Session Tree
  Browser 源码，没有读取真实 transcript。设计基线记录在
  `docs/WEB_UI_DIRECTION.md`：保留等宽紧凑风格、可缩放 tree、800px transcript
  和 tool/thinking 折叠；云端页面改走 AgentDock REST/SSE，不在浏览器直接
  操作 Pi 进程或 JSONL。
- 下一步：实现 deterministic OpenAI-compatible fake model server。原因是
  它能在不消耗 subscription token 的情况下稳定复现 text/tool stream、429、
  timeout、malformed response 和断流，之后 Web/API 的失败行为才可重复测试。

## 2026-07-18 — Deterministic fake model server

- 目标：让模型正常流式输出和失败路径都能从 clean checkout 稳定重现，CI 不
  依赖外网、真实 token 或订阅额度。
- 实现：新增 `@agent-dock/fake-model-server`，在 loopback 上提供真实
  OpenAI Chat Completions HTTP/SSE。通过 `x-agent-dock-scenario` 固定选择
  `text`、`tool_call`、`rate_limit`、`timeout`、`malformed` 或
  `disconnect`；tool-call arguments 分成两段发送，tool result 到达后返回最终
  文本，因此能验证多次模型请求的工具回路协议。
- Pi 合同：测试不是自写客户端解析自己的响应，而是由 pinned Pi `0.80.10`
  的 `openai-completions` adapter 发出请求并解析 text delta、usage、tool call
  和错误。这样 Pi 升级导致兼容性变化时会直接失败。
- 失败语义：429 禁止客户端自动重试；timeout 故意不发送 HTTP headers，验证
  request timeout；显式 AbortSignal 验证取消；malformed SSE 和发送部分文本后
  断流都必须得到 error，而不能误报成功。测试过程中还确认：收到 SSE headers
  后的 idle stream 不属于 OpenAI SDK `timeoutMs` 的同一语义，后续应由
  supervisor 的 stream-idle watchdog 处理。
- 安全边界：服务器拒绝非 loopback bind；固定 key 只用于本地测试且没有外部
  价值；观测只保留 request ID、scenario、model、message/tool 数量、状态码和
  完成方式，不保留 Authorization 或 message 内容。
- 验证：6 个 HTTP/lifecycle 测试和 7 个 Pi provider contract 测试覆盖 discovery、
  auth、日志脱敏、text/tool、429、timeout、abort、malformed 与 disconnect。
- 真实 provider：经用户明确授权后运行 subscription probe；第一次因旧 OAuth
  刷新失败。用户重新执行 Pi `/login` 后，确认 `~/.pi/agent/auth.json` 中的
  `openai-codex` 登录可刷新且未过期，证明当前本地 probe 会复用 Pi 默认
  agentDir，但这不代表生产 credential broker 已实现。
- 网络诊断：本机 `curl` 可通过 `127.0.0.1:10808` proxy 到达 Codex endpoint，
  Node 24 直连失败；`--use-env-proxy` 后无凭据 GET/POST 分别快速得到 405/401。
  为把 WebSocket proxy 问题与 rehydration 解耦，embedded backend 新增显式
  transport 选项，live probe 固定 SSE。真实第一轮仍在约 50 秒后被归类为
  `network`，所以没有把它记为通过，也没有取得成功 token usage；停止继续重试。
  所有失败路径仍由 `finally` 删除临时 transcript。
- 下一步：补 Phase 0 的 CI formatting/unit/secret-scan enforcement。原因是现有
  合同测试已经足够多，应该先确保每次提交自动执行并阻止敏感信息进入仓库；
  Docker Compose/非 root 容器仍需等当前 WSL 的 Docker 可用后做真实验证。

## 2026-07-18 — Embedded SDK HTTP bootstrap and live rehydration proof

- 现象澄清：probe 输出的 `network` 是 AgentDock 对 `fetch/socket` 类错误的粗粒度
  分类，不表示 Pi CLI、账号或 OpenAI 服务整体不可用。用户手动运行的 Pi
  `0.79.3` 可以快速返回；随后使用 AgentDock 依赖的同一个 Pi `0.80.10` CLI、
  同一 OAuth 和同一 `gpt-5.4-mini` 发送最小请求，也在 4.2 秒内返回 `OK`。
- 根因：Pi CLI 入口会在 provider SDK 发请求前调用 `configureHttpDispatcher()`，
  安装 npm Undici 的 `EnvHttpProxyAgent` 和对应 global fetch；AgentDock 直接调用
  SDK 的 embedded path 绕过了 CLI `main()`，因此漏掉这一步。Node 自带的
  `--use-env-proxy` 不能替代 Pi 所用 npm Undici 实例的完整初始化。
- 修复：embedded backend 仅在显式允许模型调用时安装 AgentDock 自有的、进程级
  幂等 HTTP runtime；直接 pin `undici@8.5.0`，从 worker 环境读取 proxy/no-proxy，
  但不返回或记录代理 URL/凭据。相同 idle timeout 可重复初始化，不同 timeout
  会被明确拒绝，避免一个共享 worker 悄悄采用互相冲突的网络策略。
- 合同测试：在隔离子进程中验证 dispatcher 类型、global fetch 安装、幂等行为、
  proxy 环境识别以及冲突 timeout 拒绝，避免污染其余 Vitest 进程。
- 真实验证：修复后的两轮 subscription probe 在 3.7 秒内通过，共报告 295 tokens。
  第一轮精确返回 ACK；runtime 释放后，新 backend 仅凭 JSONL 恢复同一个 Pi
  session，并在第二轮精确取回 nonce。tools/extensions 均为 0，临时 transcript
  在退出时删除，OAuth 值和对话正文没有输出。
- 后续理由：默认 CI 仍只运行 fake provider 和无 token 合同测试；真实订阅 probe
  必须继续 opt-in。生产凭据仍需 ADR-0006 所述 broker/gateway，不能把本机
  `~/.pi/agent` 挂载进 sandbox。

## 2026-07-18 — Reproducible CI and secret-history enforcement

- 目标：把 format、typecheck、全部单元/合同测试、两个零 token Pi spike、依赖
  audit 和 Git 历史 secret scan 变成 push/PR 的自动门禁；真实 subscription
  probe 明确不进入 CI。
- 格式基线：pin `prettier@3.9.5`，只格式化代码与 JSON/YAML，不重排 Markdown
  正文。18 个既有代码文件的纯机械格式化单独保存为 commit `bbb4ecd`，避免以后
  的 CI 行为变更被格式噪声淹没。
- Quality job：Node 固定为 `24.12.0`，使用 `npm ci --ignore-scripts` 从 lockfile
  安装，随后执行可在本地复现的 `npm run ci`。该命令覆盖格式、所有 workspace
  typecheck、73 个 Vitest 测试、RPC/embedded 两个零 token spike，以及包含 dev
  dependency 的 high-severity `npm audit`。
- Secret job：checkout 完整历史后运行 Gitleaks；关闭 PR comment 和 SARIF artifact
  上传，workflow token 仅有 `contents: read`。个人 GitHub 账号无需 Gitleaks
  license；如果以后迁移到 organization，需要按 upstream 要求配置
  `GITLEAKS_LICENSE`。
- 供应链：`actions/checkout v7.0.0`、`actions/setup-node v7.0.0` 和
  `gitleaks-action v3.0.0` 均固定到不可变 commit SHA，不依赖可移动 major tag。
- 验证：workflow 通过 checksum 验证后的 `actionlint 1.7.12`；官方 Gitleaks
  `8.30.1` 对当前目录和 10 个 Git commits 均报告 no leaks。临时 detached
  worktree 从空 `node_modules` 执行 `npm ci --ignore-scripts && npm run ci` 全部
  通过，之后已删除。
- 证据边界：当前仓库尚未配置 Git remote，所以还没有 GitHub-hosted runner
  记录；这里只声明 workflow、clean-checkout 和本地 scanner 已通过。首次 push
  后应确认两个 hosted jobs 都为绿色。
- 下一步：补 Docker Compose 和 non-root container spike。原因是 Phase 0 现在只
  剩执行隔离没有在真实容器中验证；这也是进入 NestJS/API vertical slice 前最
  重要的安全前提。

## 2026-07-18 — Hardened Phase 0 Compose topology

- 目标：把 Pi RPC compatibility 和 embedded rehydrate 两个零 token probe
  打包为可重复的一次性 runner，并让 non-root、只读文件系统、无网络、无宿主
  挂载和资源限制成为机器可检查的配置，而不是 README 中的一条建议命令。
- Topology：根目录 `compose.yaml` 定义两个独立 service；没有加入 PostgreSQL、
  MinIO 或 Toxiproxy，因为当前 Phase 0 runner 没有组件会使用它们。提前启动未
  连通的基础设施不会增加证据，只会掩盖真实数据流尚未实现。
- 运行边界：两个 service 均显式使用 UID/GID `1000:1000`、read-only rootfs、
  64 MiB `/tmp` tmpfs、`network_mode: none`、`cap_drop: ALL`、
  `no-new-privileges`、128 PID、512 MiB memory、1 CPU 和 1024 nofile；没有
  volume、port、host PID/IPC、device 或 Compose secret。
- 双重 non-root 检查：Compose 设置 `AGENT_DOCK_REQUIRE_NON_ROOT=1`；两个 spike
  启动时读取真实 Unix UID/GID，UID 为 0 或无法确认时直接失败，并在成功 JSON
  中记录 runtime identity。普通本地运行不会被这个容器专用开关误伤。
- 构建供应链：Node `24.12.0-bookworm-slim` 固定到官方 multi-arch OCI index
  digest `sha256:7326fb…d92c99`；镜像只执行 `npm ci --omit=dev --ignore-scripts`。
  `.dockerignore` 改为 allowlist，因此 `.git`、home、OAuth、session、workspace、
  `.env` 和 `.npmrc` 不会进入 build context。
- 合同测试：新增 2 个 Vitest 用例解析 Compose YAML，并检查每个 service 的
  hardening、禁止的 host boundary、两个 Dockerfile 的 digest/non-root/install
  顺序以及 build-context allowlist。全仓总计 75 个测试。
- 无 daemon 验证：checksum 校验后的 Docker Compose `v5.3.1` 成功执行
  `config --quiet`。随后在两个临时目录逐条模拟 Dockerfile 的 COPY 和 production
  npm install；RPC 布局安装 144 packages、embedded 布局安装 142 packages，
  两个 probe 均以 required non-root `1000:1000` 通过，临时目录已删除。
- CI：新增独立 container job；GitHub-hosted runner 会 build 两个 digest-pinned
  image 并顺序运行，再在 `always()` cleanup。运行时完全断网，且不注入 OAuth、
  provider key 或真实 model call。
- 证据边界：当前 WSL 仍没有 Docker CLI/daemon，仓库也没有 remote，因此还不能
  声称真实 Docker namespaces/cgroups/read-only mount 已通过。backlog 中
  “Run the spike inside a non-root Docker container”继续保持未完成；首次 hosted
  CI 或本机 `npm run container:check` 成功后才能勾选。
- 下一步：先启用 Docker Desktop WSL integration，或把仓库 push 到个人 GitHub
  触发 container job。原因是继续写 Phase 1 API 不能替代这最后一个 Phase 0
  runtime 证据；容器真实通过后再开始 NestJS vertical slice。

## 2026-07-18 — Real Docker runtime verification and Phase 0 completion

- 目标：在真实 Docker daemon 中验证 Phase 0 的两个 runner，并证明 Compose 中
  声明的隔离和资源限制确实进入了容器 `HostConfig`，不只停留在 YAML 静态检查。
- 实测环境：Docker Desktop Engine `29.4.2`、Compose `5.1.3`。两个 digest-pinned
  image 均从 allowlisted build context 成功构建；检查用的 stopped container 和
  实际运行 container 已清理，本地 image/build cache 保留用于复现。
- 有效隔离：逐个 `docker inspect` 确认 UID/GID `1000:1000`、read-only rootfs、
  `network_mode: none`、private IPC、init、`cap_drop: ALL`、
  `no-new-privileges`、128 PID、512 MiB、1 CPU，以及带 `noexec,nosuid,nodev`
  的 64 MiB `/tmp`。同时确认没有 host bind、volume、port、device、host PID/IPC
  或 privileged mode，运行环境中也没有 credential-like 变量名。
- 真实执行：Pi RPC container 完成命令发现、confirm/notify UI 往返、公共事件
  映射、wire 校验、累计 ACK/replay、spool drain、abort 与 clean exit；embedded
  container 在同一 worker 中运行 3 个 logical session，完成 JSONL/checkpoint
  rehydrate、同 session FIFO 与跨 session bounded concurrency，最后 active runtime
  回到 0。两个进程都从容器内报告 UID/GID `1000:1000`，`modelCalls` 为 0。
- 可重复检查：新增 `scripts/run-container-check.mjs`，让本地与 GitHub Actions
  使用同一条 `npm run container:check`；任一实际 `HostConfig` 约束缺失都会在
  probe 运行前失败。workflow 经 checksum-verified actionlint `1.7.12` 校验通过。
- 回归：`npm run ci` 再次通过，包括严格类型检查、75 个测试、两个本地零 token
  spike 和 `npm audit` 0 vulnerabilities。Phase 0 backlog 最后一项已勾选，Phase 0
  至此完成；仓库尚无 remote，所以 hosted CI 结果仍需首次 push 后确认。
- 下一步：开始 Phase 1 的 single-user NestJS vertical slice，先贯通“创建 session
  -> durable accept turn -> supervisor 执行 -> SSE 事件”这一条最短路径。原因是
  Phase 0 已固定协议、状态、存储与执行隔离边界，现在需要用一个端到端用户故事
  验证这些边界能组合成产品，而不是继续增加互不连通的底层模块。

## 2026-07-18 — Phase 1 durable turn-intake vertical slice

- 目标：先实现端到端路径的第一个事务边界，让 HTTP API 只有在 turn、command
  和 outbox 一起持久化之后才返回 `202 Accepted`；本切片暂不假装已经接通 Pi、
  SSE 或 Web UI。
- 公共 API：`@agent-dock/protocol` 新增 closed TypeBox schema 和 parser，覆盖创建
  project、创建 session、提交 prompt、thinking level、UUID path、
  `Idempotency-Key`、成功 resource 与统一 error envelope。额外字段、空白名称/
  prompt、不合法 UUID/header 和不受当前 model profile 允许的 thinking level
  都在写库前拒绝。
- NestJS/Fastify：新增 `@agent-dock/control-plane`，实现
  `POST /v1/projects`、`POST /v1/projects/:projectId/sessions` 和
  `POST /v1/sessions/:sessionId/turns`。v0 继续使用部署者配置的 tenant 与默认
  model profile，没有提前加入登录、多租户或前端 model picker。
- 持久化语义：project 与初始 workspace 同事务创建；session 同时初始化 event
  cursor。turn intake 在一个 Kysely/PostgreSQL transaction 内写 queued turn、
  pending command 和 `control.command.pending.v1` outbox。turn 固化 provider、model、
  thinking level 与 opaque credential-binding version；command 只保存 SHA-256 请求
  指纹，outbox 只保存 ID，不复制 prompt 或凭据。
- 幂等：同 session 下相同 key + 相同 body 返回原 turn/command，并标记
  `replayed: true`；相同 key + 不同 body 返回 `409 idempotency_conflict`。数据库
  unique constraint 仍是并发竞争的最终裁决，应用层在事务回滚后读取胜出的记录。
- 故障边界：未知数据库错误只返回通用 `internal_error`，不向客户端暴露 SQL、
  表名、prompt 或 stack。测试在 command 写入之后注入 outbox failure，确认
  turn 与 command 一起回滚；404、请求验证和 model policy 错误也有显式响应。
- 测试依赖选择：在线核对官方包后使用 NestJS/Fastify `11.1.28`/`5.10.0`；测试
  使用 ElectricSQL 官方 PGlite `0.5.4` + socket `0.2.7` 暴露 PostgreSQL wire，
  让生产 `pg`/Kysely client、migration 和真实 HTTP request 同时参与测试，避免
  引入版本滞后的第三方 Kysely dialect。PGlite 仍是 test-only。
- 验证：新增 4 个 public-schema tests 和 6 个 HTTP/database integration tests，
  全仓从 75 增至 85 tests；`npm run ci`、0-vulnerability audit 以及两套重新构建
  的 hardened Docker probe 全部通过。同一套 6-test HTTP suite 还通过可选
  `AGENT_DOCK_TEST_DATABASE_URL` 在仅绑定 `127.0.0.1` 的一次性
  PostgreSQL `15.2-alpine` container 中复跑成功，container 随后已删除。
- backlog：第一条 vertical-slice acceptance criterion“command 在 execution 前
  durable accepted”已完成。其余 criterion 保持未完成，因为 supervisor dispatch、
  Pi turn、SSE reconnect、process-tree cancellation 和最终 Git diff 尚未接通。
- 下一步：实现 transaction outbox dispatcher 与单个本地 supervisor adapter，
  把 pending `turn.execute` 从数据库送到一个受控的 fake execution backend，并把
  command/turn 状态推进到 running/completed。原因是先验证“durable command 真的
  会被后台消费且不会由 HTTP handler 直接执行”，之后接 Pi RPC 和 SSE 时才有
  稳定的异步执行边界。

## 2026-07-18 — Phase 1 transactional outbox dispatcher

- 目标：让已经 durable accepted 的 turn 真正由独立后台边界领取，而不是让 HTTP
  handler 等待或直接执行 agent；本切片仍不假装已经接通真实 Pi。
- 领取：`OutboxDispatcher.dispatchNext()` 在 PostgreSQL transaction 中使用
  `FOR UPDATE SKIP LOCKED` 领取一条到期 outbox，并同时锁住所属 session。查询只让
  每个 session 最早的 non-terminal command 进入执行，两个 dispatcher 不能领取
  同一 turn，也不能让后续 turn 越过正在执行或等待重试的 turn。
- 状态：domain 新增 command 状态机。领取把 `pending/queued` 推进到
  `dispatched/dispatching`；backend 必须先 await `lifecycle.started()`，ACK 落库后才
  推进到 `acknowledged/running` 并把 outbox 标记为已交付；成功时 command/turn
  一起终结，session 回到 `idle`。因此 ACK 后崩溃会准确表现为“命令已交付、执行态
  待协调”，而不是错误地表现为 outbox 尚未投递。
- 故障：ACK 前的 retryable failure 会回到 `pending/queued` 并延后 outbox 的
  `available_at`；超过 attempt limit 或 non-retryable failure 会终态失败。ACK 后
  不自动重放，因为此时 model/tool side effect 可能已经发生，只能记录 terminal
  failure。进程若在 ACK 前崩溃可由 claim timeout 重新领取；ACK 后崩溃暂时保持
  ambiguous，留给下一步的 supervisor lease/fencing/reconciliation。
- 测试 backend：新增 `DeterministicExecutionBackend`，可脚本化 complete、ACK 前
  failure 和 ACK 后 failure。它不调用 model，执行记录只含 command/session/turn ID
  和 outcome，不保存 prompt 或 credential；生产 `main.ts` 没有自动启动它，避免
  将真实请求假装执行成功。
- 协议：`control.command.pending.v1` payload 现在有 closed TypeBox schema，只允许
  schema version、command/session/turn ID 和 `turn.execute` kind，额外字段会被拒绝。
- 验证：新增 2 个 command-state tests、2 个 outbox-schema tests 和 6 个 dispatcher
  integration tests，全仓从 85 增至 95 tests。测试还把递增的 outbox attempt 当作
  local fencing token，证明 lease 到期后旧 claimant 即使恢复，也不能越过新 claimant
  的 attempt 去 ACK 或开始执行。PGlite suite 与一次性、仅绑定 `127.0.0.1` 的
  PostgreSQL `15.2-alpine` suite 均通过，测试 container 已删除。完整
  `npm run ci`（format、typecheck、95 tests、两个 zero-token Pi spike、0 high-severity
  vulnerabilities）及重新构建的 `npm run container:check` 也全部通过。
- backlog：只新增并勾选 deterministic dispatcher 的内部验收项；“supervisor 使用
  pinned Pi RPC”仍保持未完成。
- 下一步：把 deterministic backend 替换为本地 supervisor adapter，发出已有
  versioned `turn.execute` wire command，并且只有 supervisor 持有有效 lease/fencing
  token 且返回 durable ACK 后才调用 `lifecycle.started()`。原因是这一步会把当前
  可靠的数据库边界接到真实 Pi RPC，同时保留以后横向扩容、runner 重连和 stale
  writer 拒绝所需的协议语义。

## 2026-07-18 — Fenced local supervisor and pinned Pi execution

- 目标：把 durable outbox 真正接到 Pi，而不是继续用“假执行成功”的 backend；同时
  保证 Pi 在 ACK 落库之前不能收到 prompt。
- 协议：ADR-0007 固定 `prepare -> durable ACK -> run` 三段边界。
  `command.turn.execute` 新增 turn 已固化的 model profile、provider、model、thinking
  level 与 opaque credential-binding version；wire 中不出现 key、token、secret ref
  或任意 base URL。
- 租约：新增 PostgreSQL `SessionLeaseCoordinator`。它锁 session/sandbox、递增
  `last_fencing_token`、写 `session_leases` 并占用容量；ACK transaction 再次核对
  lease/fence 与有效期。成功和 ACK 后失败都在 turn settlement transaction 中删除
  当前 lease、归还容量；旧 lease 在释放后再次写入会得到 `stale_fence`。
- Supervisor：新增 side-effect-free prepare、command payload 去重、session fence
  high-water、容量拒绝和 event identity 检查。同 command ID 如果 prompt/model 等
  immutable payload 改变会被拒绝，不能借“duplicate”偷换执行内容。
- Pi runtime：`@agent-dock/sandbox-supervisor` 直接精确依赖 Pi `0.80.10`，每次测试
  activation 使用独立临时 agent dir、环境变量引用的 request credential、严格 LF
  JSONL、8 MiB stdout 上限、4 KiB 且不外泄正文的 stderr 边界、RPC/turn timeout，
  ambient credential/process-injection env 过滤，以及 stdin EOF、process-group
  SIGTERM/SIGKILL 的回收路径。默认关闭 telemetry、extension、tool、skill、context
  file 和 session 落盘。
- 事件：新增普通 agent event adapter，将 `agent_start`、assistant `text_delta`、tool
  start/end 和 `agent_settled` 转成 AgentDock `turn.started`、文本、工具与 terminal
  event；原始 Pi message/partial/provider error 不越过 supervisor。测试中两段 delta
  合并为 `AgentDock fake stream OK.`，序号为 1/2/3/4，所有 publication 使用同一个
  command/lease/fence。
- ACK 证据：端到端测试在每次 Pi event 到达时回查数据库，四次都已看到 command
  `acknowledged`、turn/session `running` 且 outbox `published_at` 非空，证明不是在
  model 执行之后补写 ACK。
- 安全与验证：默认只访问 loopback fake model，不读取本机 Pi 登录，也不消耗订阅
  token；event 中没有 prompt/fake key，临时 workspace 为空，fake server observation
  只记录安全 metadata。全仓 107 个测试、两个 zero-token spike、format/typecheck 和
  high-severity audit 全部通过；同一套 14 个控制面测试又在一次性、仅绑定
  `127.0.0.1` 的 PostgreSQL `15.2-alpine` 中通过，容器随后已删除。
  两个 hardened Phase 0 image 也从新 lockfile 重新构建并通过 non-root、无网络、
  read-only rootfs、资源限制和零 token runtime 检查，临时运行容器已清理。
- 当前边界：这是 test/integration 用的 in-process transport；production `main.ts`
  没有启动 dispatcher/supervisor。每个 turn 仍启动一个 ephemeral Pi RPC process，
  没有恢复 Pi JSONL，也没有 event 持久化/ACK/SSE，因此还不能称为完整的多轮云化
  runtime，更不能声称 workspace sandbox 已完成。
- 下一步：实现 fenced durable event ingestion、累计 event ACK 和基于
  `Last-Event-ID` 的 SSE replay。原因是当前 Pi 事件已经可信地产生，但只进入测试
  collector；先让事件在数据库 commit 后才 ACK，Web 才能实时显示并在断线后无损
  续传，之后再接 cancellation 和可恢复 Pi session。

## 2026-07-18 — Durable event ACK and resumable SSE

- 目标：把真实 Pi 已经产生的公开事件从 test collector 变成可恢复的权威日志，并
  让 supervisor 只在 PostgreSQL commit 后删除投递副本；浏览器实时流和断线补发必须
  使用同一份 session sequence。
- 决策：新增 ADR-0008，固定 `event.publish -> transaction commit -> event.ack` 边界、
  精确重复投递语义以及 SSE subscribe-before-replay 的无缝衔接。新增向前迁移 002：
  `session_events.agent_id` 保存 `root` 这类公开 opaque ID，`agent_node_id` 继续保留为
  可选内部 UUID；`command_id` 通过 tenant/session/turn 复合外键绑定原命令。旧事件会
  显式回填为内部 node ID 或 `legacy`，不会伪造为当前 `root`。
- 写入：`DurableEventStore` 锁 session 与 cursor，核对 tenant/session/turn/command、
  当前未过期 lease/fence、`last_persisted_seq + 1` 与 `sessions.next_event_seq`，然后在
  同一 transaction 写完整事件、推进 persisted/ACK-eligible cursor 和下一序号。gap、
  stale fence、复用 event ID 与冲突 duplicate 都不会改变数据库。
- 丢 ACK 恢复：lease 已在 terminal settlement 中释放后，如果 supervisor 重投的
  event ID/body/time/command/lease/fence 与持久化行完全相同，control plane 仍可只读地
  重发到该序号的 ACK；内容有任何变化都会得到 `event_conflict`。这样解决“commit
  成功但 ACK 包恰好丢失”的窗口，同时旧 runner 仍不能追加或篡改历史。
- Supervisor：local supervisor 每次发布前先 append 到 bounded `InMemoryEventSpool`；
  local execution backend 现在必须注入 durable ingestor，验证返回 ACK 的
  session/lease/fence/seq 后，spool 才累计删除。该 spool 仍是 memory-only，runner
  进程重启后的持久化重投留在 Phase 2。
- Web：新增 `GET /v1/sessions/:sessionId/events`。SSE frame 使用 session seq 作为
  `id`、AgentDock type 作为 `event`、完整 versioned event 作为 JSON `data`；严格校验
  canonical non-negative `Last-Event-ID`，拒绝超过 durable high-water 的 cursor。
  stream 先订阅 bounded process-local hub，再分页读取固定 replay window，最后按 seq
  去重 live overlap，并用 heartbeat 保活。因此 control-plane 重启后的浏览器 replay
  已安全；多 control-plane replica 的无缝 live fan-out 仍需 `LISTEN/NOTIFY` 或 broker。
- 端到端证据：测试在 Pi 执行前先打开 SSE，pinned Pi `0.80.10` 通过 loopback fake
  model 产生 `turn.started`、两段 text delta、`turn.completed`；数据库事件与 ACK 均为
  `1/2/3/4`，SSE 实时收到同样四条，`Last-Event-ID: 2` 只补 `3/4`。同一测试还证明
  gap 与 stale fence 被拒绝、terminal exact duplicate 在 lease 释放后可重 ACK、篡改
  duplicate 被拒绝，且全程不读取订阅凭证、不消耗 provider token。
- 验证：全仓 `npm run ci` 通过（format、typecheck、112 tests、两个 zero-token Pi
  spikes、0 high-severity vulnerabilities）；同一套 16 个 control-plane tests 在一次性
  PostgreSQL `15.2-alpine` 上通过，容器随后自动删除。重新构建后的两个 hardened
  image 也通过 non-root、read-only rootfs、no network、resource limit 和零 token
  runtime 检查，临时容器全部清理。
- 当前边界：生产 HTTP entry point 已有 durable event table 与 SSE endpoint，但不会
  自动启动 dispatcher/supervisor；live hub 只覆盖单个 control-plane process，runner
  spool 不是 crash-safe，Pi JSONL/workspace snapshot、lease renewal、cancellation 和
  React session page 仍未完成。
- 下一步：实现 durable cancel command 到 Pi/process-tree termination 的完整路径。
  原因是现在用户已经能实时观察长 turn，但还不能主动停止模型请求或工具子进程；
  cancellation 是把当前“可看”链路变成可安全操作的云端 session 的最小下一闭环。

## 2026-07-19 — Durable cancellation and confirmed process-tree teardown

- 目标：让浏览器发出的取消请求先成为可重试、可审计的 durable intent，再真正中断
  blocked model call；只有 Pi 与完整工具进程组均停止且 terminal event 已持久化后，
  turn 才能对外成为 `cancelled`。
- 决策：新增 ADR-0009 和独立 `control.command.cancel.pending.v1` outbox。公开
  `POST /v1/sessions/:sessionId/turns/:turnId/cancellations` 强制使用
  `Idempotency-Key`；同 key/同 request 可重放，变更 grace period 会冲突，另一条活跃
  cancellation 也不会重复发 abort。取消命令使用自己的 command ID，并显式保存
  `targetCommandId`，因此 acceptance、target execution 和 cancellation audit 不混淆。
- 竞态边界：cancellation dispatcher 在 supervisor 的 side-effect-free prepare 后，
  再锁定并复核 target command、turn/session、lease/fence。将 cancel command 写为
  `acknowledged` 且 turn/session 写为 `cancelling` 的同一 transaction 是线性化点：此前
  已提交的自然完成获胜并让 cancellation 得到 `cancellation_too_late`；此后 execute
  dispatcher 不再抢 terminal settlement，而由 cancellation path 持有终局所有权。
- Supervisor 与 Pi：prepare 只校验精确 assignment，不触发 AbortController；数据库 ACK
  成功后才发送 Pi JSONL `abort`。在 POSIX 上 grace period 后对独立 process group 发送
  `SIGTERM`，必要时 `SIGKILL`，并用负 PGID 探测确认包括 tool descendant 在内的进程组
  消失。测试 fixture 故意忽略 Pi abort 和 descendant `SIGTERM`，最终仍确认记录的 PID
  不存在且公开 event 为 `turn.cancelled { forced: true }`。
- Event 与 settlement：预期 abort 不再伪装为 `turn.failed`。Supervisor 在进程树回收后
  才发布 `turn.cancelled`；control plane 仍用 target execute command 的当前 lease/fence
  将其持久化和累计 ACK，SSE 实时及重连都使用同一条有序事件。只有 exact terminal
  event 存在后，dispatcher 才把两个 commands 完成、turn 设为 cancelled、session 设为
  idle 并精确归还容量。cancelling 状态下晚到的 completed/failed event 会被拒绝。
- 失败策略：pre-ACK 失败仍可安全 retry；post-ACK 若不能证明停止，则 cancel/execute
  command、turn 和 session 进入 failed，且不把 lease/sandbox 容量盲目放回 ready pool，
  留给后续 reconciler 隔离或终止。
- 端到端证据：真实 pinned Pi `0.80.10` 正阻塞在 loopback fake model 时，HTTP 取消能
  独立推进；fake server 观察到 client abort，SSE 顺序为 `turn.started ->
  turn.cancelled`，最终 durable state、lease 删除和容量归还一致。全仓 124 个测试通过，
  包括 idempotency、重复取消、queued rejection、自然完成竞态、stale fence、forced
  descendant kill 和事件终局所有权；测试不读取本机 Pi 登录，也不消耗 provider token。
- 验证：本轮 PGlite、真实 Pi、真实 loopback HTTP 和 POSIX process-group 测试已通过；
  同一套 20 个 control-plane tests 也在仅绑定 `127.0.0.1` 的一次性 PostgreSQL
  `15.2-alpine` 上通过，覆盖真实 row lock、`SKIP LOCKED`、JSONB outbox join 与上述
  cancellation races。带 `--rm` 的测试容器随后已停止并确认删除。完整 `npm run ci`
  通过 format、全仓 typecheck、124 tests、两个 zero-token Pi spikes 和 0 vulnerabilities。
- 当前边界：production `main.ts` 仍不自动启动两个 dispatchers 或远程 supervisor；
  in-process transport、memory-only event spool、每 turn ephemeral Pi process、临时本地
  workspace 仍是 integration scaffolding。queued withdrawal、ACK 后 crash recovery、
  lease renewal、Windows Job Object 和真实容器 workspace transport 尚未实现。
- 下一步：把 supervisor transport 接入已验证的 hardened Docker sandbox，并用 sample
  Java repo 贯通真实 workspace、工具执行与 final Git diff。原因是 durable intake、
  streaming、fencing 和 cancellation 已闭环；现在最大的“云化”缺口是 agent 仍在本机
  integration workspace 中运行，尚未证明不可信代码与 control plane 隔离。

## 2026-07-19 — Ephemeral Docker workspace and Java repair vertical slice

- 目标：把 Pi、内置工具和 workspace 从 NestJS/本机测试目录移入真正受限的 Docker
  activation，并让已有的 durable command、lease/fence、event ACK、SSE 和 cancellation
  链路保持不变。
- 决策：新增 ADR-0010。trusted host runner 可以调用 Docker CLI，但 container 内没有
  Docker socket、host bind、端口或真实 credential。每个活跃 turn 使用一个 ephemeral
  container；冷 session 不保留进程。worker 与 host 使用私有、封闭、版本化的 LF JSONL
  协议，每条 `event.publish` 仍必须等 PostgreSQL commit 后的 `event.ack`。
- Sandbox：新增 pinned Node 24/JDK 17/Git image。实际 HostConfig 已验证 non-root
  `1000:1000`、read-only rootfs、`network=none`、drop all capabilities、
  `no-new-privileges`、无 bind/volume/device/port，以及 CPU、768 MiB memory、128 PIDs、
  nofile、64 MiB `/tmp` 和 128 MiB workspace tmpfs 限制。完成或取消后都按精确名称确认
  container 不存在。
- Agent loop：sample Java fixture 初始 `Calculator.add()` 错写成减法。container 内复制
  fixture、建立 baseline Git commit，Pi `0.80.10` 只启用 `bash` 与 `edit`。embedded
  loopback fake model 固定驱动 `bash ./test.sh` 失败、编辑 Java、再次测试通过，最后返回
  `Java repair verified.`；整个测试不读取 Pi 登录、不调用真实 provider。
- Event 与 diff：新增 closed worker protocol 和可选 `turn.completed.workspacePatch`。
  patch 在 container 内通过 Git 生成，按 UTF-8 截断到 64 KiB 后再过公开 schema；测试
  断言只出现 `return left - right` 到 `return left + right` 的 unified diff。Pi 的
  `tool_execution_update` 经源码审核后作为 transient progress 显式忽略，tool start/end
  仍完整持久化；未知 Pi event 继续 fail closed。
- 完整证据：Docker runner 测试验证 `bash/edit/bash` 三次工具边界、第一次预期失败、
  后两次成功、final patch、无 credential 泄漏与外层 container 清理。控制面测试再把
  同一次 repair 贯通 outbox -> lease/fence -> Docker -> Pi -> 10 条逐条落库后 ACK 的
  event -> live SSE -> terminal settlement，最终 cursor 为 10、lease 删除、sandbox
  capacity 归零。阻塞模型的取消测试也确认 `turn.started -> turn.cancelled` 与 container
  消失。
- 可复现命令：新增 `npm run sandbox:check`，自动寻找 `docker`/`docker.exe`，构建 image，
  运行两条 Docker integration tests 和 19 条 control-plane tests。Docker Engine
  `29.4.2` 实测全部通过；默认 `npm test` 为 130 passed、3 个 Docker opt-in tests
  skipped。完整 `npm run ci` 也通过 format、全仓 typecheck、130 tests、两个 zero-token
  Pi spikes 和 0 vulnerabilities；CI container job 会额外执行同一 Docker 命令。
- 当前边界：这是 sample fixture 与 embedded fake model 的安全 vertical slice，不是
  任意 Git 仓库导入，也没有恢复 Pi JSONL/workspace snapshot、加载 project extension
  或连接 request-scoped model gateway。control plane 到 supervisor 仍是 in-process
  adapter，production `main.ts` 不会自动启动 dispatcher。
- 下一步：实现 Pi `/export` 风格的最小 React session page。原因是 backend story 已能
  从 clean checkout 重现真实工具、diff、取消和 SSE；现在最小的 Phase 1 缺口是让用户
  在 Web 中发起 turn、看到文本/工具状态、取消并检查 final diff，而不是继续只看测试。

## 2026-07-19 — Pi-export React session page and one-command demo

- 目标：补齐 Phase 1 最后一个用户可见切片，让页面真实驱动已经存在的 durable
  control-plane/sandbox 链路，而不是展示静态 mock 或让 browser 直接管理 Pi/Docker。
- Web：新增独立 `@agent-dock/web-ui` React/Vite workspace。页面沿用 Pi `/export` 的
  紧凑等宽语言、约 800 px transcript、克制 user card、非气泡 assistant prose、可折叠
  tool/diff、桌面可拖动且可键盘调整的 tree sidebar，以及移动端 overlay。turn/session/
  reconnect/cancel/failure 都同时使用文字和符号，不只依赖颜色；固定 fake model、Pi
  版本、sandbox 边界和 durable sequence 作为只读 metadata 展示。
- REST 边界：shared protocol 新增 success/error resource parser；project、session、turn
  和 cancellation response 在进入 React state 前都经过 closed TypeBox schema。浏览器
  不记录 request/event，不接收 credential ref、provider token 或 raw Pi RPC。Markdown
  不允许 raw HTML，也不会自动请求模型给出的远程图片；tool value 预览有 16,000 字符
  上限。
- SSE：没有使用无法为手动新连接设置 cursor 的 `EventSource`，而是实现 bounded
  fetch-stream parser。它处理任意 chunk/CRLF/comment/multiline data，显式发送
  `Last-Event-ID`，校验 AgentDock schema、session、frame id/type 和连续 seq；duplicate
  replay 幂等忽略，gap 重连，协议错误 fail visible，网络错误 bounded backoff。纯 reducer
  保留 text/tool/approval/terminal 时序，并拒绝旧 session 回调污染新 session。
- Demo runtime：新增根目录 `npm run demo`。命令确认 Docker、默认构建 pinned sandbox
  image 和 production Web bundle，然后启动 loopback-only Vite preview 与显式
  `src/demo.ts`。后者在内存 PGlite 上执行真实 migration，seed 一个零 token profile 和
  sandbox，分别轮询 execution/cancellation outbox；production `main.ts` 没有被偷偷改成
  本机 worker。`Ctrl+C` 会一起停止两个进程。
- 真实验收：通过 `127.0.0.1:4173` 的页面同源代理创建 project/session/turn，HTTP 先返回
  `queued`；随后 Docker/Pi 路径按 `1..10` 收到 start、三组 tool start/end、两段 text 和
  completed，final unified diff 为 336 bytes 且包含 `return left + right`。第二个真实
  session 在 `turn.started #1` 后提交 durable cancellation，得到 `turn.cancelled #2`、
  `forced=false`；新 SSE 使用 `Last-Event-ID: 1` 只重放 #2。两条路径结束后均确认没有
  `agent-dock.managed=true` container 遗留。
- 自动验证：Web 有 8 个测试覆盖 fragmented SSE、断线重连 cursor、duplicate 去重、
  frame identity fail-closed、ordered transcript、cancel state、sequence gap 和 server
  rendering/旧 session 隔离；protocol resource parser 另增 2 个测试。production bundle
  build 已纳入 CI，gzip JS/CSS 分别约 131/4 KiB；demo runtime 另有 1 个默认 smoke test
  验证 migration、seed、public API 和 shutdown。完整 `npm run ci` 通过 format、build、
  全仓 typecheck、141 passed/3 Docker opt-in skipped、两个 zero-token Pi spike 和 0
  high-severity vulnerabilities；重新构建 image 的 `npm run sandbox:check` 又通过 2 个
  Docker tests 和 19 个完整 control-plane tests，结束后无 managed container。
- 诚实边界：当前 image 每次 activation 都从 fixture baseline 开始，Pi JSONL 也没有
  restore；因此 UI 在首个 turn settled 后要求创建新 demo session，不把“相同 sessionId
  但全新 context/workspace”包装成多轮会话。page reload discovery、任意 repo、approval
  response、真实 model gateway、durable runner spool 与跨 replica live fan-out仍未完成。
- 里程碑：Phase 1 已完成。下一步先为 settled checkpoint manifest、Pi JSONL 与 workspace
  snapshot 的写入/校验/恢复边界写 ADR 和失败测试，再让同一 session 的第二个 turn 在
  新 container 中恢复。原因是“真正多轮且冷 session 不占进程”是 Phase 2 的核心；若先
  放开 composer 而没有可验证恢复，只会制造一个看起来多轮、实际丢上下文的假功能。

## 2026-07-19 — Settled checkpoint 与跨容器多轮恢复

- 目标：让 AgentDock session 的 durable identity 真正独立于 Pi 进程/container。第一轮
  结束后不保留任何 runtime，第二轮仍必须同时看到旧 `messages[]` 和旧 workspace。
- 决策：新增 ADR-0011。成功顺序固定为 Pi settled -> worker capture -> trusted host
  持久化并 ACK checkpoint -> worker 发布 `turn.completed` -> PostgreSQL durable event ACK。
  checkpoint 失败时禁止先发 completed。反向崩溃窗口由 durable `turn.completed` 作为
  commit marker 解决：若新 pointer 已 staged 但 terminal 尚未落库，cold load 自动回退
  上一组 completed artifacts，失败轮不会成为恢复 authority。
- Pi：checkpoint mode 不再传 `--no-session`，而是在 runner 私有临时目录使用显式
  `--session`。`agent_end` 时先读取 JSONL、执行 checkpoint hook，再允许公开 terminal；
  fresh runner 可写回同一份 JSONL 后启动，实际测试确认第二次 model request 的 message
  数量增加。
- Workspace：新增 `agent-dock.workspace-manifest.v1`。只允许 canonical relative POSIX
  regular files，拒绝 symlink/special file、`.git`、重复/穿越/冲突路径、非法 UTF-8、非
  canonical base64、长度/哈希不符；限制 512 files、512 KiB/file、512-byte path、2 MiB
  manifest。恢复保留 image fixture 的 baseline Git commit，替换其余 working tree，因此
  第二轮 final diff 仍相对原始 fixture 累积。
- 存储：新增受信任 host `SandboxCheckpointStore` 边界、atomic no-overwrite file object
  adapter，以及 PostgreSQL implementation。对象 byte、artifact metadata、session 两个
  snapshot pointer、lease/fence、row-version CAS 和 opaque revision 全部校验；DB 失败的
  未引用对象会 best-effort 清理。开发 adapter 只服务本地 demo，不冒充 MinIO/S3 或
  host-loss durability。
- 私有协议：worker stdin/stdout 新增 closed `sandbox.checkpoint.publish/ack`，Pi JSONL 与
  workspace bytes 只走私有 channel，不进入 public event/SSE、Docker args/env 或日志。
  `turn.completed` 在 checkpoint ACK 之前会被 host 拒绝。
- 多轮证据：fake model 新增 `java_followup`，只有看到上一轮 `Java repair verified.` 才会
  调用 bash 检查 `return left + right;` 并重跑测试。Docker 实测第一轮 repair 后 container
  消失，第二轮由不同 container restore，只有一次成功 bash，返回
  `Prior conversation and Java repair restored after cold activation.`；event seq 从 1..10
  连续到 11..16，artifact 从 2 增至 4，最后 container 同样消失。
- Web：settled 后 composer 不再要求 new session，显示 `cold restore ready`，下一次提交
  为 `send follow-up`。仍保留 active-turn serialization，browser 不接触 checkpoint bytes。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、150
  passed/4 skipped tests、两个 zero-token Pi spikes 和 0 high-severity vulnerabilities。
  重新构建 `agent-dock/pi-workspace:phase2` 的 `npm run sandbox:check` 又通过 3 个 Docker
  supervisor tests 与 19 个完整 control-plane tests；结束后没有 managed container 遗留。
- 当前边界：这是 bounded sample workspace 的 semantic settled restore，不恢复进程内存、
  shell/open fd/in-flight tool，也还没有 MinIO/S3、generic repo archive、durable supervisor
  spool、runner restart reconciliation、lease renewal 或 cross-replica notification。
- 下一步：先实现 crash-safe supervisor event spool 与 restart redelivery。原因是 Pi/workspace
  已能在 cold activation 中恢复，Phase 2 现在最大的 durability 缺口是 supervisor 在收到
  command ACK 或发出尚未 ACK 的 event 后崩溃；若不先补这层，仍不能诚实满足 runner
  reconnect 不丢事件的退出标准。

## 2026-07-19 — Crash-safe supervisor event spool

- 目标：让已由 runner 产生、但尚未拿到 durable control-plane ACK 的 AgentDock event 不因
  supervisor 进程退出而消失，同时覆盖“PostgreSQL 已 commit、返回 ACK 丢失”的反向窗口。
- 决策：新增 ADR-0012 和 replaceable `SupervisorEventSpool` boundary。内存实现继续用于快速
  contract tests；文件实现要求一个 supervisor 独占 private persistent-volume root，不引入
  Kafka/Redis，也不允许 execution side 直写 control-plane database。
- 文件格式：每个 session/lease/fence assignment 使用 SHA-256 directory；closed manifest
  记录 immutable identity、累计 ACK cursor、event/byte capacity。每个 sequence 使用单独的
  canonical JSON envelope 与显式 SHA-256，拒绝 symlink、special/unknown entry、非法 schema、
  hash/bytes 不符、gap、conflicting duplicate、stale fence、ACK regression 和越界容量。
- 崩溃顺序：append 先写 `0600` temp、fsync、atomic no-overwrite link、directory fsync，成功后
  才能调用 transport。ACK 先 atomic replace + fsync manifest cursor，再删除 covered files；
  因此任一 crash window 最多造成 exact duplicate，不会先删除唯一 delivery copy。
- Supervisor：`LocalSandboxSupervisor` 可注入 async spool factory，默认同步内存路径的既有
  cancellation 时序保持不变。demo runtime 改用文件 spool。fresh `FileEventSpoolStore` 可扫描
  所有 assignment，按 session/fence/seq 重投并应用 matching cumulative ACK。
- PostgreSQL 证据：integration test 先让 `DurableEventStore` commit `turn.started`，随后在 ACK
  返回路径故意抛错并让 dispatcher 释放 lease。新 store 实例重投完全相同的 event 后仍得到
  ACK，`session_events` 始终只有一行，第二次扫描为 empty。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、156
  passed/4 skipped tests、两个 zero-token Pi spikes 和 0 high-severity vulnerabilities。
- 安全边界：该能力只恢复已经 durable append 的 public event，不重启 Pi，不恢复 shell/open
  fd/in-flight tool，也不自动判断已 ACK command 的外部副作用。stale/corrupt spool fail closed
  并保留给 reconciliation；空 manifest 暂时保留，terminal-aware GC 后续实现。
- 下一步：用五个预先 accepted 的同 session prompt 做 mailbox FIFO 验收。原因是 event replay
  已跨 supervisor restart 闭环，Phase 2 的下一个用户可见保证是排队输入不能并发或越过前序
  turn；它也会暴露当前 API 是否真的允许 active session 接收 queued follow-up。

## 2026-07-19 — 显式 session mailbox 与运行中排队输入

- 目标：把“同一 session 一次只运行一轮”从近似的 `(created_at, UUID)` 排序升级成数据库可证明
  的接收顺序，并明确用户在当前 turn 运行时再次提交 prompt 的含义。
- 决策：新增 ADR-0013。每个 `turn.execute` command 获得 session 内正数且不可变的
  `mailbox_position`；session 持有 `next_mailbox_position`。prompt acceptance 锁 session row，
  在同一 transaction 中写 turn/command/outbox、推进 counter 并把 position 返回给客户端。
- 迁移：003 为旧 execute command 按既有确定性顺序 backfill position，推进各 session counter，
  增加正数、kind/null 对应关系和 session 内唯一约束。cancel/approval 等 targeted control command
  不占 execute mailbox position，避免取消被未来 prompt 阻塞。
- 调度：dispatcher 只允许最低 nonterminal position 进入执行；retry 保留原位置并阻塞后续轮。
  timestamp 和随机 UUID 不再参与同 session 正确性。幂等重放返回原 position，不产生 counter gap。
- 产品语义：active session 的普通 prompt 是新的 **queued follow-up**，不是对正在运行的模型做
  steer。它只在前序轮 settle 后，从最新成功 checkpoint 开始。真正的 steer 保留为未来独立
  API/command，并需要 runtime capability negotiation。
- Web：每轮显示 `mailbox #N`；running、waiting approval 或 cancelling 时 composer 仍可提交，按钮
  明确写 `queue follow-up`，提示 `follow-up queues · never steers`。运行中的 turn 仍保留独立 cancel。
- 证据：PostgreSQL integration test 在第 1 条已 ACK/running 时并发接受第 2–5 条，把后四条
  `created_at` 强制设成同一时间，再证明执行严格按 position 1..5、最大并发始终为 1。position 3
  的同 key/body 重放仍返回 3，五条完成后 session counter 恰为 6。migration test 同时证明旧数据
  backfill、execute 非空/唯一约束和 control-command null 约束。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、159
  passed/4 skipped tests、两个 zero-token Pi spikes 和 0 high-severity vulnerabilities。
- Docker 验收：重新构建 `agent-dock/pi-workspace:phase2` 后，3 个 supervisor Docker tests
  通过跨容器 restore、Java repair 和 confirmed cancellation；21 个 control-plane tests 全部
  通过，结束后 `io.agent-dock.managed=true` 容器为 0。
- PostgreSQL 验收：同一套 control-plane suite 通过只绑定 `127.0.0.1` 的一次性 PostgreSQL
  `15.2-alpine` 复跑（20 passed/1 Docker-only skipped），覆盖真实 row lock、partial unique index、
  `SKIP LOCKED` 和五输入 FIFO；数据库容器随后自动删除。
- 当前边界：这不是 active-loop steer，也没有 queue-depth quota、tenant fairness 或 queued-turn
  withdrawal。queued rows 只占 PostgreSQL 存储，不会预留 Pi process、thread、container 或 lease。
- 下一步：实现长 turn lease renewal 与 runner restart reconciliation。原因是 mailbox 已能稳定
  保存等待工作，而当前最大的执行所有权缺口是 supervisor/control-plane 重启或 lease 过期后，
  系统仍不能自动区分可安全重领、必须隔离和结果不明的 assignment。

## 2026-07-19 — 长 turn 租约续期与旧 runtime 对账

- 目标：让健康 turn 可以跨越初始 lease deadline，同时避免把“lease 过期”误当成“旧 Pi、tool
  或 container 已经消失”。后者会造成同一 session 两个 writer 并存，是比延迟更严重的错误。
- 决策：新增 ADR-0014。每个 `LocalSandboxSupervisor` 使用一条共享 heartbeat loop，批量报告所有
  active assignment 的 session/turn/lease/fence/state 与 produced/ACKed event cursor；不为每个
  turn 各建 timer。control plane 只有在 connection、boot、sandbox、lifecycle、lease/fence、cursor
  全部精确且 lease 尚未过期时才原子更新 `valid_until/renewed_at`。过期 lease 永不复活。
- 撤销：ACK 漏掉或错配某个 assignment 时，supervisor 以内部 `lease_revoked`、0 grace 中止该
  runtime；全局 heartbeat transport/protocol 失败会 quarantine sandbox 并撤销该 boot 的所有
  tracked executions。runner 即使忽略 abort 并返回 success，也会被改判为未确认撤销，不能提交
  假 completion。post-ACK lease loss 会让 session failed，而不是回到 idle。
- Docker 身份：activation 新增 supervisor、boot、sandbox、command、session、turn、lease、fence
  closed labels。受信任 host inventory 只按 sandbox scope 列举，删除前重新 inspect 完整身份，使用
  container ID 做 destructive target，检查 `docker rm --force` 结果并再次 inspect 确认 absent；
  Docker socket 仍不进入 sandbox。
- 对账：`AssignmentReconciler` 的调用前提是旧 supervisor boot 已被外层 manager fence、不能再创建
  runtime。它先终止 exact expired boundary 与 orphan，再在 transaction 中重新核对 lease。已 ACK
  的不明 turn/command/session 以 `assignment_lost` 失败；从未 durable ACK 的 command 只在 absence
  proof 后回到原 mailbox position。termination/identity/invariant 不能确认时 sandbox 进入 failed，
  lease/capacity 保留；重复运行会在故障解除后收敛。retirement 同样先 draining、清理 runtime，再
  终止旧 sandbox，不采用旧进程，也不宣称 exactly-once side effect。
- 故障注入：测试覆盖多次 lease deadline 续期、过期不复活、漏 renewal 撤销、runner 忽略撤销、
  exact/orphan container 清理、changed/malformed label 拒绝、pre-ACK requeue、post-ACK ambiguous fail、
  termination 未确认时保留 reservation，以及修复后幂等重试与旧 sandbox retirement。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、173 passed/4
  skipped tests、两个 zero-token Pi spikes 和 0 high-severity vulnerabilities。真实 Docker
  `sandbox:check` 重新构建 Phase 2 image，3 个 supervisor container tests 与 28 个完整
  control-plane tests 全部通过，完整 identity labels 被 inspect，结束后 managed container 为 0。
  同一 control-plane suite 又在一次性 PostgreSQL 15.2 上通过 27 passed/1 Docker-only skipped，
  覆盖真实 row lock、heartbeat renewal、过期 lease 与 reconciliation transaction；数据库容器已删除。
- 当前边界：本地 bridge 已执行真实 heartbeat contract，Docker inventory/reconciler 是可调用的 host
  boundary；生产 remote supervisor 的注册、liveness manager、启动时自动调用与跨 replica transport
  仍需后续接线。reconciler 不会仅凭 timestamp 自行断言 supervisor 进程已经死亡。
- 下一步：实现 production supervisor registration/health manager，并把“确认旧 boot 已退出 ->
  reconcile/retire -> 注册新 sandbox/boot”接成真实远程启动路径。原因是安全的数据与容器算法已经
  可测，下一层缺口是让独立 supervisor 进程自动驱动它，而不是由集成代码显式调用。

## 2026-07-19 — Supervisor 注册代际与 durable health manager

- 目标：把上一阶段只能由集成代码显式调用的 heartbeat/reconciler 接成可跨 control-plane 重启的
  状态机，同时严格区分“连接失效”和“旧 Pi/tool/container 已停止”。后者若判断错误，会提前释放
  lease/capacity 并产生并发 writer。
- 决策：新增 ADR-0015。可信 provisioner 必须先写入精确的 supervisor/boot/sandbox row，并把
  supervisor、boot、sandbox、fresh transport ID 作为认证后的 channel authority 交给 manager；
  `supervisor.register` JSON 本身不授予身份或创建任意 sandbox。注册固定 protocol v1、AgentDock
  supervisor `0.1.0`、Pi package/version、required capabilities 和预配容量。
- 数据库：migration 004 新增 `supervisor_connections` 与 `sandbox_retirements`，当前 schema 共 20 张
  application tables。连接表持久化 transport/registration/response/connection ID、payload fingerprint、
  control-plane owner、runtime version/capability、heartbeat policy、accepting flag、last-seen/expiry 和
  close reason；partial unique index 保证每个 sandbox 最多一个 active generation，复合 FK 保证
  sandbox/supervisor/boot 不会错绑。retirement 表实现 pending/claimed/blocked/completed、claim lease、
  attempt、delay 和 safe error code 的闭合约束。
- 重连：同 transport 的 exact registration retry 返回原 ACK；改 payload、跨 transport replay、过期或
  superseded generation 均拒绝。相同 boot 在 timeout 前换 transport 会原子 supersede 旧 connection，
  保留同一个 supervisor runtime/event spool；不同 boot 必须使用另一个预配 sandbox，旧 connection
  立即 fenced、旧 sandbox failed 并写 retirement job，绝不接管旧进程。
- 心跳：registered `SessionLeaseCoordinator` 在同一个 transaction、同一 lock order 中核对 sandbox、
  connection、transport、control-plane owner、boot、capacity、expiry，再同时推进 connection expiry/
  `accepting_assignments` 与 exact session lease renewal。因此 registration fence 和旧 heartbeat 有明确
  的数据库先后序，expired connection 不可复活；`acceptingAssignments=false` 会拒绝新 acquire，但不
  粗暴终止已存在 assignment。
- 回收：health sweep 只 fence/quarantine 并写 durable retirement，不删除 lease 或归还容量。worker
  claim 后必须先调用 `SupervisorOwnerBoundary.stopAndConfirm(exact boot)`；只有该调用证明旧 boot 不能
  再创建 runtime，才运行 `AssignmentReconciler.retireSandbox()`。retryable failure 延时重试，identity/
  invariant failure 进入 blocked；claimant 崩溃超过 claim deadline 后，另一 control-plane instance 可
  重领。最终还会回查 sandbox 确实为 `terminated` 才把 job 标记 completed。
- 故障证据：8 个新 control-plane integration tests 覆盖认证/版本拒绝、same-channel idempotency、
  changed/cross-channel replay、same-boot reconnect 与旧 connection 拒绝、new-boot quarantine、atomic
  lease+liveness renewal、停止接单、timeout 后 ambiguous lease/capacity 保留、owner-stop-before-inventory、
  `assignment_lost` settlement、retry/blocked retirement，以及另一 control-plane 重领 abandoned claim。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、182 passed/4
  skipped tests、两个 zero-token Pi spikes 和 0 vulnerabilities。相同 control-plane suite 又在一次性、
  仅绑定 `127.0.0.1` 的 PostgreSQL `15.2-alpine` 上通过 39 passed/1 Docker-only skipped，覆盖真实
  row lock、partial unique index、`SKIP LOCKED` 与 claim handoff；数据库 container 已删除，managed
  sandbox container 为 0。
- 当前边界：manager 是 production-shaped、transport-neutral control-plane 核心，但还没有实际的
  outbound WebSocket listener/client，也没有把 mTLS/provisioner identity 或 Docker/Kubernetes
  supervisor-owner process handle 接入 production `main.ts`。现有 HTTP entry point 不会伪造 owner
  confirmation 或静默启动本地 Docker worker。
- 下一步：实现 authenticated outbound supervisor WebSocket，并让独立 supervisor client 用真实
  register/registered/heartbeat 帧驱动本 manager。原因是数据库代际和 failure semantics 已经可证明，
  下一层应该验证网络断线、same-boot reconnect、stale socket 关闭和消息路由，而不是再增加本地假
  backend 功能。

## 2026-07-19 — 真实 outbound WebSocket 注册与共享心跳

- 目标：让独立 supervisor 通过真实网络帧驱动 ADR-0015 的 connection generation/heartbeat manager，
  并证明跨 control-plane listener 重连时不能依赖某个进程内 socket map 来 fence 旧连接。
- 决策：新增 ADR-0016。control plane 使用精确锁定的 `@fastify/websocket 11.3.0`，sandbox client 使用
  `ws 8.21.1`。gateway 必须在其他 Fastify routes 前安装，也可以通过可选
  `ControlPlaneApplicationOptions.supervisorWebSocketGateway` 挂到 Nest/Fastify application；生产
  `main.ts` 不会在缺少真实 owner/auth 配置时静默启用它。
- Upgrade 认证：新增 closed `SupervisorUpgradeAuthorizer`，只返回可信 supervisor/boot/sandbox identity，
  gateway 为每条 socket 生成 fresh transport ID 后才调用 manager。测试/开发用的 hashed-bearer
  authorizer 在构造后只保留 SHA-256 digest，并用 constant-time compare；token/header 不进入 wire、DB、
  error 或日志。生产可以替换为 mTLS/SPIFFE/provisioner，而不用修改 frame handler。
- 帧边界：第一条 bounded text frame 必须是 `supervisor.register`；binary、invalid JSON/schema、提前
  heartbeat、unsupported type、registration timeout 和超大 payload 都 fail closed。每 socket 只有一条
  promise chain，pending frame 数和 send buffer 均有上限，send callback 完成才处理下一帧，避免 frame
  reorder 与无界内存增长。断线只清理进程内 routing，不直接 quarantine/reconcile。
- Supervisor client：真实 `ws/wss` client 禁止 URL credential/query/fragment，authorization 只放 Upgrade
  header；严格验证 `supervisor.registered` identity。server 协商的 interval/timeout 驱动一条 heartbeat
  timer，任一时刻最多一个 heartbeat in flight；ACK 必须匹配 message/connection，并交给
  `LocalSandboxSupervisor.applyHeartbeatAcknowledgement()` 处理 renewal/revocation。一个 heartbeat 仍覆盖
  全部 active assignments，不为 session 创建 socket/thread。
- 重连证据：同 gateway 会在新 generation commit 后主动以 private close code 关闭旧 socket；若新旧
  socket 分别连接两个 control-plane listener，旧 listener 的内存 map 完全看不到新连接，但下一次
  heartbeat 会被 PostgreSQL 中的 superseded generation 拒绝并关闭，新的 socket 继续 registered。
- 网络测试：4 个真实 `127.0.0.1` WebSocket integration tests 覆盖 Upgrade 前 401、错误 credential 不
  泄露、register/registered、周期 heartbeat、`acceptingAssignments=false` 落库、clean close 不提前释放、
  durable timeout quarantine、跨 replica stale socket，以及 registration-first、binary、timeout、1 KiB
  payload limit。测试不调用模型、不消耗订阅 token。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、186 passed/4
  skipped tests、两个 zero-token Pi spikes 和 0 vulnerabilities。相同 control-plane suite 在一次性
  PostgreSQL `15.2-alpine` 上通过 43 passed/1 Docker-only skipped；结束后测试数据库与 managed
  sandbox containers 均为 0。
- 当前边界：网络 slice 只开放 register 与 heartbeat。gateway 会明确拒绝 `command.ack` 和
  `event.publish`，client 也不会假装能执行远程 command；execute/cancel delivery、durable command ACK、
  event publish/cumulative ACK backpressure，以及真实 provisioner credential/owner-process adapter 仍未
  接入 production。
- 下一步：实现 remote supervisor command/event router。原因是连接认证、代际、重连和 liveness 已经
  跨真实 socket 闭环，接下来应把现有 `prepare -> durable ACK -> run` 与
  `event.publish -> PostgreSQL commit -> event.ack` 顺序原样搬到网络上，而不能写一个无 durable
  correlation 的通用 JSON RPC handler。

## 2026-07-19 — 两阶段远程 command/event WebSocket 路由

- 目标：让已有 outbox/cancellation dispatcher 能驱动独立 Supervisor，而不破坏本地 backend 已证明的
  `prepare -> durable ACK -> run` 顺序；同时把 crash-safe event spool 的 publication/ACK backpressure
  原样跨进程传输。
- 协议决策：新增 ADR-0017 与 capability `command.two_phase.v1`。execute/cancel 帧只做 side-effect-free
  prepare 并返回 `command.ack`；control plane 把 command/turn/session/outbox 事务提交为
  acknowledged/running 后才发送引用该 ACK message ID 的 `command.commit`。事务失败则 best-effort
  `command.release`，只释放未启动 preparation。`command.result` 引用 commit message ID，闭合表达 execute
  completion、explicit cancellation、cancellation completion 或 bounded safe failure。该协议不声称
  distributed exactly-once。
- Control plane：新增 `SupervisorCommandRouter`，每个 sandbox 只绑定当前 socket generation，并以
  commandId 隔离 bounded ACK/result waiter。错误阶段、identity/lease/fence/ACK/commit correlation 不匹配、
  unsolicited result、timeout 或 superseded connection 都 fail closed。Router 在 event 进入
  `DurableEventStore` 前验证 PostgreSQL 中的当前 connection generation，以及该 sandbox 对 session lease
  的真实持有关系；落库及可选通知成功后才回 cumulative `event.ack`。
- Remote backend：新增 `RemoteSupervisorExecutionBackend`，复用原 `OutboxDispatcher`、
  `CancellationDispatcher` 和 guarded `SessionLeaseCoordinator`。pre-ACK 网络失败仍可按 mailbox 策略重试；
  durable start 后的断线属于 ambiguous execution，session 被隔离且不会盲目 replay 工具。显式 user
  cancellation 和 lease-revoked failure 保持不同语义。
- Supervisor client：一个 `ws` connection 同时承载 registration、共享 heartbeat、多 session command、
  result 与 event ACK，不为 session 新建 thread/process/socket。Inbound frame 串行有界处理，但 commit
  启动的 runner 独立推进，避免等待 event ACK 时阻塞 socket reader。每个 session 同时最多一个 event
  ACK waiter，send buffer/payload/timeout 均有上限。连接丢失会 release 所有 uncommitted preparation，并
  `revokeAllAssignments()` 停止 committed runtime；`LocalSandboxSupervisor` 也新增 cancellation
  pre-start release。
- 可执行证据：4 个真实 loopback WebSocket + PostgreSQL tests 覆盖 ACK 到达但尚未 durable 时 runner=0、
  commit 前数据库已 acknowledged/running、两条 public event 均先落库后 ACK、durable transaction failure
  release 且从不启动 runner、远程 fenced cancellation 同时收敛 execute/cancel、以及共享 lease channel
  关闭后 runtime 收到 `lease_revoked` 并使 session failed。3 个 router negative tests 另证实旧 capability
  不会收到两阶段 command、仅 commandId 相同但 fence 错误的 ACK 被拒绝、伪造 sandbox lease 的 event
  不会进入 durable ingestor。
- 测试隔离：新增的真实数据库/socket suite 使默认 worker 数同时启动过多 PGlite socket server，暴露
  `unnamed prepared statement` 与 90ms lease timing 的跨 server 干扰。control-plane Vitest 因此固定最多
  4 个 workers；三次完整 control-plane 复跑均为 50 passed/1 Docker-only skipped，同时仍保留文件并行。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、194 passed/4
  skipped tests、两个 zero-token Pi spikes 和 0 vulnerabilities。相同 50-test control-plane suite 又在
  一次性、仅绑定 `127.0.0.1` 的 PostgreSQL `15.2-alpine` 上通过 50 passed/1 Docker-only skipped；结束后
  database container 与 managed sandbox containers 均为 0。
- 当前边界：router 只服务持有本地 socket 的 control-plane instance；PostgreSQL 会拒绝跨 replica stale
  socket，但尚未提供跨实例 command broker。Client 仍是单连接生命周期，没有 production automatic
  reconnect/backoff；新 connection generation 需要重建 guarded coordinator/backend。生产 `main.ts` 仍未
  接入真实 provisioner/mTLS credential、owner-process handle 或 dispatcher ownership。durable ACK 后、
  commit 前若 control-plane 进程崩溃，会安全失败并交给 reconciliation，不会自动重放。
- 下一步：实现 production reconnect/backend reconstruction 与 cross-instance dispatch ownership。原因是
  单连接内的执行安全和 event durability 已闭环，下一项真实可用性风险已变成“socket owner 实例退出后谁
  接管”，而不是消息 schema 或 Pi loop 本身。

## 2026-07-19 — Supervisor 自动重连与 connection generation 恢复

- 目标：让短暂网络故障不再要求人工重启 Supervisor，同时不把“连接恢复”错误地实现成“重放可能已经
  产生副作用的 command”。后者会破坏两阶段协议的安全边界。
- 决策：新增 ADR-0018。原 `SupervisorWebSocketClient` 保持一次性、单 generation；新的
  `ReconnectingSupervisorWebSocketClient` 为每次尝试创建全新 client，使用有上限、equal-jitter 的指数
  backoff。网络/heartbeat/overload/server failure 可重试；鉴权、协议、normal close 与 superseded identity
  为 terminal，防止两个相同 identity 的进程互相抢占连接。
- 旧 runtime 排空：任何断线仍先 `revokeAllAssignments()`。重连 loop 随后必须等待
  `LocalSandboxSupervisor.waitUntilAssignmentsSettled()`，且等待有 deadline；旧 Pi/tool 未确认退出时不会
  打开下一条 socket。超时 fail closed，交给 owner-stop/reconciliation，而不是仅依赖更高 fencing token
  就并发启动新 writer。
- drain 原子性：`supervisor.register` 新增 required `acceptingAssignments`，manager 在创建 generation 的
  同一个 transaction 中持久化它。Supervisor 在每次注册前继承 operator 当前设置，避免原本“注册默认
  true、第一次 heartbeat 再改 false”的短暂误接单窗口。
- generation-aware backend：`RemoteSupervisorExecutionBackend` 可接收 coordinator provider，每条
  execute/cancel 开始时解析一次当前 connection guard，并在该 exchange 内固定使用。Gateway 暴露
  `createRemoteExecutionBackend()` 组装该边界；旧 generation 的 coordinator 明确失败，而断线前创建的
  backend 可以为断线后的新 command 使用新 generation。正在执行的 committed command 仍按 ambiguous
  failure 处理，绝不迁移或 replay。
- 可执行证据：4 个 reconnect 单元测试覆盖 assignment 排空门、drain state 跨 generation、鉴权失败不
  重试、stop 中断 backoff 与 teardown timeout fail-closed。真实 loopback WebSocket + PostgreSQL 测试会
  强制 terminate socket，验证旧 connection 变成 `superseded/reconnected`、新 connection ID 生效、旧
  coordinator 被拒绝，并由断线前创建的 dynamic backend 完成一条含 durable events 的两阶段 command。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、201 passed/4
  skipped tests、两个 zero-token Pi spikes 和 0 vulnerabilities。相同 control-plane suite 又在一次性、
  仅绑定 `127.0.0.1` 的 PostgreSQL `15.2-alpine` 上通过 51 passed/1 Docker-only skipped；结束后 database
  container 与 managed sandbox containers 均为 0。
- 当前边界：自动重连只恢复未来 command capacity，不恢复 in-flight Pi/tool execution。Router 仍属于
  持有 socket 的单个 control-plane process；另一个 replica 尚不能把 outbox claim 转发给该 owner。
- 下一步：实现 cross-instance command ownership/forwarding。原因是 Supervisor 自身已经能跨网络抖动
  恢复，剩余的高可用缺口是“dispatcher 和 socket 位于不同 control-plane replica 时如何安全会合”。

## 2026-07-19 — 跨 control-plane command claim ownership

- 目标：避免 dispatcher 从共享 PostgreSQL outbox 领取一条只能由另一 control-plane 进程内 WebSocket
  发送的 command，同时判断是否真的需要再引入 Redis/Kafka 或第二套 durable command relay。
- 决策：新增 ADR-0019，选择 database claim affinity。execute 在 acquire lease 前尚未绑定 sandbox，任何
  拥有健康本地 Supervisor 的 replica 都可以领取；cancellation 已绑定目标 session lease，必须跟随该
  lease 到 exact sandbox 的当前 socket owner。现有 outbox、connection generation 和 `SKIP LOCKED` 已能
  提供排他性，因此当前拓扑不新增 broker 或 payload 中转表。
- Execute guard：`OutboxDispatcher` 可配置 exact sandbox/control-plane affinity。claim transaction 只有在
  sandbox 为 ready/leased、低于 capacity，且存在属于本实例的 active、unexpired、accepting connection 时
  才锁定 command。`SessionLeaseCoordinator.acquire()` 随后仍重复权威检查，覆盖 claim 与发送之间的 owner
  变化。wrong owner、drain 或 full capacity 只返回 idle，不增加 attempt/retry deadline。
- Cancellation guard：`CancellationDispatcher` 使用 target session lease、sandbox、active connection 与
  `control_plane_instance_id` 做关联。它要求 lease/connection 未过期，但故意忽略
  `accepting_assignments=false`，因为 drain 必须禁止新 execute、不能禁止终止已有 runtime。
- Gateway binding：`createRemoteDispatchBinding()` 一次返回 dynamic remote backend、该 generation 的
  lifecycle lease coordinator、connection ID 与经过验证的 affinity，减少调用方把 backend 和错误 owner
  组合在一起的机会。生产 attach/detach worker lifecycle 仍必须由真实 provisioner/owner adapter 接线。
- 可执行证据：一个真实双 Fastify listener、双 `control_plane_instance_id`、共享 PostgreSQL、同 boot
  Supervisor 测试先证明非 owner 对 execute 返回 idle/attempt=0，再由 A 完成第一轮；Supervisor 重连 B 后，
  A 对 follow-up 立即失去 claim 权，B 在 drain 时也不领取 execute，恢复 accepting 后开始第二轮。容量占满
  时另一 session 保持 attempt=0；随后再次 drain，A 不能领取 cancellation，而 B 仍能完成 fenced cancel。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、202 passed/4
  skipped tests、两个 zero-token Pi spikes 和 0 vulnerabilities。相同 control-plane suite 又在一次性、
  仅绑定 `127.0.0.1` 的 PostgreSQL `15.2-alpine` 上通过 52 passed/1 Docker-only skipped，双 owner affinity
  的 correlated `EXISTS`、row locks 与 owner handoff 均通过；结束后 database 与 managed sandbox containers
  均为 0。
- 当前边界：这里解决的是正确性归属，不是全局公平调度。当前单用户 v0 可为每个本地连接启动 bounded
  async polling lanes；多 tenant quota/fairness、跨 region scheduler 与生产自动 worker 生命周期仍是后续层。
- 下一步：实现 cross-replica live event notification。原因是 command claim 已能跟随 owner，但浏览器 SSE
  目前仍依赖进程内 event hub；写 event 的 replica 与承载浏览器连接的 replica 不同时，实时通知仍会延迟
  到客户端重连/轮询 durable history。

## 2026-07-19 — 跨 control-plane 的实时 SSE event notification

- 目标：让浏览器的 SSE 可以连在任意 control-plane replica，而 Supervisor socket owner 在另一 replica
  写入事件时仍能立即看到结果；同时不能把 PostgreSQL 外再造一份不可靠的 event log。
- 决策：新增 ADR-0020。`event.publish` 仍以 `session_events` 与 contiguous cursor 为唯一真相；同一个 ingest
  transaction 在 cursor 前进后调用 `pg_notify`，payload 只有 version、tenant UUID、session UUID 与 durable
  high-water sequence，不包含 prompt、模型输出、tool 参数、credential 或 checkpoint bytes。rollback 不会发出
  notification，commit 与 hint 的可见性由 PostgreSQL 对齐。
- Replica transport：production `main.ts` 从 `DATABASE_URL` 为每个 control-plane process 创建一条独立于
  Kysely pool 的 `LISTEN` connection。初次连接失败会阻止应用启动；运行后断线使用 bounded equal-jitter
  backoff 自动重连。notification 做完整 schema/UUID/sequence 校验并按 configured tenant 过滤；重连成功会
  唤醒本进程全部 SSE subscription 做 durable rescan。应用关闭会中断 backoff 并关闭 dedicated client。
- Hub/SSE：process-local hub 不再缓存完整 `AgentDockEvent[]`。每个 subscriber 只保留一个可合并 high-water
  wake；duplicate/out-of-order hint 取最大 sequence，resync wake 强制查当前 cursor。SSE 仍先 subscribe 再读
  initial replay window，之后每个 wake 都从 PostgreSQL 分页补连续 suffix，并显式拒绝 durable gap。idle
  heartbeat 也先检查 durable cursor，所以 listener 暂时离线或丢 hint 最多增加一个 heartbeat interval 的延迟，
  不会丢 history；browser reconnect 仍以 `Last-Event-ID` 为准。
- 可执行证据：PGlite socket 当前能接受 `LISTEN/pg_notify` SQL、但不会转发 notification frame，因此默认
  测试不伪造该能力；它仍证明无 notification 的第二 replica 可在 25ms test heartbeat 中补读事件。真实
  localhost PostgreSQL `15.2-alpine` 另外证明 transaction rollback 零通知、commit 后通知、foreign tenant
  丢弃、`pg_terminate_backend` 强制断开后的 listener reconnect，以及 A 持久化/B 持有 SSE 时即使插入一个
  duplicate hint 仍只收到 durable sequence `1,2`。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、204 passed/6
  conditional skipped tests、两个 zero-model-call Pi spikes 和 0 vulnerabilities。完整 control-plane suite 又在
  一次性、仅绑定 `127.0.0.1` 的 PostgreSQL `15.2-alpine` 上通过 56 passed/1 Docker-only skipped；其中
  transaction rollback/commit、tenant filter、listener reconnect、cross-replica SSE 与既有 lease/WebSocket/
  checkpoint 路径共同通过。两条路径都不调用真实模型，不消耗 subscription/API token；临时 database
  container 在测试后自动删除。
- 当前边界：每个 control-plane replica 额外占用一条 PostgreSQL connection；每个 idle SSE heartbeat 会做
  一次 cursor recovery query。当前单租户阶段优先保证简单、可解释的正确性；达到大规模并发后应测量并考虑
  process-level batch cursor polling 或 broker，而不是现在提前复制 event payload/offset 协议。
- 下一步：实现 S3-compatible checkpoint object store，并用 localhost MinIO 做跨宿主恢复测试。原因是
  command owner 与 browser event 已能跨 control-plane replica，但 Pi JSONL/workspace checkpoint 仍写在开发
  机本地目录；Supervisor 移到另一宿主机时读不到 settled state，这才是下一项阻止真正云化的边界。

## 2026-07-19 — S3-compatible settled checkpoint 与跨宿主恢复

- 目标：让 settled Pi JSONL/workspace bytes 脱离某台 Supervisor 的本地目录，同时保留 ADR-0011 已证明的
  checkpoint-before-terminal、lease/fence、revision CAS 和 durable `turn.completed` commit marker。
- 决策：新增 ADR-0021。PostgreSQL 继续保存 provider-neutral logical key、byte length、SHA-256 和两个
  authoritative pointer；bucket、endpoint、prefix 与 credential 只属于部署配置，不写进数据库、public event、
  SSE、Docker args/env、sandbox 或日志。因此无需 migration，也没有第二套 recovery protocol。
- 写入：新增 `S3CheckpointObjectStore`，对最多 2 MiB 的 object 使用 single-part `PutObject`、
  `If-None-Match: *`、精确 `Content-Length` 与预计算 SHA-256。`412` 表示 fresh key 已存在并 fail closed；并发
  `409` 可重试。不会因 UUID “大概率不碰撞”就允许覆盖。
- 读取：请求 checksum metadata，同时检查 declared length 和实际 stream 的 hard limit；超限立即断流并安全吸收
  Node stream 的异步 error。若 S3 checksum 不符先拒绝；即使远端对象被合法覆盖、checksum 随之更新，
  `PostgresSandboxCheckpointStore` 仍用独立数据库 hash 检出 `checkpoint_corrupt`。
- 配置/安全：bucket、region、endpoint、prefix、boolean 和 retry 数均 fail-fast 校验；custom endpoint 默认
  path-style，明文 HTTP 必须显式 opt-in。SDK/network failure 映射成 closed safe error，不返回 endpoint、key、
  access/secret/session token 或原始 SDK message。生产 factory 不新增 AgentDock secret channel，凭据继续走 AWS
  SDK 标准 provider chain。
- 可执行证据：`npm run object-store:check` 使用 digest-pinned、仅绑定 `127.0.0.1`、无 volume 的一次性 MinIO。
  独立 writer 写入并销毁后，fresh reader 仅凭相同 PostgreSQL metadata 与 S3 namespace 恢复完整 Pi/workspace；
  同 key 替换被拒绝，raw overwrite 被数据库 hash 检出，2 MiB + 1 byte object 被拒绝。测试完成会按精确
  container name 清理。该旧式 fixture 只证明 S3 API compatibility，不是 production MinIO 推荐。
- 自动验证：完整 `npm run ci` 通过 format、production Web build、全仓 typecheck、209 passed/7
  conditional skipped tests、两个 zero-model-call Pi spikes 和 0 vulnerabilities。重构后的
  `npm run object-store:check` 又独立通过 file/S3 两个 checkpoint tests，MinIO 容器随后删除；所有路径都不
  调用真实模型，不消耗 subscription/API token。
- 当前边界：demo 仍故意使用 ephemeral PGlite + private file store；`main.ts` 仍是 HTTP/SSE entry point，不会
  静默启动 Docker worker。bucket provisioning、IAM、encryption、lifecycle/GC、replication 与 credential rotation
  都是明确的部署职责；成功 supersede 的旧 checkpoint 尚未做 lifecycle GC。
- 下一步：把 production provisioner/owner adapter、Supervisor gateway、retirement/maintenance loop、
  execute/cancel dispatcher 和 S3 checkpoint factory 组合成一个显式 runtime process。原因是各个 durability
  算法已分别跨 socket、replica、container 和 object store 通过，但当前部署 `main.ts` 仍只会接受请求，不会
  自动消费 outbox；先完成真实 composition，才能做端到端重启/扩缩容验收，而不是继续增加孤立组件。

## 2026-07-19 — Remote control-plane 自动 worker composition

- 目标：消除“HTTP 已接受并持久化 command，但生产形态没有任何组件自动消费 outbox”的断层；同时不能为每个
  session 创建进程、线程、socket 或 timer，也不能用 socket close 冒充 Supervisor 进程已经消失。
- 决策：新增 ADR-0022 与 `RemoteControlPlaneRuntime`。组合根只创建一份 `SessionEventHub` 和
  `DurableEventStore`，同时注入 REST/SSE 与 `SupervisorCommandRouter`；因此 remote event 的 PostgreSQL commit、
  cumulative ACK、进程内 wake 和跨 replica notification 不会出现两套 event authority。
- Worker：`RemoteSupervisorWorkerRuntime` 每个 control-plane process 只有一个 connection-discovery loop 和一个
  maintenance loop。每条当前本地 Supervisor binding 按
  `min(maxConcurrentSessions, configuredLaneCap)` 创建 promise-based execute lane，并创建同数目的独立 cancel
  lane；每条 lane 串行等待一次 `dispatchNext()`，不会用重叠 `setInterval` 放大并发。冷 session 数量为一百万
  也不会增加 lane。
- Generation 与停机：binding 保留 sandbox、connection generation、PostgreSQL owner affinity 和 guarded lease
  coordinator。disconnect/capacity generation 变化会排空旧 lane；shutdown 先 abort discovery，且明确丢弃 abort
  后才返回的 discovery snapshot，再拒绝新 upgrade、detach command transport、等待 dispatcher 按既有 ambiguous
  failure 规则收敛，最后关闭 Nest。重复 `close()` 返回同一 teardown promise。
- 安全观察：worker observation 只允许 component、safe code/retryable、sandbox/connection ID、lane/count/status，
  observer 自身抛错不会破坏 correctness loop；原始异常、prompt、模型输出、tool 参数、token、URL、object key 和
  credential 都不会进入该边界。
- 可执行证据：真实 Fastify/Nest + WebSocket Supervisor + PostgreSQL composition test 在无需手写 dispatcher 的
  情况下自动完成第一轮；第二轮 execute 持续运行时，独立 cancellation lane 仍完成 fenced cancel，maintenance
  计数继续增长；容量 3 被配置 cap 限制为 2 execute + 2 cancel lanes；第三轮运行中调用两次 `close()` 会关闭
  socket、撤销 runtime、把 ambiguous turn 收敛为 failed，并停止全部 binding。另有 failure test 证明 discovery/
  maintenance 不重叠、raw secret 不泄漏、observer failure 被隔离，以及 drain 后晚到的 discovery 结果不会再起 lane。
- 测试说明：该 composition test 将 Kysely pool 固定为 1，因为 PGlite socket adapter 在同一 embedded engine 上的
  多连接 extended-query 并发会偶发破坏 unnamed prepared statement；异步 lane 仍真实并发，数据库请求由 test
  adapter 串行化。设置 `AGENT_DOCK_TEST_DATABASE_URL` 时，同一文件改用真实连接池，不采用这个限制。
- 真实数据库复核：同一套 3 个 runtime tests 在一次性、仅绑定 `127.0.0.1` 的 PostgreSQL `15.2-alpine` 和
  8-connection pool 上全部通过；自动 execute/cancel/maintenance/drain 用例约 0.6 秒。测试 container 随后删除，
  Docker container 数回到 0。
- 自动验证：完整 `npm run ci` 通过 formatting、production Web build、全仓 typecheck、213 passed/7
  conditional skipped tests、两个 zero-model-call Pi spikes 和 high-level security audit（0 vulnerabilities）。
  control-plane 的 63 passed/4 skipped 同时覆盖新 runtime 与既有 mailbox、lease/fence、WebSocket generation、
  checkpoint、SSE 和 cancellation 语义。
- 当前边界：这是可复用且端到端可执行的 control-plane library composition，不是完整生产部署。
  `main.ts` 仍保持 HTTP/SSE-only，直到真实 provisioner/mTLS authorizer、exact boot owner-stop、assignment inventory
  和 Supervisor host/S3 factory 到位；这里没有添加危险的 no-op owner，也没有让 S3 credential 进入 HTTP 进程。
- 下一步：实现可信 Supervisor host composition 与 production owner/provisioner adapter。原因是 control plane 已经
  能自动调度并正确停机，下一项阻止“打开 Web 就能安全使用 Pi”的边界是：谁创建/停止 exact Supervisor boot、
  谁提供 assignment inventory，以及 checkpoint S3 credential 如何只留在可信 host。

## 2026-07-19 — 可完整部署的单机生产拓扑

- 目标：把已经分别通过测试的 remote control-plane、Supervisor WebSocket、Docker runner、PostgreSQL 和
  S3 checkpoint 组合成一套别人可以从 clean checkout 部署、重启、扩缩容、恢复和排障的真实拓扑，同时严格
  限定产品声明：当前只支持 single-user、deterministic Java repair/follow-up fixture，不冒充通用 coding-agent
  SaaS、任意仓库/extension 或 real-provider 平台。
- 架构决策：新增 ADR-0023，固定可信 `@agent-dock/supervisor-host`、每进程 fresh boot/sandbox/connection
  credential、fsynced boot ledger、authenticated provisioning/owner/inventory、S3 checkpoint、显式 readiness 与
  单宿主 Docker Compose 边界。Docker socket 只进入 root-equivalent trusted host；control plane 和 Pi worker 都
  不接触它。每个 active turn 才创建一次性 worker，cold session 仍没有专属进程、thread、socket 或 timer。
- 生产 control plane：`main.ts` 现在只在完整 fail-fast 配置下启动 remote runtime。public `/v1` 使用独立
  file-backed bearer；Supervisor enrollment、management 与 per-boot WebSocket credential 完全分离。per-boot
  secret 只在 host 内存中出现，PostgreSQL 只保存 digest；provision request 不能扩大 supervisor identity 或
  capacity。owner/inventory URL 固定，拒绝 redirect/动态 URL，assignment 操作还会再次验证 sandbox 必须存在于
  本机 ledger，且 supervisor/boot 必须精确匹配后才允许检查 Docker。
- 可信 host：新增独立 executable，把 Docker runner、LocalSandboxSupervisor、PostgreSQL checkpoint metadata、
  S3 object store、per-boot active/quarantine spool、reconnect client、boot ledger 和 private management endpoint
  组合起来。网络 reconnect 保持同一 boot，进程 restart 必须产生新 boot；readiness 只有在 Docker/DB/S3、
  provisioning、spool recovery 和当前 WebSocket 全部就绪时才为 true。
- 部署物：新增 digest-pinned control-plane/Supervisor/Web images、non-root read-only Caddy ingress 和
  `deploy/production/compose.yaml`。拓扑包含持久 PostgreSQL/MinIO/boot/spool 四个 volume、幂等 migration/bootstrap
  jobs、五个隔离 network、read-only roots、cap drop、`no-new-privileges`、bounded tmpfs/CPU/memory/PID/logs 与
  health checks；只有 Web 默认发布 `127.0.0.1:8080`。脚本提供 `production:init/config/build/up/deploy/ps/logs/
  down/token/check`，partial runtime 拒绝覆盖，现有完整 runtime 保持 idempotent。
- 宿主 UID 与 object-store 最小权限：application containers 不再假设宿主 operator 一定是 UID 1000，而是使用
  四个 mounted application secret 的共同非 root owner；root 初始化会安全分配给 `1000:1000`，混合/root owner
  在 Compose 前失败。MinIO root 只留在 storage/bootstrap boundary；Supervisor 使用单独随机 application
  identity，policy 只允许 checkpoint bucket location/list 与 object get/put，不允许 delete。旧 runtime 若仍把
  root 写进 `aws-credentials`，`production:init` 会原子迁移并保持 public API token/稳定 IDs 不变。
- reconnect 验收发现的真实协议缺口：control-plane 在 committed command 中断后按 ADR-0018 正确记录
  `connection_closed` ambiguous failure 并释放 lease，但 Supervisor 随后产生的本地撤销终态 event 仍在旧 fence
  下。旧协议只能 close socket 表示拒绝，导致同一健康 host 无限恢复并最终退出。先新增 ADR-0024，再加入精确、
  non-retryable `event.rejected(stale_fence)`；current socket 保持连接，client 只接受与 pending publication 完全
  匹配的 rejection，file spool 原子移动整个剩余 assignment 到独立 per-boot quarantine，并 fsync checksummed
  `rejection.json`，不伪造 ACK、不删除原 event。partial replay 后的 quarantine count 也按真实剩余文件计算。
- 可执行生产验收：`npm run production:check` 每次创建随机 project/port/runtime/secrets/volumes，构建四个镜像并
  启动真实 PostgreSQL、MinIO、control plane、Supervisor host、Caddy 和 networkless Pi worker。它验证 auth/
  internal route/host port、secret permission 与非 root UID、bootstrap 二次执行、MinIO no-delete policy、Java repair、
  control-plane restart 后 same-process/same-boot reconnect、旧 command durable ambiguous failure、exact spool
  quarantine、新 session 恢复执行、control plane `1 -> 2 -> 1`、follow-up 从 S3 恢复、Supervisor restart 后 fresh
  boot/old credential revocation/retirement、再次 S3 restore、active worker cancellation/absence、worker 无 bind/network/
  deployment secret、22 条连续 durable SSE replay，以及最终零 managed worker。结束只删除自己的 exact 随机资源。
- 失败驱动修正：第一次完整构建发现 pinned MinIO 镜像没有 `sed`，bootstrap 改用纯 POSIX shell built-in `read`，
  没有向镜像增加包；第二次发现验收器用 running-only `compose ps` 检查已成功退出的 bootstrap container，改为
  `--all`。随后 cached iteration 和默认 full-build 两条路径均输出 `production_check_passed`；最终 full-build run
  使用 `projectName=agent-dock-check-3eab0b077e`，完成 22 events 后自动删除全部临时 container/network/volume/runtime。
- 文档与 CI：新增 `docs/PRODUCTION_DEPLOYMENT.md`，记录 first deploy、拓扑、信任边界、TLS/remote exposure、
  routine ops、health/alerts、备份恢复、升级回滚、credential rotation、故障语义和验收命令；README、architecture、
  roadmap、backlog 与 ADR-0023 同步当前事实。GitHub Actions 新增独立 45 分钟 disposable production topology job。
- 最终验证：`npm run ci` 完整通过 production Web build、所有 workspace typecheck、235 passed/7 conditional skipped
  tests、两个 zero-model-call Pi spikes 与 `npm audit --audit-level=high`（0 vulnerabilities）。默认
  `npm run production:check` 随后再次从 image build 开始全程通过。所有测试不调用真实 provider，不消耗 API/
  subscription token。
- 当前边界：这已经是当前 deterministic slice 的完整 self-hosted production deployment，不是 Internet-ready 或
  multi-tenant release。直接远程访问仍必须在外层加入 TLS、firewall/identity-aware access，并保持 SSE 代理语义；
  Kubernetes、generic repository import、policy-approved extension、request-scoped real-model gateway、steer、metrics/
  alerting backend 与自动 quarantine/checkpoint GC 仍属于后续独立里程碑。
- 下一步（不属于本里程碑）：优先实现 generic repository import + request-scoped model gateway，而不是继续给
  deterministic fixture 堆功能。原因是部署与 runtime correctness 已有可执行证据，下一项决定它能否成为真正可用
  coding agent 产品的瓶颈已经变成“用户代码和模型凭据如何安全进入”，不是 agent loop 或进程数量。

## 2026-07-19 — 私有多租户 identity、quota 与全局公平调度

- 目标：在不开放公网注册、不引入 OIDC/计费、也不复制一套 Supervisor 的前提下，让同一单机部署真正服务多个
  私有 tenant。不能只给表加 `tenant_id`：HTTP auth、SSE、进程内 wake、后台 claim、checkpoint 与 Web token
  切换都必须使用同一个可信 tenant authority。
- 决策：新增 ADR-0025。API token 采用 `adk_<credential UUID>.<random secret>`，数据库只保存 SHA-256；旧生产
  token 通过 bounded digest lookup 原样迁移。credential 精确绑定 tenant-local user 与 `owner/member/viewer`，
  tenant 创建、发证、列表与撤销只允许可信宿主运行 offline CLI，不新增 platform-admin HTTP bearer。
- 请求隔离：Fastify 在进入 Nest controller 前解析 bearer 并把只读 identity 绑定到 request；controller 按该
  identity 临时构造 tenant store。`GET /v1/identity` 只返回 slug/display name/role。已知的 foreign project、
  session、turn、cancellation 与 SSE UUID 和不存在 UUID 一样返回 `404`，客户端不能用 header/body 选择 tenant。
- Admission：新增 `tenant_runtime_policies`，在创建 project/session/turn 的同一 transaction 内锁 policy 并检查
  project、session、unsettled-turn 上限；同一 idempotency key 的已接受 replay 在 quota 前返回。稳定过载结果为
  `429 tenant_quota_exceeded`。禁用 intake 不会使安全取消失效。
- 调度：execute worker 不再保存 process-wide tenant。global claim 锁 policy，排除 disabled/并发饱和 tenant，先按
  least-recently-served cursor，再按既有 mailbox/outbox 顺序；cursor 在同一 transaction 单调前进。并发 lane
  共享 per-tenant active-turn 上限。cancel claim 故意不参加普通 fairness/quota，并从 durable cancellation command
  读取 tenant，避免 active work 因停用或拥塞无法终止。
- 事件与对象：`DurableEventStore` 从已锁 durable session/command 推导 tenant；PostgreSQL listener 接收全部合法
  tenant high-water hint，进程内 hub 用 `(tenantId, sessionId)` 分区，SSE replay 每次查询仍带认证 tenant。
  checkpoint key 已有的 `checkpoints/<tenant>/<session>/<turn>/...` 前缀继续作为不可变对象边界。
- Web：生产登录卡先调用 `/v1/identity`，成功后显示 tenant/user/role；token 只留在 React 内存，不再写
  `sessionStorage`。logout/token 变化会清空 session、cursor 与 stream，viewer composer/new-session/cancel 控件禁用。
- 生产配置：常驻 control-plane 不再读取 tenant/user/default-profile，也不挂载 `api-token`。只有一次性的
  database bootstrap/admin 容器读取初始 token；新 runtime 生成 indexed token 与独立 credential ID，旧 runtime
  继续用原 token/IDs。bootstrap 尊重已经撤销的初始 credential，不会在升级时重新启用。
- 仓库门禁：完整 `npm run ci` 通过 production Web build、所有 workspace typecheck、251 passed/7 conditional
  skipped tests、两个 zero-model-call Pi compatibility/rehydration spikes，以及 `npm audit --audit-level=high`
  （0 vulnerabilities）。其中双 tenant REST/SSE foreign probe、role、quota、global fairness、并发上限、disabled-policy
  cancellation 和真实 remote Supervisor 自动执行/取消都进入自动测试，不依赖手工判断。
- Docker 验收：fresh disposable topology 创建第二 tenant 和 viewer，两边分别执行真实 Java repair，验证同名 project
  可并存、foreign project/session/turn/cancellation/SSE UUID 全部不可枚举、两个租户各有 10 条连续事件和两个
  tenant-prefixed S3 checkpoint object。常驻 control plane 的 env/mount inspection 证明它没有 tenant、default-profile
  或 API token。same-boot reconnect、stale-fence quarantine、`1 -> 2 -> 1`、fresh Supervisor boot、checkpoint restore 和
  active cancellation 全部通过，最终输出 `production_check_passed`（project `agent-dock-check-4dd5955455`，22 durable
  events）并只清理自己的随机资源。第一次 run 暴露验收器把“整个 boot 的 active spool 为空”当作单租户事实；双租户
  完成态本来就会保留 ACK manifest，因此修成只断言被拒绝的 exact assignment 已原子移入 quarantine，再从头通过。
- 现有部署升级：默认 `agent-dock-production` 在保留原 PostgreSQL/MinIO volumes、稳定 tenant/user ID 和既有 API token
  的情况下运行 `production:deploy` 成功。五个常驻 service 全部 healthy，旧 token 经 `/v1/identity` 解析为原
  `agent-dock` owner；offline `production:tenant -- list --tenant agent-dock` 能读取无 secret 的 credential metadata。
  `docker inspect` 再次确认常驻 control plane 只挂载 database、Supervisor enrollment/management 三个 secret。
- 当前边界与下一步：这个里程碑已经是可完整部署的私有、单宿主、多租户 deterministic AgentDock，不是公网 SaaS。
  public signup/OIDC、计费/滥用控制、跨宿主 mTLS、generic repository、request-scoped real-model gateway、extension
  policy、warm-pool cost accounting 和可观测性仍未宣称完成。若继续产品能力，优先做 generic repository import +
  request-scoped model gateway；原因是多租户 runtime correctness 已有真实部署证据，当前可用性的主要瓶颈已经是
  安全接入用户代码和模型凭据。

## 2026-07-19 — 可选公开注册与租户会话发现

- 目标：让使用者无需宿主 CLI 就能创建两个独立 tenant，从浏览器直接验证多租户边界；同时补上刷新后找不到历史
  session 的产品缺口。这里的“公开”只表示一个可选的匿名 HTTP admission，不扩大当前 loopback、单宿主、
  deterministic fixture 的生产声明。
- 决策：新增 ADR-0026。生产网关只对精确的 `POST /v1/registrations` 放行匿名请求，并且默认关闭；GET、子路径和
  其余 `/v1` 仍必须 bearer auth。注册请求只接受规范化 slug 与安全 UTF-8 display name，一个 PostgreSQL
  transaction 原子创建 tenant、owner、fake-model binding/profile、runtime policy 和 indexed owner token。明文
  token 只返回一次，数据库仍只保存 SHA-256 digest。
- 有界 admission：配置提供 total tenant cap 以及每个 self-service tenant 的 project/session/unsettled/concurrent
  quotas。注册 transaction 先锁稳定的第一个 tenant row，再计数并插入；因此并发请求也不能越过 cap。duplicate
  slug 返回 `409 tenant_slug_unavailable`，容量耗尽返回 `429 registration_capacity_reached`，失败路径不返回 UUID/
  token，也不留下 partial rows。offline admin 仍是独立可信边界。
- 会话发现：新增 tenant-scoped `GET /v1/conversations` 和 `GET /v1/conversations/:sessionId`。列表按 durable
  `last_active_at` 返回最新 100 个 session；详情返回 project/session 与最新 200 个 prompt turn。截断时同时返回
  `historyTruncated` 和对应 durable SSE replay boundary，避免 Web 把被省略的旧 event 插到错误位置。所有 SQL 从
  authenticated store 获得 tenant；已知 foreign session 与不存在 session 一样为 `404`。
- Web：登录卡加入 `use token/create tenant` 两种入口。注册成功后先用一次性 token 调 `/v1/identity` 验证，再切换
  security context；token 只在 React memory 和可 dismiss 的一次性提示中出现。侧栏加载当前 tenant 的会话列表，
  选择会话后先恢复 prompt metadata，再从服务器给出的 cursor 续接 SSE。注册、换 token、logout 都先清空旧
  transcript/list/cursor/operation/stream；viewer 可以读列表/详情但不能写。
- 配置与运维：Compose 和 `production:init` 支持 `AGENT_DOCK_PUBLIC_REGISTRATION_ENABLED`、total cap 与四项
  tenant quota。新 runtime 会校验并持久化首次设置；旧 runtime 可只修改私有 `.env` 后 idempotent deploy。运行手册
  明确说明没有 password/OIDC/recovery/CAPTCHA/rate-limit/billing，也不允许据此把 plain-HTTP loopback ingress 直接
  暴露公网。
- 自动测试：新增 protocol parsing、gateway exact-route、原子注册、digest-only persistence、invalid/duplicate/
  capacity、owner/viewer role、双 tenant list/detail/SSE isolation、Web API/reducer/security-context 测试。新增 PGlite
  integration 后，四个重型 PGlite/WebSocket 文件并行曾分别触发两个不可重复的时序超时；失败用例单独均通过，
  将 control-plane suite 从 4 workers 降为 2 后整包稳定通过，业务断言未放宽。
- 真实生产验收：默认 full-build run `agent-dock-check-d0fb9502cc` 和初始化修正后的 cached-image run
  `agent-dock-check-d9b3f6389d` 均输出 `production_check_passed`。每次都在真实 PostgreSQL 下以 total cap 3 证明两个
  并发注册恰好一个 `201`、一个 `429`，并验证 owner/viewer conversation reads、foreign detail/SSE `404`、两租户
  checkpoint、same-boot reconnect、`1 -> 2 -> 1`、fresh boot、cancellation、22 条连续 event、secret scan 和精确清理。
- 仓库门禁：最终 `npm run ci` 完整通过 production Web build、所有 workspace typecheck、260 passed/7 conditional
  skipped tests、两个 zero-model-call Pi spikes 和 `npm audit --audit-level=high`（0 vulnerabilities）。
- 当前部署：保留原 PostgreSQL/MinIO/boot/spool volumes、stable tenant/user/token，把
  `agent-dock-production` 的 registration 开关设为 true、total cap 32 后重新部署；五个常驻 service healthy，仍只发布
  `127.0.0.1:8080`。无污染探针得到 health `200`、同 slug registration `409`、匿名 conversation list `401`，旧 token
  仍解析为原 `agent-dock` owner 且只看到本 tenant 的列表。
- 当前边界：用户现在可以用两个无痕/独立浏览器 context 自助创建 tenant 并验证互不可见，但丢失一次性 token 仍需
  operator offline 发新 credential。真正面向公网前仍需独立的人类 identity/recovery、edge TLS、rate limiting、
  abuse/billing、审计与 hostile-tenant sandbox threat model。

## 2026-07-19 — 租户级真实模型凭据与 brokered Pi coding-agent

- 目标与原因：完成“每个租户安全配置真实模型”和“用真正的 Pi coding agent 替代 deterministic worker”两项能力，
  但不把可复用 provider key 交给 Pi/bash，也不让真实模型测试污染日常 zero-token CI。
- 决策：新增 ADR-0027。Web/API 只接受固定的 DeepSeek provider 和 allowlisted model；任意角色可读安全元数据，只有
  owner 可替换。凭据用 AES-256-GCM 加密，AAD 绑定 tenant/binding/version/provider/key-version；相同 key/model
  重试不增版本，轮换创建 immutable version，已经接受的 turn 仍使用它自己的精确 snapshot。
- 执行边界：Supervisor 按 snapshot 解密 key，生成随机、限时、限请求次数且绑定 turn/model 的 capability。真实
  worker 只加入 Compose internal `model-runtime` network，Pi 把 capability 当临时 API key 调 Supervisor gateway；
  只有 Supervisor 加入 provider-egress。真实 key 不进入 Docker args/env/labels、stdin runtime message、Pi JSONL、
  workspace/checkpoint、event、Web 或日志。fake activation 继续使用 embedded server 和 `--network none`。
- Pi 行为：两条路径都运行 pinned Pi `0.80.10`、`bash`/`edit`、durable event ACK、settled Pi/workspace checkpoint、
  cancellation 和 bounded Git diff；差别只在 model runtime lease。gateway 固定 upstream、重写 auth、强制 streaming、
  限制 body/response/timeout，并把 provider usage 写入既有的 tenant/session/turn `usage_ledger`。当前只记 token，因没有
  versioned price table，`cost_amount` 保持 0。
- Web 与生产：owner 登录后可打开 model panel，选择 `deepseek-v4-flash` 或 `deepseek-v4-pro` 并提交 key；输入随后
  清空且不进 browser storage。生产初始化新增私有 `model-credential-master-key`，只挂载给 control plane/Supervisor；
  Compose 增加 internal model network 和 Supervisor-only provider egress。默认/新注册 tenant 仍是 zero-token fake。
- 自动证据：新增加密 tamper/wrong-key/AAD、双 tenant 隔离、role denial、内容幂等/轮换/旧 snapshot、HTTP 安全响应、
  capability revoke/wrong-model、usage SSE ledger、fake/real Docker network 和参数泄漏测试。完整 `npm run ci` 通过所有
  workspace build/typecheck/tests、两个 zero-model-call Pi spikes 与 high-level audit（0 vulnerabilities）。
- 真实消耗验收：保留现有生产 volumes/identity/token 重新构建并健康部署到 `127.0.0.1:8080`，把 bootstrap tenant
  配为 `deepseek-v4-flash` credential version 2。通过正常 REST durable intake 创建 turn，状态依次为
  `queued -> running -> completed`。Pi 实际调用 11 次工具（包含失败 `test.sh`、一次 `edit`、通过的复测），把
  `Calculator.add` 从减法改为加法，提交 407-byte non-truncated unified diff 和 settled checkpoint。gateway 收到 7 次
  provider model call，ledger 记录 input 2,274、output 909、cache-read 11,136、cache-write 0；这次测试确实消耗真实
  provider quota。运行中 Docker inspection 证明 worker 唯一 network 是 `agent-dock-production_model-runtime`，容器
  env 没有 provider key/capability，完成后临时容器被删除。
- 当前边界与下一步：现有 Web 已能向 cloud Pi 发真实请求，但 workspace 仍是 image-owned Java fixture，不是任意仓库。
  下一项产品瓶颈应是受控 repository import/workspace provisioning；原因是模型调用、agent loop、工具、持久化和
  多租户凭据边界已有端到端证据，而用户代码尚不能安全进入系统。

## 2026-07-19 — 受控 public GitHub workspace 与真实双轮 coding 验收

- 目标与原因：把上一里程碑的 image-owned Java fixture 扩展成真实用户代码入口，同时不让 Pi/bash 获得 GitHub
  网络、不让 control plane 接触 Docker/S3，也不把任意 URL 变成 SSRF 接口。这里选择“公开 GitHub + 精确 commit”
  的窄边界，而不是假装已经支持通用 Git hosting。
- 决策：新增 ADR-0028。公开 API 的 source 只有 `sample_java` 或 `github_public`；后者只接受规范化小写
  `owner/repository` 与小写 40-hex commit SHA，拒绝 URL、branch/tag/refspec、端口、查询串、认证、SSH、本地路径和
  多余字段。project、初始 workspace 与 `workspace_sources` 在同一个 tenant-scoped transaction 中创建；migration
  008 将旧 workspace 安全回填为 ready sample，schema 现在共 21 张表。
- Provisioning 数据流：第一个 turn 到达 trusted Supervisor 后查询 source；PostgreSQL 用 expiring lease 让一个
  importer 获胜，其余 activation 轮询 ready。过期 lease 可回收，旧 owner 在 lease 被替换后不能发布。一次性 Docker
  importer 使用非 root、read-only rootfs、无 bind mount/Docker socket/secret/port、bounded CPU/memory/PID/tmpfs，只
  加入 repository-egress；Git URL 由 worker 固定构造，redirect、hook、credential helper、interactive auth、file/ext
  protocol、submodule 与 LFS 全部关闭。clone 后验证 HEAD、删除 `.git`，再复用已有 canonical regular-file manifest。
- 网络事实边界：importer 不加入 database/object-storage/management/model-runtime/provider-egress。当前单宿主 Compose
  由 trusted Supervisor 锚定 repository-egress，因此 importer 在该 bridge 上能连到 Supervisor 容器的 HTTP surface；
  这些 privileged route 仍要求 importer 不具备的 management credential 或 turn capability。固定 GitHub URL 不是 DNS
  firewall；若未来宣称 hostile public tenants，仍需 DNS-aware egress proxy/独立网络 threat model。
- Immutable seed：manifest bytes 以 SHA-256 content address 写入 tenant/workspace-prefixed MinIO key；对象已存在时只在
  bytes 完全相同时复用。source ready metadata 与 `workspaces.object_snapshot_key` 在一个 lease-fenced transaction 发布。
  每次 activation 重新验证 object key、size、digest 和 manifest；Pi worker 通过 typed stdin 收到 seed，先建立 imported
  baseline commit，再 overlay 当前 session 的 settled checkpoint。因此第二轮不重新 clone，GitHub 暂时不可用也不影响
  已导入会话，cold session 仍不占常驻 Pi 进程。
- Pi/diff：worker 的 sample/GitHub 两条路径共用 pinned Pi、bash/edit、事件 ACK、取消和 checkpoint 流程。验收首次发现
  原 collector 的普通 `git diff` 会漏掉 agent 新建的 production source 与 `test.sh`；改为只对 `git ls-files
  --others --exclude-standard` 返回的 path 执行 intent-to-add，再生成 working-tree diff。回归测试同时覆盖 tracked edit、
  tracked delete、untracked new file 和空 cached diff，避免用 `git add -N --all` 意外吞掉删除。
- Web：Pi `/export` 风格页面新增 `new workspace` panel，可选择 sample 或 public GitHub exact commit；conversation detail
  只暴露 safe source kind/repository/commit/status。模型选择仍属于 tenant model panel，不与 workspace source 混在一起。
- 生产升级修正：既有 production tenant 已从 bootstrap fake profile 切换到 owner-configured DeepSeek。部署时旧 bootstrap
  校验错误地把这种合法状态当 drift；现在同时接受 immutable bootstrap identity 下的 allowlisted DeepSeek v2+ binding，
  仍拒绝 tenant/profile identity、thinking、disabled 或非 allowlist 模型变化。migration 008 与五个常驻 service 随后健康。
- 真实消耗验收：对 `mathewjonas/java-calculator-junit` 的 commit
  `0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb` 创建 workspace，并用现有 `deepseek-v4-flash` 连续执行两个 Pi turn。第一轮
  产生 434 events、22 次 tool start、4,302-byte cumulative patch；第二轮在同一 conversation 加入 `divideExact` 与除零
  防护，产生 320 events、7 次 tool start、5,660-byte cumulative patch。两轮都实际运行 portable JDK `test.sh`，patch
  同时包含新 `src/main/java/junit_project/Calculator.java` 和 `test.sh`。
- 真实模型账本：两轮共 18 次 provider call，持久化 input 6,032、output 5,829、cache-read 93,568、cache-write 0。第二轮
  source 的 status/object key/hash/size/updated_at 与第一轮逐字相同，证明没有重新导入；conversation 恢复到 ready source
  和两个 turns；运行中 Pi worker 只有 `agent-dock-production_model-runtime`，完成后没有 importer container 残留。
- 可重复 live gate：新增显式 opt-in 的
  `AGENT_DOCK_LIVE_GITHUB_CHECK=1 npm run production:github-check`。它默认使用上述 pinned tiny repo，也允许同时覆盖 repo/SHA；
  脚本会创建真实 project/session、消费 provider quota、断言两轮工具/patch/ledger/seed reuse/cleanup，因此故意不进入常规
  zero-token CI。
- 故障路径补强：最终 review 将 importer cleanup 从“任何 inspect error 都视为 absent”改为只接受 Docker 明确返回的
  `No such object/container`；daemon/permission/timeout 错误现在以 `repository_import_cleanup_unverified` fail closed。生产
  bootstrap 在允许 owner-configured DeepSeek profile 的同时，也验证其当前 v2+ binding 的 provider/kind/exact sealed
  ref/status 与对应密文行存在，避免“profile 看似合法、实际 secret 缺失”的不健康部署。Docker 29 实际使用小写
  `error: no such object`，matcher 改为大小写不敏感后，以 `octocat/hello-world` exact commit 做了一次 217-byte、zero-model
  smoke import，canonical manifest 验证通过且 importer cleanup 确认无残留；其他 Docker 错误仍不会降级为 absent。
- 最终仓库门禁：`npm run ci` 从 production Web build 开始完整通过所有 workspace typecheck、288 passed/7 conditional
  skipped tests、两个 zero-model-call Pi spikes 和 `npm audit --audit-level=high`（0 vulnerabilities）。首次全量 run 中一个旧
  remote-control-plane runtime test 在并发 PGlite 负载下超过 20 秒等待阈值；该文件隔离通过、control-plane 整包 91/91
  通过，第二次完整 CI 也原断言通过，因此没有放宽测试或修改生产调度逻辑。
- Disposable production gate：默认 full-build `npm run production:check` 以随机项目
  `agent-dock-check-dba675c049` 从当前源码重建四个镜像、应用 migration 008，随后证明 bootstrap 重跑、3-tenant admission
  与隔离、control-plane restart、`1 -> 2 -> 1`、fresh Supervisor boot、S3 follow-up restore、active worker cancel、22 条
  durable events、worker hardening/secret absence 和 exact cleanup，最终输出 `production_check_passed`。该 deterministic
  gate 没有调用真实 provider；GitHub/真实模型组合由前述 opt-in live gate 单独证明。
- 当前边界与下一步：现已支持小型 public GitHub exact commit，不支持 private repo、任意 host/URL、submodule、LFS、
  branch refresh、monorepo 超限、extension、PR/write-back。若继续增强简历项目，下一步优先做 extension policy + approval
  boundary，而不是立刻扩大 Git 来源；原因是“用户代码能导入并执行”已有端到端证据，接下来最能体现工程判断的是让
  project extension 的权限、secret、网络和人工审批变成可验证策略。

## 2026-07-20 — Trusted Pi Runner、Sandbox Manager 与无凭据 Tool Sandbox

- 目标与原因：把“Pi 与用户命令在同一个临时容器里”的旧边界拆成用户提出的官方推荐形态：Pi、对话状态和模型认证留在
  可信区，只有 `read/write/edit/bash` 进入隔离执行环境。这样用户命令即使读取全部 Sandbox 环境，也得不到 DeepSeek key、
  Model Gateway capability、数据库、MinIO、Supervisor enrollment credential 或 Docker socket。
- 架构决策：新增 ADR-0029。Control Plane 继续负责 tenant/session/turn/queue/database；非 root Supervisor 现在是稳定的
  Trusted Pi Runner；独立 Sandbox Manager 是唯一挂载 Docker socket 的服务；每个 active turn 创建一个 UID 1000、
  `network=none`、read-only rootfs、无 mount/port/credential 的 Tool Sandbox。冷会话只保留 PostgreSQL/MinIO checkpoint，
  不占 Pi 子进程、Sandbox、线程或计时器。
- Pi 集成：生产 Pi 显式使用 `--no-builtin-tools --no-extensions`，只加载一个镜像内固定 extension。extension 用 Pi 官方
  `createReadTool/createWriteTool/createEditTool/createBashTool` 接口，把工具调用通过带 service token 与单次 activation
  capability 的 HTTP RPC 发给 Manager；Pi 的 agent loop、`messages[]`、compact/session JSONL 和 Model Gateway 仍在可信
  Runner。`user_bash` 也走同一远程边界，传入 Pi 的环境变量不会被转发到 bash。
- 工具与状态：新增版本化、strict-schema 的 Tool Sandbox protocol，以及独立 `workspace-runtime` 包。Sandbox worker 支持
  bounded bash、取消/超时/进程组回收、read/write/edit 所需文件操作、workspace seed/restore、Git baseline、snapshot 和
  cumulative bounded diff。终态先 capture 再生成 diff，保证最后一次工具修改不会漏进 `turn.completed`。
- Manager 边界：Manager 只提供 create/operation/capture/stop/inventory 和受控 GitHub import；activation capability 只存
  SHA-256 digest，并拒绝 operation ID 重放。容器 identity 用完整 assignment labels 逐字段核对，所有 stop 都确认 absent；
  import cleanup 不再静默忽略。Runner 没有 Docker socket，Manager 没有 DB/S3/provider/enrollment credential，也不加入
  repository-egress；导入器只加入 repository-egress，普通 Tool Sandbox 永远无网络。
- 生产迁移：Compose 新增 `sandbox-manager`、`tool-sandbox-image` 与一次性 volume ownership bootstrap；Supervisor 镜像删除
  Docker CLI/socket 并固定非 root 用户。另一个无凭据、立即退出的 network bootstrap 只负责让 Compose 创建 importer 专用
  `repository-egress`，Manager 与 Runner 均不加入。旧 deployment version 与既有四个 volume 保持兼容，`production:init`
  幂等补发私有 manager token。生产健康检查先验证 Manager，再允许 Runner ready。
- 自动证据：protocol、Manager client/server 鉴权与 capability、Docker 参数、固定无凭据工具环境均有单元测试；真实 Docker
  integration 启动 Pi + Manager + Tool Sandbox，完成 bash → edit → bash Java 修复，并检查 Sandbox UID、`network=none`、
  read-only、无 mount、无敏感 env、终态 diff 和删除确认。完整 `npm run ci` 通过 production Web build、所有 workspace
  typecheck、297 passed/8 conditional skipped tests、两个 zero-token Pi spikes 和 high-level audit（0 vulnerabilities）。
- Disposable production gate：五个当前源码镜像完成重建后，最终门禁 `agent-dock-check-e8840586cc` 复用这些镜像，通过三租户
  隔离、control-plane restart 与 `1 -> 2 -> 1`、fresh boot、S3 双轮恢复、active Sandbox cancel 和 22 条 durable events。新增
  inspection 断言还证明
  Supervisor 无 socket、Manager 是唯一 socket owner、两者均非 privileged/read-only rootfs、Manager 无 DB/S3/model credential、
  Tool Sandbox 无 network/mount/secret env；随机容器、网络、volume 与 runtime 最终精确清理。
- 真实仓库烟测：把同一批镜像部署到本机生产实例后，经 Manager 临时 importer 导入 `octocat/hello-world` 的固定 commit
  `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`；client 对 snapshot envelope、manifest 和内容 hash 完整解码，得到 217-byte
  snapshot（SHA-256 `7ff9e22d573d6ac65f521f3a07b9412558210bbe419fec8896473187f000e9f2`）。完成后 importer、
  `repository-egress` endpoint 和 managed Sandbox 均为 0；该烟测不调用模型、不消耗 token。
- 当前产品边界：这是可在单台 Linux Docker host 私有部署的多租户 cloud coding agent，而不是 hostile-public SaaS。Docker
  容器仍共享宿主内核；Manager 的 socket 仍属于 TCB。用户已明确暂缓 project extension 与 approval boundary，因此下一步
  不扩功能，先用 CI、加强后的 production gate 和当前部署检查把这次执行边界固化；若未来开放公网任意代码，应再评估
  gVisor/Kata/Firecracker 或托管 microVM，并单独写 threat model。

## 2026-07-20 — Provider-neutral Sandbox runtime 与长期平台路线

- 目标与原因：接受“长期打磨、可公开演示、能经受系统设计追问”的产品定位，把上一阶段已经跑通的 Docker Tool Sandbox
  从具体实现提升为可维护的 Provider 边界，同时保存后续 Durable Run、Workspace/GitHub、Context、Observability/Eval、
  第二 Provider 和产品完善的依赖顺序。完整路线保存在 `docs/PLATFORM_PRODUCT_PLAN.md`；本轮只声明并完成 Milestone 1，
  不把 gVisor、Vercel、GitHub App、PR 或 Temporal 写成已有能力。
- 架构决策：新增 ADR-0030。`ToolSandboxManager` 属于可信控制边界，负责 capability digest、常量时间鉴权、operation replay
  防护、activation 生命周期和 assignment/policy 校验；`SandboxProvider` 只负责 runtime mechanics，不接触 bearer
  capability，也不向 Agent Runtime 暴露 Docker SDK/handle。当前部署配置是闭合 union，只接受经过验证的 `docker`；未知
  Provider 启动即失败，避免配置看似生效、实际静默降级。
- Provider 合同：新增 `create/exec/readFile/writeFile/snapshot/stop/destroy/inspect/inventory/reconcile/close` 等 provider-neutral
  能力。不可变 handle 绑定 `provider/activationId/tenantId/sessionId/turnId/attemptId`；当前 `attemptId` 明确映射现有 lease ID，
  等 Milestone 2 引入独立 `RunAttempt` 后再迁移。Docker 实现移入 `DockerSandboxProvider`，Provider 本身不生成、保存或校验
  capability。
- 固定策略：Tool Sandbox 使用 UID 1000、非 privileged、read-only rootfs、`cap_drop=ALL`、
  `no-new-privileges`、`network=none`、零 host mount/socket/port，并固定 CPU 1、memory 768 MiB、pids 128、nofile 1024、
  `/tmp` 64 MiB、workspace 128 MiB、单次输出 1 MiB、命令 300 秒和 turn 900 秒上限。网络策略类型预留 deny-all、GitHub、
  package registries 和 explicit hosts，但 Docker Tool provider 当前只实现 deny-all；其余策略 fail closed，不借助 platform
  internal network 伪装 allowlist。
- 自动隔离证据：新增 opt-in `npm run sandbox-provider:check`。真实 Docker 测试创建两个 tenant 的 sandbox，并从容器内验证
  UID、capabilities、read-only、network、mount/socket、CPU/memory/PID/cgroup 限额；证明 `env`、自身和 PID 1 的 `/proc`
  都没有平台/模型凭据，Control Plane/PostgreSQL/MinIO/Manager/host gateway/公网均不可达，跨租户文件不可见，路径穿越和
  symlink escape 被拒绝，无限输出被截断，取消后后台进程及容器消失。随后由 pinned Pi 真实执行远程 bash/edit/bash 的
  Java 修复与 checkpoint；整个 gate 不调用模型、不消耗 token。
- 仓库门禁：最终 `npm run ci` 完整通过 production Web build、所有 workspace typecheck、301 passed/9 conditional skipped
  tests、两个 zero-model-call Pi spikes 和 `npm audit --audit-level=high`（0 vulnerabilities）。Disposable full-build production
  gate `agent-dock-check-9b1a344c13` 通过公开注册、3 tenant 隔离、control-plane restart、`1 -> 2 -> 1`、fresh Supervisor
  boot、active worker cancel、22 条 durable events、新 provider/resource/identity 断言和精确清理。
- 当前部署：正式栈已更新到同一批镜像，五个常驻服务 healthy，Web 仍只发布 `127.0.0.1:8080`。Supervisor 是非 root、
  read-only 且没有 Docker socket；Manager 只加入 sandbox-control，是唯一 socket owner；空闲时 managed sandbox 与 importer
  均为 0。受控 importer 再次导入 `octocat/hello-world` 固定 commit，得到相同的 217-byte snapshot 和 SHA-256
  `7ff9e22d573d6ac65f521f3a07b9412558210bbe419fec8896473187f000e9f2`，完成后 repository-egress endpoint 回到 0。
- 下一步：实施 Milestone 2 的显式 Durable Run Protocol：独立 `Run/RunAttempt`、lease/heartbeat/fencing、HTTP 幂等键、
  terminal/checkpoint CAS 与故障注入。原因是 Sandbox 安全边界已经可替换且有真实证据，下一项最大系统风险不在增加工具，
  而在 Worker 崩溃、重复投递和旧 Attempt 延迟完成时，能否保证状态与 Workspace 不被覆盖。

## 2026-07-20 — Durable Run / RunAttempt 执行协议

- 目标与原因：把原先分散在 Turn、Command、outbox attempt 与 session lease 中的执行语义提升为产品可见、可追责的
  `Run/RunAttempt`。同一个用户请求拥有稳定 Run；每次 at-least-once 调度领取拥有独立 Attempt，避免把重试次数、lease 或
  Turn 错当成 Worker 执行身份。
- 存储与 API：migration 009 新增 tenant-owned `runs`、immutable-numbered `run_attempts` 和 append-only
  `run_attempt_transitions`，并安全回填旧 Turn。Turn/Command/outbox/Run 在接受事务中原子创建；`202` 响应包含 `runId`，新增
  tenant-scoped Run list/detail API，Attempt 历史包含 claim/phase/heartbeat/assignment/checkpoint/failure/settlement，foreign UUID
  与不存在资源保持相同 `404`。
- 执行权：每次 outbox claim 创建新 Attempt；pre-ACK retry 先把旧 Attempt 标记 failed，再将 Run 返回 queued。Supervisor
  wire 和 Provider assignment 携带独立 Run/Attempt UUID；session lease acquire 把 current Attempt 与 sandbox/lease/fence
  原子绑定，heartbeat 在同一事务续租 Attempt claim 和 session lease。旧 Attempt、旧 lease 或旧 fence 的 phase、checkpoint、
  terminal write 全部 fail closed。
- 阶段与结算：trusted Runner 通过独立 observer 持久化 provisioning/restoring/running/checkpointing 和 checkpoint revision；
  complete/fail/timeout/cancel 在锁定的 current Attempt 下与 Command/Turn/Session/outbox/lease 结算。Assignment reconciler 在
  requeue/fail 前先终止旧 Attempt；checkpoint CAS 同时验证 Run、Attempt、lease、fence，上传成功但 CAS 失败的对象不会成为
  current workspace。
- 故障证据：测试覆盖重复领取与多 Attempt history、旧 claimant/旧 fence、checkpoint revision、lost assignment、取消竞态、
  timeout/failure 分类、同 Session FIFO 和 tenant 隔离。全量复跑还发现 Supervisor 心跳 ACK 原来只容许一个 heartbeat interval；
  PostgreSQL 短暂写竞争会误触发断线。现在串行 heartbeat 使用 `timeout - interval` 作为 ACK 窗口，连续五轮真实远程执行/取消
  复跑稳定通过。
- 仓库门禁：`npm run ci` 完整通过 production Web build、全部 workspace typecheck、306 passed/9 conditional skipped tests、
  两个 zero-model-call Pi spikes 和 high-level dependency audit（0 vulnerabilities）。语义声明仍是
  `at-least-once scheduling + idempotent/fenced commit`，不声称任意 shell、LLM 或外部副作用 exactly once。
- 下一步：进入 Milestone 3，先把 settled checkpoint 从“一个 current pointer”扩展成 tenant-scoped immutable Workspace
  version/history，再在这个版本协议上实现 compare/fork/rollback/archive 和 trusted GitHub App write-back；原因是 PR 交付必须
  引用一个稳定、可审计、不会被旧 Attempt 覆盖的 Workspace 版本。
## 2026-07-20 — Milestone 3: versioned Workspace and GitHub-native delivery

- Added migration 010 for immutable Workspace versions, operation audit,
  structured test results, GitHub installations/repositories, PR deliveries,
  and webhook delivery deduplication.
- Checkpoints now stage a version under Run/Attempt identity and settle or
  abandon it with the terminal Run transition. Failed Runs restore the prior
  pointers; rollback is honored by the next cold restore.
- Added tenant-scoped history, files, compare, artifact download, fork,
  rollback, archive, and test-result APIs.
- Added the separate trusted GitHub Gateway, in-memory installation tokens,
  exact-commit snapshot import, deletion-aware Git object/PR/Check delivery,
  HMAC webhook verification, and authenticated normalized webhook ingestion.
- Added authenticated Supervisor-to-Control-Plane artifact transport so the
  Control Plane does not acquire the object-store credential.
- Added migration, version consistency, tenant isolation, GitHub API contract,
  private import, webhook, and artifact transport tests.
- The independent production acceptance gate passed from a cold Compose deployment with migration 010, repeatable bootstrap,
  public multi-tenant registration, tenant-scoped conversations, structured failed/passed test results, immutable Workspace version
  settlement, artifact persistence, Control Plane restart and 1→2→1 replica scaling, same-boot reconnect, fresh Supervisor boot,
  exact RunAttempt/Lease/Fencing container identity checks, active cancellation, and orphan-free teardown. The run produced 22
  replayable events for the restored session and admitted exactly three tenants under the configured registration cap.
- The full repository gate passed the production Web build, every workspace typecheck, 318 tests with 9 environment-conditional
  skips, both zero-model-call Pi compatibility spikes, and the high-level dependency audit with 0 vulnerabilities.
- GitHub App behavior is covered against a deterministic GitHub API contract. A live private-repository/PR write-back is deliberately
  not claimed because production App credentials are not configured in this local deployment; the Gateway remains disabled by default
  and fails closed until those secrets are supplied.
- Next: Milestone 4 will add durable context/compaction records and enforce per-Run and per-tenant token/cost/tool budgets at the trusted
  Model Gateway. This comes before observability because the Usage ledger and budget decisions need to become stable domain data that
  later traces, metrics, dashboards, and eval reports can consume.

## 2026-07-20 — Milestone 4：Context 与 Model Governance

- 目标与原因：长会话不能只依赖无限增长的 `messages[]`，真实多租户也不能等 provider 返回后才统计额度。先把上下文、请求
  预留、价格快照和完整 usage 变成稳定领域数据，后续 Trace、Dashboard 和 Eval 才有可信的数据源。
- 上下文：保留 Pi 对 transcript 和 compaction 的唯一所有权。每次 activation 写入 tenant budget 对应的 native compaction
  settings；固定 extension 将 Pi/platform system、最多 16 KiB 的 workspace `AGENTS.md`、Pi summary、recent messages、bounded
  tool results 和当前 task 按顺序组合。Compaction start/end 进入 durable event，PostgreSQL 只保存 token、first-kept entry、
  summary version 与 SHA-256，不复制摘要正文。
- 预算：migration 011 扩展 tenant policy，并新增 model rate、routing、request reservation 和 compaction audit。每个 Turn 固化
  model request/token/cost/tool/output/wall-clock snapshot；同 Session 保持串行。Tool 次数在 trusted extension 发 RPC 前扣减，
  Run timeout 取 tenant 与部署上限较小值。
- Model Gateway：在 provider egress 前锁 tenant policy，清理过期 reservation，验证 current RunAttempt，汇总 completed usage 与
  active reservation，再原子写 `reserved` 或 `budget_denied`。只允许一次显式 fallback，限 429/5xx/timeout 策略。完成时记录实际
  provider/model、四类 token、四类 owner-configured micro-USD rate、整数 cost，并写一条 linked usage ledger；bootstrap rate 为 0，
  不冒充实时官方价格。
- 大输出：read/bash 超过 context 限额时，Pi 只收到 bounded preview；完整但 Provider-bounded 的 bytes 先写 activation-private
  trusted directory，再由 checkpoint store 以 current Run/Attempt/lease/fence 校验写成 tenant-scoped `tool_output` Artifact，最后
  `tool.completed` 才发布 opaque artifact ID/hash/size。失败 Run 也不会因为没有 checkpoint 而丢失该工具证据。
- 产品 API：新增 owner-only governance replace，以及 tenant-scoped usage、Run model-request audit 和 Session context/compaction
  history。Viewer 不能改 policy，foreign Run/Session 与不存在资源保持相同 `404`。
- 自动证据：migration up/down、reservation/fallback/pre-egress denial、actual rate/cost、tool budget、context layer、native
  compaction privacy、large-output capture/persistence/event reference、tenant/role 隔离均有 deterministic tests；正式门禁结果在
  本里程碑 commit 前以仓库 CI 复核。最终 `npm run ci` 通过 production Web build、所有 workspace typecheck、330 passed/
  9 environment-conditional skipped tests、两个 zero-model-call Pi spikes 和 high-level audit（0 vulnerabilities）。

## 2026-07-20 — Milestone 5：Observability 与可复现评测

- 目标与原因：把异步 Run 的排队、Runner、模型、Tool Sandbox、checkpoint 和清理串成可定位的执行链，并用互不混淆的实验
  分别证明平台正确性、安全隔离和 HTTP 容量；不把 deterministic fake model 的结果包装成模型智力，也不把 100 个并发 API
  请求包装成 100 个并发 Agent Run。
- Trace：migration 012 为每个 Run 固化非零 128-bit `trace_id`。Control Plane 以 Attempt 构造 W3C parent，跨远程 Supervisor、
  trusted Runner、Pi provider hook、Model Gateway、Tool RPC 和 Sandbox Manager 传播；外部 DeepSeek upstream 不接收平台内部
  trace header。Jaeger 实测可按相同 durable trace ID 查询，每条 coding eval trace 包含 11 个跨服务 span。
- Metrics/日志：新增独立 observability workspace，三个可信服务各自暴露 bearer-protected Prometheus endpoint，label 只使用
  closed low-cardinality outcome/provider/model/tool 集合，不含 tenant/Run/path/content；JSON 日志附带 trace/span 并递归脱敏。
  owner-only `/v1/operations/summary` 从 PostgreSQL 返回 tenant-scoped 24 小时 Run、usage、tool/test、sandbox 和失败聚合。
- 部署：正式 Compose 增加持久 Prometheus、Badger Jaeger 和自动 provision 的 Grafana dashboard。三者留在 internal network，
  由无凭据、read-only、cap-drop 的独立 Caddy 只向 `127.0.0.1:9090/16686/3001` 代理；实测三条 scrape target 全部 up、
  三个 Jaeger service 可见、Grafana `AgentDock Platform` dashboard 已加载。
- Eval：10 个 Java repair 全部通过完整 durable Pi/tool/checkpoint 流程（并发 2，p50 9.168 秒、p95 10.224 秒）；10 类
  ACK 丢失、旧 fence、object-store outage、checkpoint corruption/CAS、cancel/complete race、orphan runtime 等注入故障全部
  守住不变量。`sandbox-provider:check` 再次通过真实 Docker security contract 与 Pi remote-tool repair。
- Load：loopback 10/50/100 simultaneous Session create/read 共 320 requests、0 error。100 并发时 create 114.20 req/s、p95
  831 ms，read 236.81 req/s、p95 408 ms；采样 RSS 为 Control Plane 200,962,048、Runner 167,043,072、Manager 119,164,928
  bytes。报告明确限定为本机 Docker Desktop，不是公网 SLO。
- 门禁：Milestone 5 代码进入生产镜像前，全仓门禁通过 337 passed/9 environment-conditional skipped tests、两个
  zero-model-call Pi spikes 和 high-level audit（0 vulnerabilities）。正式部署完成 migration 012，十个常驻/入口服务 healthy。
- 下一步：实施 Milestone 6 的第二 Sandbox Provider。原因是共享内核 Docker 仍是公开恶意代码执行场景的最大剩余边界；
  只有第二 Provider 通过同一 contract、真实 Pi 和生产验收后，才能把 stronger isolation 写成已支持能力。

## 2026-07-20 — Milestone 6：Docker Sandboxes microVM Provider

- 选择依据：当前 Docker Desktop/WSL2 daemon 没有 `runsc`，也没有受支持的持久自定义 OCI runtime 安装路径，因此没有用
  mock 冒充 gVisor。实际探测了本机 Docker Sandboxes v0.12.0；它为每个 Sandbox 创建独立 LinuxKit VM、kernel 和 VM 内
  Docker Engine，最终选择为可真实验证的第二 Provider。调研与限制保存在
  `docs/research/2026-07-20-strong-sandbox-provider-selection.md`。
- 架构：新增 `DockerMicrovmSandboxProvider`。Manager 先解析 host Tool image ID，导出 private content-keyed tar，以每 activation
  staging 只读传入 VM，加载后再次校验 image ID。outer shell 只执行可信 provisioning；在任何 Tool Worker/用户命令开始前把
  proxy 切为 deny-all。真正的 bash/edit/git/test 仍在 VM 内的原 hardened Tool Worker 中执行，保持 non-root、read-only、
  `network=none`、cap-drop、no-new-privileges、cgroup/PID/tmpfs/output/timeout 和 JSONL cancel/checkpoint 协议。
- 生命周期：短 `admv-*` 名称规避 Windows AF_UNIX path 上限。private atomic manifest 将 VM、inner labeled container、tenant、
  Attempt、lease 和 fence 绑定；fresh Manager 会重新检查 inner labels，能够列出并精确终止旧 assignment，未知无 manifest VM
  fail closed。outer handle 仍是 Provider-neutral，不向 Runner 暴露 Sandbox 原生对象。
- 真实排障：首次 boot image 拉取没有继承 Docker Engine proxy；改为在 sandbox daemon 启动环境配置 upstream。低于 4 GiB 可用
  host memory 时 OpenVMM 返回 Windows 1450；回收 WSL page cache 后通过。guest kernel 实测为 `6.12.67-linuxkit`，host 为
  `6.6.87.2-microsoft-standard-WSL2`。deny-all 后 `example.com` 与 host Docker endpoint 均被 network log 记录为 blocked。
- 自动证据：Provider gate 完整通过 credential/env、独立 kernel、inner cgroup、network、file/path、取消、snapshot、fresh-Manager
  reconciliation 和无残留 VM；随后 pinned Pi 通过同一 microVM Tool RPC 完成真实 `bash/edit/bash` Java repair 和最终 patch，
  不调用外部模型、不消耗 token。独立两轮实测分别为 142.520 秒与 116.756 秒，包含每次临时 state 中的 263 MB image export/load，
  不能当成稳态 SLO。
- 产品边界：默认 Compose 仍使用共享内核 `docker`；`docker_microvm` 是需要 host Docker Sandboxes 的 opt-in Manager backend。
  它显著加强 Tool kernel 边界，但没有自动补齐公网身份、滥用控制、dependency egress、容量治理或独立安全审计，因此项目仍不
  声称 anonymous hostile public SaaS。
- 下一步：Milestone 7 将把现有 Workspace/files/diff/tests/artifacts/Run/usage/audit API 完整呈现在 Web 产品中，并补齐
  backup/restore drill、release/SBOM/image scan 和从 clean checkout 可复现的一键部署。原因是执行内核边界已经有第二条真实路径，
  最后最大缺口是用户是否能完成完整工作流，以及运维人员是否能可靠升级和恢复。

## 2026-07-20 — Milestone 7：产品闭环、恢复演练与发布证据

- 产品闭环：Web 新增 Session inspector，把 Workspace 文件树与安全文本预览、结构化 Diff、Artifact、Run/Attempt/transition、
  测试结果、usage/context/governance、owner operations/activity 放入同一界面；支持失败 Run retry、Session fork、Workspace
  rollback/restore/archive，以及由用户显式触发、绑定 immutable Workspace version 的 GitHub PR delivery。GitHub App 未配置时
  UI 和 Gateway 都 fail closed，不冒充 live private-repository/PR 结果。
- 运维可见性：新增 owner-only `/v1/operations/audit`，从 tenant-scoped RunAttempt transition、Workspace operation、model request
  和 GitHub delivery 派生最近执行活动。它明确不是包含 actor/IP 的完整合规审计；viewer 被拒绝，foreign tenant 数据不可见。
- 冷备恢复：新增 `production:backup` / `production:restore`。平台停机后将 private runtime 与 PostgreSQL、MinIO、Supervisor
  boot/spool、Prometheus、Grafana、Jaeger 七个 volume 打包，逐文件 SHA-256 后用 scrypt + AES-256-GCM 认证加密。restore 只接受
  空的新 project/runtime，验证认证标签、路径、manifest、hash 和六个精确本地 image ID，再创建 volume 和校验 Compose；失败
  会回收本次新建资源。独立 crypto gate 证明 1 MiB round trip、篡改与错误口令均被拒绝。
- 恢复实测：完整 disposable production gate 在三租户、22 条 replayable events、3 个 Workspace version、31 条 product activity
  和 3 个 Jaeger service 验收后停栈，生成 7,285,908-byte 加密备份；新 project 恢复所有七个 volume，验证两个 tenant 的
  conversation/workspace/audit 和 22 条原事件，再真实提交一轮 deterministic Pi follow-up，event cursor 从 22 继续到 28。
  原/恢复拓扑、临时 volume、network、Tool Sandbox 和进程全部清理。
- 发布证据：新增 clean-worktree `release:evidence`，绑定完整 Git SHA 与六个 OCI-labelled production image ID，生成 root 和逐镜像
  CycloneDX、完整 HIGH/CRITICAL JSON、manifest 与 `SHA256SUMS`。digest-pinned Trivy 只在更新数据库时联网，随后用 read-only
  image archive、无 socket/网络/capability 扫描；任何可修复 HIGH/CRITICAL 都阻断发布。真实门禁先发现旧 Caddy 镜像的
  62 HIGH/6 CRITICAL 可修复项；最终改为 pinned Go 1.26.5 编译 Caddy 2.11.4，并放入 minimal Alpine runtime 后，Web 镜像
  fixable HIGH/CRITICAL 均为 0。Tool Sandbox 的本地证据只扫 OS package，npm package 由 root SBOM/audit 覆盖；CI 保留完整
  language-package image scan，差异写入 manifest 和 release 文档。
- CI/镜像：Node 更新到 24.18.0；六个生产镜像都写 OCI version/revision，trusted Node runtime 删除全局 npm/corepack。
  CI 增加 root SBOM 和六镜像矩阵，固定 Anchore、Trivy 与 artifact Action commit，既保留全部严重发现，也只对已有修复版本的
  HIGH/CRITICAL fail。`npm run ci` 通过 340 passed/10 conditional skipped tests、两个 Pi compatibility spike、backup crypto gate
  和 npm audit（0）；`container:check`、真实 Docker `sandbox-provider:check` 及 whole-Pi `sandbox:check` 均通过。兼容门禁还修复并
  证明 Docker settled-checkpoint 会把 Git Patch 与 Pi transcript、Workspace snapshot 一起原子持久化，而不是只把 Patch 留在
  终态事件中。
- 产品边界：Milestone 1–7 对应的私有/loopback 单主机产品闭环已完成，但这仍不是 anonymous hostile public SaaS。公开注册只在
  显式容量上限下启用；默认 Docker Provider 共享 host kernel，microVM Provider 依赖 Docker Sandboxes；registry signing、
  Kubernetes、多地域、完整 actor audit 和公网 abuse defense 仍属于未来部署决策，未伪装成当前能力。

## 2026-07-20 — 产品入口修正：账户、对话壳与平台模型

- 问题：原 Milestone 7 页面仍以开发/运维验收为中心，首次进入要求粘贴 API token，模型配置占据用户流程，并默认把 Java repair
  fixture 当成产品起点。这些能力作为诊断面是有效的，但不是普通用户理解的 Cloud Coding Agent 产品。
- 账户：migration 013 新增全局规范化用户名、salted scrypt password verifier 和持久 Web session。浏览器只收到
  `HttpOnly`、`SameSite=Strict` 的 opaque cookie；数据库只存 session SHA-256，支持过期、最多 10 条 active session、即时
  logout revoke。旧 Bearer token 路径保留给自动化和离线运维，不再出现在默认 Web 页面。
- 模型：production bootstrap tenant 成为 platform model source。新账户创建时，Control Plane 在可信边界解密当前 allowlisted
  DeepSeek credential，并按新 tenant/binding/version 重新 AES-GCM seal；deterministic 环境则继承 fake profile。普通 tenant
  即使绕过 UI 调用写接口也会被拒绝，只有配置的 platform operator tenant 可以 replace model；一次 replacement 会在同一事务
  为所有 browser-account tenant 生成新 binding version，后续注册也动态读取当前 source。浏览器不再请求/展示 model picker
  或 API key。
- 产品：新增 ChatGPT 风格的产品壳——未登录先看到登录/注册，登录后左侧为 tenant-scoped conversation list，右侧为对话和固定
  composer；首次发送消息会懒创建 `empty` Workspace，而不是 Java 示例。tool output、patch 和原 Session inspector 继续作为
  可折叠详情/工作区按钮保留；窄屏侧栏变为 overlay。
- 验证：协议、数据库、Control Plane、Web 都增加对应 schema/type/integration/render/API tests；production gate 增加真实
  register → cookie identity → empty Project/Session → conversation isolation → logout/re-login → model write denial → production bundle
  断言，并继续执行原有 Run/Attempt、Tool Sandbox、恢复和备份闭环。正式部署仍只监听 `127.0.0.1`；账户便利性不扩大为公网
  身份、找回、MFA、distributed rate limit 或 hostile SaaS 声明。
- 真实部署：commit `3a20d42` 已滚动部署到保留原 PostgreSQL/MinIO/观测数据的本机 production topology；migration
  `013_product_auth_and_empty_workspaces` 已落库，十个常驻/入口服务正常运行，Control Plane、GitHub Gateway、Sandbox Manager、
  Supervisor、Web 与内部存储均通过健康检查。对 `127.0.0.1:8080` 的黑盒与真实浏览器验收确认：匿名首页稳定显示登录/注册，
  旧 operator/model 表单不再进入产品路径，匿名 identity 被拒绝，错误登录不泄露账户是否存在，production bundle 包含会话侧栏、
  对话 composer 和无需配置模型的注册说明。平台模型仍由可信后台以 `real/deepseek/deepseek-v4-flash` 提供，凭据未进入页面或验收输出。
- 发布门禁：全仓 `npm run ci`、production container smoke、真实 Docker Sandbox Provider/Pi remote-tool gate 和 disposable
  production backup/restore acceptance 均通过；后者覆盖四 tenant 隔离、Control Plane 扩缩/重启、Supervisor fresh boot、取消、
  durable event replay、Workspace version 延续、观测目标、加密备份恢复和恢复后继续执行。该结果证明本次入口改造没有绕过或删除
  Milestone 1–7 的执行、安全、耐久化和运维能力。

## 2026-07-20 — 空 Workspace 首轮执行故障修复

- 现象与定位：真实浏览器账户提交“你好”后，Run 在 1.8 秒内以 `supervisor_execution_failed` 结束，且没有产生 model request，
  排除了 DeepSeek 延迟和 token 消耗。对应 Trace 将根因定位到 Sandbox `create`：空 snapshot 恢复后执行普通 Git baseline commit，
  因没有文件可提交而失败；Provider 又把合法的 `worker.failed` 错误错误归类为 `tool_worker_protocol_error`。由于失败发生在第一个
  Session event 之前，页面只依赖 SSE 时会一直显示“正在思考”。
- 修复：Tool Worker 使用 `git commit --allow-empty` 建立真实空基线，后续文件仍可生成确定性 Diff；Docker Provider 将 JSON/schema
  解析错误与 Worker 报告的运行错误分开，保留后者的安全错误码。Web 为每个 active Turn 保存 `runId`，以 durable Run API 对账
  queued/running/terminal 状态；即使 provisioning 阶段没有发布事件，也会停止等待并显示失败或超时，重开历史失败对话也有兜底提示。
- 防回归：真实 Docker Provider contract 新增空 snapshot 启动、空 baseline、命令执行、完整清理和合法 Worker failure 传播；Web
  reducer 新增 pre-event failure 测试；production gate 现在用 HttpOnly 浏览器 Cookie 在空 Workspace 中真实跑完 Pi、Tool Sandbox、
  assistant delta、checkpoint 和 Run settlement。全仓 CI、真实 Docker/Pi gate 及四 tenant backup/restore production gate 均通过。
  同时将高成本 PGlite migration 包限制为两个 worker，29 个数据库测试稳定通过，避免宿主资源竞争造成的成批假超时。
- 真实回归：commit `a18654d` 已滚动部署到保留用户数据的 production topology，十个常驻/入口服务全部 healthy。随后为发生故障的
  浏览器账户签发 15 分钟、只用于验收的临时凭据，在原 Session 中以 `real/deepseek/deepseek-v4-flash` 重新提交“你好”；Run 完成、
  44 条 durable event 可重放、assistant 文本已持久化、Workspace checkpoint 已提交，usage ledger 记录 1,326 input / 59 output
  tokens。验收凭据随即撤销并实测返回 401，受管 Tool Sandbox 容器无残留；这次验证实际消耗模型 token，不是 fake model 或 health
  probe。

## 2026-07-21 — Pi TUI 风格的 Web 执行记录

- 问题：产品页虽然已经按 durable event 保存完整 Tool 输入和输出，但默认只显示 `write 完成` / `bash 失败` 折叠卡片。真实冒泡排序
  Run 中的命令、`command not found`、文件内容和 Node 测试结果都存在 PostgreSQL/SSE 中，却没有像 Pi TUI 那样形成可读的执行过程。
- 展示：Web 现在把同一轮中的中间 assistant 文本识别为阶段说明；`bash` 直接显示 `$ command`、stdout/stderr 和失败原因，`write`
  显示操作名、Workspace 路径和源代码预览，其他工具保留可读输入/输出。成功、失败、运行中使用 Pi 式 glyph；根据两个 durable event
  的 `occurredAt` 展示 `Took` 耗时。长源码保留开头、长终端输出保留结尾，并可点击展开完整的 bounded event 内容。
- 兼容：没有修改 Agent protocol、Sandbox 或历史持久化格式；Web reducer 只把已有 event 时间保存在 view model。新增 SSR tests
  证明 Pi content block 会扁平为真实终端文本、失败命令不会显示 JSON、write acknowledgement 不重复显示，源码预览和耗时均可见。
  Web typecheck、22 tests 和 production build 通过，全仓所有 build/type/function/spike/backup 门禁通过。
- 已知发布门禁：2026-07-21 的 npm advisory 新增 Pi 0.80.10 内部 shrinkwrap 锁定的 `brace-expansion@5.0.6` high 与
  `protobufjs@7.6.4` moderate。当前 Pi 已是 registry 最新版，root override 和 `npm audit fix` 都不能覆盖发布包内部 shrinkwrap；
  没有伪造修复或降低 audit level，已单独进入 Backlog 等待 upstream repack 或经过验证的 vendoring 方案。本次 Web-only image 不包含
  Pi runtime，部署不会把这两个包新增到浏览器镜像或重建 Trusted Runner。
- 实际发布：commit `9b5adda` 已构建为 `agent-dock/web-ui:production`，OCI revision 与提交一致。Compose 只重建 Web 和复用同一静态
  镜像的 observability ingress；Control Plane 与 Supervisor 容器保持原启动时间和原 image ID。上线后 Web、内部服务和入口均
  healthy，`8080/healthz` 返回 `ok`，实际静态 bundle 包含阶段文本、命令、可展开输出和 `Took` 样式标记。

## 2026-07-21 — Pi Tool Call 真流式预览与源码高亮

- 根因：上一版只能在 `tool_execution_start` 后展示 `write`。这时模型已经生成并解析完全部 JSON 参数，所以即使 SSE 正常，源码也会
  一次性出现。Pi 在更早的 `message_update.toolcall_delta` 中实际提供了增量参数，只是 AgentDock v1 Adapter 先前将非文本 delta
  明确忽略；因此不能靠前端动画解决。
- 协议：新增只包含 `toolCallId/toolName/delta` 的 `tool.input.delta` 公开事件。Adapter 从 Pi partial 中只提取已审查的调用身份和原始
  JSON fragment，不转发 provider/Pi 原对象；缺少调用身份的兼容 Provider delta 被安全忽略，最终 `tool_execution_start` 仍是执行
  权威边界。事件与 assistant text 一样进入 durable spool、PostgreSQL 和可重放 SSE。
- 流控：第一次真实 DeepSeek 验收发现 2,849-byte 参数被 Provider 切为 777 个极小 delta；若逐条持久化会把视觉优化变成数据库写放大。
  Adapter 现在按至少 128 UTF-8 bytes 合并同一 toolCall 的真实 fragment，并在 `toolcall_end` 强制冲刷尾部；最多只缓存不足 128 bytes，
  不缓存完整工具输入，也不延迟最终执行边界。短命令仍由 authoritative `tool.started` 立即显示，长 write 则保持多阶段真实流式预览。
- Web：Reducer 以 toolCallId 合并增量 JSON，并在 `tool.started` 到来时把同一条记录从“正在生成”切换为“执行中”，不创建重复卡片。
  `partial-json` 只用于浏览器渐进恢复 `path/content/command`；执行端始终使用 Pi 最终验证后的参数。`write` 源码带真实增量光标，完成后
  仍保留相同内容。
- 高亮：使用 Pi 同系列的 Highlight.js core，根据文件扩展名显式选择 Python、Java、JavaScript/TypeScript、Shell、C/C++/C#、Go、
  Kotlin、Rust、Ruby、PHP、SQL、JSON、HTML/CSS、Markdown、YAML 和 Diff；未知扩展名保持纯文本，不做不稳定的自动猜测。高亮器被拆成
  90.27 kB 的按需 chunk，主 bundle 为 494.02 kB，避免把所有语言语法塞进首屏。Highlight.js 先转义不可信源码再产生 token span。
- 验证：协议覆盖新增事件，Pi Adapter 覆盖脱敏后的 tool delta，Web reducer 覆盖两个 delta → 一个 preparing item → authoritative
  tool start 的重放，SSR 覆盖流式状态/光标，独立高亮测试覆盖 Python token 和 HTML 转义。全仓 build/typecheck、格式检查和允许本机
  临时端口后的全仓测试通过；首次受限运行出现的 `listen EPERM` 已确认是执行沙箱禁止测试 server bind，并非产品断言失败。
- 真实发布：`394073c` 的协议/Control Plane/Web 与首版 Runner 上线后，真实 DeepSeek write 已证明 preview seq=2、tool start seq=779，
  但也暴露 777-delta 写放大；随后 `04068ee` 的合并 Runner 单独滚动上线。第二个独立空 Workspace 任务生成 2,084-char Python 文件，
  2,245-byte JSON 被合并为 18 条 durable write delta，仍从 seq=2 开始并在 seq=20 的 `tool.started` 前完整到达；Run completed，两个
  model call 实耗 165 input / 882 output tokens。最终 Control Plane、Supervisor 和 Web image revision 与预期提交一致且全部 healthy，
  线上主 bundle、90.27 kB 高亮 chunk、流式光标和 token CSS 均可读取。

## 2026-07-21 — gVisor/KVM 成为唯一 Tool 执行内核

- 决策：共享宿主内核的普通 Docker 不能作为本项目最终的不可信代码边界；Docker Sandboxes microVM 路径又依赖 Desktop、启动慢且保留
  双 Provider 兼容面。ADR-0038 因此把 `runsc --platform=kvm` 定为唯一受支持的 Tool/Repository Import runtime。旧普通 Docker、
  Docker microVM Provider、旧 whole-Pi 容器 Worker、选择器、脚本和对应兼容测试已经删除；旧环境变量会 fail closed，不存在 runc、
  systrap 或 Desktop fallback。
- Host：在 Ubuntu 24.04 WSL2 中安装原生 Docker Engine 29.6.2、Compose 5.1.3 与官方 gVisor
  `runsc release-20260714.0`，daemon 只注册 `/usr/bin/runsc --platform=kvm`。安装脚本会验证 Linux daemon、KVM、runtime args 和真实
  guest kernel；Sandbox Manager readiness 还会启动一次 live probe。实测 guest 为 `4.19.0-gvisor`，不再暴露 WSL kernel release 或
  AMD 物理 CPU model。
- 执行边界：Trusted Supervisor/Pi 只持有 Model Gateway 身份并通过窄 Tool RPC 工作；只有 Sandbox Manager 持有原生 Docker socket。
  每个 activation 都检查 `HostConfig.Runtime=runsc` 和 guest kernel，再启用无网络、非 root、read-only rootfs、cap-drop ALL、
  no-new-privileges、独立 tmpfs Workspace、CPU/memory/pids/disk/output/command/turn timeout。Docker 的 PidsLimit 在本机 runsc 下不能单独
  约束 guest，最终增加 `RLIMIT_NPROC=128`；耗尽实验启动 121 个子进程并拒绝后续 135 个。Tool image 同时补齐 Python 3、pip 和 venv，
  Java/Node/Python 都在同一 gVisor 边界内可执行。
- 自动证据：真实 gVisor gate 通过 runtime/host concealment、credential 与 `/proc`、内网/host gateway/公网、跨租户、路径与 symlink、
  输出、timeout、CPU/memory/process、cancel/descendant 和 orphan cleanup；随后 pinned Pi 通过远程 `bash/edit/bash` 完成确定性修复。
  安全 gate 约 14.1 秒、Pi gate 约 9.1 秒，结束后 managed runtime 为 0。全量 production acceptance 又通过四租户、22 条 durable
  events、Control Plane 扩缩/重启、Supervisor fresh boot、取消、Workspace version 3、三个 Prometheus targets、三个 Jaeger services、
  31 条 product audit；最终重跑生成 7,355,988-byte 加密冷备，并在新 project 恢复到 event cursor 34。
- 供应链：Pi 0.80.10 发布包内部 shrinkwrap 锁住的 `brace-expansion@5.0.6` 和 `protobufjs@7.6.4` 无法被 root override 控制。
  当前使用两个精确 npm alias 作为已验证补丁源，安装后只原子替换对应目录为 5.0.7/7.6.5；本地、CI 和 Trusted production images 都
  校验实际 package version，并在任何未来 Pi 版本上 fail closed。安全审计只调和这两个精确 stale-metadata path，其他 high/critical
  仍照常阻断。全新 `npm ci --ignore-scripts` 后的 hardening、全仓 build/type/test、两个 zero-token Pi spike、备份密码学和审计全部通过。
- 数据迁移：先记录 Desktop 旧库 `users=4`、`tenants=4`、`sessions=336`、`session_events=4655`、`tenant_model_credentials=2`，停掉旧
  Compose 但保留其七个 volume；随后生成 `/home/rayn/agent-dock-pre-gvisor-20260721.adbackup` 加密冷备，把精确旧 image ID 流式导入原生
  daemon，并恢复为同名 `agent-dock-production` volumes/runtime。旧 Desktop runtime 可恢复地保存在
  `deploy/production/runtime-desktop-pre-gvisor/` 且已被 Git 忽略，没有删除用户对话或凭据。
- 真实 GitHub 路径修正：首次真实 token gate 在模型调用前揭示 WSL 上的 `runsc`/KVM 无法访问用户自定义 Docker bridge 的
  `127.0.0.11` embedded DNS；相同 workload 使用 legacy default `bridge` 时会直接获得 WSL resolver 并可验证 exact commit。
  因此删除可配置 repository network、Compose network bootstrap 和专用 bridge，固定 importer 使用 `bridge`。AgentDock 常驻服务
  均不加入该 bridge；importer 没有凭据、prompt、mount、port、hook 或用户命令，只执行由代码构造的 GitHub exact-commit fetch。
  普通 Pi/Tool activation 仍严格为 `network=none`，没有把这一修正变成 Agent 的通用网络能力。
- 真实闭环验收：修正后从 `mathewjonas/java-calculator-junit` 精确 commit 导入成功，在同一 Session 连续完成两个
  `deepseek-v4-flash` turn；分别产生 628/379 events、25/9 次工具调用和 3,007/4,103-byte cumulative patch，第二轮复用同一个
  13,904-byte immutable source snapshot。usage ledger 记录 27 次真实 model call、8,266 input、5,977 output、192,384 cache-read、
  0 cache-write tokens。运行中抽查 Tool 为 `runsc`、`network=none`、`4.19.0-gvisor`、UID 1000、read-only、零 mount/socket；
  完成后 importer 与 managed Tool 容器均为 0。
- 能力边界：当前交付仍是 loopback/self-hosted 多租户产品，不声称已经完成 hostile public-Internet SaaS 的身份恢复、滥用治理、计费或
  独立渗透测试。这个限制不再来自 Tool kernel fallback；所有可达的用户代码执行路径现在都必须通过 gVisor/KVM attestation。

## 2026-07-21 — Kubernetes + gVisor 执行面升级

- 架构：ADR-0039 用 `KubernetesGvisorSandboxProvider` 完整取代 Manager 直接持有 Docker socket 的生命周期实现。K3s embedded
  containerd 通过 `RuntimeClass/agent-dock-gvisor -> io.containerd.runsc.v1 -> runsc/KVM` 启动每个 active Turn 的独立 Pod；同一
  Turn 内所有工具复用该 Pod，任何终态都先 checkpoint 再 UID-fenced 删除，后续 Turn 从 PostgreSQL/MinIO 恢复到新 Pod，冷 Session
  不占 Pod。Pi、模型能力与 transcript 仍在 trusted Runner，用户代码只在 credential-free Tool Pod 中执行。
- 权限：Sandbox Manager 改用官方 Kubernetes JavaScript client，作为非 root Compose 服务运行且没有 Docker/containerd socket。
  独立 kubeconfig 只允许两个 execution namespace 的 Pod/log/attach/exec、NetworkPolicy 读取，以及读取唯一命名 RuntimeClass；Tool 与
  Importer ServiceAccount 不挂 token。Restricted Pod Security、固定 PodSpec、non-root/read-only/cap-drop/seccomp、memory-backed
  workspace、cgroup/rlimit/output/timeout 和 default-deny NetworkPolicy 共同构成纵深边界。
- 导入：public exact-commit import 独立到 `agent-dock-importers` gVisor Pod，只开放 DNS 与排除私网后的 TCP/443，不接收 prompt、凭据、
  PodSpec 或任意命令，也不执行 hooks/submodule/LFS/repository code。真实排障发现 WSL2/K3s 路径的 GSO 会造成 HTTP/2 framing error 与
  30 秒 TCP retransmission，因此保持 `network=sandbox`，显式关闭 host/software GSO，并固定 Git HTTP/1.1；Kubernetes `emptyDir` 的
  root owner 则用命令级 `safe.directory=/workspace` 处理，没有关闭全局 Git ownership 防护。后续门禁又捕获一次公共网络瞬时 stall，
  因此 exact-commit fetch 增加 20 秒 low-speed threshold、45 秒单次 deadline 与最多三次有界重试；一次 54.566 秒实测已证明首连接超时后
  第二连接成功，紧接的正常路径为 8.311 秒，协议/身份/快照策略错误仍不重试。
- 自动证据：`sandbox:check` 现会真实导入
  `mathewjonas/java-calculator-junit@0b7314b2f25b83794bf0d52f13f4f750eb0f4bdb`，再验证 runsc/KVM、host identity concealment、
  credential/`/proc`、内网/公网、cross-tenant workspace、path/symlink、CPU/memory/process/output/timeout、cancel descendants、
  orphan cleanup 与真实 pinned-Pi remote tools；结束后两个 namespace 的 managed Pod 都为 0。
- 真实产品验收：保留原多租户 PostgreSQL/MinIO/观测与 Web 产品面，滚动部署新 Manager/Tool image 后，从上述 exact commit 连续完成
  两个 `deepseek-v4-flash` Turn。第一轮产生 413 events、23 tool calls、3,628-byte patch；第二轮恢复同一 Session/Workspace 后产生
  254 events、7 tool calls、5,204-byte cumulative patch。ledger 记录 22 model calls、6,468 input、5,490 output、145,408
  cache-read、0 cache-write tokens；13,904-byte immutable source snapshot 没有重复导入，终态后 Tool/Importer Pod 均为 0。
- 边界：这是单节点、loopback/private self-hosted 的可部署与可复现结果，不是独立渗透测试或 hostile public SaaS 声明。Kubernetes
  负责调度/资源/策略，gVisor 负责缩小 syscall 攻击面；宿主管理员、K3s/containerd/runsc、KVM 与 host kernel 仍在可信计算基中。

## 2026-07-21 — 按需激活、Session 热复用与异步批量事件

- 根因测量：改造前一次无 Tool Call 的真实聊天仍同步支付约 4.1 秒 Pod 创建/Workspace 恢复，首字约 6.68 秒、总时长约 13.4 秒；152 个
  text delta 又逐个执行 spool、WebSocket、PostgreSQL transaction、ACK，模型结束后约 3.9 秒才排空。ADR-0040 因此保留 gVisor
  安全边界，修改的是生命周期和背压位置。
- Sandbox：Manager 的 `create` 改为逻辑 reservation，第一次经过 capability 鉴权的 Tool operation 才 singleflight 创建 Pod。健康 Pod
  仅能按 tenant/project/workspace/session 精确键热复用；复用要求 committed Workspace SHA 一致、严格递增 fence，并用 UID 与
  `resourceVersion` 前置条件原子 patch/reverify Attempt/Turn 注解。capability 每 Run 轮换，失败、取消、revision mismatch、TTL、LRU
  与 shutdown 均销毁。纯聊天的根 `AGENTS.md` 从可信侧已提交 snapshot 注入，Pi 启动不再为了读取说明文件而隐式激活 Pod。
- Checkpoint：Pi JSONL 与 Workspace snapshot 分离。每个 settled Run 都提交 conversation checkpoint；只有 materialized Tool Sandbox 才
  capture Workspace。失败回滚分别恢复最近 completed Pi 指针与 settled Workspace head，热 Pod 永远不替代 PostgreSQL/MinIO 权威状态。
- Event：Pi 首个 text delta 立即输出，其后相邻同 content block delta 按 50 ms/2 KiB 聚合；每个公共事件仍先 fsync 本地 spool，随后由
  有界异步 publisher 以最多 64 event/512 KiB 的 `event.publish_batch` 发送。Control Plane 单事务提交连续 batch 并返回 cumulative ACK，
  terminal 返回前强制 drain；100-event 确定性测试验证 64+36 两批与 spool 清空。
- 真实 DeepSeek/Kubernetes 验收：revision `db70dd6` 在同一 Session 连续执行 chat → cold coding → warm coding → chat。首次聊天 0 Pod、
  0 Tool，首字 2.410 秒、terminal 3.174 秒；工具后聊天首字 2.029 秒、terminal 2.843 秒，Pod identity/fence 未变。首次 Tool 冷激活约
  3.704 秒，下一 Run 首个 warm Bash 为 201 ms；两轮 Pod name/UID 完全相同，fence 2→3、Attempt/Turn 已更新，guest 仍为
  `4.19.0-gvisor`。四轮 terminal event production→persistence/SSE 为 80–201 ms。详细原始身份与边界见
  `docs/reports/demand-activated-sandbox-latency-2026-07-21.md`。
- 最终生产门禁：热 Pod 首次进入 Supervisor inventory 后暴露了 strict protocol 边界中多返回内部字段的问题，现已显式投影为闭合的
  `SupervisorRuntimeAssignment` 并增加 live rebind → inventory → retirement 测试。取消验收也不再依赖旧 eager Pod，而是让 fake model
  发出 300 秒 Bash、等待 gVisor workspace container Ready 后真实取消；目标 Pod/Lease 被删除，其他 Session 热 Pod 不受影响，随后通过
  fresh Boot retirement 清零。完整 disposable production acceptance 通过四租户、Control Plane 重连/扩缩、22 条事件重放、31 条审计、
  7,382,120-byte 加密备份与 cursor 34 的恢复后继续执行，结束时受管 Pod 为 0。

## 2026-07-22 — 移除单次 Run 累计 Token 上限

- 根因：计数排序 Run `d4237ce4-7e2a-4a41-9061-a8c00d4cfa83` 的前五次 DeepSeek 请求均返回 HTTP 200，五次 Tool Call
  也全部成功；实际累计用量为 173,623 tokens，其中大部分是后续 Agent Loop 重复上报的 cache-read context。第六次请求在
  Provider 出站前按 47,817 input + 8,192 output 预留时超过旧 200,000 单 Run 上限，被 `run_token_budget` 拒绝。故障与
  DeepSeek 网络、Kubernetes 或 gVisor 无关。
- 决策：ADR-0041 删除累计单 Run Token 限制，而不是简单调高默认值。模型请求次数、单 Run 成本、Tool Call/输出、Run wall-clock、
  tenant daily tokens 和 monthly cost 仍保留；input/output/cache token 仍完整进入 `model_requests`、usage ledger、成本计算和
  tenant daily quota。
- 实现：migration 014 删除 `maximum_tokens_per_run` 及其 compaction 联动约束；公开 governance schema、Supervisor budget snapshot、
  Outbox、Model Gateway capability/聚合检查和 Web governance 卡片同步删除该字段。旧客户端继续发送 `maximumTokensPerRun` 会因闭合
  schema 明确失败，不会被静默忽略。历史 request/usage 与既有 `run_token_budget` 审计行不删除。
- 回归：新增迁移 up/down 测试，证明删除字段后 compaction 配置独立生效、其他治理约束仍有效，回滚时可为现有配置恢复足够大的兼容列；
  Model Gateway 测试把同一 Run 的已完成 cache-read usage 提高到 250,000 后仍成功完成新的上游请求，同时 request-count exhaustion
  仍在出站前被拒绝。协议测试证明旧字段被拒绝，Control Plane/API/Web 对应测试均通过。
- 门禁：干净依赖树上的全仓 format/build/typecheck/test、两个零 Token Pi spike、备份密码学和 high-level security audit 全部通过；
  真实 `sandbox:check` 再次通过 RuntimeClass → runsc/KVM、跨租户/凭据/网络/资源隔离、warm rebind、纯聊天零 Pod 以及 pinned Pi
  remote-tool 修复闭环。门禁期间 npm 新发布的 `fast-uri` high advisory 被直接升级到修复版本 3.1.4/4.1.1，没有降低审计等级；最终
  remaining high/critical vulnerabilities 为 0。

## 2026-07-22 — 版本化 Project Environment Plane

- 问题：此前所有 Project 隐式使用部署时的同一 Tool image。Run 没有保存环境身份，镜像滚动会覆盖“这次任务究竟在哪个工具链上执行”的
  事实，Session warm Pod 也只校验 Workspace revision，无法证明复用的是同一开发环境。单纯让浏览器或模型传 Docker image 又会把供应链和
  Kubernetes 策略控制交给不可信输入。
- 决策：ADR-0042 引入 append-only `environment_versions`。Project 只有一个 active version；Turn acceptance 把 environment UUID、版本、
  固定 `agent-dock-fullstack/1` profile、部署 image revision 和 canonical spec SHA-256 快照进 Run。Control Plane 与 Sandbox Manager 都必须
  配置同一 immutable revision，升级只为后续 Run 生成新 version，旧 Run 不被静默改写。
- 执行：环境快照经过 durable outbox、Supervisor wire、Tool reservation 到 gVisor Pod。Tool Worker 在 Workspace restore 和任何用户命令前
  用镜像构建时写入的只读 revision 文件校验物理 image，而不是相信 Manager 注入的自报值；随后用绝对路径有界探测 Node 24、Java 17、
  Python 3.11、Git 2。Provider 再合并真实 runsc/gVisor、deny-all、UID/GID 1000:1000 和 read-only rootfs 证据。任一不匹配都在
  repository code 执行前 fail closed。
- 持久化：成功的 Tool Run 在 fenced Workspace checkpoint 事务内写 append-only `environment_validations`，并把 Project environment projection
  更新为 validated。pure chat 仍只保存逻辑 snapshot、0 Pod；warm reuse 同时要求 committed Workspace SHA 和完整 environment identity，
  环境滚动会销毁旧 Pod。Web header 显示 pending/validated/failed 与实际工具版本。
- 回归与生产修正：新增 migration up/down、闭合 protocol、Manager policy/reuse、Pod annotation、worker revision、checkpoint evidence 与
  production composition 回归。第一次 live Run 在模型出站前 fail closed，证明 Remote Control Plane 组合层遗漏了
  `environmentImageRevision`；修正后生产 Store、Manager policy 和物理 Tool image 均锁定 revision
  `37a26878d210eae83a3ca9a994fadc9abd041492`，不再回落到 `development`。全仓 format/typecheck/test 通过。
- gVisor 门禁：一次 Docker Compose 重建后，长期运行的 K3s/runsc 网络状态出现 public TLS stall；同 namespace/NetworkPolicy 的 runc 对照
  Pod 可连接、gVisor Pod 不可连接，重启 K3s 执行面后恢复。没有降级 runtime 或放宽 egress。随后干净 `sandbox:check` 通过 exact-commit
  import（7.837 秒）、隔离安全契约（22.318 秒）、同环境 warm rebind（4.420 秒）、pure chat 零 Pod 与 pinned-Pi remote repair；结束时两个
  execution namespace 均无受管 Pod。
- 真实闭环：production Web/API 使用 `deepseek-v4-flash` 在 Session `ce56b501-58b5-4de7-b980-87162cf7ffae` 完成两轮 Java coding Run，均为
  completed。第一轮 144 events/18 tool calls/4,313-byte patch，第二轮 64 events/6 tool calls/5,374-byte cumulative patch；19 次真实模型调用
  实耗 6,616 input、5,028 output、120,320 cache-read、0 cache-write tokens。两轮复用同一 gVisor Pod UID
  `96ce5ff7-c14a-4d75-bfa9-72d208e76142` 和 activation，fence 1→2，随后通过受信 inventory/terminate protocol 精确回收。
- 落库证据：environment version `3b6bbb64-c3f8-4d97-98de-805169985831` 为 validated，并为两个 Run 分别保存 append-only validation；报告
  attests `runsc`/`gvisor`、deny-all、UID/GID 1000:1000、read-only rootfs、Node 24.18.0、OpenJDK 17.0.19、Python 3.11.2 与 Git 2.39.5。
  immutable 13,904-byte GitHub source snapshot 未在第二轮重复导入，验收结束后 Tool/Importer Pod 都为 0。

## 2026-07-22 — Cursor-informed Environment Configuration as Code

- 取舍：依据 ADR-0043，保留现有 PostgreSQL RunAttempt/Lease/Fence 协议而不为了技术名词迁移 Temporal；先实现 Cursor 经验中对现有依赖最强的
  Environment-as-code。环境 Recipe 只能描述最多 10 条 setup 与 10 条 verification 命令、固定 cwd/timeout/network class；image、PodSpec、
  RuntimeClass、挂载、资源与平台网络仍完全属于 operator policy。
- 执行边界：Recipe 和 canonical SHA-256 进入 Run immutable snapshot，经过 outbox、Supervisor、Manager 到 Tool Worker。Worker 在 Workspace
  restore 后、Agent Tool 开放前执行命令，校验 symlink/realpath 边界并管理 process group、timeout 与输出上限；持久证据只含 command ID、phase、
  exit/duration 和 output hash，不把原始安装日志带回可信控制面。`dependency` 网络在 allowlist proxy 完成前 fail closed。
- 生命周期：owner 编辑配置只会创建 pending/inactive candidate。真实 validation 是一个绑定候选环境的普通 durable Run；成功的 fenced
  checkpoint 才写 append-only physical evidence 并置为 validated。激活/回滚要求 expected-active CAS，只接受当前部署 image 下的 validated
  version，并在同一事务记录 actor/from/to/idempotency audit。失败候选不可重试或篡改，只能从历史派生新版本。
- 产品：Session inspector 新增 environment 页，显示版本、recipe hash、gVisor/runsc/network/user 证据、每条 recipe command hash 与审计轨迹，
  并提供 create candidate、validate、activate/rollback 操作；普通用户仍不看到模型密钥或 Kubernetes 控件。
- 回归：新增 recipe canonical/closed-schema、Worker 命令执行与无网络 fail-closed、migration backfill/constraint/down、service idempotency/CAS/rollback/
  tenant isolation 和 Web API 测试；完整 Control Plane 回归的 108 passed/3 environment-conditional skipped 测试保持通过。

## 2026-07-22 — Cursor-informed Multi-repository Workspace

- 产品：新建 Project 时可提交 2–8 个 public exact-commit 或 tenant-allowlisted GitHub App repository，并为每个仓库指定唯一、规范化的顶层
  root。Web 对话产品提供闭合 JSON manifest 输入和 Workspace root/repository 投影；单仓库与内置 source 保持兼容。
- 耐久性：migration 017 增加不可变 repository child rows，并为每个 Run 回填/写入 canonical `source_set_snapshot`。Turn 返回 202 前已经冻结
  repository identity、exact SHA、root 和 private metadata；Runner 只使用该 Run snapshot，当前 Workspace source 与单仓 snapshot 不一致时在
  GitHub 出站前 fail closed。
- 执行：public repository 继续经过 credential-free gVisor importer，private repository 继续经过 trusted GitHub Gateway。每个 safe manifest
  按 root 前缀合并，再统一校验 path/file/byte limits；并发首次激活仍共享一个 import lease，ready seed 内容寻址且后续多轮不重复导入。
- 边界：repository-set 目前不开放自动 PR delivery。一个 cumulative patch 可能跨多个 root，系统不会猜测目标 repository；后续需要显式的
  root-aware patch/branch/PR mapping 才能启用。
- 回归：protocol 46、database 33、workspace runtime 3、Web 29、Supervisor Host 26 和 Control Plane 109 个测试通过；另外 3 个环境条件测试按
  设计跳过。覆盖 migration 回填/拒绝有损回滚、duplicate root、snapshot drift、两个 manifest 合并、ready seed reuse 和共享调度队列隔离。

## 2026-07-22 — Capability-scoped Dependency Egress

- 边界：Environment recipe 只有 setup command 可声明 `network: dependency`，并必须绑定 canonical exact-host allowlist。Sandbox Manager 在可信侧
  持有 Ed25519 issuer 私钥，为一次 bootstrap activation 签发同时限制 host、有效期、连接数、并发、字节与持续时间的 capability；Kubernetes
  只接收公开验证键。CONNECT proxy 每次解析域名并拒绝 loopback、private、link-local、cluster/node 等非公网地址，不进入任何平台网络。
- 两阶段执行：最初尝试在同一 Pod 上移除 dependency label 并等待 CNI 收敛，真实测试证明该节点的 selector 更新超过 120 秒仍未可靠撤销，系统按
  设计 fail closed。最终删除这条动态重标路径：联网的 `dependency-bootstrap` gVisor Pod 只执行 setup，命令结束强杀整个 process group；随后
  capture Workspace、按 UID 删除并确认该 Pod 消失，再把内容恢复进一个从未拥有 egress label、proxy token 或联网进程的新 gVisor Pod。所有
  verification 与 Agent bash 都只在第二个 Pod 中执行。
- 恢复：bootstrap workload 不进入 Supervisor inventory。Manager 启动时先枚举并清理上次进程故障留下的 bootstrap Pod，正式
  `tool-sandbox` 才允许被 Session warm-reuse；因此旧联网 runtime 既不会被接管，也不会跨 tenant/session 复用。
- 真实验收：在 K3s 1.36.2、`RuntimeClass/agent-dock-gvisor`、KVM platform 上，通过 capability 对
  `registry.npmjs.org` 实际执行 `npm install is-number@7.0.0`；随后新 Pod 离线 `require` 验证成功，访问 `example.com` 失败，最终 Pod 没有
  dependency-egress label，且 bootstrap inventory 为 0。完整 gVisor gate 还通过 exact-commit GitHub import、跨租户文件隔离、凭据与宿主信息
  隔离、cgroup/进程/输出/超时限制、取消清理、warm fence rebind、纯聊天零 Pod 和真实 remote-tool repair；6 个 live integration tests 全部通过，
  结束时两个 execution namespace 均无受管 Pod。

## 2026-07-22 — Single-consumption Clean gVisor Prewarm

- 决策：ADR-0045 只预热固定 image/revision 的空 gVisor Pod，不预热租户 Workspace。Pool Pod 没有 tenant/project/workspace/session/attempt/
  lease/fence/sandbox-hash，没有 DNS、网络、ServiceAccount token 或凭据；只有空的 memory-backed volume、只读 rootfs 和等待首次可信初始化的固定
  Tool Worker。production target 为 2、claim TTL 为 5 分钟。
- 领取：第一次离线 Tool activation 从 pool 原子移除一个候选，再用 Pod UID 与 resourceVersion 前置条件把 metadata 单向绑定为
  `tool-sandbox`。绑定后才 attach、restore、验证 toolchain 和执行 recipe。领取或初始化失败会销毁 Pod；执行过租户代码的 Pod 只能精确 Session
  warm-reuse 或删除，永远没有返回 clean pool 的路径。dependency-bootstrap 不使用 pool，但它销毁后的新离线 Pod 可以领取 clean prewarm。
- 恢复与观测：`listAssignments` 只选择正式 `tool-sandbox`，不会把 prewarm 当成 Supervisor runtime。singleton Manager 启动先清理上次进程遗留的
  clean/bootstrap Pod，再补足目标；shutdown 删除全部 tracked prewarm。新增独立低基数
  `agent_dock_sandbox_prewarm{provider="gvisor"}` gauge，不把共享容量混入 active Session 数。
- 真实证据：K3s/runsc 测试在领取前证明 Pod metadata 不含目标 tenant，领取后 name/UID 不变、prewarm annotation 消失并绑定 exact Attempt，随后
  离线 Node Tool 成功且 effective isolation 仍为 `runsc` + deny-all。相同已缓存 image/command 下两次实测分别为 2,260 ms vs 4,073 ms、
  2,218 ms vs 4,379 ms（ready clean-prewarm vs fresh Pod）；used Pod 删除，补池产生新的 clean Pod，测试退出后无残留。

## 2026-07-22 — Capability-scoped Public GitHub Import

- 根因与取舍：完整 gVisor 回归连续暴露 public GitHub importer 直连 TLS stall，而宿主 `git ls-remote` 正常。没有重启掩盖、切回 runc 或放宽
  NetworkPolicy；按 ADR-0046 将 importer 迁移到 ADR-0044 的签名 CONNECT proxy。Importer 现在无 DNS、无任意公网，唯一 L3/L4 路径是
  proxy ClusterIP；每次 import 的 Ed25519 capability 只允许 `github.com:443`，并限制有效期、连接、并发、字节与持续时间。
- 升级安全：沿用原 NetworkPolicy 对象名并原地替换其内容，避免 `kubectl apply` 升级后遗留旧 broad-public rule。Provider readiness 同时验证
  importer→proxy、bootstrap→proxy、proxy ingress/default-deny/public-resolution 四组有效策略；缺一即 fail closed。
- 协议与 Git：闭合 importer request 必须携带可信侧生成的 proxy bootstrap；Pod metadata、环境和 Workspace 不保存 capability。Proxy 补齐标准
  Basic 407 challenge，Git 通过 process-local config 明确使用该代理，仍禁用 redirect、credential helper、hook、submodule、LFS 和交互认证。
- 真实证据：定向 runsc 测试 8.162 秒导入固定 commit，proxy audit 仅记录一个 `github.com` tunnel（10,945 bytes）且不含 token。随后完整
  `npm run sandbox:check` 通过 5 个 Manager live tests 与 2 个 trusted-Runner live tests：真实 npm 安装后最终 Pod 断网、clean prewarm
  2,350 ms vs fresh 4,448 ms、跨租户/资源/清理、warm fence rebind、pure chat 零 Pod及 remote repair 全部通过，最终输出
  `kubernetes_gvisor_sandbox_check_passed`。

## 2026-07-23 — Attempt Rewind and Immutable Review Bundles

- 状态与恢复：migration 018 为每个 Run 固化 conversation boundary、Workspace base version 与 Pi artifact；显式 rewind 只接受当前最新 terminal
  Attempt，要求 actor 与幂等键，并创建新 Run/Attempt。历史 events/Attempts 永不删除，API/SSE 将旧 Attempt 投影为 superseded、当前 Attempt 投影为
  canonical，旧 fence 不能推进 conversation 或 Workspace head。
- Review evidence：completed Run 在同一持久提交边界生成不可变 Review Bundle，canonical JSON 经过 SHA-256；内容包括最终 assistant 文本及 hash、
  source/environment snapshot、Attempt history、changed paths、patch/artifact 引用、测试结果和真实 usage。数据库 trigger 阻止 update/delete，Web 只渲染
  bounded escaped text，Artifact 仍走 tenant-scoped authenticated download。
- 验证：Control Plane 覆盖 owner/viewer/foreign-tenant、幂等 rewind、旧 Attempt 拒绝、Workspace/Conversation 精确回退与 Bundle 内容/hash/不可变性；fault eval
  新增 rewind boundary 与 immutable Bundle 两项并达到 12/12。并行全仓测试暴露的短暂 `SKIP LOCKED` idle 通过有界重试 helper 修正，2 秒内 mailbox 未被领取
  仍 hard fail，不掩盖 stranded work。

## 2026-07-23 — Versioned Helm gVisor Execution Plane

- 唯一来源：删除静态 execution-plane manifest，新增 `deploy/helm/agent-dock-execution-plane` 0.1.0 closed chart。RuntimeClass→`runsc`、四个 restricted
  namespace、tokenless ServiceAccount、resource-name-limited RBAC、default-deny/Proxy-only NetworkPolicy 和 ClusterIP identity 均不可通过 values 改写。
- 可用性：dependency/repository CONNECT proxy 默认两副本，RollingUpdate `maxUnavailable=0`、PDB `minAvailable=1`、topology spread 与显式资源限制；chart
  故意不部署 Runner/Ingress，维持 Supervisor 仅向 Control Plane 发起认证出站连接。
- 供应链与门禁：Helm 3.18.6/构建/SHA 固定；`helm:check` 对 29 个 rendered resources 做语义断言，并证明不安全副本数、滚动策略和未知 values 被 schema 拒绝。
  Supervisor image 另增递归 workspace dependency-closure gate；它在生产重启时真实捕获并修复了遗漏的 dependency-egress-proxy runtime package。

## 2026-07-23 — Cursor-informed Production Acceptance

- 测试隔离修正：live gVisor gate 原本生成临时 Ed25519 issuer，却复用生产 `dependency-egress-trust` ConfigMap，导致测试结束后生产签名 key 与 Proxy trust
  fingerprint 分叉。门禁现在只使用部署配置的 issuer，不再轮换共享 trust anchor；生产 Manager 重启后验证 ConfigMap 与 Proxy 实际 fingerprint 已恢复。
- gVisor 实测：5 个 Manager live tests 与 2 个 trusted Runner tests 全部通过，包括固定 GitHub commit、真实 npm 安装后换入全新离线 Pod、single-consumption
  prewarm（2,357 ms vs cold 4,256 ms）、跨租户/凭据/资源/输出/清理和 warm fence rebind；最终无 Tool/Importer 残留。
- 真实模型：最终 commit/OCI/environment revision `bb855b74da1056422ce8755232e3a6200c1b7647` 部署后，production Web/API 使用
  `deepseek-v4-flash` 对固定 commit 连续完成两轮 Java coding。共 34 次请求、6,797 input、8,771 output、244,480 cache-read tokens；第一轮
  174 events/29 tool calls/4,895-byte patch，第二轮 170 events/17 tool calls/6,782-byte cumulative patch。第二轮先持久记录两次 failed test，再由 Agent
  修复并记录 passed；两轮 Review Bundle hash 复算一致且二次读取完全相同。
- 生命周期证据：两轮复用 Pod UID `714fed06-da04-49e9-8899-13861bd50d7e` 与同一 activation，fence 1→2；exact source snapshot 未重复导入，最后通过受信
  inventory/terminate-and-confirm 协议删除该精确 UID。脱敏报告保存在 `docs/reports/real-model-acceptance-latest.json` 和 `.md`。

## 2026-07-23 — Helm Release Takeover and Post-upgrade Acceptance

- 实际接管：使用固定 Helm 3.18.6 对既有 execution plane 执行 `upgrade --install --take-ownership`。低权限 Manager 随后读到
  `RuntimeClass/agent-dock-gvisor`、proxy Endpoints 与 trust ConfigMap 的 `managed-by=Helm`、release name/namespace 元数据；RuntimeClass handler
  仍为 `runsc`，Service 同时包含两个 Ready Pod UID。Manager 对 Deployment、PDB 和 NetworkPolicy 的读取仍被 RBAC 拒绝，证明 Helm 部署没有扩大
  运行时身份权限。
- 信任链：从生产 capability issuer 私钥只派生公钥指纹，与 Helm 接管后 ConfigMap 以及 Service 的 8 次 `/health/ready` 返回逐一比较，全部为
  `840148802ac2838a51a66c070c970cc53cb6741ca0623d3de24a870192c61d49`；未输出、复制或注入生产私钥。
- 升级后 gVisor 门禁：5 个 Manager live tests 与 2 个 trusted Runner tests 全过。覆盖 restricted GitHub import、真实 npm dependency bootstrap 后销毁联网
  Pod 并换入 fresh offline Pod、clean prewarm（2,488 ms vs cold 4,214 ms）、跨租户/资源/输出/精确清理、warm fence rebind、纯聊天零 Pod与 Pi remote repair。
- 升级后真实模型：production Web/API 再次用 `deepseek-v4-flash` 完成同一 Workspace 的两轮代码修改，实际产生 24 次 model call、5,675 input、
  4,877 output、123,008 cache-read tokens，以及 31 次 Tool Call。两轮分别生成 4,180/4,962-byte cumulative patch 与内容哈希固定的 Review Bundle；
  同一 gVisor Pod fence 1→2，结束后精确回收。最新脱敏报告覆盖写入 `docs/reports/real-model-acceptance-latest.{json,md}`。

## 2026-07-23 — Legacy Environment Evidence Compatibility Repair

- 根因：Environment Recipe 上线前写入的 6 条 `validated` evidence 使用旧 JSON shape；migration 016 为 `environment_versions` 回填了默认 Recipe，
  却没有同步升级既有 `environment_validations.report`。新 Control Plane 打开历史会话时通过闭合 schema 解析 active environment，因缺少
  `recipeSha256` 和 `recipeCommands` 而返回 `Project environment validation evidence is invalid`。新项目正常，因此此前生产双轮验收没有覆盖这个
  upgrade-only 路径。
- 修复：migration 019 只选择 validated、JSON object 且缺少 Recipe evidence 的历史行，将原始 JSON 保存到独立 backfill ledger，再从对应 immutable
  environment version 写入真实 Recipe hash，并以空 command evidence 明确表示旧版本未记录逐命令结果。当前格式报告保持逐字不变；新增数据库约束禁止未来
  validated evidence 再缺少这两个字段；down migration 先移除约束，再从 ledger 精确恢复原始 JSON。
- 安全上线：全仓 CI、35 项数据库测试和 high-level security audit 全过。部署前确认 active Run 为 0，构建 revision
  `137032d323fe390d2d45a67b24f7f2888917cb2a`，生成独立密钥保护的 33,089,358-byte 冷备后才启动新版本。bootstrap 确认 migration 019 applied，
  6 条旧 evidence 全部修复，12 条 validated evidence 的当前 schema 均完整。
- 产品验收：在新生产 Control Plane 内使用与 HTTP API 相同的 `ControlPlaneStore.getConversation()` 逐一读取全部 351 个既有 Session；351/351 成功、
  0 failure。12 个 Compose 服务随后全部处于 running 且 healthy/no-probe 状态。

## 2026-07-23 — Semantic Conversation Projection and Capability-free Provider Egress

- 外部实现取舍：调研 `maidangzhu/cloud-agent-platform` 后，没有照搬其 Vercel Sandbox、Redis Pub/Sub 或前端拼装原始事件的路径；保留现有自托管
  PostgreSQL durable log、Outbox、RunAttempt/Lease/Fence 与 Kubernetes + gVisor 执行面，只吸收适合当前系统的两点：独立的语义会话读模型，
  以及受信网络出口与 Agent Runner 解耦。
- 会话投影：migration 020 增加 terminal-turn semantic projection。`turn.completed` 在检查 Attempt lease/fence 后，与 durable event 持久化位于同一
  PostgreSQL 事务；投影保存 bounded text/thinking/tool summary、来源 event high-water 和版本，原始 durable events 与 Pi JSONL 继续作为权威事实源。
  `getConversation()` 对历史 Session 做惰性修复，Web 先加载语义投影，再从 `replayAfterSequence` 继续 SSE，因此不会重新传输并在浏览器拼装全部历史
  token delta。
- 模型出口：Supervisor 不再加入具有宿主外联能力的网络。新增 private `model-egress` 与两段 relay：bridge 仅在内部网络接受 CONNECT，host relay
  使用私有 Unix socket 与 bridge 通信、只允许 `api.deepseek.com:443`，并可复用宿主既有 HTTPS proxy。两者均不持有模型/API/数据库凭据；
  Tool Sandbox 仍不加入任何 Compose 网络。直接解析模式还拒绝 private、loopback、link-local 和 reserved 地址。
- 验证：全仓 CI 通过（Control Plane 113 passed/3 environment-conditional skipped、database 36 passed），新增 relay 测试覆盖 allowlist、
  upstream proxy、普通 HTTP 拒绝、private DNS 拒绝与 direct CONNECT；production composition gate 验证 network membership、精确 proxy 配置、
  non-root、read-only、no privilege、no Docker socket/secret。
- 安全部署：在 active Run 为 0 时生成
  `/home/rayn/agent-dock-backups/pre-provider-relay-deploy-d216ae0.adbackup`（36,503,137 bytes、mode 0600），随后部署 revision
  `76f276fea94319c637ac47f5b2a972a5286bfa40`。首次启动暴露 one-shot volume bootstrap 在 drop-all capability 下的 chmod 顺序问题；
  修复为先 chmod 后 chown，并只为 bootstrap 增加 `CHOWN`/`FOWNER`，长期 relay 仍保持 drop-all。最终所有生产服务健康。
- 真实模型与 gVisor 闭环：production Web/API 使用 `deepseek-v4-flash` 完成两轮同一 Session 验收。纯聊天首字/settled 为
  4,127/4,332 ms，1 次真实请求消耗 65 input、27 output、1,280 cache-read token，0 Tool Call、0 Sandbox activation；第二轮编码
  首字/settled 为 5,186/5,793 ms，2 次真实请求消耗 182 input、200 output、2,816 cache-read token，在
  `RuntimeClass/agent-dock-gvisor` 内完成 1 次 Tool Call并产生 207-byte patch。
- 投影与清理证据：两轮共 15 个 durable events 投影为 2 个 turn/3 个 semantic items，`replayAfterSequence=15` 与 durable high-water 一致；
  精确 gVisor Sandbox UID `06cb040a-b632-495b-88ba-cb5760674a1f` 验收后已销毁。脱敏报告保存在
  `docs/reports/semantic-conversation-acceptance-latest.{json,md}`。

## 2026-07-23 — Bounded Parallel Candidate Races

- 产品闭环：Session Inspector 新增 `parallel` 页。用户可从当前 immutable
  WorkspaceVersion 一次创建 2–4 个策略候选，设置 race 内并发上限和
  patch/test/path policy；候选卡片实时显示 Run、验收、测试、路径、token、
  成本和耗时，可打开独立子会话、取消整场 race，并显式提升推荐或任一通过
  的候选。普通会话列表隐藏内部候选，避免把 orchestration 细节混入产品导航。
- 耐久协议：migration 021 增加 tenant-bound Orchestration、Candidate、
  Dispatch、Acceptance、DecisionGate 和 Promotion。fan-out 与
  Turn/Command/Run/Outbox 在一个事务创建；现有 tenant-fair dispatcher 外再
  加 race concurrency gate。取消覆盖 queued、active 以及 claim/ACK 竞态；
  Acceptance append-only，promotion 要求 passing evidence、父 Workspace
  expected-version CAS、无未完成父 Run，并只复制候选 Workspace artifact，
  保留父 Pi artifact 和对话。
- 执行隔离：每个候选是独立 Session/Run/Attempt，由同一可信 Supervisor
  并发代理到不同 Tool activation 和不同 gVisor Pod；候选不共享可写
  Workspace。模型看不到 Pod、runtime、lease、winner authority 或 promotion
  凭据。完成后通过受信 inventory + terminate-and-confirm 按 UID 精确回收。
- 验收语义：首轮真实测试暴露把 red→green 历史累计成失败，第二轮又暴露
  `ls ... test.sh` 被正则误当测试。最终实现保守的 shell command classifier：
  解析 compound command，只识别受支持 runner/script，忽略 `cd/chmod`
  准备段，规范化 `/workspace` 路径并拒绝 incidental filename。Review
  Bundle 继续完整保留每次 red/green attempt，Acceptance 对同一 canonical
  invocation 只采用最终结果。
- 生产上线：部署前 active Run 为 0，并生成
  `/home/rayn/agent-dock-backups/pre-parallel-candidate-races-3d6ba17.adbackup`
 （35,987,342 bytes、mode 0600）。migration 021 已应用；所有既有租户
  concurrent-turn quota 至少为 2；最终 production revision
  `176de64dc561effaea6496fd9d868f77c2c52ab8` 的服务全部健康。
- 真实模型证据：`deepseek-v4-flash` 先用 6 次请求修复父基线，再以并发 2
  运行两个 subtract 候选。race 15,681 ms settled，两个 Run 时间区间重叠；
  候选分别使用 7/8 次模型请求、1,164/1,026 input、664/776 output 和
  13,312/16,128 cache-read tokens。两个候选都只修改
  `src/Calculator.java`，完整 Bundle 分别保留 2/3 次测试尝试，最终有效结果
  均为 1 passed、0 failed。
- 物理证据：同时观测到两个 `RuntimeClass/agent-dock-gvisor` Pod，UID 为
  `f347e02c-6244-4e50-9f79-5bdff6a603cd` 与
  `1e90c423-e38c-4a58-a7b7-8b32be62b549`，Tool activation 为
  `97a4da3d-a97c-41a0-9905-abb366861d53` 与
  `e08b552a-42f7-43b8-88b4-8cd3aa2c6f41`。稳定评分推荐 Minimal patch，
  CAS promotion 后父 Pi artifact 保持不变；父/两个候选共 3 个分配均精确
  销毁，最终 active Run 和受管 Tool Pod 都为 0。脱敏报告保存在
  `docs/reports/parallel-candidate-race-acceptance-latest.{json,md}`。
- 边界：这次实现的是有界 fan-out/fan-in、确定性验收和人工 promotion，
  不是无限递归 subagent tree 或通用 task DAG；CubeSandbox/microVM provider
  仍是可选的未来执行后端，不把它虚构为已完成能力。

## 2026-07-25 — CubeSandbox Primary Tool Execution Plane

- 架构：普通用户消息仍由可信 Control Plane、Supervisor Host 与 Pi Worker 池执行
  Agent Loop，模型凭据、对话状态、RunAttempt、Lease 与 Fencing 均不进入
  Sandbox。Pi 的 `read/write/edit/bash/git` 调用经既有 narrow Tool RPC 到
  Sandbox Manager，再映射为一个绑定 tenant/session/run/attempt/fence 的
  CubeSandbox KVM microVM；Cube 负责 microVM 生命周期与执行代理，AgentDock
  继续负责多租户授权、调度、公平性、幂等、checkpoint 和最终清理。
- 主方案：production 默认 Provider 已切换为 CubeSandbox，不保留普通 Tool
  execution 的 runc/runsc 兼容分支。gVisor 只保留在受信 exact-commit importer
  与确定性回归测试中，不承担 Agent 生成代码的生产执行。Cube API key、cluster
  endpoint 和 template evidence 只由 Sandbox Manager 读取，Pi Worker、Tool
  guest、Web 和模型上下文均不可见。
- 供应链：固定上游 `TencentCloud/CubeSandbox@v0.6.0`
  (`8721dd151971ce3c2966482bbd32904ad98f378e`)；生产模板从当前 clean Git
  revision 构建并推送私有 registry，记录 image digest、template ID 与精确源码
  revision。部署在证据缺失、模板 revision 不匹配或 API key 权限不安全时
  fail closed。
- 实际部署：在本机 K3s/KVM 安装 CubeSandbox，并将 Pod 网络 MTU 固定为 1450
  以匹配 WSL2 路径；Control Plane 通过 loopback relay 访问 Cube API/Proxy，
  Tool guest 没有平台网络、模型凭据、数据库凭据或 Kubernetes/Docker 管理面
  权限。镜像验证覆盖非 root、no-new-privileges、零 capability、固定
  Node/Java/Python/Git 工具链及路径穿越拒绝。
- KVM 隔离门禁：真实 Cube guest 在 7,911 ms 内完成两次隔离执行，guest kernel
  与 host 不同，3 个受禁端点及公网访问均失败；取消会销毁 microVM，最终
  orphan count 为 0。
- 真实产品验收：production Web/API 使用 `deepseek-v4-flash` 完成一轮纯聊天和
  同一 Session 的两轮 counting-sort coding。纯聊天 0 Tool/0 Cube activation；
  两轮编码分别执行 2/3 次 Tool Call、各创建并销毁一个不同 KVM guest，第二轮从
  durable Workspace 恢复第一轮文件并产生第二个 immutable version。8 次真实模型
  请求消耗 2,071 input、1,834 output、21,120 cache-read tokens；82 个 durable
  events 投影为 8 个 semantic items，跨租户 conversation/API 访问被拒，结束后
  两个验收租户的残留 microVM 均为 0。脱敏证据保存在
  `docs/reports/cubesandbox-production-acceptance-latest.{json,md}`。
- 验收边界修正：SSE `turn.completed` 表示 Agent 已 settled，而 durable Run
  `completed` 才表示 Workspace head 与 Run state 已在最终事务中提交。真实验收
  现在显式等待第二个边界后再读取 Workspace version，避免把合法的短暂提交窗口
  误报为数据丢失。
# 2026-07-25: Horizontal Pi Worker pool and native compact recovery

- Replaced the exact single-Supervisor enrollment policy with a bounded Worker
  ID prefix and operator-owned management URL template.
- Registered and persisted each Worker's private management endpoint, then
  routed exact-boot retirement to the owning Worker.
- Moved Control Plane artifact reads to the shared S3-compatible store.
- Production now starts two trusted Pi Workers with independent boot ledgers,
  event spools, identities, capacity, and failure domains.
- Added multi-connection lane tests and a real pinned-Pi test that forces native
  threshold compaction, captures its JSONL entry, restores it in a fresh Pi RPC
  process, and continues the conversation.
- Recorded the precise PostgreSQL projection versus Pi JSONL checkpoint
  persistence contract in ADR-0054 and
  `docs/PI_WORKER_POOL_AND_SESSION_PERSISTENCE.md`.
- Added a real-model Worker-pool acceptance gate. It stopped the Worker that
  handled the first Run, restored the next Run on the surviving Worker, and
  recovered a random marker from the prior Pi checkpoint. Four simultaneous
  follow-up Sessions occupied both independent Worker connections.
  The latest six real DeepSeek requests consumed 496 input, 1,252 output, and 7,680
  cache-read tokens; sanitized evidence is stored in
  `docs/reports/pi-worker-pool-acceptance-latest.{json,md}`.
- Fixed Compose network-alias inheritance so the second Worker cannot answer
  the first Worker's exact management address. The full production drill now
  restarts the owning replica, preserves the peer replica's prewarm resources,
  and verifies exact old-boot retirement.

## 2026-07-25 — Durable orchestration and conversation-storage selection

- Added an adopt-before-build repository rule: evaluate active open-source
  infrastructure from established companies/foundations before implementing a
  distributed subsystem, select on semantics rather than stars, keep an
  AgentDock adapter/exit path, and assign one durable authority per concern.
- Compared Temporal, Cadence, Dapr Workflow, Argo Workflows, Conductor, and the
  current PostgreSQL dispatcher using official docs, repositories, licenses,
  releases, TypeScript support, failure semantics, and operational topology.
- ADR-0055 selects Temporal as the preferred future post-admission Run
  orchestrator, but production remains on the current dispatcher until an
  isolated parity/fault/security/performance/rollback gate passes. Temporal
  must replace, not duplicate, the matching authority.
- The target uses one bounded Workflow per Run. PostgreSQL retains transactional
  HTTP acceptance, tenant fairness, Session mailbox order, product projections,
  usage and checkpoint heads; Kubernetes scales Pi Workers; Cube schedules Tool
  microVMs. Temporal histories carry only bounded IDs/hashes/references.
- Selected a Pi checkpoint-v2 direction using tenant/session-scoped,
  line-aligned content-addressed JSONL segments plus immutable manifests and
  the existing fenced PostgreSQL head CAS. The current complete JSONL snapshot
  remains the production v1 until byte-identical compact/branch restore,
  rebase/corruption/GC behavior, and storage/latency benchmarks pass.

## 2026-07-25 — Runtime, Temporal, and Pi checkpoint-v2 validation

- Added a pinned official Temporal TypeScript spike with one bounded Workflow
  per Run and two capacity-one polling Worker processes. It proves
  load-balancing, Activity heartbeat/cancellation, killed-Worker retry with a
  newer fence, service restart, duplicate Workflow-ID rejection, and a bounded
  history without raw prompt/credential sentinels.
- The measured four 400 ms activities completed across both Workers in
  2,446 ms; killed attempt 1 was recovered as attempt 2 with fence 100 -> 101;
  the development-service restart recovery took 13,081 ms. This proves
  Temporal mechanics but also confirms that the current AgentDock Run would be
  one long Activity. Production stays on the PostgreSQL dispatcher; no dual
  scheduler was introduced.
- Added a direct Pi SDK versus RPC zero-token benchmark. Twenty samples measured
  5.61/6.99 ms SDK p50/p95 including an extension command and dispose, versus
  630.60/673.17 ms for fresh RPC child readiness. RPC remains production
  because it supplies per-Run environment isolation, verified process-group
  termination, and a smaller failure radius; direct SDK requires a
  capacity-one replaceable Worker and instance-scoped configuration first.
- Implemented `agent-dock.pi-session-manifest.v2` in the production checkpoint
  adapter. It stores tenant/session-scoped SHA-256 line segments and immutable
  manifests, supports online v1 reads, conditional/idempotent S3 puts,
  append/rebase, 32-segment consolidation, per-segment and whole-file
  verification, and the existing fenced checkpoint-head CAS.
- The 120-turn local benchmark reduced cumulative stored bytes from 33,897,660
  to 1,439,612 (95.75%). The final 560,167-byte JSONL restored
  byte-identically from 26 segments; in-memory integrity/concatenation
  p50/p95 was 6.185/11.807 ms. Orphan GC and remote MinIO latency remain
  explicit operations follow-ups.
- Updated the verified post-install dependency hardening boundary for the new
  brace-expansion 5.0.8 and find-my-way 9.7.0 releases. Published nested lock
  metadata still names older exact versions, so CI copies the pinned safe
  packages into the reviewed Pi/Nest transitive locations, verifies installed
  versions after `npm ci`, and reports the corresponding npm-audit metadata
  findings as remediated only when node identity and advisory sets match.
- Deployed commit `6afeb96` without replacing the existing PostgreSQL/MinIO
  volumes. A six-request real DeepSeek acceptance stopped the first owning
  Worker, restored the native Pi checkpoint on the surviving Worker, recovered
  the previous-turn marker, and exercised four concurrent Runs across both
  Worker connections. The first/follow-up settled times were 5,603/3,873 ms.
  Production artifact inspection confirms all six newly committed Pi
  checkpoints use the v2 manifest media type and
  `pi-sessions/.../manifests/<sha256>.json` keys; older whole-NDJSON rows remain
  readable for online migration.

## 2026-07-25 — Capacity-one direct Pi SDK production cutover

- Replaced the per-Run `pi --mode rpc` child process in the production execution
  path with Pi's pinned programmatic SDK. Each activation now constructs its own
  `ModelRuntime`, native `SessionManager`, settings and inline trusted Tool
  extension; model capabilities, Tool capabilities and project instructions are
  activation-local objects rather than process-global environment variables.
- Kept the trusted/untrusted boundary unchanged: Pi's Agent Loop executes in a
  trusted Supervisor Worker, while every `read/write/edit/bash` operation still
  crosses the narrow authenticated Tool RPC and runs in a CubeSandbox KVM
  microVM. Pi builtin local tools and discovered extensions remain disabled.
- Made each SDK Worker capacity one. Production runs two independent Worker
  processes, so concurrency is horizontal without sharing simultaneous tenant
  activations in one JavaScript heap. Cooperative cancellation aborts the model
  and SDK session; if bounded disposal fails, the Worker marks itself poisoned,
  stops accepting assignments and exits so another Worker can restore the last
  committed checkpoint.
- Preserved Pi's native JSONL as the conversation authority. SDK settlement
  captures the complete native session, including branch and compaction entries,
  into checkpoint-v2. Tests force threshold compaction, restore the artifact in a
  fresh SDK activation and continue the conversation; cancellation and
  credential/prompt non-disclosure are also covered.
- The zero-token benchmark measured direct SDK activation at 5.61/6.99 ms
  p50/p95 versus 630.60/673.17 ms for fresh RPC process readiness. RPC remains
  only as an explicit compatibility/fault-test backend, not a production
  fallback.
- Production deployment initially rejected the capacity change because the
  operator-pinned host policy still stored capacity 2. The live policy was
  explicitly reduced to 1, and provisioning now automatically reconciles only
  restrictive capacity changes; attempts to expand a stored host policy still
  fail closed.
- Real `deepseek-v4-flash` Worker-pool acceptance consumed 6 requests, 494 input,
  1,339 output and 7,680 cache-read tokens. It stopped Worker 1 after a 2,090 ms
  first Run; Worker 2 restored the native Pi artifact and marker and settled the
  follow-up in 1,549 ms. Four more concurrent Runs were distributed 2/2 across
  both capacity-one Workers.
- Real Cube production acceptance consumed another 8 model requests. Pure chat
  produced first text in 1,134 ms and settled in 1,436 ms with zero Tool calls
  and zero Cube activations. Two coding Runs used 2 and 3 Tool calls in distinct
  KVM guests, restored the Workspace across Runs, committed two immutable
  versions, hid the other tenant's conversation and left zero test microVMs.
  Sanitized evidence is stored in
  `docs/reports/pi-worker-pool-acceptance-latest.{json,md}` and
  `docs/reports/cubesandbox-production-acceptance-latest.{json,md}`.

## 2026-07-25 — Temporal sole-scheduler production cutover

- Accepted ADR-0056 and replaced production PostgreSQL-to-WebSocket Worker
  matching with self-hosted Temporal Server 1.29.1. The transactional outbox
  relay now starts or cancels one deterministic Workflow per Run and never
  chooses a Worker.
- Added a pure deterministic Workflow package whose history carries only
  schema version plus tenant, Session, Run and command UUIDs. Prompt text,
  Pi JSONL, `messages[]`, model/Tool output, credentials and Workspace bytes
  remain in PostgreSQL/MinIO and trusted Worker memory.
- Both capacity-one Supervisor processes now poll the common
  `agent-dock-pi-runs-v1` Task Queue. The Activity performs an exact command
  claim, rechecks PostgreSQL FIFO/concurrency rules, acquires the existing
  RunAttempt lease/fence and executes the embedded Pi SDK. Later same-Session
  work defers through a durable Workflow timer.
- Temporal cancellation reaches the Worker that owns the Activity and invokes
  the exact local cancellation dispatcher. Activity heartbeat/retry handles
  infrastructure delivery only; ambiguous model, Bash and checkpoint side
  effects remain protected by Tool IDs, fencing and CAS.
- Production Supervisors explicitly advertise
  `acceptingAssignments=false`; the legacy WebSocket matching lanes do not
  start. The socket remains for authenticated boot identity, liveness and
  management. Temporal and its visibility database share the coordinated cold
  PostgreSQL backup boundary.
- Fixed the multi-network Temporal container to bind all container interfaces
  while broadcasting its private Temporal-network address. Readiness fails
  closed if Temporal, either Worker poller or the application dependencies are
  unavailable.
- Real DeepSeek/Cube acceptance completed three Workflows, including pure chat
  and two coding Runs, with 9 requests, 1,842 input, 1,968 output and 23,040
  cache-read tokens. Pure chat settled in 2,155 ms without a Cube activation;
  both coding Runs restored Workspace state in distinct KVM guests and left
  zero microVMs.
- A second six-request fault gate stopped the first owning Worker. The
  surviving Temporal Worker restored the native Pi checkpoint and marker,
  then four concurrent Runs were distributed 2/2 across the two pollers.
  Decoded Workflow history contains only bounded IDs and status results.

## 2026-07-25 — bounded checkpoint read cache and multi-tenant model load gate

- Added a private cache to each capacity-one Pi Worker with a ten-minute TTL,
  512-entry limit and 32 MiB byte limit. It caches only immutable MinIO object
  bytes and never caches the PostgreSQL Session head.
- Kept correctness checks on every Run: PostgreSQL resolves the committed
  pointer under the current lease/fence, restored manifest/segments retain
  SHA-256 validation, and the revision is re-read after reconstruction.
- Added defensive byte copies, concurrent-miss coalescing, LRU/TTL eviction,
  delete invalidation and low-cardinality Prometheus cache/restore metrics.
- Added an explicit real-token multi-tenant gate that registers independent
  tenants, submits first/follow-up Runs concurrently, checks foreign Session
  denial and marker isolation, records Worker distribution and p50/p95
  acceptance/first-text/settlement/queue latency, and fails on retries,
  Tool calls or terminal errors.
- The accepted six-tenant/twelve-Run execution completed with zero failures,
  zero cross-tenant marker leaks, one Attempt per Run and an exact 6/6 split
  across the two Workers. It consumed 12 requests, 1,362 input, 2,128 output
  and 15,360 provider cache-read tokens. First text was 3,542/13,257 ms
  p50/p95; queue wait was 2,291/12,255 ms because twelve Runs intentionally
  saturated two capacity-one Workers.
- A preliminary execution completed the same 12 model requests but its final
  evidence query referenced a nonexistent Attempt timestamp column. The query
  was corrected to use the Run start time and the complete gate was rerun.
  Across both executions the evaluation consumed 24 requests, 2,706 input,
  4,170 output and 30,720 provider cache-read tokens.
- Each Worker recorded 20 immutable-object cache hits and 4 misses (83.33%),
  retained about 31 KiB, and completed all six follow-up restores below 25 ms.
  A 20-iteration direct MinIO comparison measured restore p50/p95 at
  4.488/10.375 ms without the cache and 0.073/0.278 ms with it.

## 2026-07-25 — capacity-one Workers and global Cube admission

- Evaluated packing multiple SDK activations into each Pi Worker, but retained
  the enforced capacity-one process boundary. A poisoned SDK session retires
  its entire process; capacity greater than one would make an unrelated active
  tenant collateral damage.
- Confirmed that Worker horizontal scaling is independent of Kubernetes:
  replaceable Docker Compose replicas poll one Temporal Task Queue and restore
  PostgreSQL/MinIO state. Kubernetes remains a future operational deployment
  option for trusted Workers, while Cube's K3s/KVM plane executes untrusted
  Tool workloads.
- Added a bounded FIFO admission gate before physical CubeSandbox
  materialization. Production admits two Tool guests, keeps pure chat outside
  the gate, removes cancelled waiters, rechecks ownership after admission and
  releases permits only after confirmed cleanup.
- Added Prometheus gauges for admitted Tool guests, queued materializations and
  the configured limit. Unit tests cover queued wake-up and cancellation
  without a capacity leak; the full repository check remains green.
- A four-Run real-model gate used four distinct Temporal Pi Workers and one
  12-second Bash execution per Run. It observed exactly two active and two
  waiting Cube guests, then completed all Runs in one Attempt with zero
  residual admission. The first pair settled in 17.7–17.8 seconds and the
  queued pair in 33.0–33.2 seconds. Eight provider requests consumed 1,108
  input, 625 output and 10,752 cache-read tokens. Evidence is stored in
  `docs/reports/tool-sandbox-admission-latest.{json,md}`.

## 2026-07-26: Kubernetes trusted Pi Worker pool

- Added ADR-0058 and the `agent-dock-pi-worker-pool` Helm chart.
- Each capacity-one Pi SDK Worker now has a deployable StatefulSet identity,
  private `ReadWriteOncePod` boot/spool claim, per-Pod management Service,
  restricted trusted-plane network policy, PDB and topology spreading.
- Added Temporal Worker Deployment name/Build ID configuration with pinned Run
  Workflow behavior; new builds use separate blue/green Helm releases.
- Kept PostgreSQL plus S3-compatible Pi JSONL segments/manifests as the shared
  conversation authority. Worker PVCs contain no committed user conversation.
- Evaluated Temporal Worker Controller v1.8.0 and CloudNativePG v1.30.0. The
  former is deferred until private spool state can fit a Deployment lifecycle;
  the latter is a recommended external PostgreSQL HA option rather than a
  dependency bundled into the Worker chart.
- Added deterministic Helm policy checks plus Supervisor configuration/runtime
  tests for Kubernetes Secret projection and Temporal deployment identity.
- Validated the complete repository typecheck/test/Pi recovery suite after
  dependency hardening, both Helm chart policy gates, production Web build,
  image dependency closure, encrypted-backup tamper checks and the HIGH-level
  security audit. Live multi-node Kubernetes, node-loss and storage-failover
  validation intentionally remain open evidence rather than implied claims.

## 2026-07-26: local Kubernetes cutover and live acceptance

- Created the disposable single-server `agent-dock-workers` k3d/K3s cluster
  and moved the two capacity-one trusted Pi SDK Workers from Compose into a
  Kubernetes StatefulSet. Temporal remains the only Run scheduler and both
  Pods poll the same versioned Task Queue.
- Kept the execution planes separate: the trusted Worker cluster has no host
  K3s credential or Cube runtime authority, while CubeSandbox continues to
  execute untrusted Tools in KVM microVMs. Narrow selector-free Services and
  exact EndpointSlices bridge only PostgreSQL, Temporal, MinIO, Control Plane,
  Sandbox Manager, provider relay and management ingress.
- Preserved the external conversation authority. PostgreSQL stores the
  committed Session/checkpoint pointer and MinIO stores immutable Pi-native
  JSONL segments/manifests. A Worker Pod PVC is limited to its private boot
  ledger and unacknowledged event spool, so deleting or moving a Worker does
  not move or lose the committed conversation.
- Hardened the cutover around failures observed on the real machine: pinned
  K3s system-image import, Kubernetes system-plane readiness, application and
  Temporal registration gates, upgrade-safe StatefulSet claim templates,
  individual `subPath` Secret files compatible with `O_NOFOLLOW`, Pod
  inventory waits, non-interactive Temporal version promotion, and automatic
  Helm rollback to the previously serving Worker revision.
- A real DeepSeek `deepseek-v4-flash` acceptance stopped the Worker that owned
  the first turn and resumed the same Session on the surviving Pod. The
  restored Pi artifact and previous-turn marker were both verified; the two
  turns settled in 1,547 ms and 1,784 ms. Four additional concurrent Runs used
  both Workers, took 4,496–11,345 ms, and the complete gate consumed 7 model
  requests, 585 input, 1,407 output and 8,960 provider-cache-read tokens.
- A separate real-token semantic gate verified pure chat without a Cube
  activation (1,083 ms first text, 1,299 ms settled), two-round Tool execution
  in distinct Cube microVMs with Workspace restoration, cross-tenant denial,
  bounded Temporal histories and zero remaining guests. It consumed 8 model
  requests, 1,979 input, 1,723 output and 18,944 cache-read tokens.
- Re-ran the native forced-threshold Pi compaction integration test through a
  fresh SDK activation and the v2 Pi session manifest integrity suite. This
  validates that recovery uses Pi's native JSONL session tree, including its
  compaction entry, rather than rebuilding `messages[]` from UI projections.
- A final revision rollout exposed a short Traefik endpoint-propagation race
  after both StatefulSet Pods became Ready. The release automatically rolled
  back, but the observation also exposed that Temporal current-version
  promotion preceded the management-route gate. The operator now retries
  management reachability and enrollment, validates all serving paths before
  promotion, confirms the exact current Build ID, and restores both Helm and
  Temporal routing state on any post-promotion failure.
- This proves a functional single-machine Kubernetes deployment and the
  multi-node-ready control/data contract. It does not yet claim real
  multi-node node-loss, storage failover or cross-zone high availability;
  those remain an explicit open acceptance item.

## 2026-07-26: fenced Cube recovery and offline dependency promotion

- Audited the immutable CubeSandbox v0.6.0 source at
  `8721dd151971ce3c2966482bbd32904ad98f378e`. Cube's standard recovery path is
  explicit `pause` followed by `connect` (or CLM-managed timeout pause/automatic
  resume), coordinated through Cube lifecycle state and Redis locks. That
  physical state machine does not identify the AgentDock RunAttempt allowed to
  mutate a Workspace, so ADR-0060 keeps PostgreSQL lease/fence state authoritative.
- Reworked the Cube Tool template into a root-owned authenticated supervisor
  plus a UID/GID 1000 Tool Worker. Warm release now rejects active operations,
  stops the Worker, kills and verifies every process carrying Tool UID 1000,
  seals the service and only then observes Cube `paused`. A later exact-Session
  Run must have a higher fence, presents the old in-memory handoff authority,
  rotates to a fresh 256-bit secret and starts a fresh non-root Worker attached
  to the retained Workspace. Old authority is rejected after rebind.
- Added Cube API authorization and runtime-client support for `pause` and
  `connect`, disabled transparent auto-resume, retained the private traffic
  token in the trusted client, and changed Manager inventory to expose the
  current in-memory assignment while physical Cube metadata remains an
  immutable binding. Identity mismatch, ambiguous lifecycle transitions or
  Manager loss destroys the optimization and cold-restores the committed
  checkpoint.
- Kept ordinary Cube Tools offline. Environments with declared dependency hosts
  now run setup in the existing disposable gVisor/Ed25519-capability bootstrap,
  capture regular Workspace bytes, destroy the bootstrap, and restore into a
  newly created `allow_internet_access=false` Cube guest for offline
  verification. Processes, sockets, namespaces and capability material cannot
  cross that promotion boundary.
- Added Provider/runtime/authorizer tests for pause/connect, exact-Session
  higher-fence reuse, stale authority, dependency promotion and final offline
  policy. The local Cube template compatibility gate additionally ran counting
  sort, traversal rejection, background-process sealing and fence 7→8 rebind;
  it observed root supervisor, UID/GID 1000 Tool Worker, zero effective Worker
  capabilities, `NoNewPrivs`, zero remaining Tool processes and successful
  stale-secret rejection.
- The complete monorepo typecheck and the focused Cube authorizer, Tool Worker
  and Sandbox Manager suites passed before immutable-template registration.
  Real KVM pause/connect and real-model multi-round evidence is recorded in the
  subsequent production-acceptance entry/report rather than implied here.

# 2026-07-26: Cube official private-management template registration

- Added a non-root template-registration path through Cube v0.6.0's official
  `cubemastercli` and private CubeMaster port. It uses the same
  `create-from-image -> watch -> list/READY` protocol as the in-cluster CLI,
  without granting AgentDock or Sandbox Manager Kubernetes administrator
  credentials.
- The private template registry is reached through a short-lived raw TCP relay
  bound only to `127.0.0.1`; the relay transports registry TLS unchanged and is
  closed after the digest-pinned image push. The push uses a temporary empty
  Docker client configuration so an unrelated desktop credential helper cannot
  enter this unauthenticated private-registry path.
- Retained the existing kubeconfig-based operator path for installations where
  the official CLI is managed in-cluster. Direct mode is explicit and
  fail-closed: CubeMaster address, pinned CLI and registry address must all be
  supplied.
- Scoped `supervisor-volume-bootstrap` to the Compose Pi Worker profile. A
  Kubernetes Worker deployment has no Compose supervisor volumes to prepare;
  excluding that successful one-shot container also prevents Compose `--wait`
  from treating its expected exit as a failed long-running service.

## 2026-07-26: capacity-aware Temporal Worker affinity

- Added soft Session affinity without introducing a second scheduler.
  PostgreSQL remembers the Worker that successfully completed a Session, while
  Temporal remains the only component that matches an Activity to a Worker.
  An affinity reservation is issued only when that exact Worker is live and
  `active_sessions + unexpired_reservations < max_concurrent_sessions`.
- Added a deterministic, Worker-private Temporal Activity Task Queue alongside
  the existing shared queue. The two pollers share the same in-process
  execution-slot counter, so the private poller cannot increase effective
  Worker capacity. A private Activity has a two-second Schedule-to-Start
  timeout and falls back to the shared queue only when it has not started;
  an Activity that may already have produced side effects is never blindly
  retried.
- Made affinity a bounded optimization rather than correctness state.
  Reservations are short-lived, claimed by the exact Worker, released on every
  terminal path and serialized against capacity with a PostgreSQL row lock.
  Session FIFO, RunAttempt ownership, leases, fencing tokens, checkpoint CAS
  and the durable Temporal Workflow remain authoritative when a Worker is
  stale, full, unreachable or replaced.
- Added deterministic tests proving that two concurrent Sessions cannot both
  reserve a capacity-one Worker, that a wrong Worker cannot claim a
  reservation, that active capacity suppresses affinity, and that attacker
  input cannot select an arbitrary Temporal Task Queue. The complete monorepo
  typecheck and test suites passed: Control Plane reported 132 passing tests
  with 3 expected environment-dependent skips, Database reported 37 passing
  tests, and all other workspaces passed.
- Registered and validated the immutable Cube Tool template for revision
  `f704269b5b853c9bc77e0799fd3b06d3fc020fa0`, deployed the production stack,
  promoted the same revision as the current Temporal Worker build and observed
  both Kubernetes Worker Pods Ready.
- Real-model acceptance used Session
  `462873bd-ef0d-4943-8eab-09f84c14d9c3`. Its first Run settled on Worker
  `agent-dock-pi-worker-local-v1-0` in 1,919 ms and the next Run settled on the
  same Worker in 1,679 ms after restoring a non-empty Pi base artifact.
  Temporal History, rather than the final Worker identity alone, proves the
  affinity hit: the second Activity was scheduled on
  `agent-dock-pi-worker-v1-757ba511-294f-40e6-bdfc-e8a09a76a613` with the
  expected two-second Schedule-to-Start timeout.
- A separate busy-capacity acceptance held that preferred Worker's only slot
  with Run `d121ab17-4e07-4aec-bf49-ae79ea3ae361`, then submitted Run
  `630923db-41f0-4093-bb76-5942fbd16e85` for the same Session. Every scheduled
  Activity for the queued Run used the shared
  `agent-dock-pi-runs-v1` queue; none used the Worker-private queue. During the
  same-Session FIFO wait, Activity starts alternated between both Worker Pods,
  proving that the task was not pinned behind the occupied preferred Worker.
  It executed only after the earlier same-Session Run settled, preserving the
  required serialization.

## 2026-07-26: Cube full-public/private-denied egress

- Accepted ADR-0062 and changed the sole ordinary Cube Provider to a fixed
  `public_egress_private_denied` policy. Every create now enables native
  Internet, keeps public inbound disabled and installs a repository-owned CIDR
  deny list covering private, loopback, carrier-grade NAT, link-local/metadata,
  benchmarking, documentation, multicast and reserved IPv4 classes. Browser,
  model, recipe and Tool input cannot replace that policy.
- Updated immutable template registration to record
  `allowInternetAccess=true`, registered template
  `tpl-094eb332fcf244b89e3b2fd5` for revision
  `0a45d71d4fc404c57962d5d48c139870c50b6207`, and deployed that revision with
  both Kubernetes Pi Workers Ready. Request-shape, closed-policy, protocol and
  Sandbox Manager tests passed; the monorepo CI passed except for the external
  npm audit endpoint returning a malformed gzip response after the repository's
  own vulnerability policy had reported zero remaining vulnerabilities.
- The first real KVM gate proved platform/private/metadata denial, but public
  HTTPS timed out. Host inspection found WSL `mirrored` mode, no native IPv4
  default route and Internet access available only through
  `HTTP_PROXY=http://127.0.0.1:10808`. CubeVS performs native guest NAT and
  cannot inherit that application proxy. The gate now performs a direct
  trusted-host HTTPS preflight and reports this prerequisite explicitly.
- This entry does not claim completed full-public acceptance on the current
  node. Switch the Cube node to a native-route network mode, rerun the real KVM
  gate, then update the immutable acceptance report and close the ADR-0062
  backlog item.
## 2026-07-26 — Hot model administration and proxy-mediated Cube web egress

- Added an owner-facing runtime settings panel. The platform operator can
  replace the Pi DeepSeek model/key and the Cube upstream HTTP(S) proxy without
  restarting the cluster. Model keys remain AES-GCM encrypted, replacements
  create immutable credential versions, and an accepted Run keeps its original
  model/credential snapshot.
- Added versioned PostgreSQL authority and append-only digest audit for the
  Cube proxy setting. A separate service-token-authenticated read endpoint
  exposes only the current credential-free origin to trusted execution-plane
  infrastructure.
- Added a non-root, read-only, capability-free K3s host-network Cube egress
  gateway. It hot-polls the setting, resolves destinations itself, rejects
  private/special DNS answers, and supports public HTTP/HTTPS through the
  operator proxy. New connections switch revision without Pod or cluster
  restart.
- Replaced direct Cube public NAT with a closed network policy:
  `allowOut=["10.255.255.254/32"]` and `denyOut=["0.0.0.0/0"]`. Tool
  microVMs receive only the trusted gateway address in a fixed subprocess
  environment; no upstream URL, polling token or inherited host proxy crosses
  the boundary.
- Added service, gateway, Tool environment and Cube request-shape tests. ADR
  0063 supersedes ADR 0062's direct-native-route requirement and documents WSL
  mirrored networking plus the exact hot-update semantics.

## 2026-07-26 — Large Workspace settlement and Cube-native cold restore

- Diagnosed the reported `Local supervisor execution failed` against the
  durable Run evidence: all model calls and Tool operations had succeeded, but
  settlement rejected the cloned Temporal repository at the original
  512-file/2-MiB portable Workspace-manifest boundary.
- Researched Kopia, Restic, REAPI CAS and Cube v0.6 snapshots before changing
  the persistence contract. ADR-0064 keeps the portable content manifest for
  small Workspaces and selects Cube's official snapshot-clone path for
  larger ordinary Cube Workspaces. This avoids a second repository/credential
  plane now while preserving a future Kopia/REAPI data-mover boundary.
- Added a sealed checkpoint protocol. The root-owned guest supervisor stops
  the Tool Worker, kills all Tool-UID processes, captures a content-hashed
  index and Git patch, and rotates to a recovery authority without reopening
  execution. Small Workspaces return portable content; large Workspaces create
  a Cube snapshot and return only an AES-256-GCM encrypted reference bound to
  tenant, Workspace, image, environment, source binding and fence.
- Added higher-fence cold restore. A new activation creates a fresh Cube VM
  from the committed snapshot template, authenticates only to the sealed
  service, rotates activation/binding/secret/fence, starts a new Tool Worker
  and revalidates runtime/toolchain evidence. Cube v0.6 copies source labels
  after create-time metadata, so every physical assignment also carries an
  immutable fence-qualified assignment record. Inventory and identity checks
  select only the highest valid fence and reject ambiguous records; inherited
  lower-fence labels cannot regain authority.
- Raised only the bounded reference/index transport to 32 MiB and the durable
  file-count column to 100,000; portable manifests retain their original
  512-file, 512-KiB/file and 2-MiB limits. Historical lists/comparisons use the
  provider index, while unsupported exact-content reads fail explicitly.
- Deterministic evidence includes a 601-file index without embedded file
  content, non-dereferencing symbolic-link indexing, portable-small/native-large Provider paths,
  encrypted-authority non-disclosure, source-destroy/fresh-activation restore,
  official snapshot HTTP request shape and Workspace-version projection.
  The rebuilt Cube Tool template check also passed real process killing,
  checkpoint authority rotation, portable capture and warm rebind.
- The first real KVM snapshot attempt exposed a missing operation in the
  external Cube API authorizer. The allowlist now admits
  `POST /sandboxes/:id/snapshots` and restricts deletion to Cube v0.6's exact
  `DELETE /templates/snap-<24 lowercase hex>` namespace. It continues to deny
  `tpl-*` deletion, list endpoints and arbitrary template operations.
- A real rollback attempt then proved an important Cube v0.6 constraint:
  rollback is origin-Sandbox-bound and rejects a fresh VM. Cold restore now
  follows Cube's supported snapshot-as-template clone path; rollback was
  removed from the AgentDock Manager credential instead of weakening the
  physical-identity model.
- The operational boundary is explicit: current Cube snapshot data is local to
  the single-node Cube storage plane. Compose backup alone is not a node-loss
  backup for provider-native Workspace versions; replicated/off-host storage,
  reference-aware GC and a read-only historical materializer remain backlog.
- The real Temporal repository gate exposed two Git `120000` entries after the
  original file-count limit had been removed. Cube-native indexes now hash
  symbolic-link targets with an explicit domain separator, never dereference
  them, and mark the Workspace as native-only. This keeps the portable manifest
  regular-file-only while allowing ordinary real repositories to checkpoint
  without hiding links or weakening path traversal checks.
- Repeated production acceptance exposed an admission leak in the administrative
  physical-VM termination path. Cube had already removed the VM, but the Manager
  retained one warm activation because its Run/Fence assignment had advanced.
  Termination now lets the Provider validate the exact inventory assignment,
  while Manager cleanup is keyed by the validated physical runtime plus stable
  Supervisor identity. A regression test proves that the admission drops from
  `1/1` to `0/1` even when the inventory assignment has advanced.
- Fresh-VM restore then exposed a format-boundary bug before lazy activation:
  the trusted Runner attempted to extract `AGENTS.md` bytes from a provider-native
  checkpoint that intentionally contains only a bounded index and encrypted
  recovery authority. Native checkpoints are now recognized before portable
  manifest parsing, so file bytes remain deferred to the restored Tool Sandbox.
- Final real-model acceptance used 18 DeepSeek requests, cloned and settled
  3,664 Temporal repository files, explicitly destroyed the source Cube VM and
  restored 3,665 files into a fresh higher-fence VM. The durable checkpoint
  reference was 669,487 bytes, all five Temporal histories carried bounded
  references only, and explicit cleanup left zero Cube microVMs.
- The disposable production gate then reproduced a capacity-starvation edge
  case: two idle Session-scoped warm sandboxes could occupy both global
  admissions, leaving a new Session blocked until the 15-minute TTL. Admission
  now evicts the least-recently-used idle warm runtime when new demand reaches
  capacity; active runtimes remain untouched and exact-Session warm reuse still
  wins before eviction.
- Production Kubernetes inspection now uses an explicit host-loopback API
  endpoint while retaining the kubeconfig TLS server name, and prefers the
  native Linux kubectl when installed. This avoids depending on a transient WSL
  `/etc/hosts` entry or accidentally invoking Docker Desktop's Windows kubectl
  shim. The rebuilt disposable gate passed restart recovery, `1 -> 2 -> 1`
  control-plane scaling, fresh Supervisor boot, active cancellation, warm
  retirement, 22 durable events, and a 12,472,325-byte encrypted backup/restore
  drill with restored cursor 34.

## 2026-07-26 — Cube snapshot lifecycle closure and deploy convergence

- Added a separately authenticated, read-only historical materializer. A
  Workspace-version file read now clones the immutable Cube snapshot into a
  temporary sealed VM, verifies the content-index entry and hash, returns only
  the requested bounded file, and destroys the reader. The reader cannot run
  ordinary tools or inherit a writable Session assignment.
- Added reference-aware Cube snapshot garbage collection. PostgreSQL/MinIO
  committed Workspace versions are the authoritative reference set; Cube
  inventory candidates require two observations and a 24-hour grace period,
  deletion is capped per scan, and invalid or missing committed references stop
  the scan before deletion. GC state is persisted mode `0600`.
- Extended the Cube API authorizer only for the official bounded
  `GET /snapshots` inventory shape. Unknown query fields, duplicate fields and
  invalid pagination bounds remain denied.
- Production deployment now rebuilds and rolls the Kubernetes Pi Worker pool,
  pins it to the current Git revision and promotes the matching Temporal build.
  This closes the stale-worker failure where the Compose control plane had
  advanced but K3d Workers still executed an older protocol.
- Snapshot reconciliation now treats Sandbox Manager startup unavailability as
  a bounded retryable dependency race and retries after five seconds. Integrity,
  tenant-binding and protocol failures remain non-retryable and fail closed;
  shutdown cancels both periodic and retry timers.

## 2026-07-26 — Cube POSIX volumes and trusted Kopia Workspace durability

- Added ADR-0067 after checking Cube v0.6's official binary Volume Plugin
  contract and Kopia's current repository/restore behavior. New Cube
  activations receive one deterministic tenant/Workspace/Session volume through
  the `agentdock-posix` plugin; browsers, models and Tool code cannot select a
  host path, volume driver or repository.
- Added a separately authenticated trusted Workspace Data Mover. It alone
  mounts the POSIX root and receives a dedicated Kopia repository password and
  least-privilege S3 credential. Its API is limited to exact-volume prepare,
  quiescent snapshot and hash-verified bounded single-file materialization.
- New checkpoints contain a Kopia snapshot ID, volume/session binding, file
  index, environment evidence, activation and fence. Legacy portable and
  Cube-native formats remain readable, but ordinary new Cube Runs no longer
  create node-local Cube snapshots.
- Cube checkpointing now seals the guest, kills Tool processes and calls
  `sync -f /workspace` before the trusted mover snapshots it. Cold restore
  populates the POSIX volume before a fresh base-template VM starts under a
  strictly higher fence. PostgreSQL's existing staged WorkspaceVersion,
  RunAttempt fencing and head CAS remain the sole publication authority.
- Production now provisions a dedicated Kopia MinIO bucket/user, private mover
  state/secrets, internal-only network membership and a pinned static Kopia
  binary. The Cube API allowlist admits only deterministic volume create/read;
  volume deletion and arbitrary IDs remain denied.
- Unit evidence covers strict reference shape, tenant-bound volume identity,
  traversal rejection, authenticated mover RPC, materialization hash checking,
  Kopia Provider restore, legacy compatibility and Cube API denial. The live
  acceptance additionally erases the source Session's local POSIX contents
  while leaving its mover sidecar intact before demanding a fresh-VM restore
  from Kopia; a sidecar is deliberately never treated as proof of live bytes.

## 2026-07-27 — Session-resident Cube runtime and legacy checkpoint removal

- Audited CubeSandbox v0.6 source and confirmed that the binary Volume Plugin
  is a mount contract, while `CommitSandbox` rejects the host-path/shared
  directories used for AgentDock's external `/workspace`. Native Cube snapshots
  therefore cannot be the complete version authority for this topology.
- Adopted ADR-0068: one exact Session may retain one running Cube for the
  15-minute idle window. A settled Run revokes its Tool capability and closes
  its Tool Worker, but preserves user background processes. The next Run rotates
  the handoff secret under a strictly higher fence and starts a fresh Worker.
- Checkpointing is now a two-phase trusted protocol. The guest closes the Tool
  Worker, records and freezes exact UID-1000 PID/start-time identities, flushes
  and indexes `/workspace`, the trusted Data Mover creates an immutable Kopia
  snapshot, and the guest resumes only those identities. Any ambiguous cleanup
  destroys the VM.
- The live POSIX Volume remains the interactive execution copy. Its trusted
  sidecar permits reuse only for the exact Session and requested committed
  Kopia base, preserving later background writes; selecting another
  WorkspaceVersion performs empty-then-restore and cannot be overridden by
  stale live bytes.
- Removed the Cube-native Workspace checkpoint codec, encrypted recovery
  authority, snapshot clone/materializer branches, snapshot inventory/GC
  protocol and services, deployment token/state, and all migration tests for
  that format. No compatibility path remains; incompatible development data is
  reset during deployment.
- Unit/type evidence covers Kopia-only restore, background-safe checkpoint
  completion, exact-Session warm rebind, live-volume reuse and explicit
  rollback. The one unrelated concurrent WebSocket test that flaked in the
  workspace-wide run passed on isolated rerun.

## 2026-07-27 — POSIX volume-generation proof

- A real-model large-Workspace fault injection exposed that the external mover
  sidecar could survive after the POSIX volume contents were erased. Treating
  that sidecar alone as proof caused restore to be skipped and mounted an empty
  Workspace into the replacement Cube.
- Every new live volume now receives a random
  `.agent-dock-runtime/generation` marker before user code starts. Kopia carries
  that marker in every immutable snapshot, while the trusted sidecar records
  the same generation with the committed snapshot ID.
- Warm reuse now requires exact tenant/workspace/session identity, exact
  snapshot ID and matching sidecar/volume generation. A missing marker,
  replaced or empty volume, explicit rollback or sidecar mismatch always takes
  the empty-then-Kopia-restore path.
- Runtime metadata is excluded from Tool file paths, Git patches, Workspace
  indexes and portable snapshots. Old sidecar schema and markerless snapshots
  are intentionally unsupported; development data is reset instead of adding
  compatibility branches.
- Portable source restoration preserves the trusted runtime directory while
  replacing user files. This is required for empty/GitHub source seeds, whose
  restore step runs after the Data Mover establishes the volume generation.

## 2026-07-27 — Pi Tool batch serialization

- Production evidence showed one assistant response emitting two sibling
  `read` calls 17 ms apart. Pi correctly used its default parallel Tool mode,
  while the Cube guest Tool Worker deliberately admits one cancellable
  operation at a time, so the second call returned
  `tool_operation_overlap` before the model retried it.
- All four remote `read`, `write`, `edit` and `bash` definitions now declare
  Pi's public `executionMode: "sequential"` contract. The Agent Loop preserves
  model order before crossing Tool RPC, matching the single-operation guest
  protocol without moving file or command execution out of CubeSandbox.
- The extension test asserts the execution mode on every registered Tool.
  Sandbox Supervisor typecheck and its complete 65-test suite pass.
## 2026-07-27 — Cube-only runtime and Workspace-first conversations

- Runtime: removed the executable alternate Sandbox Provider, Kubernetes
  runtime client/API relay, execution-plane Helm chart, host installer,
  dependency bootstrap proxy and their production image/configuration paths.
  `SandboxManager` now constructs only `CubeSandboxProvider`; environment setup
  runs in the same Cube boundary through the deployment Web proxy.
- Product: removed repository import and runtime-verification controls from the
  browser. A conversation now has its own title and must select an existing
  named Workspace or create a new empty Workspace. Multiple conversations may
  share one durable `/workspace`.
- Storage: replaced the Session-bound Kopia index with the deliberately
  incompatible v2 format. A committed checkpoint is tenant/Workspace scoped,
  records its source Session only as provenance, and can cold-restore into a
  different conversation's isolated live POSIX volume. Pi transcripts and
  live process trees remain Session-local.
- Deletion: added tenant-scoped, idempotent soft deletion for conversations.
  Archived Sessions disappear from list/direct-read APIs while the shared
  Workspace and audit history remain.
- Workspace UI: replaced the operational multi-endpoint inspector with a
  committed directory tree and safe file preview. Loading depends only on
  Workspace versions/files, eliminating the previous rejected-request refresh
  loop.
- Administration: added explicit `platformAdministrator` identity. Ordinary
  tenant owners stay in the conversation product; the dedicated operator
  account lands on the hot model/Cube-proxy settings page.
- Operations: deleted the ignored pre-runtime execution snapshot and obsolete
  dependency issuer secret, corrected production build/deploy/backup/release
  scripts, and rewrote current architecture/runbook documents around the sole
  Cube path. Historical ADRs, research, migrations and evidence remain
  immutable records.
- Deployment: cluster evidence now includes the private CubeMaster and template
  registry endpoints plus a pinned local `cubemastercli`. A normal non-root
  deploy can register the exact committed Tool image before Compose validates
  and starts that revision, without receiving a Kubernetes administrator
  kubeconfig.

## 2026-07-27 — Cube Tool network-capability separation

- A real-model empty-Workspace acceptance exposed an initialization failure:
  the Cube Web proxy intended for later user Bash operations was also supplied
  to an environment recipe that declared no dependency hosts. The Tool Worker
  correctly rejected that excess setup capability before executing any Tool.
- Environment initialization now receives the Web proxy only when the accepted
  immutable recipe declares dependency hosts. The initialized Worker still
  retains the separately scoped Web proxy for later user `bash` operations.
  This restores empty-Workspace Tool execution without weakening the recipe
  network invariant.
- Sandbox Manager now writes bounded structured operator diagnostics for
  otherwise generic internal failures. Cube Tool error envelopes are included
  only in trusted logs; model-visible and public API errors remain generic and
  do not expose credentials or infrastructure details.
- Unit and type evidence covers the no-dependency and dependency-recipe paths.
  Production acceptance additionally requires a real-model write/read and
  committed Workspace file inspection.

## 2026-07-27 — Workspace-owned directory head

- End-to-end acceptance exposed that the new Workspace picker still inherited
  the old Session-owned version model: a second conversation could select the
  same Workspace but its directory inspector had no versions.
- Added an authoritative Workspace version head and backfilled it from the
  latest settled non-fork version. New ordinary conversations inherit the
  directory head and snapshot only; their Pi checkpoint remains empty.
- Ordinary same-Workspace Runs now claim under a Workspace row lock, rebase to
  the latest committed head, execute one writer at a time, and advance the
  head using base-version CAS. All ordinary conversation directory mirrors are
  refreshed after commit without merging their Pi transcripts.
- Explicit forks and Candidate-Race Sessions retain isolated branch heads and
  parallel scheduling. Promotion is the only operation that advances the
  parent Workspace head.
- Automated evidence covers new-conversation inheritance, shared history,
  same-Workspace execution serialization, candidate parallelism and migration
  schema.

## 2026-07-28 — Current-path repository review

- Removed the complete Pi RPC subprocess fallback, environment-selected
  execution mode, environment-configured Tool extension, obsolete RPC/TUI and
  Temporal-adoption spikes, phase-zero Compose topology, and unused standalone
  GitHub import workers. The trusted runtime now has one executable path:
  capacity-one Pi SDK Worker to Tool RPC to CubeSandbox.
- Removed the pre-Temporal PostgreSQL binding-discovery scheduler instead of
  retaining it behind a test flag. `SupervisorMaintenanceRuntime` now performs
  connection/orphan reconciliation only; Temporal remains the sole Run
  scheduler.
- Removed authentication of unindexed legacy bearer tokens. Tenant API
  credentials now require the current `adk_<credential-id>.<secret>` format,
  allowing one indexed lookup followed by constant-time digest comparison.
- Removed the production bootstrap fallback that reused `USER_ID` when
  `API_CREDENTIAL_ID` was absent. Runtime reuse now verifies that the
  deployment manifest, environment and private API Token all name the same
  current-format credential before any service is rebuilt.
- Removed whole-file Pi checkpoint fallback. Restore accepts only the current
  content-addressed v2 manifest and pinned Pi version; unsupported media types
  fail with `checkpoint_incompatible`.
- Fixed a Workspace inspector race where directory refresh and file materialize
  shared one generation counter, allowing either loading indicator to remain
  stuck. Directory and file operations now invalidate independently, and a
  refresh never shows content from an older Workspace version.
- New browser projects always request an empty Workspace. The browser client no
  longer exposes a generic source parameter after repository import was removed
  from the product UI.
- Corrected deterministic control-plane fixtures that tried to use an API key
  with Pi's OAuth-only `openai-codex` Provider. SDK integration now uses the
  supported fake Provider; production Provider coverage remains the DeepSeek
  capability Gateway.
- Added regression evidence for strict checkpoint media types, SDK completion
  and cancellation, maintenance-only runtime lifecycle, current-format tenant
  credentials and empty-Workspace project creation.
