/**
 * 网关错误日志读取 REST 控制器（挂在 /admin/gateway-errors/api 下）。
 *
 * 只读、受管理密钥保护（挂载点在 server.ts）。数据源是 {@link createErrorLogService}
 * 落的 JSONL，业务与解析都不在这里。
 */
import express from "express"

import { AppError } from "../../core/errors.ts"
import { sendJson } from "../../http/respond.ts"

/** 文件名形态的日期：YYYY-MM-DD（UTC+8 天）。 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function createErrorLogController({ service }: { service: any }) {
  const router = express.Router()

  /** 不带 day → 有哪些天；带 day → 那天的记录（新在前，上限在 service 里）。 */
  router.get("/", async (request, response) => {
    const day = typeof request.query.day === "string" ? request.query.day : undefined
    if (day === undefined) {
      sendJson(response, 200, { days: await service.listFiles() })
      return
    }
    if (!DAY_RE.test(day)) throw new AppError(400, "invalid_day", "day 必须形如 YYYY-MM-DD")
    const entries = await service.readDay(day)
    if (entries === null) throw new AppError(404, "no_log", `没有 ${day} 的错误日志`)
    sendJson(response, 200, { day, entries })
  })

  return { router }
}
