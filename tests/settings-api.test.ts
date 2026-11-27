/**
 * 管理端设置（面板开关）的后端契约。
 *
 * 覆盖三件容易静默坏掉的事：
 *
 * 1. **落盘**：改了要写进 `<home>/settings.json`，重启后仍在（否则「设了等于没设」）；
 * 2. **实时生效**：改了之后**不用重启**就能影响行为（这是「点一下就生效」的核心）；
 * 3. **鉴权**：新的 `/admin/settings/api` 必须和其它管理 API 一样受保护。
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { test } from "vite-plus/test"

import { startTestApp, TEST_ADMIN_KEY } from "./helpers"

const JSON_ACCEPT = { accept: "application/json" }

function authed(app: any, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${app.adminKey}`, ...JSON_ACCEPT, ...extra }
}

async function readSettings(app: any) {
  const response = await fetch(`${app.origin}/admin/settings/api`, { headers: authed(app) })
  assert.equal(response.status, 200)
  return response.json()
}

test("默认：装饰开、报错落盘开、重试关，来源都是 default", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const state = await readSettings(app)
  assert.equal(state.modelNameDecor, true, "装饰默认开，保持历史行为")
  assert.equal(state.errorLog, true, "报错落盘默认开")
  assert.equal(state.retryFallback, false, "重试默认关")
  assert.equal(state.sourceModelNameDecor, "default")
  assert.equal(state.sourceErrorLog, "default")
  assert.equal(state.sourceRetryFallback, "default")
})

test("模型名装饰开关：落盘、重启后仍在，且改一个键不擦掉另一个", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // 先开重试，再关装饰 —— 两个键要共存。
  await fetch(`${app.origin}/admin/settings/api/retry-fallback`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: true }),
  })
  const off = await fetch(`${app.origin}/admin/settings/api/model-name-decor`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(off.status, 200)
  assert.equal((await off.json()).modelNameDecor, false)

  const saved = JSON.parse(await readFile(join(app.home, "settings.json"), "utf8"))
  assert.equal(saved.modelNameDecor, false)
  assert.equal(saved.retryFallback, true, "改装饰不能擦掉重试")

  const state = await readSettings(app)
  assert.equal(state.modelNameDecor, false)
  assert.equal(state.retryFallback, true)
  assert.equal(state.sourceModelNameDecor, "panel")
  assert.equal(state.sourceRetryFallback, "panel")

  await app.close()
  const restarted = await startTestApp({ home: app.home })
  t.onTestFinished(() => restarted.close())
  const after = await readSettings(restarted)
  assert.equal(after.modelNameDecor, false, "重启后应保持装饰关")
  assert.equal(after.retryFallback, true, "重启后应保持重试开")
})

test("坏输入：enabled 不是布尔 → 400", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  for (const path of ["model-name-decor", "error-log", "retry-fallback"]) {
    for (const body of [{ enabled: "yes" }, { enabled: 1 }, {}]) {
      const response = await fetch(`${app.origin}/admin/settings/api/${path}`, {
        method: "PUT",
        headers: authed(app, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, `${path} + ${JSON.stringify(body)} 应 400`)
    }
  }
})

test("鉴权：未登录 401；大小写变体也必须被拦", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const anonymous = await fetch(`${app.origin}/admin/settings/api`, { headers: JSON_ACCEPT })
  assert.equal(anonymous.status, 401, "未登录应 401")

  const anonymousWrite = await fetch(`${app.origin}/admin/settings/api/model-name-decor`, {
    method: "PUT",
    headers: { ...JSON_ACCEPT, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(anonymousWrite.status, 401, "未登录写入应 401")

  // 大小写变体绕过鉴权 = P0（Express 的 case sensitive routing 兜底中间件）。
  for (const path of ["/Admin/Settings/Api", "/ADMIN/SETTINGS/API"]) {
    const response = await fetch(`${app.origin}${path}`, { headers: JSON_ACCEPT })
    assert.equal(response.status, 401, `${path} 大小写变体也必须 401`)
  }
})

test("settings.json 落盘且权限 0600", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  await fetch(`${app.origin}/admin/settings/api/model-name-decor`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: false }),
  })

  const path = join(app.home, "settings.json")
  const raw = await readFile(path, "utf8")
  assert.equal(JSON.parse(raw).modelNameDecor, false)
  if (process.platform !== "win32") {
    const { stat } = await import("node:fs/promises")
    assert.equal((await stat(path)).mode & 0o777, 0o600, "设置文件应 0600")
  }
})

test("不碰 ~/.dsh：设置只落在自己的 home 里", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  await fetch(`${app.origin}/admin/settings/api/model-name-decor`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: false }),
  })

  const files = await readFile(join(app.home, "settings.json"), "utf8")
  assert.ok(files.includes("modelNameDecor"))
  // 状态目录里只有本程序自己的文件，没有插件的 jet-hub 目录被写。
  assert.ok(!files.includes("dsh"))
})

test("默认密钥不变时 admin key 仍可用于设置 API（回归：没把 adminKey 弄丢）", async (t) => {
  const app = await startTestApp({ adminKey: TEST_ADMIN_KEY })
  t.onTestFinished(() => app.close())

  const response = await fetch(`${app.origin}/admin/settings/api`, {
    headers: { authorization: `Bearer ${TEST_ADMIN_KEY}`, ...JSON_ACCEPT },
  })
  assert.equal(response.status, 200)
})
