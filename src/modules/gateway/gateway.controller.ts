/** `/v1/*` 透明反代控制器（HTTP 边界）：SSE 流式回写，鉴权交给 callerGate。 */
import { Readable } from "node:stream"

import { readBody } from "../../http/body.ts"
import { sendAdminJson } from "../../http/security.ts"
import { createGatewayTargetResolver, decorateModelsWithProvider, MODEL_DECOR_LIMIT } from "./gateway.service.ts"
import { createSessionHint } from "./session-hint.service.ts"

/**
 * 会话提示要自己 buffer 请求体时的上限。
 *
 * 与 caller-gate 的 BODY_CAP（32MB）取同值：闸门开着时它就按这个上限收，
 * 这里独立读时用同一把尺子，两条路径的报错形态才一致。
 */
const HINT_BODY_LIMIT = 32 * 1024 * 1024

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

export function createGatewayController({
  host,
  callerGate,
  logger,
  upstreamTimeoutMs,
  adminRpc,
  sessionHintEnabled,
}: any) {
  const resolveGatewayTarget = createGatewayTargetResolver({ host })
  // 会话开头提示：/v1/chat/completions 首轮注入「模型 + 渠道积分」system 消息。
  // 请求体的来源见下面 >>> session-hint 段：闸门开着就用闸门 buffer 的，
  // 闸门关着（默认形态）就自己 buffer —— 两条路都得覆盖。
  //
  // ⚠️ `sessionHintEnabled` 可以是布尔常量，也可以是 **getter**（`() => boolean`）：
  //    管理端面板的开关要能实时生效，所以不能在建对象时把开关求值成常量。
  const hintOn = () =>
    typeof sessionHintEnabled === "function" ? sessionHintEnabled() === true : sessionHintEnabled === true
  const sessionHint =
    typeof adminRpc === "function" ? createSessionHint({ enabled: hintOn, rpc: adminRpc, logger }) : null

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

    // >>> session-hint
    // 首轮聊天请求注入「模型 + 渠道积分」system 消息；失败原样透传。
    // 改写后 body 变长，必须同步 content-length（客户端原值已失效）。
    //
    // ⚠️ 请求体来源有两条路，**必须都覆盖**：
    //   1. 闸门开着 → caller-gate 已 buffer（gateBody），直接用；
    //   2. 闸门关着（**默认形态**：没有 caller-keys.json）→ gateBody 是 undefined，
    //      闸门把请求体原样留给流式透传。所以这里自己 buffer 一次。
    //   只认 gateBody 的话，默认形态下这个功能**永远不会触发**（2026-11-18 实测证实）。
    //
    // ⚠️ 开关关着时**整段跳过**：否则会为了「读完再原样转发」而无谓地 buffer
    //    整个请求体（SSE 长对话尤其明显）。开关是每请求现读的，所以点了立刻生效。
    if (sessionHint && hintOn() && url.pathname === "/v1/chat/completions" && hasBody) {
      let body = gateBody
      if (!body) {
        // 只在**声明了长度且在上限内**时自己 buffer。
        // ⚠️ readBody 超限会 destroy 请求流 → 客户端只看到 connection reset，
        //    而不是上游本该给的干净报错。所以长度不明（chunked）或超限就**不碰**请求体，
        //    直接放弃注入（fail-open）—— 少一条提示，好过把对话打死。
        const declared = Number(headers.get("content-length") ?? Number.NaN)
        if (Number.isFinite(declared) && declared > 0 && declared <= HINT_BODY_LIMIT) {
          try {
            body = await readBody(request, HINT_BODY_LIMIT)
          } catch (error) {
            // 读不动就放弃注入，原样透传（fail-open）。提示是锦上添花，
            // 读体失败不该影响正常对话。
            logger?.debug?.(`[session-hint] 读取请求体失败，跳过注入：${String(error)}`)
            body = undefined
          }
        }
      }
      if (body) {
        const rewritten = await sessionHint.rewrite(body, gateModel ?? null)
        if (rewritten !== body) {
          body = rewritten
          headers.set("content-length", String(body.length))
        }
        gateBody = body
      }
    }
    // <<< session-hint

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
