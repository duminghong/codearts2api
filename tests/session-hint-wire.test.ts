/**
 * 「会话提示」的**接线级**回归测试（HTTP 层）。
 *
 * 提示注入在**响应侧**：每轮请求 → 判定并生成提示文本 → 在助手回复正文开头插一段
 * 用户可见文字。单测（session-hint.test.ts）覆盖纯函数，这里守住真正容易静默坏掉的接线：
 *
 * 1. 提示是否真的出现在**回给客户端的响应体**里（而不是只塞进发给模型的请求体）；
 * 2. 注入代码挂在 usage 记录**之后**（计费看原始字节，不受提示影响）—— 见单测形态；
 * 3. 路径判断（`/v1/chat/completions`）、开关 getter、闸门开/关两条请求体路径；
 * 4. 注入后删掉 content-length（body 变长），否则客户端按旧长度截断。
 *
 * 用假 host + 假上游占端口，避免真装插件（8.6s 且会抢 DSH_OPENAI_GATEWAY_PORT）。
 * 走真 Express 挂载（与 server.ts 一致），因为控制器判的是 originalUrl 的 pathname。
 */

import assert from "node:assert/strict"
import { createServer } from "node:http"

import express from "express"
import { test } from "vite-plus/test"

import { createGatewayController } from "../src/modules/gateway/gateway.controller.ts"

const CHAT_PATH = "/v1/chat/completions"
const HINT_MARK = "[网关提示]"

function jsonReply(model = "trae/glm-5.1") {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "你好，我是助手" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

function sseReply(model = "trae/glm-5.1") {
  const frame = (delta: any) =>
    `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
  return `${frame({ role: "assistant", content: "你好" })}${frame({ content: "，我是助手" })}data: [DONE]\n\n`
}

/** 假上游：记录收到的请求体，按 mode 回 JSON 或 SSE。 */
async function startFakeUpstream(mode: "json" | "sse") {
  const received: any[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      received.push({
        path: req.url,
        contentLength: req.headers["content-length"],
        raw: Buffer.concat(chunks).toString("utf8"),
      })
      if (mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end(sseReply())
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(jsonReply())
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", resolve)
    server.listen(0, "127.0.0.1")
  })
  const port = (server.address() as any).port
  return {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

const fakeHost = { routes: new Map() }

/**
 * 起一个「网关反代」实例。
 * @param options.gateMode "enabled"：闸门自己 buffer 请求体；"disabled"：闸门不碰请求体（默认形态）。
 * @param options.adminRpc 积分查询（默认回 7 credit）。
 */
async function startProxy(options: {
  sessionHint: boolean | (() => boolean)
  gateMode?: "enabled" | "disabled"
  adminRpc?: (method: string, params: any) => Promise<any>
}) {
  const app = express()
  const gateMode = options.gateMode ?? "enabled"
  const holder: { body?: Buffer; model?: string } = {}

  const callerGate = {
    async inspect() {
      if (gateMode === "disabled") return { ok: true, disabled: true }
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
    sendJson(_res: any, status: number, payload: any) {
      _res.statusCode = status
      _res.end(JSON.stringify(payload))
    },
    filterModels(payload: any) {
      return payload
    },
    tapStream(stream: any) {
      return stream
    },
  }

  const controller = createGatewayController({
    host: fakeHost,
    callerGate,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    upstreamTimeoutMs: 5000,
    adminRpc: options.adminRpc ?? (async () => ({ accounts: [{ balance: { total: 7, unit: "credit" } }] })),
    sessionHintEnabled: options.sessionHint,
  })

  if (gateMode === "enabled") {
    app.use((req: any, _res: any, next: any) => {
      const chunks: Buffer[] = []
      req.on("data", (c) => chunks.push(c))
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
  }
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
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  return {
    origin,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

async function chat(origin: string, body: any) {
  const text = JSON.stringify(body)
  const response = await fetch(`${origin}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
    body: text,
  })
  return response
}

const firstTurn = { model: "trae/glm-5.1", messages: [{ role: "user", content: "hi" }] }

test("开启后：首轮请求发给上游时原样（不塞 system），提示出现在回给客户端的回复正文开头", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true })
  try {
    const res = await chat(app.origin, firstTurn)
    const text = await res.text()

    // 请求侧：上游收到的就是原始 body —— 提示不给模型。
    const seen = upstream.received.at(-1)
    assert.ok(seen, "上游应收到请求")
    assert.deepEqual(JSON.parse(seen.raw), firstTurn, "提示不该塞进发给模型的请求体")

    // 响应侧：用户看到的回复正文开头有提示。
    const obj = JSON.parse(text)
    assert.ok(obj.choices[0].message.content.startsWith(HINT_MARK), "回复正文开头应有提示")
    assert.ok(obj.choices[0].message.content.includes("trae/glm-5.1"), "提示要有模型名")
    assert.ok(obj.choices[0].message.content.includes("7 credit"), "提示要有积分")
    assert.ok(obj.choices[0].message.content.endsWith("你好，我是助手"), "原文必须保留")
    assert.deepEqual(obj.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, "usage 不能被改")
    assert.equal(res.headers.get("content-length"), null, "注入后不能有失效的 content-length")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("闸门关着（默认部署形态）：响应侧同样注入", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true, gateMode: "disabled" })
  try {
    const res = await chat(app.origin, firstTurn)
    const obj = JSON.parse(await res.text())
    assert.ok(obj.choices[0].message.content.startsWith(HINT_MARK))
    assert.deepEqual(JSON.parse(upstream.received.at(-1)!.raw), firstTurn, "请求体仍原样")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("流式（SSE）：提示出现在第一个 delta 帧，其余帧与 DONE 原样", async () => {
  const upstream = await startFakeUpstream("sse")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true })
  try {
    const res = await chat(app.origin, firstTurn)
    assert.ok(res.headers.get("content-type")!.includes("event-stream"))
    const text = await res.text()
    const frames = text
      .split("\n\n")
      .filter(Boolean)
      .map((f) => f.replace(/^data: /, ""))
    assert.equal(frames.length, 3)
    const first = JSON.parse(frames[0])
    assert.ok(first.choices[0].delta.content.startsWith(HINT_MARK), "首帧要带提示")
    assert.equal(JSON.parse(frames[1]).choices[0].delta.content, "，我是助手", "后续帧原样")
    assert.equal(frames[2], "[DONE]")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("多轮请求也注入：回复正文开头带提示", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true })
  try {
    const res = await chat(app.origin, {
      model: "trae/glm-5.1",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "again" },
      ],
    })
    const obj = JSON.parse(await res.text())
    assert.ok(obj.choices[0].message.content.startsWith(HINT_MARK), "续会话也要带提示")
    assert.ok(obj.choices[0].message.content.includes("你好，我是助手"))
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("关闭时：请求体、回复体都一个字节不动", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: false })
  try {
    const res = await chat(app.origin, firstTurn)
    const obj = JSON.parse(await res.text())
    assert.equal(obj.choices[0].message.content, "你好，我是助手")
    assert.ok(!obj.choices[0].message.content.includes(HINT_MARK))
    assert.deepEqual(JSON.parse(upstream.received.at(-1)!.raw), firstTurn)
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("积分查询失败（RPC 抛错）：仍注入只有模型名的提示（fail-open）", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({
    sessionHint: true,
    adminRpc: async () => {
      throw new Error("upstream down")
    },
  })
  try {
    const res = await chat(app.origin, firstTurn)
    const content = JSON.parse(await res.text()).choices[0].message.content
    assert.ok(content.startsWith(HINT_MARK))
    assert.ok(content.includes("trae/glm-5.1"))
    assert.ok(!content.includes("积分"), "查不到积分时不该编造")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("面板开关（getter）：点一下立刻生效，不用重启", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const panel = { on: false }
  const app = await startProxy({ sessionHint: () => panel.on })
  try {
    let content = JSON.parse(await (await chat(app.origin, firstTurn)).text()).choices[0].message.content
    assert.ok(!content.includes(HINT_MARK), "关闭时不注入")

    panel.on = true
    content = JSON.parse(await (await chat(app.origin, firstTurn)).text()).choices[0].message.content
    assert.ok(content.startsWith(HINT_MARK), "打开后立刻注入")

    panel.on = false
    content = JSON.parse(await (await chat(app.origin, firstTurn)).text()).choices[0].message.content
    assert.ok(!content.includes(HINT_MARK), "关回去立刻恢复")
  } finally {
    await app.close()
    await upstream.close()
  }
})
