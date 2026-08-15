import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  parseWorkspaceTerminalServerFrame,
  type WorkspaceTerminalClientFrame,
} from "@agent-dock/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

type TerminalState = "disconnected" | "connecting" | "ready" | "failed";

function socketUrl(sessionId: string): string {
  const value = new URL(
    `/v1/conversations/${encodeURIComponent(sessionId)}/terminal`,
    window.location.href,
  );
  value.protocol = value.protocol === "https:" ? "wss:" : "ws:";
  return value.toString();
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function bytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

export function WorkspaceTerminal({
  sessionId,
  onError,
}: {
  sessionId: string | null;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<TerminalState>("disconnected");
  const [state, setStateValue] = useState<TerminalState>("disconnected");

  const setState = useCallback((next: TerminalState): void => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const transmit = useCallback((frame: WorkspaceTerminalClientFrame): void => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }, []);

  const disconnect = useCallback((): void => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.close",
        } satisfies WorkspaceTerminalClientFrame),
      );
      socket.close(1_000, "user closed terminal");
    } else if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
    setState("disconnected");
  }, [setState]);

  const connect = useCallback((): void => {
    if (sessionId === null || stateRef.current === "connecting" || stateRef.current === "ready") {
      return;
    }
    const terminal = terminalRef.current;
    if (terminal === null) return;
    terminal.reset();
    terminal.writeln("\x1b[38;5;245m正在启动隔离的 Workspace 终端…\x1b[0m");
    setState("connecting");
    const socket = new WebSocket(socketUrl(sessionId));
    socketRef.current = socket;
    socket.addEventListener("message", (event) => {
      try {
        const frame = parseWorkspaceTerminalServerFrame(JSON.parse(String(event.data)) as unknown);
        if (frame.type === "workspace_terminal.ready") {
          setState("ready");
          terminal.reset();
          terminal.focus();
          fitRef.current?.fit();
          transmit({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.resize",
            rows: terminal.rows,
            cols: terminal.cols,
          });
        } else if (frame.type === "workspace_terminal.output") {
          terminal.write(bytes(frame.data));
        } else if (frame.type === "workspace_terminal.exit") {
          terminal.writeln("\r\n\x1b[38;5;245m终端已断开。\x1b[0m");
          setState("disconnected");
        } else if (frame.type === "workspace_terminal.error") {
          terminal.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`);
          setState("failed");
          onError(frame.message);
        }
      } catch {
        terminal.writeln("\r\n\x1b[31m终端返回了无效数据。\x1b[0m");
        setState("failed");
      }
    });
    socket.addEventListener("close", () => {
      if (socketRef.current === socket) socketRef.current = null;
      if (stateRef.current === "ready" || stateRef.current === "connecting") {
        terminal.writeln("\r\n\x1b[38;5;245m终端连接已关闭。\x1b[0m");
        setState("disconnected");
      }
    });
    socket.addEventListener("error", () => {
      terminal.writeln("\r\n\x1b[31m无法连接 Workspace 终端。\x1b[0m");
      setState("failed");
    });
  }, [onError, sessionId, setState, transmit]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#171917",
        foreground: "#e7e9e5",
        cursor: "#f4f1e8",
        selectionBackground: "#454b45",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminal.writeln("\x1b[38;5;245m点击“连接终端”进入 /workspace。\x1b[0m");
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      if (stateRef.current !== "ready") return;
      transmit({
        workspaceTerminalProtocolVersion: 1,
        type: "workspace_terminal.input",
        data: base64(new TextEncoder().encode(data)),
      });
    });
    const resize = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (terminalRef.current !== terminal) return;
        fit.fit();
        if (stateRef.current === "ready") {
          transmit({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.resize",
            rows: terminal.rows,
            cols: terminal.cols,
          });
        }
      });
    });
    resize.observe(host);
    return () => {
      disconnect();
      resize.disconnect();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [disconnect, transmit]);

  useEffect(() => disconnect, [disconnect, sessionId]);

  return (
    <section className="workspace-terminal-panel" aria-label="Workspace 终端">
      <div className="workspace-terminal-toolbar">
        <div>
          <strong>隔离终端</strong>
          <small>
            {state === "ready"
              ? "已连接 · /workspace"
              : state === "connecting"
                ? "正在启动 Cube KVM"
                : "未连接"}
          </small>
        </div>
        {state === "ready" || state === "connecting" ? (
          <button onClick={disconnect} type="button">
            断开
          </button>
        ) : (
          <button disabled={sessionId === null} onClick={connect} type="button">
            {state === "failed" ? "重新连接" : "连接终端"}
          </button>
        )}
      </div>
      <p className="workspace-terminal-notice">
        连接期间 Agent 不会同时修改此
        Workspace；断开后文件仍会保留，但进程和终端状态不会恢复，文件视图会在下一次 Agent
        提交后刷新。
      </p>
      <div className="workspace-terminal-host" ref={hostRef} />
    </section>
  );
}
