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
