import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptItem, TurnView } from "./session-view.ts";

type SourceHighlightModule = typeof import("./source-highlight.ts");
type SourceHighlightResult = ReturnType<SourceHighlightModule["highlightSource"]>;

let loadedSourceHighlighter: SourceHighlightModule | null = null;
let sourceHighlighterPromise: Promise<SourceHighlightModule> | null = null;

function useSourceHighlight(text: string, path: string | null): SourceHighlightResult {
  const [ready, setReady] = useState(loadedSourceHighlighter !== null);
  useEffect(() => {
    if (path === null || ready) return;
    sourceHighlighterPromise ??= import("./source-highlight.ts");
    let active = true;
    void sourceHighlighterPromise.then((module) => {
      loadedSourceHighlighter = module;
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [path, ready]);
  return ready && loadedSourceHighlighter !== null
    ? loadedSourceHighlighter.highlightSource(text, path)
    : null;
}

function safeDisplay(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (rendered === undefined) return "";
  return rendered.length > 12_000 ? `${rendered.slice(0, 12_000)}\n…输出已截断` : rendered;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  const output = objectValue(value);
  if (output === null || !Array.isArray(output.content)) return safeDisplay(value);
  const content = output.content
    .map((part) => {
      const candidate = objectValue(part);
      return candidate?.type === "text" ? stringValue(candidate.text) : null;
    })
    .filter((part): part is string => part !== null)
    .join("\n");
  return content.length > 0 ? content : safeDisplay(value);
}

function durationLabel(startedAt: string, completedAt: string | undefined): string | null {
  if (completedAt === undefined) return null;
  const milliseconds = new Date(completedAt).valueOf() - new Date(startedAt).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${String(minutes)}m ${((milliseconds % 60_000) / 1_000).toFixed(1)}s`;
}

function ExpandableToolText({
  text,
  direction,
  className,
  sourcePath = null,
  streaming = false,
}: {
  text: string;
  direction: "head" | "tail";
  className: string;
  sourcePath?: string | null;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalized = text.replace(/\n+$/, "");
  const lines = normalized.split("\n");
  const maximumLines = direction === "head" ? 16 : 20;
  const omitted = Math.max(0, lines.length - maximumLines);
  const preview =
    omitted === 0
      ? normalized
      : direction === "head"
        ? lines.slice(0, maximumLines).join("\n")
        : lines.slice(-maximumLines).join("\n");
  const visible = expanded ? normalized : preview;
  const highlighted = useSourceHighlight(visible, sourcePath);
  return (
    <div className="product-tool-text">
      {omitted > 0 && !expanded && direction === "tail" ? (
        <button type="button" onClick={() => setExpanded(true)}>
          … {String(omitted)} earlier lines · 展开完整输出
        </button>
      ) : null}
      <pre className={className}>
        {highlighted === null ? (
          <code>{visible}</code>
        ) : (
          <code
            className={`hljs language-${highlighted.language}`}
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        )}
        {streaming ? <span aria-hidden="true" className="product-tool-stream-cursor" /> : null}
      </pre>
      {omitted > 0 && direction === "head" && !expanded ? (
        <button type="button" onClick={() => setExpanded(true)}>
          … {String(omitted)} more lines · 展开
        </button>
      ) : null}
      {omitted > 0 && expanded ? (
        <button type="button" onClick={() => setExpanded(false)}>
          收起
        </button>
      ) : null}
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="product-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => (
            <a href={href} rel="noreferrer noopener" target="_blank">
              {label}
            </a>
          ),
          img: ({ alt }) => <span className="product-image-placeholder">[图片：{alt ?? ""}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ToolActivity({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const input = objectValue(item.input);
  const command = stringValue(input?.command);
  const path = stringValue(input?.path);
  const content = stringValue(input?.content);
  const output = item.output === undefined ? "" : toolOutputText(item.output);
  const multilineCommand = command !== null && command.includes("\n");
  const displayedCommand =
    command === null
      ? null
      : command
          .split("\n")
          .map((line, index) => `${index === 0 ? "$ " : "  "}${line}`)
          .join("\n");
  const duration = durationLabel(item.startedAt, item.completedAt);
  const conventionalWriteResult = /^Successfully wrote \d+ bytes to /u.test(output.trim());
  const statusLabel =
    item.status === "running"
      ? "执行中"
      : item.status === "unknown"
        ? "结果未知"
        : item.status === "failed"
          ? "执行失败"
          : "执行完成";
  const icon =
    item.status === "running"
      ? "◌"
      : item.status === "unknown"
        ? "?"
        : item.status === "failed"
          ? "!"
          : "✓";
  const heading =
    item.toolName === "bash" && command !== null && !multilineCommand ? (
      <div className="product-tool-command">
        <span aria-hidden="true">$</span>
        <code>{command}</code>
      </div>
    ) : item.toolName === "bash" && multilineCommand ? (
      <div className="product-tool-operation product-tool-multiline-label">
        <strong>bash</strong>
        <span>{String(command.split("\n").length)} 行命令</span>
      </div>
    ) : (
      <div className="product-tool-operation">
        <strong>{item.toolName}</strong>
        {path === null ? null : <code>{path}</code>}
      </div>
    );
  return (
    <section
      aria-label={`${item.toolName} ${statusLabel}`}
      className={`product-tool product-tool-${item.status}`}
    >
      <div className="product-tool-line">
        <span className="product-tool-icon" aria-hidden="true">
          {icon}
        </span>
        {heading}
        <span className="product-tool-state">{statusLabel}</span>
      </div>
      <div className="product-tool-body">
        {item.toolName === "bash" && multilineCommand && displayedCommand !== null ? (
          <ExpandableToolText
            className="product-tool-command-block"
            direction="head"
            text={displayedCommand}
          />
        ) : item.toolName === "write" && content !== null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            sourcePath={path}
            streaming={false}
            text={content}
          />
        ) : item.toolName !== "bash" && path === null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            text={safeDisplay(item.input)}
          />
        ) : null}
        {output.length > 0 && !(item.toolName === "write" && conventionalWriteResult) ? (
          <ExpandableToolText
            className={item.toolName === "bash" ? "product-tool-terminal" : "product-tool-output"}
            direction={item.toolName === "bash" ? "tail" : "head"}
            text={output}
          />
        ) : null}
        {duration === null ? null : <div className="product-tool-duration">Took {duration}</div>}
      </div>
    </section>
  );
}

function AssistantItem({
  item,
  processNarration,
}: {
  item: TranscriptItem;
  processNarration: boolean;
}) {
  if (item.kind === "text") {
    return (
      <div className={processNarration ? "product-agent-stage" : "product-agent-answer"}>
        <Markdown>{item.text}</Markdown>
      </div>
    );
  }
  if (item.kind === "tool") return <ToolActivity item={item} />;
  if (item.kind === "notification") {
    return (
      <div className={`product-notification product-notification-${item.level}`}>
        {item.message}
      </div>
    );
  }
  return (
    <div className="product-notification">
      {item.outcome === undefined
        ? `等待确认：${item.approval.title}`
        : `已处理：${item.approval.title}`}
    </div>
  );
}

export function ConversationTurn({
  turn,
  canFork = false,
  onFork,
  canPrune = false,
  onPrune,
}: {
  turn: TurnView;
  canFork?: boolean;
  onFork?: () => void;
  canPrune?: boolean;
  onPrune?: () => void;
}) {
  const working =
    turn.status === "queued" || turn.status === "running" || turn.status === "cancelling";
  const lastToolIndex = turn.items.reduce(
    (lastIndex, item, index) => (item.kind === "tool" ? index : lastIndex),
    -1,
  );
  return (
    <section
      className="product-turn"
      data-conversation-turn-id={turn.turnId}
      id={`turn-${turn.turnId}`}
    >
      <div className="product-message product-user-message">
        <div className="product-user-bubble">{turn.prompt}</div>
      </div>
      <div className="product-message product-assistant-message">
        <div className="product-avatar" aria-hidden="true">
          A
        </div>
        <div className="product-assistant-content">
          {turn.items.length === 0 && working ? (
            <div className="product-thinking">
              <i />
              <i />
              <i />
              <span>正在思考</span>
            </div>
          ) : (
            turn.items.map((item, index) => (
              <AssistantItem
                item={item}
                key={item.key}
                processNarration={item.kind === "text" && index < lastToolIndex}
              />
            ))
          )}
          {turn.failure ? (
            <div className="product-turn-error">
              <strong>这次运行失败了</strong>
              <span>{turn.failure.message}</span>
            </div>
          ) : null}
          {turn.cancellation ? <div className="product-muted-line">已停止生成</div> : null}
          {turn.status === "completed" && (onFork || onPrune) ? (
            <div className="product-answer-actions">
              {onFork ? (
                <button disabled={!canFork} onClick={onFork} type="button">
                  <span aria-hidden="true">↳</span>
                  从此对话开始
                </button>
              ) : null}
              {onPrune ? (
                <button
                  className="product-prune-action"
                  disabled={!canPrune}
                  onClick={onPrune}
                  type="button"
                >
                  <span aria-hidden="true">⌫</span>
                  删除后续
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
