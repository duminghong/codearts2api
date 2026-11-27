/**
 * 网关报错落盘 + 失败换渠道重试的接线级回归测试（HTTP 层）。
 *
 * 守住真正容易静默坏掉的三处：
 *
 * 1. 落盘：失败真的写进 `<home>/gateway-errors/<日期>.jsonl`，字段齐全可读回；
 * 2. 重试：只换请求体里的 model id（换渠道），候选过白名单，日志记全部 attempt；
 *    不可恢复的错误（400 / model_not_found）**不重试**；
 * 3. 流式：SSE 首帧是 error 才重试，首帧已有内容则原样透传。
 *
 * 用假 host + 脚本化假上游占端口，避免真装插件。走真 Express 挂载，
 * 与 server.ts 的 `/v1` 挂载形态一致。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import express from "express"
import { test } from "vite-plus/test"

import { createErrorLogService } from "../src/modules/gateway/error-log.service.ts"
import { createGatewayController } from "../src/modules/gateway/gateway.controller.ts"
import { createSettingsService } from "../src/modules/settings/settings.service.ts"

const CHAT_PATH = "/v1/chat/completions"
const BARE = "glm-5.1"

interface Script {
  status: number
  contentType: string
  body: string
  /** true：发出响应头后立刻掐断 socket（模拟「首帧都没等到就断流/超时」）。 */
  destroy?: boolean
}

function okJson(model = `trae/${BARE}`) {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "成功了" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

function errJson(message: string, code: string) {
  return JSON.stringify({ error: { message, type: "server_error", code } })
}

/** 脚本化假上游：按顺序回放 scripts（用完后重复最后一条），记录收到的请求体。 */
async function startUpstream(scripts: Script[]) {
  const received: Array<{ raw: string }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      received.push({ raw })
      const script = scripts[Math.min(received.length - 1, scripts.length - 1)]
      res.writeHead(script.status, { "content-type": script.contentType })
      if (script.destroy) {
        res.socket?.destroy()
        return
      }
      res.end(script.body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", resolve)
    server.listen(0, "127.0.0.1")
  })
  return {
    port: (server.address() as any).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

/** 假 host：`routes` 空 → 走 env 端口；`ctx.get("llm")` 提供 provider 名单（重试候选来源）。 */
function makeHost() {
  return {
    routes: new Map(),
    ctx: {
      get: (name: string) => (name === "llm" ? { listProviders: () => [{ id: "trae" }, { id: "other" }] } : undefined),
    },
  }
}

/** 默认 adminRpc：trae 有两个模型（候选排序靠前）、other 一个；账本默认空。 */
function defaultRpc(ledgerEntries: any[] = []) {
  return async (method: string, params: any) => {
    if (method === "model.list") {
      return params?.provider === "trae" ? { models: [BARE, "other-model"] } : { models: [BARE] }
    }
    if (method === "usage.tokenLedger") return { entries: ledgerEntries }
    return {}
  }
}

async function startProxy(options: {
  home: string
  errorLog?: boolean
  retry?: boolean
  adminRpc?: (method: string, params: any) => Promise<any>
}) {
  const errorLog = createErrorLogService({ home: options.home, logger: { warn() {}, debug() {} } })
  const app = express()
  const holder: { body?: Buffer; model?: string } = {}

  const callerGate = {
    async inspect() {
      return {
        ok: true,
        disabled: false,
        entry: { id: "k-1", name: "测试", group: "full" },
        model: holder.model,
        body: holder.body,
      }
    },
    async upstreamKey() {
      return "sk-upstream"
    },
    sendJson(res: any, status: number, payload: any) {
      res.statusCode = status
      res.end(JSON.stringify(payload))
    },
    filterModels(payload: any) {
      return payload
    },
    tapStream(stream: any) {
      return stream
    },
  }

  const controller = createGatewayController({
    host: makeHost(),
    callerGate,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    upstreamTimeoutMs: 5000,
    adminRpc: options.adminRpc ?? defaultRpc(),
    modelNameDecorEnabled: false,
    errorLog,
    errorLogEnabled: options.errorLog ?? true,
    retryFallbackEnabled: options.retry ?? false,
  })

  // 与 caller-gate 的形态一致：闸门自己 buffer 请求体后交给控制器。
  app.use((req: any, _res: any, next: any) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      holder.body = Buffer.concat(chunks)
      try {
        holder.model = JSON.parse(holder.body.toString("utf8"))?.model
      } catch {
        holder.model = undefined
      }
      next()
    })
  })
  app.use("/v1", (req: any, res: any) => {
    const url = new URL(req.originalUrl || req.url || "/", "http://127.0.0.1")
    controller.proxyToGateway(req, res, url).catch(() => {
      if (!res.writableEnded) res.statusCode = 500
      res.end()
    })
  })

  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", resolve)
    server.listen(0, "127.0.0.1")
  })
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    errorLog,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

async function chat(origin: string, model = `trae/${BARE}`) {
  const text = JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] })
  return fetch(`${origin}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
    body: text,
  })
}

/** 落盘是 fire-and-forget：轮询到期望条数为止（最多 3s）。 */
async function waitEntries(service: any, expected = 1): Promise<any[]> {
  const start = Date.now()
  while (Date.now() - start < 3000) {
    const days: string[] = await service.listFiles()
    if (days.length > 0) {
      const rows = await service.readDay(days[0])
      if (Array.isArray(rows) && rows.length >= expected) return rows
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`等待错误日志落盘超时（期望 ${expected} 条）`)
}

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "c2a-errlog-"))
  try {
    await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test("非流式 5xx（重试关）：原样回写错误信封 + 落一条盘（字段齐全）", async () => {
  await withHome(async (home) => {
    const upstream = await startUpstream([
      { status: 503, contentType: "application/json", body: errJson("上游挂了", "upstream_error") },
    ])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: false })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 503)
      assert.equal(JSON.parse(await res.text()).error.code, "upstream_error", "错误信封原样回写")
      assert.equal(upstream.received.length, 1, "重试关着只发一次")

      const [entry] = await waitEntries(app.errorLog)
      assert.equal(entry.provider, "trae")
      assert.equal(entry.model, `trae/${BARE}`)
      assert.equal(entry.caller, "k-1")
      assert.equal(entry.attempt, 1)
      assert.equal(entry.error.status, 503)
      assert.equal(entry.error.code, "upstream_error")
      assert.equal(entry.error.message, "上游挂了")
      assert.equal(entry.accountId, null, "账本没记录 → 账号留空")
      assert.ok(typeof entry.ts === "string" && !Number.isNaN(Date.parse(entry.ts)), "ts 是 ISO 时间")
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("重试：503 → 换渠道 200；上游收到两次、第二次 model id 换成 other/裸名，日志记两次 attempt", async () => {
  await withHome(async (home) => {
    const upstream = await startUpstream([
      { status: 503, contentType: "application/json", body: errJson("第一个渠道挂了", "upstream_error") },
      { status: 200, contentType: "application/json", body: okJson(`other/${BARE}`) },
    ])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: true })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 200)
      assert.ok((await res.text()).includes("成功了"))

      assert.equal(upstream.received.length, 2, "应该换渠道再试一次")
      assert.equal(JSON.parse(upstream.received[0].raw).model, `trae/${BARE}`)
      assert.equal(JSON.parse(upstream.received[1].raw).model, `other/${BARE}`, "重试只换渠道前缀")

      const entries = await waitEntries(app.errorLog)
      assert.equal(entries.length, 1, "成功的 attempt 不落盘，只记失败的第一次")
      assert.equal(entries[0].attempt, 1)
      assert.equal(entries[0].provider, "trae")
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("重试：全部候选失败 → 回最后一次失败的信封，日志按 attempt 递增记两条", async () => {
  await withHome(async (home) => {
    const upstream = await startUpstream([
      { status: 503, contentType: "application/json", body: errJson("trae 挂了", "upstream_error") },
      { status: 502, contentType: "application/json", body: errJson("other 也挂了", "upstream_error") },
    ])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: true })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 502)
      assert.equal(JSON.parse(await res.text()).error.message, "other 也挂了", "回最后一次失败")

      const entries = await waitEntries(app.errorLog, 2)
      assert.equal(entries.length, 2)
      const sorted = [...entries].sort((a, b) => a.attempt - b.attempt)
      assert.deepEqual(
        sorted.map((e) => [e.attempt, e.provider]),
        [
          [1, "trae"],
          [2, "other"],
        ],
      )
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("400 参数类错误：不重试（只发一次），仍落盘", async () => {
  await withHome(async (home) => {
    const upstream = await startUpstream([
      { status: 400, contentType: "application/json", body: errJson("参数不对", "invalid_request_error") },
    ])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: true })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 400)
      assert.equal(upstream.received.length, 1, "参数错误换渠道也不会好 → 不重试")
      const entries = await waitEntries(app.errorLog)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].error.code, "invalid_request_error")
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("model_not_found（404）：不重试", async () => {
  await withHome(async (home) => {
    const upstream = await startUpstream([
      { status: 404, contentType: "application/json", body: errJson("模型不存在", "model_not_found") },
    ])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: true })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 404)
      assert.equal(upstream.received.length, 1, "模型不存在 → 换渠道也找不到 → 不重试")
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("SSE 首帧是 error 帧 → 换渠道重试，第二次成功透传", async () => {
  await withHome(async (home) => {
    const errorFrame = `data: ${errJson("流式挂了", "upstream_error")}\n\n`
    const goodSse = `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      model: `other/${BARE}`,
      choices: [{ index: 0, delta: { content: "流式成功" }, finish_reason: null }],
    })}\n\ndata: [DONE]\n\n`
    const upstream = await startUpstream([
      { status: 200, contentType: "text/event-stream", body: errorFrame },
      { status: 200, contentType: "text/event-stream", body: goodSse },
    ])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: true })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 200)
      assert.ok(res.headers.get("content-type")!.includes("event-stream"))
      const text = await res.text()
      assert.ok(text.includes("流式成功"), "重试后的内容要透传给客户端")
      assert.equal(upstream.received.length, 2, "error 首帧可重试")
      assert.equal(JSON.parse(upstream.received[1].raw).model, `other/${BARE}`)

      const entries = await waitEntries(app.errorLog)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].error.code, "upstream_error")
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("SSE 首帧已有内容 → 原样透传，不重试", async () => {
  await withHome(async (home) => {
    const goodSse = `data: ${JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      model: `trae/${BARE}`,
      choices: [{ index: 0, delta: { content: "只有一次" }, finish_reason: null }],
    })}\n\ndata: [DONE]\n\n`
    const upstream = await startUpstream([{ status: 200, contentType: "text/event-stream", body: goodSse }])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: true })
    try {
      const res = await chat(app.origin)
      const text = await res.text()
      assert.ok(text.includes("只有一次"))
      assert.ok(text.includes("[DONE]"), "首帧与后续帧都要完整")
      assert.equal(upstream.received.length, 1, "已吐内容 → 不重试")
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("断流（发出 SSE 头后没等首帧就断）：回 502 信封 + 落 upstream_no_response", async () => {
  await withHome(async (home) => {
    const upstream = await startUpstream([{ status: 200, contentType: "text/event-stream", body: "", destroy: true }])
    process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
    const app = await startProxy({ home, errorLog: true, retry: false })
    try {
      const res = await chat(app.origin)
      assert.equal(res.status, 502, "首帧为空的断流要给客户端明确的 502，而不是一个静默死掉的 200 流")
      // undici 可能把「头发出后 socket 被掐」直接当 fetch 异常（gateway_unreachable 分支），
      // 也可能喂给 body 流一个错误（upstream_no_response 分支）—— 两条路都会落盘。
      const code = JSON.parse(await res.text()).error.code as string
      assert.ok(["upstream_no_response", "gateway_unreachable"].includes(code), `实际 code=${code}`)

      const entries = await waitEntries(app.errorLog)
      assert.equal(entries[0].error.code, code)
      assert.equal(entries[0].provider, "trae")
      assert.equal(entries[0].model, `trae/${BARE}`)
    } finally {
      await app.close()
      await upstream.close()
    }
  })
})

test("账号关联：账本恰好一条匹配 → 落盘带上 accountId；撞车 → null", async () => {
  await withHome(async (home) => {
    const service = createErrorLogService({ home, logger: { debug() {} } })
    const now = Date.now()
    const rpcOnce = async () => ({
      entries: [{ ts: now, provider: "trae", model: `trae/${BARE}`, accountId: "acc-1", error: "同一个错误消息" }],
    })
    const svcOnce = createErrorLogService({ home, adminRpc: rpcOnce, logger: { debug() {} } })
    assert.equal(
      await svcOnce.resolveAccountId({ provider: "trae", model: `trae/${BARE}`, errorMessage: "同一个错误消息" }),
      "acc-1",
    )

    const rpcTwice = async () => ({
      entries: [
        { ts: now, provider: "trae", model: `trae/${BARE}`, accountId: "acc-1", error: "同一个错误消息" },
        { ts: now, provider: "trae", model: `trae/${BARE}`, accountId: "acc-2", error: "同一个错误消息" },
      ],
    })
    const svcTwice = createErrorLogService({ home, adminRpc: rpcTwice, logger: { debug() {} } })
    assert.equal(
      await svcTwice.resolveAccountId({ provider: "trae", model: `trae/${BARE}`, errorMessage: "同一个错误消息" }),
      null,
      "撞车时宁可不标账号",
    )

    // JSONL 往返：log → listFiles → readDay（新记录在前）。
    await service.log({
      ts: new Date().toISOString(),
      provider: "trae",
      model: `trae/${BARE}`,
      accountId: null,
      caller: null,
      attempt: 1,
      error: { message: "第一", status: 500 },
    })
    await service.log({
      ts: new Date().toISOString(),
      provider: "trae",
      model: `trae/${BARE}`,
      accountId: null,
      caller: null,
      attempt: 2,
      error: { message: "第二", status: 500 },
    })
    const days = await service.listFiles()
    assert.equal(days.length, 1)
    const rows = await service.readDay(days[0])
    assert.equal(rows!.length, 2)
    assert.equal(rows![0].error.message, "第二", "新记录在前")
    assert.equal(await service.readDay(".."), null, "非法日期不放行")
    assert.equal(await service.readDay("1999-01-01"), null, "不存在的文件返回 null")
  })
})

test("设置：报错落盘默认开、重试默认关；点过后以面板为准并落盘", async () => {
  await withHome(async (home) => {
    const settings = createSettingsService({ home })
    await settings.load()
    assert.equal(settings.errorLogEnabled(), true)
    assert.equal(settings.retryFallbackEnabled(), false)
    assert.equal(settings.view().sourceErrorLog, "default")
    assert.equal(settings.view().sourceRetryFallback, "default")

    await settings.setRetryFallback(true)
    await settings.setErrorLog(false)

    const reloaded = createSettingsService({ home })
    await reloaded.load()
    assert.equal(reloaded.retryFallbackEnabled(), true, "点过之后以面板为准")
    assert.equal(reloaded.errorLogEnabled(), false)
    assert.equal(reloaded.view().sourceErrorLog, "panel")
    assert.equal(reloaded.view().sourceRetryFallback, "panel")
  })
})
