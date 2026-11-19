/**
 * 会话结尾提示的**接线级**测试（HTTP 层）：提示是否真的出现在回给客户端的
 * 响应体**末尾**（非流式正文末尾 / 流式 [DONE] 前），且不发给模型、不改 usage。
 * 用假 host + 假上游，避免真装插件。
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"

import express from "express"
import { test } from "vite-plus/test"

import { createGatewayController } from "../src/modules/gateway/gateway.controller.ts"

const CHAT_PATH = "/v1/chat/completions"
const firstTurn = { model: "trae/glm-5.1", messages: [{ role: "user", content: "hi" }] }
const fakeHost = { routes: new Map() }

function jsonReply() {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "trae/glm-5.1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}
function sseReply() {
  const usageFrame = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "trae/glm-5.1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
  const textFrame = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "trae/glm-5.1", choices: [{ index: 0, delta: { role: "assistant", content: "你好" }, finish_reason: null }] })}\n\n`
  return `${textFrame}${usageFrame}data: [DONE]\n\n`
}

async function startFakeUpstream(mode: "json" | "sse") {
  const received: any[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8"))
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
  return { port, received, close: () => new Promise<void>((r) => server.close(() => r())) }
}

async function startProxy(endEnabled: boolean | (() => boolean)) {
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
    adminRpc: async () => ({ accounts: [{ balance: { total: 7, unit: "credit" } }] }),
    sessionHintEnabled: false,
    sessionEndHintEnabled: endEnabled,
  })
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
  return { origin, close: () => new Promise<void>((r) => server.close(() => r())) }
}

async function chat(origin: string, body: any) {
  const text = JSON.stringify(body)
  return fetch(`${origin}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) },
    body: text,
  })
}

test("非流式：结尾提示在回给客户端的正文末尾，usage 不变，上游请求体原样", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy(true)
  try {
    const res = await chat(app.origin, firstTurn)
    const obj = JSON.parse(await res.text())
    assert.equal(obj.usage.total_tokens, 15)
    const content: string = obj.choices[0].message.content
    assert.ok(content.startsWith("你好"), "原文在最前")
    assert.ok(content.includes("本次 token 用量：15（输入 10 / 输出 5）"))
    assert.ok(content.trimEnd().endsWith("。"))
    assert.deepEqual(JSON.parse(upstream.received.at(-1)), firstTurn, "提示不发给模型")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("流式：提示帧出现在 [DONE] 之前", async () => {
  const upstream = await startFakeUpstream("sse")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy(true)
  try {
    const res = await chat(app.origin, firstTurn)
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
    assert.equal(lines.at(-1), "[DONE]")
    assert.ok(JSON.parse(lines.at(-2)!).choices[0].delta.content.includes("本次 token 用量：15"))
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("关闭时：响应正文字节不变", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy(false)
  try {
    const res = await chat(app.origin, firstTurn)
    const obj = JSON.parse(await res.text())
    assert.equal(obj.choices[0].message.content, "你好")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("getter 开关：请求间实时切换生效", async () => {
  const upstream = await startFakeUpstream("json")
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  let on = false
  const app = await startProxy(() => on)
  try {
    let obj = JSON.parse(await (await chat(app.origin, firstTurn)).text())
    assert.equal(obj.choices[0].message.content, "你好")
    on = true
    obj = JSON.parse(await (await chat(app.origin, firstTurn)).text())
    assert.ok(obj.choices[0].message.content.includes("本次 token 用量：15"))
  } finally {
    await app.close()
    await upstream.close()
  }
})
