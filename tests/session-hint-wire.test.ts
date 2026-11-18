/**
 * 「会话开头提示」的**接线级**回归测试（HTTP 层）。
 *
 * ## 为什么单测之外还要这一层
 *
 * `session-hint.test.ts` 覆盖的是纯函数（body -> body）。但真正容易坏的是**接线**，
 * 而它的失败模式全是静默的：
 *
 * 1. 注入代码写在了 `fetch` 之后 —— 改写根本没生效，功能等于没有；
 * 2. 改写了 body 却没同步 `content-length` —— 上游按旧长度读，body 被截断，
 *    表现为莫名其妙的 JSON 解析错误；
 * 3. 路径判断写错（`/v1/chat/completions` vs 挂载后的 pathname）—— 永远不触发；
 * 4. 开关没接上 env —— 设了 `SESSION_HINT=1` 也没反应。
 *
 * 这些都只能靠「真发一个 HTTP 请求，看上游收到什么」来守住。
 *
 * ## 为什么用假 host 而不是真装插件
 *
 * 真 `createHost()` 要 8.6s（装载全部渠道插件），而且**上游插件会自己抢占
 * `DSH_OPENAI_GATEWAY_PORT`** —— 假上游占同一个端口就冲突。
 * 这里只需要三样东西：目标地址、闸门判定、回写；用假 host 精确供给即可。
 *
 * ## 为什么仍然用 Express
 *
 * 生产里 `/v1` 是 `app.use("/v1", …)` 挂载的，Express 会把 `req.url` 剥掉挂载前缀
 * （变成 `/chat/completions`），只有 `req.originalUrl` 才是全路径。控制器判的是
 * `url.pathname === "/v1/chat/completions"` —— 若哪天误用 `req.url`，这里就会红。
 * 用原生 http server 挂载则看不出这个差别。
 */

import assert from "node:assert/strict"
import { createServer } from "node:http"

import express from "express"
import { test } from "vite-plus/test"

import { createGatewayController } from "../src/modules/gateway/gateway.controller.ts"

const CHAT_PATH = "/v1/chat/completions"

/** 假上游：回显收到的 body 与 content-length。 */
async function startFakeUpstream() {
  const received: any[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks)
      received.push({
        path: req.url,
        contentLength: req.headers["content-length"],
        raw: raw.toString("utf8"),
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
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

/** 假 host：`routes.get` 返回 undefined → 目标地址回落到 DSH_OPENAI_GATEWAY_PORT。 */
const fakeHost = { routes: new Map() }

/**
 * 起一个「网关反代」实例。
 *
 * 走真 Express（与 server.ts 的挂载形状一致），但用假 host/假闸门，
 * 避免装载插件。
 *
 * @param options.gateMode 闸门形态：
 *   - `"enabled"`：闸门**自己** buffer 请求体并给出 model（真闸门开着时的形态）；
 *   - `"disabled"`：闸门**不碰**请求体（真闸门关着时的形态 —— 默认部署就是这样）。
 */
async function startProxy(options: { sessionHint: boolean | (() => boolean); gateMode?: "enabled" | "disabled" }) {
  const app = express()
  const gateMode = options.gateMode ?? "enabled"

  // 闸门读到的 body / model 来自当次请求 —— 用可变 holder 传给假闸门。
  const holder: { body?: Buffer; model?: string } = {}

  const callerGate = {
    async inspect() {
      // 闸门关着：只放行，**不返回 body**（真实现的形态，见 caller-gate.service.ts
      // 的 inspect()：disabled 时返回 { ok: true, disabled: true }）。
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
    adminRpc: async () => ({ accounts: [] }),
    sessionHintEnabled: options.sessionHint,
  })

  // 闸门开着时，请求体由「闸门」buffer（真实现是 caller-gate 读的）。
  // 闸门关着时**不能**碰流 —— 控制器得自己读，否则测的就不是默认形态了。
  if (gateMode === "enabled") {
    app.use((req: any, res: any, next: any) => {
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
    // ⚠️ 与 server.ts 的 urlOf 同形：Express 挂载后 req.url 已被剥掉 /v1 前缀，
    //    只有 originalUrl 才是全路径。误用 req.url 会让 pathname 判断失配。
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

/** 发一条聊天请求。 */
async function chat(origin: string, body: any) {
  const text = JSON.stringify(body)
  const response = await fetch(`${origin}${CHAT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
    },
    body: text,
  })
  await response.text().catch(() => "")
  return response
}

test("开启后：首轮请求到达上游时已被注入提示，且 content-length 同步更新", async () => {
  const upstream = await startFakeUpstream()
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true })
  try {
    const original = { model: "trae/glm-5.1", messages: [{ role: "user", content: "hi" }] }
    await chat(app.origin, original)

    const seen = upstream.received.at(-1)
    assert.ok(seen, "上游应收到请求")
    assert.equal(seen.path, CHAT_PATH)

    const body = JSON.parse(seen.raw)
    assert.equal(body.messages.length, 2, "应多出一条提示消息")
    assert.equal(body.messages[0].role, "system")
    assert.ok(body.messages[0].content.includes("[网关提示]"))
    assert.ok(body.messages[0].content.includes("trae/glm-5.1"), "提示里要有模型名")
    assert.deepEqual(body.messages[1], original.messages[0], "用户消息必须原样保留")
    assert.equal(body.model, "trae/glm-5.1", "其他字段不能丢")

    // ⚠️ 这条最关键：body 变长了，content-length 不更新上游就会读到截断的 JSON。
    assert.equal(
      String(seen.contentLength),
      String(Buffer.byteLength(seen.raw)),
      "content-length 必须等于实际 body 长度",
    )
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("开启后：闸门关着（默认部署形态）也要注入", async () => {
  const upstream = await startFakeUpstream()
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  // gateMode="disabled"：闸门不返回 body，请求体完全没被碰过 ——
  // 这就是「没有 caller-keys.json」的默认部署形态。
  const app = await startProxy({ sessionHint: true, gateMode: "disabled" })
  try {
    const original = { model: "trae/glm-5.1", messages: [{ role: "user", content: "hi" }] }
    await chat(app.origin, original)

    const seen = upstream.received.at(-1)
    assert.ok(seen, "上游应收到请求")
    const body = JSON.parse(seen.raw)
    assert.equal(body.messages.length, 2, "闸门关着时也应多出一条提示消息")
    assert.equal(body.messages[0].role, "system")
    assert.ok(body.messages[0].content.includes("[网关提示]"))
    assert.ok(body.messages[0].content.includes("trae/glm-5.1"), "提示里要有模型名")
    assert.deepEqual(body.messages[1], original.messages[0], "用户消息必须原样保留")
    assert.equal(
      String(seen.contentLength),
      String(Buffer.byteLength(seen.raw)),
      "content-length 必须等于实际 body 长度",
    )
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("开启后：多轮请求不注入（上游收到的就是原样）", async () => {
  const upstream = await startFakeUpstream()
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true })
  try {
    const original = {
      model: "trae/glm-5.1",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
    }
    await chat(app.origin, original)

    const seen = upstream.received.at(-1)
    const body = JSON.parse(seen.raw)
    assert.equal(body.messages.length, 2, "多轮不该注入")
    assert.equal(body.messages[0].role, "user")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("关闭时：请求体一个字节都不动", async () => {
  const upstream = await startFakeUpstream()
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: false })
  try {
    const original = { model: "trae/glm-5.1", messages: [{ role: "user", content: "hi" }] }
    await chat(app.origin, original)

    const seen = upstream.received.at(-1)
    assert.deepEqual(JSON.parse(seen.raw), original, "关闭时请求体必须原样")
    assert.equal(String(seen.contentLength), String(Buffer.byteLength(seen.raw)))
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("非聊天路径（/v1/models）不被注入", async () => {
  const upstream = await startFakeUpstream()
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  const app = await startProxy({ sessionHint: true })
  try {
    await fetch(`${app.origin}/v1/models`, { method: "GET" }).catch(() => null)
    const seen = upstream.received.at(-1)
    if (seen) assert.ok(!seen.raw.includes("[网关提示]"), "/v1/models 不该带提示")
  } finally {
    await app.close()
    await upstream.close()
  }
})

test("面板开关（getter）：同进程内点一下就生效，不用重启", async () => {
  const upstream = await startFakeUpstream()
  process.env.DSH_OPENAI_GATEWAY_PORT = String(upstream.port)
  // 可变 holder 模拟「面板上的开关」：每请求现读，不用重启。
  const panel = { on: false }
  const app = await startProxy({ sessionHint: () => panel.on })
  try {
    const original = { model: "trae/glm-5.1", messages: [{ role: "user", content: "hi" }] }

    // 关：原样透传
    await chat(app.origin, original)
    assert.deepEqual(JSON.parse(upstream.received.at(-1)!.raw), original, "关闭时请求体必须原样")

    // 点一下开关 → 立刻注入（同一个进程、同一个反代实例）
    panel.on = true
    await chat(app.origin, original)
    const body = JSON.parse(upstream.received.at(-1)!.raw)
    assert.equal(body.messages.length, 2, "开了就该注入")
    assert.equal(body.messages[0].role, "system")

    // 再点一下关掉 → 又恢复原样
    panel.on = false
    await chat(app.origin, original)
    assert.deepEqual(JSON.parse(upstream.received.at(-1)!.raw), original, "关回去就该恢复原样")
  } finally {
    await app.close()
    await upstream.close()
  }
})
