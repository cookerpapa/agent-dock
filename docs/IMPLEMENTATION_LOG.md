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
