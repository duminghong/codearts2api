/** 网关报错日志读取接口（/admin/gateway-errors/api，受管理密钥保护）。 */
const API = "/admin/gateway-errors/api"

/** 一条落盘的失败记录（字段与后端 error-log.service.ts 的 ErrorLogEntry 对齐）。 */
export interface GatewayErrorEntry {
  ts: string
  provider: string
  model: string
  accountId: string | null
  caller: string | null
  attempt: number
  error: { message: string; type?: string; code?: string; status: number }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(API + path, { credentials: "same-origin", headers: { accept: "application/json" } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && (data as any).error) || "HTTP " + res.status)
  return data as T
}

/** 有哪些天（UTC+8 日期，倒序）。 */
export const listDays = () => request<{ days: string[] }>("/")

/** 某一天的记录（新在前，最多 500 条）。 */
export const listEntries = (day: string) => request<{ day: string; entries: GatewayErrorEntry[] }>(`?day=${day}`)
