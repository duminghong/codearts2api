/**
 * 网关错误日志：把 /v1 反代层的上游失败逐条落盘，并提供管理端读取接口的数据源。
 *
 * 与 usage-recorder 同款形态：异步写 + 串行队列，不阻塞请求热路径；写失败只告警
 * （fail-open，日志是诊断辅助，绝不能反过来打死主链路）。
 *
 * 每条一行 JSONL 落在 `<home>/gateway-errors/<UTC+8 日期>.jsonl`。字段：
 * `ts / provider / model / accountId / caller / attempt / error{message,type,code,status}`。
 *
 * 账号关联是**尽力而为**：上游 token-ledger 的明细只有请求发起时刻的记账，
 * 没有请求 id 可对。这里用「provider + model + 时间窗（最近 10 分钟）+ 错误消息
 * 前缀」近似匹配；任何一步失败或匹配不上都落 `null`，绝不阻塞错误落盘。
 */
import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import { utc8Day } from "../../core/day.ts"
import { readJsonl } from "../../core/fs-store.ts"

/** 账号关联的时间窗：只在上游账本里找「最近 N 毫秒」内发起的同 provider+model 请求。 */
const LEDGER_MATCH_WINDOW_MS = 10 * 60_000
/** 错误消息取前 N 字符做前缀匹配（上游会把「（纠错建议）」等后缀拼进 message）。 */
const MESSAGE_PREFIX_LEN = 60
/** 读 API 单次最多返回的记录数（防止一天错误太多把响应打爆）。 */
const READ_LIMIT = 500

export interface FailedAttemptEntry {
  ts: string
  provider: string
  model: string
  accountId: string | null
  caller: string | null
  attempt: number
  error: { message: string; type?: string; code?: string; status?: number }
}

export function createErrorLogService({
  home,
  logger,
  adminRpc,
}: {
  home: string
  logger?: any
  adminRpc?: (method: string, payload?: any, tag?: string) => Promise<any>
}) {
  const logDir = join(home, "gateway-errors")

  let logChain = Promise.resolve()
  function log(entry: FailedAttemptEntry) {
    const line = `${JSON.stringify(entry)}\n`
    logChain = logChain.then(async () => {
      try {
        await mkdir(logDir, { recursive: true })
        await appendFile(join(logDir, `${utc8Day()}.jsonl`), line, "utf8")
      } catch (error) {
        logger?.warn?.(`[gateway-errors] 写错误日志失败：${String(error)}`)
      }
    })
    return logChain
  }

  /**
   * 尽力关联账号：读上游 token-ledger 明细，找「最近 10 分钟内、同 provider+model、
   * 错误消息前缀一致」的条目。
   *
   * ⚠️ 匹配只是近似（同模型并发多次失败会互相撞车），撞车时宁可返回 null：
   * 错标账号比不标更误导。
   */
  async function resolveAccountId(input: {
    provider: string
    model: string
    errorMessage: string
  }): Promise<string | null> {
    if (typeof adminRpc !== "function") return null
    try {
      const res: any = await adminRpc("usage.tokenLedger", { limit: 500 })
      const entries: any[] = Array.isArray(res?.entries) ? res.entries : []
      const windowStart = Date.now() - LEDGER_MATCH_WINDOW_MS
      const prefix = input.errorMessage.slice(0, MESSAGE_PREFIX_LEN)
      const hits = entries.filter((e) => {
        if (!e || typeof e !== "object") return false
        if (e.provider !== input.provider || e.model !== input.model) return false
        const ts = Number(e.ts ?? e.timestamp ?? NaN)
        if (!Number.isFinite(ts) || ts < windowStart) return false
        const err = typeof e.error === "string" ? e.error : ""
        return typeof err === "string" && err.slice(0, prefix.length) === prefix && prefix.length > 0
      })
      // 恰好一条才敢认领；多条 = 撞车（同模型并发失败），标 null。
      if (hits.length !== 1) return null
      const accountId = hits[0].accountId
      return typeof accountId === "string" && accountId.length > 0 ? accountId : null
    } catch (error) {
      logger?.debug?.(`[gateway-errors] 账号关联失败（降级为 null）：${String(error)}`)
      return null
    }
  }

  /** 列错误日志的**日期**（按日期倒序 = 新在前）。去掉 `.jsonl` 后缀 —— 返回值直接可喂 readDay。 */
  async function listFiles(): Promise<string[]> {
    try {
      const names = await readdir(logDir)
      return names
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .map((name) => name.slice(0, -".jsonl".length))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** 读某一天的日志（新记录在前）。文件不存在 / 名字非法返回 null。 */
  async function readDay(day: string): Promise<any[] | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
    let rows: any[]
    try {
      rows = await readJsonl(join(logDir, `${day}.jsonl`))
    } catch {
      return null
    }
    if (rows.length === 0) {
      try {
        await stat(join(logDir, `${day}.jsonl`))
      } catch {
        return null // 文件不存在
      }
    }
    return rows.reverse().slice(0, READ_LIMIT)
  }

  return { log, resolveAccountId, listFiles, readDay, logDir }
}
