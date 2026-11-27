/** 管理端设置接口（/admin/settings/api）：面板上可改的运行时开关。 */
const API = "/admin/settings/api"

export interface SettingsState {
  /** /v1/models 展示名加渠道前缀（默认开）。 */
  modelNameDecor: boolean
  /** 网关报错落盘（默认开）。 */
  errorLog: boolean
  /** 失败换渠道重试（默认关）。 */
  retryFallback: boolean
  /** 值来源：默认值或面板设置过。 */
  sourceModelNameDecor: "default" | "panel"
  sourceErrorLog: "default" | "panel"
  sourceRetryFallback: "default" | "panel"
}

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && (data as any).error) || "HTTP " + res.status)
  return data as T
}

export const getSettings = () => request<SettingsState>("/")

/** 开关「/v1/models 渠道前缀装饰」。返回生效后的值。 */
export const setModelNameDecor = (enabled: boolean) =>
  request<{ modelNameDecor: boolean }>("/model-name-decor", { method: "PUT", body: JSON.stringify({ enabled }) })

/** 开关「网关报错落盘」。返回生效后的值。 */
export const setErrorLog = (enabled: boolean) =>
  request<{ errorLog: boolean }>("/error-log", { method: "PUT", body: JSON.stringify({ enabled }) })

/** 开关「失败换渠道重试」。返回生效后的值。 */
export const setRetryFallback = (enabled: boolean) =>
  request<{ retryFallback: boolean }>("/retry-fallback", { method: "PUT", body: JSON.stringify({ enabled }) })
