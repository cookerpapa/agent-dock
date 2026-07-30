import { useState, type FormEvent } from "react";
import type { TenantIdentityResource } from "@agent-dock/protocol";
import type { AgentDockApi } from "./api.ts";
import { errorMessage } from "./ui-errors.ts";

type AuthMode = "login" | "register";

export function AuthScreen({
  api,
  onAuthenticated,
}: {
  api: AgentDockApi;
  onAuthenticated: (identity: TenantIdentityResource) => void;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === "login"
          ? await api.loginAccount(username.trim().toLowerCase(), password)
          : await api.registerAccount(username.trim().toLowerCase(), displayName.trim(), password);
      onAuthenticated(session.identity);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="product-auth-page">
      <section className="product-auth-brand">
        <div className="product-logo product-logo-large" aria-hidden="true">
          A
        </div>
        <h1>AgentDock</h1>
        <p>你的云端 Coding Agent</p>
      </section>
      <form className="product-auth-card" onSubmit={(event) => void submit(event)}>
        <div className="product-auth-tabs" role="tablist" aria-label="账户操作">
          <button
            aria-selected={mode === "login"}
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
            role="tab"
            type="button"
          >
            登录
          </button>
          <button
            aria-selected={mode === "register"}
            className={mode === "register" ? "active" : ""}
            onClick={() => {
              setMode("register");
              setError(null);
            }}
            role="tab"
            type="button"
          >
            注册
          </button>
        </div>
        <h2>{mode === "login" ? "欢迎回来" : "创建账户"}</h2>
        <p>{mode === "login" ? "登录后继续你的对话" : "注册后即可开始使用，无需配置模型"}</p>
        {mode === "register" ? (
          <label>
            <span>显示名称</span>
            <input
              autoComplete="name"
              maxLength={256}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="你希望我们如何称呼你"
              required
              value={displayName}
            />
          </label>
        ) : null}
        <label>
          <span>用户名</span>
          <input
            autoCapitalize="none"
            autoComplete="username"
            maxLength={48}
            minLength={3}
            onChange={(event) => setUsername(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,47}"
            placeholder="3–48 位字母、数字或 . _ -"
            required
            spellCheck={false}
            value={username}
          />
        </label>
        <label>
          <span>密码</span>
          <input
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            maxLength={128}
            minLength={10}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 10 个字符"
            required
            type="password"
            value={password}
          />
        </label>
        {error ? <div className="product-auth-error">{error}</div> : null}
        <button className="product-primary-button" disabled={busy} type="submit">
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并继续"}
        </button>
      </form>
      <footer>账户、对话和 Workspace 按租户隔离</footer>
    </main>
  );
}
