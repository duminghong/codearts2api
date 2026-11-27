/**
 * 「渠道前缀装饰」开关的**接线级**回归测试（HTTP 层）。
 *
 * 纯函数测试（model-name-decor.test.ts）只证明 `decorateModelsWithProvider` 正确，
 * 证明不了「开关接到了反代出口」。这里真发一个 `/v1/models` 请求，断言开关关着时
 * 上游的模型名**原样**返回 —— 守住「不写死、由 settings 控制」这件事本身。
 */

import assert from "node:assert/strict"
import { createServer } from "node:http"

import express from "express"
import { test } from "vite-plus/test"

import { createGatewayController } from "../src/modules/gateway/gateway.controller.ts"

const MODELS = { data: [{ id: "trae/glm-5.1", name: "GLM-5.1 · x0.83", input: ["text"] }] }

const fakeHost = { routes: new Map() }

async function startProxy(enabled: boolean | (() => boolean)) {
  const app = express()
  const controller = createGatewayController({
    host: fakeHost,
    callerGate: null,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    upstreamTimeoutMs: 5000,
    adminRpc: async () => ({ accounts: [] }),
    modelNameDecorEnabled: enabled,
  })
  // 假上游：返回固定模型列表。
  let upstream: any
  const up = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(MODELS))
  })
  await new Promise<void>((resolve) => up.listen(0, "127.0.0.1", resolve))
  const port = (up.address() as any).port
  process.env.DSH_OPENAI_GATEWAY_PORT = String(port)
  upstream = up

  app.use("/v1", (req: any, res: any) => {
    const url = new URL(req.originalUrl || req.url || "/", "http://127.0.0.1")
    controller.proxyToGateway(req, res, url).catch(() => {
      if (!res.writableEnded) res.statusCode = 500
      res.end()
    })
  })
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  return {
    origin,
    async close() {
      await new Promise<void>((r) => server.close(() => r()))
      await new Promise<void>((r) => upstream.close(() => r()))
      delete process.env.DSH_OPENAI_GATEWAY_PORT
    },
  }
}

test("开关开着：/v1/models 展示名带渠道前缀（默认行为）", async (t) => {
  const app = await startProxy(true)
  t.onTestFinished(() => app.close())
  const out = await (await fetch(`${app.origin}/v1/models`)).json()
  assert.equal(out.data[0].name, "[TRAE] GLM-5.1 · x0.83")
})

test("开关关着：/v1/models 原样返回上游模型名", async (t) => {
  const app = await startProxy(false)
  t.onTestFinished(() => app.close())
  const out = await (await fetch(`${app.origin}/v1/models`)).json()
  assert.equal(out.data[0].name, "GLM-5.1 · x0.83")
})

test("开关是 getter 且实时改变：同一进程内下次请求即生效", async (t) => {
  let on = true
  const app = await startProxy(() => on)
  t.onTestFinished(() => app.close())
  assert.equal((await (await fetch(`${app.origin}/v1/models`)).json()).data[0].name, "[TRAE] GLM-5.1 · x0.83")
  on = false
  assert.equal((await (await fetch(`${app.origin}/v1/models`)).json()).data[0].name, "GLM-5.1 · x0.83")
})
