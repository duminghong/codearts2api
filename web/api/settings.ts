/** 管理端设置接口（/admin/settings/api）：面板上可改的运行时开关。 */
const API = "/admin/settings/api"

export interface SettingsState {
  /** 会话开头提示：首轮聊天请求注入「模型 + 渠道积分」。 */
  sessionHint: boolean
  /** 会话结尾提示：助手回复末尾追加「模型 + 渠道积分 + token 用量」。 */
  sessionEndHint: boolean
  /** /v1/models 展示名加渠道前缀（默认开）。 */
  modelNameDecor: boolean
  /** 当前值来自面板（用户点过）还是环境变量的初始默认值。 */
  source: "env" | "panel"
  /** 结尾提示当前值来源（独立于开头提示）。 */
  sourceEndHint: "env" | "panel"
  /** 环境变量提供的初始默认值（仅供界面提示）。 */
  envDefault: boolean
  /** 结尾提示的 env 初始默认值。 */
  envDefaultEndHint: boolean
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

/** 开关「会话开头提示」。返回生效后的值。 */
export const setSessionHint = (enabled: boolean) =>
  request<{ sessionHint: boolean }>("/session-hint", { method: "PUT", body: JSON.stringify({ enabled }) })

/** 开关「会话结尾提示」。返回生效后的值。 */
export const setSessionEndHint = (enabled: boolean) =>
  request<{ sessionEndHint: boolean }>("/session-end-hint", { method: "PUT", body: JSON.stringify({ enabled }) })

/** 开关「/v1/models 渠道前缀装饰」。返回生效后的值。 */
export const setModelNameDecor = (enabled: boolean) =>
  request<{ modelNameDecor: boolean }>("/model-name-decor", { method: "PUT", body: JSON.stringify({ enabled }) })
