/** 管理端设置 REST 控制器（挂在 /admin/settings/api 下）。业务在 {@link createSettingsService}。 */
import express from "express"

import { AppError } from "../../core/errors.ts"
import { sendJson } from "../../http/respond.ts"

export function createSettingsController({ service }: { service: any }) {
  const router = express.Router()
  router.use(express.json({ limit: "64kb", type: () => true }))

  /** 读当前设置。 */
  router.get("/", (request, response) => {
    sendJson(response, 200, service.view())
  })

  /** 改「/v1/models 渠道前缀装饰」开关，立刻生效。 */
  router.put("/model-name-decor", async (request, response) => {
    const body = request.body ?? {}
    if (typeof body.enabled !== "boolean") throw new AppError(400, "invalid_enabled", "enabled 必须是布尔值")
    sendJson(response, 200, { modelNameDecor: await service.setModelNameDecor(body.enabled) })
  })

  /** 改「网关报错落盘」开关（默认开），立刻生效。 */
  router.put("/error-log", async (request, response) => {
    const body = request.body ?? {}
    if (typeof body.enabled !== "boolean") throw new AppError(400, "invalid_enabled", "enabled 必须是布尔值")
    sendJson(response, 200, { errorLog: await service.setErrorLog(body.enabled) })
  })

  /** 改「失败换渠道重试」开关（默认关），立刻生效。 */
  router.put("/retry-fallback", async (request, response) => {
    const body = request.body ?? {}
    if (typeof body.enabled !== "boolean") throw new AppError(400, "invalid_enabled", "enabled 必须是布尔值")
    sendJson(response, 200, { retryFallback: await service.setRetryFallback(body.enabled) })
  })

  return { router }
}
