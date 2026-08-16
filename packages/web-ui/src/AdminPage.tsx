import { useEffect, useState } from "react";
import type {
  CubeProxyConfigurationResource,
  DeepSeekModelId,
  ModelConfigurationResource,
  TenantIdentityResource,
} from "@pi-cloud/protocol";
import { PiCloudApiError, type PiCloudApi } from "./api.ts";
import { errorMessage } from "./ui-errors.ts";

export function AdminPage({
  api,
  identity,
  onLogout,
}: {
  api: PiCloudApi;
  identity: TenantIdentityResource;
  onLogout: () => void;
}) {
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigurationResource | null>(
    null,
  );
  const [selectedModelId, setSelectedModelId] = useState<DeepSeekModelId>("deepseek-v4-flash");
  const [modelApiKey, setModelApiKey] = useState("");
  const [cubeProxyConfiguration, setCubeProxyConfiguration] =
    useState<CubeProxyConfigurationResource | null>(null);
  const [cubeProxyEnabled, setCubeProxyEnabled] = useState(false);
  const [cubeProxyUrl, setCubeProxyUrl] = useState("");
  const [settingsSaving, setSettingsSaving] = useState<"model" | "proxy" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getCubeProxyConfiguration(), api.getModelConfiguration()])
      .then(([proxyConfiguration, model]) => {
        if (cancelled) return;
        setCubeProxyConfiguration(proxyConfiguration);
        setCubeProxyEnabled(proxyConfiguration.enabled);
        setCubeProxyUrl(proxyConfiguration.proxyUrl ?? "");
        setModelConfiguration(model);
        if (model.mode === "real") setSelectedModelId(model.modelId);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof PiCloudApiError && caught.status === 403) {
          setCubeProxyConfiguration(null);
          setModelConfiguration(null);
          return;
        }
        setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function saveModelConfiguration(): Promise<void> {
    if (modelConfiguration === null || settingsSaving !== null) return;
    const apiKey = modelApiKey.trim();
    if (!/^[A-Za-z0-9._-]{16,512}$/.test(apiKey)) {
      setError("DeepSeek API Key 格式无效。");
      return;
    }
    setSettingsSaving("model");
    setError(null);
    try {
      const configured = await api.replaceModelConfiguration(selectedModelId, apiKey);
      setModelConfiguration(configured);
      setModelApiKey("");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setSettingsSaving(null);
    }
  }

  async function saveCubeProxyConfiguration(): Promise<void> {
    if (cubeProxyConfiguration === null || settingsSaving !== null) return;
    const proxyUrl = cubeProxyUrl.trim();
    if (cubeProxyEnabled && proxyUrl.length === 0) {
      setError("启用 Cube 联网前需要填写上游代理地址。");
      return;
    }
    setSettingsSaving("proxy");
    setError(null);
    try {
      const configured = await api.replaceCubeProxyConfiguration(
        cubeProxyEnabled,
        proxyUrl.length === 0 ? undefined : proxyUrl,
      );
      setCubeProxyConfiguration(configured);
      setCubeProxyEnabled(configured.enabled);
      setCubeProxyUrl(configured.proxyUrl ?? "");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setSettingsSaving(null);
    }
  }

  return (
    <main className="product-admin-page">
      <header className="product-admin-header">
        <div>
          <div className="product-logo">A</div>
          <div>
            <strong>PiCloud 管理后台</strong>
            <span>平台运行配置</span>
          </div>
        </div>
        <div>
          <span>{identity.displayName}</span>
          <button onClick={onLogout} type="button">
            退出登录
          </button>
        </div>
      </header>
      {error ? (
        <div className="product-error-banner product-admin-error">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            ×
          </button>
        </div>
      ) : null}
      <section className="product-admin-content">
        <div className="product-admin-intro">
          <span>ADMINISTRATION</span>
          <h1>运行配置</h1>
          <p>配置写入持久化控制面，新任务或新连接热生效，无需重启集群。</p>
        </div>
        <div className="product-admin-grid">
          <section className="product-settings-section">
            <div>
              <h2>Pi Worker 模型</h2>
              <p>Key 加密保存且不会进入 Cube；运行中的任务保留启动时的模型快照。</p>
            </div>
            <label>
              <span>模型</span>
              <select
                disabled={settingsSaving !== null}
                onChange={(event) => setSelectedModelId(event.target.value as DeepSeekModelId)}
                value={selectedModelId}
              >
                <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
              </select>
            </label>
            <label>
              <span>API Key</span>
              <input
                autoComplete="off"
                disabled={settingsSaving !== null}
                onChange={(event) => setModelApiKey(event.target.value)}
                placeholder={modelConfiguration?.mode === "real" ? "输入新 Key 以轮换" : "sk-…"}
                spellCheck={false}
                type="password"
                value={modelApiKey}
              />
            </label>
            <div className="product-settings-action">
              <small>
                当前凭据版本{" "}
                {modelConfiguration === null
                  ? "读取中"
                  : String(modelConfiguration.credentialVersion)}
              </small>
              <button
                className="product-primary-button"
                disabled={
                  settingsSaving !== null ||
                  modelApiKey.trim() === "" ||
                  modelConfiguration === null
                }
                onClick={() => void saveModelConfiguration()}
                type="button"
              >
                {settingsSaving === "model" ? "加密并发布中…" : "更新模型配置"}
              </button>
            </div>
          </section>
          <section className="product-settings-section">
            <div>
              <h2>CubeSandbox 公网代理</h2>
              <p>MicroVM 只能连接可信网关；新 HTTP/HTTPS 连接读取最新配置。</p>
            </div>
            <label className="product-settings-toggle">
              <input
                checked={cubeProxyEnabled}
                disabled={settingsSaving !== null}
                onChange={(event) => setCubeProxyEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>允许代理感知的软件访问公网 HTTP/HTTPS</span>
            </label>
            <label>
              <span>WSL / 宿主机上游代理</span>
              <input
                autoComplete="off"
                disabled={settingsSaving !== null}
                onChange={(event) => setCubeProxyUrl(event.target.value)}
                placeholder="http://127.0.0.1:7890"
                spellCheck={false}
                type="url"
                value={cubeProxyUrl}
              />
            </label>
            <div className="product-settings-action">
              <small>
                当前代理版本{" "}
                {cubeProxyConfiguration === null
                  ? "读取中"
                  : String(cubeProxyConfiguration.revision)}
              </small>
              <button
                className="product-primary-button"
                disabled={
                  settingsSaving !== null ||
                  cubeProxyConfiguration === null ||
                  (cubeProxyEnabled && cubeProxyUrl.trim() === "")
                }
                onClick={() => void saveCubeProxyConfiguration()}
                type="button"
              >
                {settingsSaving === "proxy" ? "发布中…" : "应用代理配置"}
              </button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
