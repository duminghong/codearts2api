/** `/v1/*` 透明反代控制器（HTTP 边界）：SSE 流式回写，鉴权交给 callerGate。 */
import { PassThrough, Readable } from "node:stream"

import { AGGREGATE_PROVIDERS, READONLY_V1_PATHS } from "../../core/upstream.ts"
import { readBody } from "../../http/body.ts"
import { sendAdminJson } from "../../http/security.ts"
import {
  createGatewayTargetResolver,
  decorateModelsWithProvider,
  MODEL_DECOR_LIMIT,
  providerIds,
} from "./gateway.service.ts"
import { createEndHintTransform, createResponseHintTransform, createSessionHint } from "./session-hint.service.ts"

/**
 * 会话提示 / 换渠道重试要自己 buffer 请求体时的上限。
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

/** 换渠道重试上限：首次之外最多再试 2 次（共 3 次）。 */
const MAX_RETRY = 2

/** 从上游响应里挑出可透传的头（剔掉逐跳头）。 */
function pickHeaders(upstream: any): Record<string, string> {
  const out: Record<string, string> = {}
  upstream.headers.forEach((value: string, key: string) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return
    out[key] = value
  })
  return out
}

/** 上游错误信封（见 openai-gateway/stream.js、server.js）。 */
interface UpstreamError {
  message: string
  type?: string
  code?: string
  status: number
}

/** 从 `{error:{...}}` 形态解析错误（不含 status）；形态不符返回 null。 */
function errorFromEnvelope(obj: any): Omit<UpstreamError, "status"> | null {
  const err = obj?.error
  if (!err || typeof err.message !== "string") return null
  return {
    message: err.message,
    type: typeof err.type === "string" ? err.type : undefined,
    code: typeof err.code === "string" ? err.code : undefined,
  }
}

/** 解析非流式上游的错误信封文本；解析不出返回 null。 */
function parseErrorEnvelope(text: string): Omit<UpstreamError, "status"> | null {
  try {
    return errorFromEnvelope(JSON.parse(text))
  } catch {
    return null
  }
}

/** 从单条 SSE `data:` payload 文本解析错误信封；非错误帧返回 null。 */
function sseFrameError(frame: string): Omit<UpstreamError, "status"> | null {
  const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"))
  if (!line) return null
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return null
  try {
    return errorFromEnvelope(JSON.parse(payload))
  } catch {
    return null
  }
}

/**
 * 判定一段 SSE 起始缓冲是否为「纯错误开头」（还没吐过内容 → 可以换渠道重试）。
 *
 * 上游把失败作为 `data: {"error":...}` 帧下发（见 openai-gateway/stream.js）。
 * 只有当缓冲里的**每一个** data 帧都是错误帧时才判定可重试；中间混进任何正常帧
 * （role=assistant 的首 chunk 等）就判定已吐内容、**不重试**。
 *
 * ponytail: 只窥探到「第一个事件边界」为止，单帧足够 —— 上游失败时第一个事件就是
 * 错误帧。误判成「有内容」只会少一次重试（保守、安全），误判成「错误」才会吞掉正常流，
 * 所以判据宁松勿紧：拿不准就当作有内容、不重试。
 */
function inspectSseHead(head: string): { error: Omit<UpstreamError, "status"> | null; hasContent: boolean } {
  const frames = head.split(/\r?\n\r?\n/).filter((f) => f.trim())
  if (frames.length === 0) return { error: null, hasContent: false }
  let error: Omit<UpstreamError, "status"> | null = null
  for (const frame of frames) {
    const err = sseFrameError(frame)
    if (err) {
      if (error) return { error: null, hasContent: true } // 多条错误帧 → 形态不熟，保守不重试
      error = err
      continue
    }
    // 不是错误帧：只要它是个非空 data 帧就算「已吐内容」。
    if (frame.split(/\r?\n/).some((l) => l.startsWith("data:") && l.slice(5).trim() !== "")) {
      return { error: null, hasContent: true }
    }
  }
  return { error, hasContent: false }
}

/**
 * 重试是否「可恢复」：排除 `model_not_found` 与参数类 4xx。
 *
 * - `model_not_found`：换渠道也找不到同一模型 → 不可重试。
 * - 400/401/403/404/413：参数/鉴权/权限类，换渠道不会变好。
 * - 其余（5xx、429、超时、连接错误等）视为可恢复。
 */
function isRecoverableError(status: number, code: string | undefined): boolean {
  if (code === "model_not_found") return false
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 413) return false
  return true
}

/**
 * 从模型 id 切出 provider 与裸模型名：`provider/model`，按首个 `/` 切片
 * （上游 parseModelRoute 同口径；provider 名不含 `/`）。
 */
function splitModelId(modelId: string): { provider: string; bare: string } | null {
  const idx = modelId.indexOf("/")
  if (idx <= 0 || idx === modelId.length - 1) return null
  return { provider: modelId.slice(0, idx), bare: modelId.slice(idx + 1) }
}

export function createGatewayController({
  host,
  callerGate,
  logger,
  upstreamTimeoutMs,
  adminRpc,
  sessionHintEnabled,
  sessionEndHintEnabled,
  modelNameDecorEnabled,
  errorLog,
  errorLogEnabled,
  retryFallbackEnabled,
}: any) {
  const resolveGatewayTarget = createGatewayTargetResolver({ host })
  // 各开关可以是布尔常量，也可以是 **getter**（`() => boolean`）：管理端面板的
  // 开关要能实时生效，所以不能在建对象时把开关求值成常量。
  const flag = (v: any) => (typeof v === "function" ? v() === true : v === true)
  const hintOn = () => flag(sessionHintEnabled)
  const endHintOn = () => flag(sessionEndHintEnabled)
  // 装饰开关关着时两条装饰路径都整段跳过：不缓冲、不解析，行为与「没有装饰功能」完全一致。
  const decorOn = () => flag(modelNameDecorEnabled)
  // 失败换渠道重试开关：同样每请求现读，面板点完立刻生效。
  const retryOn = () => flag(retryFallbackEnabled)
  // 错误落盘开关（默认开）：service 没接进来时整条链路自然 no-op。开关每请求现读。
  const errorLogOn = () => Boolean(errorLog) && flag(errorLogEnabled ?? true)
  const sessionHint =
    typeof adminRpc === "function"
      ? createSessionHint({
          enabled: hintOn,
          endEnabled: endHintOn,
          rpc: adminRpc,
          logger,
          allProviders: () => providerIds(host),
        })
      : null

  /** 落一条失败（fire-and-forget；service 内部串行队列自带 fail-open，绝不阻塞主链路）。 */
  function recordFailure(
    gateEntry: any,
    attempt: { provider: string; model: string; attempt: number; error: UpstreamError },
  ) {
    if (!errorLogOn()) return
    const provider = attempt.provider
    const model = attempt.model
    Promise.resolve()
      .then(async () => {
        let accountId: string | null = null
        try {
          accountId = await errorLog.resolveAccountId({ provider, model, errorMessage: attempt.error.message })
        } catch {
          accountId = null
        }
        return errorLog.log({
          ts: new Date().toISOString(),
          provider,
          model,
          accountId,
          caller: gateEntry?.id ?? gateEntry?.name ?? null,
          attempt: attempt.attempt,
          error: {
            message: attempt.error.message,
            type: attempt.error.type,
            code: attempt.error.code,
            status: attempt.error.status,
          },
        })
      })
      .catch((error) => logger?.warn?.(`[gateway-errors] 落盘失败（已忽略）：${String(error)}`))
  }

  /**
   * 生成换渠道重试的候选 provider 列表：裸模型名全等、按该 provider 在线模型数降序、
   * 字母序兜底。候选排除聚合路由（换过去还是同一批后端）。
   *
   * ⚠️ 调用方白名单在挑「下一个」时用 `gateEntry.match(...)` 复核，这里只筛「裸模型名
   *    是否存在于该渠道」—— 模型目录是上游的，这里不复制它的可见性逻辑。
   */
  async function retryCandidates(bareModel: string): Promise<string[]> {
    let ids: string[]
    try {
      ids = providerIds(host)
    } catch {
      return []
    }
    const scored: Array<{ provider: string; count: number }> = []
    for (const provider of ids) {
      if (AGGREGATE_PROVIDERS.has(provider)) continue
      try {
        const res: any = await adminRpc("model.list", { provider })
        const list: any[] = Array.isArray(res?.models) ? res.models : Array.isArray(res) ? res : []
        const has = list.some((m) => (typeof m === "string" ? m === bareModel : m?.id === bareModel))
        if (has) scored.push({ provider, count: list.length })
      } catch {
        /* 该 provider 查不到就跳过（fail-open：少一个候选，不是报错） */
      }
    }
    scored.sort((a, b) => b.count - a.count || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
    return scored.map((s) => s.provider)
  }

  /** 过调用方白名单：重试候选必须该调用方可用。没有闸门（默认形态）时不拦。 */
  function allowByEntry(entry: any, modelId: string): boolean {
    if (typeof entry?.match !== "function") return true
    try {
      return entry.match(modelId)?.allowed === true
    } catch {
      return false
    }
  }

  /**
   * 把上游响应透传给客户端，挂上 usage 记账与会话提示（与原路径行为一致）。
   *
   * `headBuffered`：重试/落盘窥探 SSE 首帧时已读的字节，需要灌回流头部；
   * `restStream`：首帧之后剩余的 Node 流。两者同时存在时用 PassThrough 串起来。
   */
  function pipeUpstream(upstream: any, response: any, opts: any) {
    const { headBuffered, restStream, isStream, gateEntry, gateModel, hintText, endHintCtx, startedAt, path } = opts
    const outHeaders = pickHeaders(upstream)
    // 提示/首帧缓冲都会让 body 与上游 content-length 对不上 → 删掉走 chunked。
    if (hintText || endHintCtx || headBuffered) delete outHeaders["content-length"]
    response.writeHead(upstream.status, outHeaders)

    let stream: any
    if (headBuffered != null) {
      stream = new PassThrough()
      stream.write(headBuffered)
      if (restStream) restStream.on("error", () => stream.destroy()).pipe(stream, { end: true })
      else stream.end()
    } else if (upstream.body === null) {
      response.end()
      return
    } else {
      stream = Readable.fromWeb(upstream.body)
    }
    let streamFailed = false
    response.once("close", () => {
      if (response.writableEnded || streamFailed) return
      // 客户端提前断开（自身超时 / 手动取消）：上游未见失败，但用户侧体验是「报错」——
      // 记一条可查（HTTP 499 = 业界约定的「client closed request」）。上游流没有错、
      // 用量记账也不会完成，这里是这类事件唯一的落点。
      stream.destroy()
      const mid = typeof gateModel === "string" ? splitModelId(gateModel) : null
      recordFailure(gateEntry, {
        provider: mid?.provider ?? "unknown",
        model: typeof gateModel === "string" ? gateModel : "",
        attempt: 1,
        error: {
          message: "客户端提前断开（超时或取消）—— 上游未见失败，响应未完整送达。",
          type: "client_error",
          code: "client_aborted",
          status: 499,
        },
      })
    })
    stream.on("error", (error: any) => {
      streamFailed = true
      if (!response.writableEnded) response.destroy()
      // 流中途断掉（上游/网关半路挂、超时）：HTTP 层看不到失败，只有这里能记。
      const mid = typeof gateModel === "string" ? splitModelId(gateModel) : null
      recordFailure(gateEntry, {
        provider: mid?.provider ?? "unknown",
        model: typeof gateModel === "string" ? gateModel : "",
        attempt: 1,
        error: {
          message: `上游流中断：${String(error)}`,
          type: "server_error",
          code: "upstream_stream_broken",
          status: upstream.status,
        },
      })
    })

    const outStream =
      callerGate && !READONLY_V1_PATHS.has(path)
        ? callerGate.tapStream(stream, {
            status: upstream.status,
            callerId: gateEntry?.id,
            callerName: gateEntry?.name,
            callerGroup: gateEntry?.group,
            model: gateModel,
            path,
            startedAt,
            stream: isStream,
          })
        : stream
    let finalStream: any = outStream
    if (hintText) finalStream = finalStream.pipe(createResponseHintTransform({ hintText, isStream, logger }))
    if (endHintCtx) {
      finalStream = finalStream.pipe(
        createEndHintTransform({
          model: endHintCtx.model,
          isStream,
          logger,
          resolveProvider: endHintCtx.resolveProvider,
        }),
      )
    }
    finalStream.pipe(response)
  }

  /** 把已读取过部分的 reader 包回 Node 可读流（剩余字节不丢）。 */
  function nodeStreamFromReader(reader: any) {
    return Readable.from(
      (async function* () {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) return
            yield value
          }
        } catch {
          /* 上游流断：交给 response 的 error 处理 */
        }
      })(),
    )
  }

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
    const isChat = url.pathname === "/v1/chat/completions"

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
    // 首轮聊天请求：判定 + 生成「用户可见」提示文本（**不改写请求体** —— 提示给用户，不给模型）。
    //
    // ⚠️ 请求体来源有两条路，**必须都覆盖**：
    //   1. 闸门开着 → caller-gate 已 buffer（gateBody），直接用；
    //   2. 闸门关着（**默认形态**：没有 caller-keys.json）→ gateBody 是 undefined，
    //      闸门把请求体原样留给流式透传。所以这里自己 buffer 一次。
    //   只认 gateBody 的话，默认形态下这个功能**永远不会触发**（2026-11-18 实测证实）。
    //
    // ⚠️ 开关关着时**整段跳过**：否则会为了「读完再原样转发」而无谓地 buffer
    //    整个请求体（SSE 长对话尤其明显）。开关是每请求现读的，所以点了立刻生效。
    let hintText: string | null = null
    let endHintCtx: { model: string; resolveProvider?: () => Promise<string | null> } | null = null
    const needBodyBuffer = isChat && hasBody
    if (sessionHint && (hintOn() || endHintOn()) && needBodyBuffer) {
      let body = gateBody
      if (!body) {
        const declared = Number(headers.get("content-length") ?? Number.NaN)
        if (Number.isFinite(declared) && declared > 0 && declared <= HINT_BODY_LIMIT) {
          try {
            body = await readBody(request, HINT_BODY_LIMIT)
          } catch (error) {
            logger?.debug?.(`[session-hint] 读取请求体失败，跳过提示：${String(error)}`)
            body = undefined
          }
        }
      }
      if (body) {
        gateBody = body
        if (hintOn()) hintText = await sessionHint.prepare(body, gateModel ?? null)
        if (endHintOn()) endHintCtx = await sessionHint.prepareEnd(body, gateModel ?? null)
      }
    }
    // <<< session-hint

    const ctx = {
      request,
      response,
      url,
      target,
      headers,
      method,
      hasBody,
      gateBody,
      gateModel,
      gateEntry,
      hintText,
      endHintCtx,
      startedAt,
    }

    // >>> 聊天链路：落盘 / 重试统一走这一条（retry 关时只跑一次，等价于原透传 + 落盘）。
    if (isChat && (errorLogOn() || retryOn())) {
      return await handleChat(ctx)
    }
    // <<<

    // 非聊天（/v1/models、/v1/embeddings…）与「落盘+重试都关」：原样透传，零行为变化。
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
      recordFailure(gateEntry, {
        provider: "unknown",
        model: typeof gateModel === "string" ? gateModel : "",
        attempt: 1,
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）：${String(error)}`,
          type: "server_error",
          code: "gateway_unreachable",
          status: 502,
        },
      })
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
        const filtered = callerGate.filterModels(payload, gateEntry)
        callerGate.sendJson(response, 200, decorOn() ? decorateModelsWithProvider(filtered) : filtered)
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
      decorOn() &&
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
          const passthrough = pickHeaders(upstream)
          response.writeHead(upstream.status, passthrough)
          response.end(raw)
          return
        }
      }
    }
    // <<< provider-name-decor

    // 非聊天路径的上游失败也落盘（定稿：/v1/* 反代层的失败逐条记录）。
    // 错误体很小，整份读出不影响透传语义；recordFailure 是 fire-and-forget，不拖慢回写。
    const isStream = String(upstream.headers.get("content-type") ?? "").includes("event-stream")
    if (errorLogOn() && !upstream.ok && !isStream) {
      const text = await upstream.text().catch(() => "")
      const env = parseErrorEnvelope(text) ?? {
        message: `上游返回 ${upstream.status}。`,
        type: "server_error",
        code: "upstream_error",
      }
      const split = typeof gateModel === "string" ? splitModelId(gateModel) : null
      recordFailure(gateEntry, {
        provider: split?.provider ?? "unknown",
        model: typeof gateModel === "string" ? gateModel : "",
        attempt: 1,
        error: { ...env, status: upstream.status },
      })
      response.writeHead(upstream.status, pickHeaders(upstream))
      response.end(text)
      return
    }

    pipeUpstream(upstream, response, { ...ctx, isStream, headBuffered: null, restStream: null, path: url.pathname })
  }

  /**
   * 聊天请求的统一处理：落盘（默认开）+ 可选换渠道重试。
   *
   * 重试只换请求体里的 model id（`${新provider}/${裸模型名}`），目标网关不变、不改写响应。
   * 每条失败都落一行盘；全部失败回**最后一次**失败的错误信封。
   * retry 关时只发一次请求，行为 = 原透传 + 失败落盘。
   */
  async function handleChat(ctx: any) {
    const { request, response, headers, hasBody, gateEntry, gateModel } = ctx
    const retry = retryOn() && typeof adminRpc === "function"

    // 重试/落盘都可能要改写或解析请求体 → buffer 一次。
    // 闸门开着时它已 buffer（Buffer）；闸门关着（默认形态）就自己读。
    let body: Buffer | undefined = Buffer.isBuffer(ctx.gateBody) ? ctx.gateBody : undefined
    if (!body && hasBody) {
      const declared = Number(headers.get("content-length") ?? Number.NaN)
      // 长度不明（chunked）/超限/缺失：不碰请求体，退回单次透传（fail-open）。
      // 宁可不重试也不打死长对话；落盘此时退化成只记 HTTP 状态、没有逐请求 model 归属。
      const canBuffer = Number.isFinite(declared) && declared > 0 && declared <= HINT_BODY_LIMIT
      if (retry && !canBuffer) {
        return await singlePassthrough(ctx)
      }
      if (canBuffer) {
        try {
          body = await readBody(request, HINT_BODY_LIMIT)
        } catch (error) {
          logger?.debug?.(`[gateway-retry] 读取请求体失败：${String(error)}`)
          body = undefined
        }
      }
    }
    // body 可能被 readBody 消费过；用 Buffer 转发（不再用 request 流）。
    const forwarded = body ?? ctx.gateBody ?? (hasBody ? request : undefined)

    let parsed: any = null
    if (body) {
      try {
        parsed = JSON.parse(body.toString("utf8"))
      } catch {
        parsed = null
      }
    }
    const modelId =
      (typeof parsed?.model === "string" && parsed.model) || (typeof gateModel === "string" && gateModel) || null
    const split = modelId ? splitModelId(modelId) : null

    // 没有可切的 provider、重试关着、或请求体解析不出（改写会毁掉整个 body）→
    // 单次请求（attemptOnce 负责写响应），失败顺手落盘。
    const provider = split?.provider ?? "unknown"
    if (!split || !retry || parsed === null) {
      const outcome = await attemptOnce({ ctx, body: forwarded, provider, bare: split?.bare, mayRetry: false })
      if (outcome.kind === "passed" && outcome.failure) {
        recordFailure(gateEntry, { provider, model: modelId ?? "", attempt: 1, error: outcome.failure })
      }
      return
    }

    const tried = new Set<string>([split.provider])
    let current = split.provider
    let lastFailure: UpstreamError | null = null

    for (let attempt = 1; attempt <= MAX_RETRY + 1; attempt++) {
      const sendModel = `${current}/${split.bare}`
      const sendBody = Buffer.from(JSON.stringify({ ...(parsed ?? { model: sendModel }), model: sendModel }), "utf8")
      const outcome = await attemptOnce({
        ctx,
        body: sendBody,
        provider: current,
        bare: split.bare,
        mayRetry: attempt <= MAX_RETRY,
      })
      if (outcome.kind === "passed") {
        // 末次 attempt（mayRetry=false）的失败也在这里：响应已由 attemptOnce 回写，只补落盘。
        if (outcome.failure) {
          recordFailure(gateEntry, { provider: current, model: sendModel, attempt, error: outcome.failure })
        }
        return
      }
      lastFailure = outcome.error
      recordFailure(gateEntry, { provider: current, model: sendModel, attempt, error: outcome.error })
      if (!isRecoverableError(outcome.error.status, outcome.error.code)) break
      const next = (await retryCandidates(split.bare)).find(
        (p) => !tried.has(p) && allowByEntry(gateEntry, `${p}/${split.bare}`),
      )
      if (!next) break
      tried.add(next)
      current = next
    }

    const finalError = lastFailure ?? {
      message: "上游无响应。",
      type: "server_error",
      code: "gateway_error",
      status: 502,
    }
    sendAdminJson(response, finalError.status || 502, {
      error: { message: finalError.message, type: finalError.type, code: finalError.code },
    })
  }

  /** 落盘/重试都拿不到请求体归属时的退路：一次原样透传（与改造前一致）。 */
  async function singlePassthrough(ctx: any) {
    const {
      request,
      response,
      url,
      target,
      headers,
      method,
      hasBody,
      gateBody,
      gateModel,
      gateEntry,
      hintText,
      endHintCtx,
      startedAt,
    } = ctx
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
      recordFailure(gateEntry, {
        provider: "unknown",
        model: typeof gateModel === "string" ? gateModel : "",
        attempt: 1,
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）：${String(error)}`,
          type: "server_error",
          code: "gateway_unreachable",
          status: 502,
        },
      })
      sendAdminJson(response, 502, {
        error: {
          message: `本机网关不可达（${target.host}:${target.port}）。请在 /admin 里确认网关已开启。`,
          type: "server_error",
          code: "gateway_unreachable",
        },
      })
      return
    }
    const isStream = String(upstream.headers.get("content-type") ?? "").includes("event-stream")
    pipeUpstream(upstream, response, {
      headBuffered: null,
      restStream: null,
      isStream,
      gateEntry,
      gateModel,
      hintText,
      endHintCtx,
      startedAt,
      path: url.pathname,
    })
  }

  /**
   * 单次上游请求 + 首帧判定（聊天链路专用）。
   *
   * 返回 `passed` 表示响应已写出（成功 / 不可重试的失败原样回写）；
   * 返回 `retryable` 表示这是「可恢复且还能重试」的失败，**未碰 response**，上层换渠道。
   * 注意：无论是否重试，只要判定为失败都会让上层负责落盘（这里不落，避免与重试循环重复记）。
   */
  async function attemptOnce(
    args: any,
  ): Promise<{ kind: "passed"; failure?: UpstreamError } | { kind: "retryable"; error: UpstreamError }> {
    const { ctx, body, provider, bare, mayRetry } = args
    const { response, url, target, headers, method, gateEntry, gateModel, hintText, endHintCtx, startedAt } = ctx
    const sendModel = bare ? `${provider}/${bare}` : String(gateModel ?? "")
    const wantPeek = errorLogOn() || mayRetry

    // 换渠道会用新的 model id 重写请求体 → 长度变了，必须丢掉旧的 content-length
    // （否则 fetch 会因长度不符直接报错，重试永远失败）。
    let sendHeaders: any = headers
    if (Buffer.isBuffer(body)) {
      sendHeaders = new Headers(headers)
      sendHeaders.set("content-length", String(body.byteLength))
    }

    let upstream: any
    try {
      upstream = await fetch(`http://${target.host}:${target.port}${url.pathname}${url.search}`, {
        method,
        headers: sendHeaders,
        body,
        duplex: "half",
        signal: AbortSignal.timeout(upstreamTimeoutMs ?? 600_000),
      } as any)
    } catch (error) {
      const err: UpstreamError = {
        message: `本机网关不可达（${target.host}:${target.port}）。请在 /admin 里确认网关已开启。`,
        type: "server_error",
        code: "gateway_unreachable",
        status: 502,
      }
      if (!mayRetry) {
        logger?.warn?.(`[proxy] 网关不可达（${target.host}:${target.port}）：${String(error)}`)
        sendAdminJson(response, 502, { error: { message: err.message, type: err.type, code: err.code } })
        return { kind: "passed", failure: err }
      }
      return { kind: "retryable", error: err }
    }

    const isSse = String(upstream.headers.get("content-type") ?? "").includes("event-stream")
    const pipeOpts = { gateEntry, gateModel: sendModel, hintText, endHintCtx, startedAt, path: url.pathname }

    // 流式且失败可能在首帧：窥探一个事件边界。peek 仅在「要重试」或「要落盘」时做。
    if (isSse && wantPeek && upstream.body !== null) {
      const reader = upstream.body.getReader()
      const dec = new TextDecoder()
      let head = ""
      let done = false
      let peekError: unknown = null
      try {
        while (!head.includes("\n\n")) {
          const r = await reader.read()
          if (r.done) {
            done = true
            break
          }
          head += dec.decode(r.value, { stream: true })
        }
      } catch (error) {
        peekError = error
      }
      const { error: envErr, hasContent } = inspectSseHead(head)
      const rest = done ? null : nodeStreamFromReader(reader)

      // 首帧都没等到就断流 / 提前结束（上游连接挂起直到 AbortSignal 打断、网关半路掐断；
      // undici 两种形态都可能：read() 抛错，或直接给 done）。HTTP 层没有失败响应可解析，
      // 只有这里能记。给客户端一个明确的 502（多半早已断开，写不进去也无妨 —— 落盘才是目的）。
      if (!envErr && !hasContent && head.trim() === "") {
        const reason = peekError ? `超时/断流：${String(peekError)}` : "流提前结束"
        const err: UpstreamError = {
          message: `上游无响应（${reason}）。`,
          type: "server_error",
          code: "upstream_no_response",
          status: 502,
        }
        if (mayRetry && isRecoverableError(err.status, err.code)) {
          rest?.destroy()
          return { kind: "retryable", error: err }
        }
        sendAdminJson(response, 502, { error: { message: err.message, type: err.type, code: err.code } })
        return { kind: "passed", failure: err }
      }

      if (envErr && !hasContent) {
        const err: UpstreamError = { ...envErr, status: upstream.status }
        if (mayRetry && isRecoverableError(err.status, err.code)) {
          rest?.destroy()
          return { kind: "retryable", error: err }
        }
        // 不再重试：错误帧原样透传给客户端（形态不动），把失败交回上层落盘。
        pipeUpstream(upstream, response, {
          ...pipeOpts,
          isStream: true,
          headBuffered: Buffer.from(head, "utf8"),
          restStream: rest,
        })
        return { kind: "passed", failure: err }
      }
      // 有内容 / 无错误帧 → 灌回首帧 + 剩余继续透传。
      pipeUpstream(upstream, response, {
        ...pipeOpts,
        isStream: true,
        headBuffered: Buffer.from(head, "utf8"),
        restStream: rest,
      })
      return { kind: "passed" }
    }

    // 非流式：失败时整份读出来解析错误信封（这是拿错误码的唯一途径）。
    if (!upstream.ok && !isSse) {
      const text = await upstream.text().catch(() => "")
      const env = parseErrorEnvelope(text)
      const err: UpstreamError = env
        ? { ...env, status: upstream.status }
        : {
            message: `上游返回 ${upstream.status}。`,
            type: "server_error",
            code: "upstream_error",
            status: upstream.status,
          }
      if (mayRetry && isRecoverableError(err.status, err.code)) {
        return { kind: "retryable", error: err }
      }
      // 不再重试 → 原样回写（不自己编形态），把失败交回上层落盘。
      response.writeHead(upstream.status, pickHeaders(upstream))
      response.end(text)
      return { kind: "passed", failure: err }
    }

    // 成功 / 流式但无需窥探 → 原样透传。
    if (upstream.body === null) {
      response.writeHead(upstream.status, pickHeaders(upstream))
      response.end()
      return { kind: "passed" }
    }
    pipeUpstream(upstream, response, { ...pipeOpts, isStream: isSse, headBuffered: null, restStream: null })
    return { kind: "passed" }
  }

  return { proxyToGateway }
}
