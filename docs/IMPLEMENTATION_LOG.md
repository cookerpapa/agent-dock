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
