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

  /**
   * 改「会话开头提示」开关。
   *
   * 立刻生效（不需要重启）：网关在请求路径上同步读服务里的当前值。
   */
  router.put("/session-hint", async (request, response) => {
    const body = request.body ?? {}
    if (typeof body.enabled !== "boolean") throw new AppError(400, "invalid_enabled", "enabled 必须是布尔值")
    sendJson(response, 200, { sessionHint: await service.setSessionHint(body.enabled) })
  })

  /**
   * 改「会话结尾提示」开关。
   *
   * 立刻生效（不需要重启）：与开头提示一样，网关在请求路径上同步读当前值。
   */
  router.put("/session-end-hint", async (request, response) => {
    const body = request.body ?? {}
    if (typeof body.enabled !== "boolean") throw new AppError(400, "invalid_enabled", "enabled 必须是布尔值")
    sendJson(response, 200, { sessionEndHint: await service.setSessionEndHint(body.enabled) })
  })

  /** 改「/v1/models 渠道前缀装饰」开关，同样立刻生效。 */
  router.put("/model-name-decor", async (request, response) => {
    const body = request.body ?? {}
    if (typeof body.enabled !== "boolean") throw new AppError(400, "invalid_enabled", "enabled 必须是布尔值")
    sendJson(response, 200, { modelNameDecor: await service.setModelNameDecor(body.enabled) })
  })

  return { router }
}
