/** `/v1/*` 透明反代控制器（HTTP 边界）：SSE 流式回写，鉴权交给 callerGate。 */
import { Readable } from "node:stream"

import { sendAdminJson } from "../../http/security.ts"
import { createGatewayTargetResolver, decorateModelsWithProvider, MODEL_DECOR_LIMIT } from "./gateway.service.ts"

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export function createGatewayController({ host, callerGate, logger, upstreamTimeoutMs }: any) {
  const resolveGatewayTarget = createGatewayTargetResolver({ host })

  async function proxyToGateway(request: any, response: any, url: any) {
    const startedAt = Date.now()
    const target = await resolveGatewayTarget()
    const headers = new Headers()
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
      if (Array.isArray(value)) for (const item of value) headers.append(key, item)
      else headers.set(key, value as string)
    }

    const method = request.method ?? "GET"
    const hasBody = method !== "GET" && method !== "HEAD"

    let gateEntry: any = null
    let gateModel
    let gateBody
    if (callerGate) {
      const verdict = await callerGate.inspect(request, url, method)
      if (!verdict.ok) {
        callerGate.sendJson(response, verdict.status ?? 403, { error: verdict.error })
        return
      }
      if (!verdict.disabled) {
        gateEntry = verdict.entry ?? null
        gateModel = verdict.model
        gateBody = verdict.body
        const upstreamKey = await callerGate.upstreamKey()
        if (upstreamKey) headers.set("authorization", `Bearer ${upstreamKey}`)
        if (gateEntry?.id) headers.set("x-caller-id", String(gateEntry.id))
      }
    }

    let upstream: any
    try {
      upstream = await fetch(`http://${target.host}:${target.port}${url.pathname}${url.search}`, {
        method,
        headers,
        body: gateBody ?? (hasBody ? request : undefined),
        ...(hasBody ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(upstreamTimeoutMs ?? 600_000),
      } as any)
    } catch (error) {
      logger?.warn?.(`[proxy] 网关不可达（${target.host}:${target.port}）：${String(error)}`)
      sendAdminJson(response, 502, {
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）。请在 /admin 里确认网关已开启。`,
          type: "server_error",
          code: "gateway_unreachable",
        },
      })
      return
    }

    if (callerGate && gateEntry && url.pathname === "/v1/models" && upstream.ok) {
      try {
        const payload = await upstream.json()
        callerGate.sendJson(response, 200, decorateModelsWithProvider(callerGate.filterModels(payload, gateEntry)))
        return
      } catch {
        /* 解析失败就退回原始流 */
      }
    }

    // >>> provider-name-decor
    // 未启用调用方闸门时（常态：DSH 直接用网关 Key），/v1/models 走下面的流式透传，
    // 装饰必须在流式路径里也做一次。缓冲有上限，且**任何失败都原样回写已读的字节**，
    // 绝不因为装饰功能把上游响应吞掉 —— 装饰失败宁可退回「没有渠道前缀」。
    if (
      url.pathname === "/v1/models" &&
      upstream.ok &&
      String(upstream.headers.get("content-type") ?? "").includes("json")
    ) {
      const declared = Number(upstream.headers.get("content-length") ?? Number.NaN)
      if (!Number.isFinite(declared) || declared <= MODEL_DECOR_LIMIT) {
        const buffered = await upstream.arrayBuffer().catch(() => null)
        if (buffered !== null && buffered.byteLength <= MODEL_DECOR_LIMIT) {
          const raw = Buffer.from(buffered)
          let payload: any = null
          try {
            payload = JSON.parse(raw.toString("utf8"))
          } catch {
            payload = null
          }
          if (payload && Array.isArray(payload.data)) {
            sendAdminJson(response, 200, decorateModelsWithProvider(payload))
            return
          }
          // 形态不认识：原样透传，行为与装饰前完全一致。
          const passthrough: any = {}
          upstream.headers.forEach((value: string, key: string) => {
            if (HOP_BY_HOP.has(key.toLowerCase())) return
            passthrough[key] = value
          })
          response.writeHead(upstream.status, passthrough)
          response.end(raw)
          return
        }
      }
    }
    // <<< provider-name-decor

    const outHeaders: any = {}
    upstream.headers.forEach((value: string, key: string) => {
      if (HOP_BY_HOP.has(key.toLowerCase())) return
      outHeaders[key] = value
    })
    response.writeHead(upstream.status, outHeaders)

    if (upstream.body === null) {
      response.end()
      return
    }
    const stream = Readable.fromWeb(upstream.body)
    response.once("close", () => {
      if (!response.writableEnded) stream.destroy()
    })
    stream.on("error", () => response.destroy())
    const outStream = callerGate
      ? callerGate.tapStream(stream, {
          status: upstream.status,
          callerId: gateEntry?.id,
          callerName: gateEntry?.name,
          callerGroup: gateEntry?.group,
          model: gateModel,
          path: url.pathname,
          startedAt,
          stream: String(upstream.headers.get("content-type") ?? "").includes("event-stream"),
        })
      : stream
    outStream.pipe(response)
  }

  return { proxyToGateway }
}
