/**
 * 管理端设置（面板开关）的后端契约。
 *
 * 覆盖三件容易静默坏掉的事：
 *
 * 1. **面板为准**：env 的 `SESSION_HINT` 只是初始默认值，用户点过开关后以面板为准；
 * 2. **落盘**：改了要写进 `<home>/settings.json`，重启后仍在（否则「设了等于没设」）；
 * 3. **实时生效**：改了之后**不用重启**就能影响行为（这是「点一下就生效」的核心）。
 *
 * 另外守住鉴权：新的 `/admin/settings/api` 必须和其它管理 API 一样受保护，
 * 且大小写变体也要被拦（Express 的 case-sensitive routing 有个兜底中间件）。
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

test("默认：开关关闭，来源是 env（未动过面板）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const state = await readSettings(app)
  assert.equal(state.sessionHint, false)
  assert.equal(state.sessionEndHint, false)
  assert.equal(state.modelNameDecor, true, "装饰默认开，保持历史行为")
  assert.equal(state.source, "env")
  assert.equal(state.sourceEndHint, "env")
  assert.equal(state.envDefault, false)
  assert.equal(state.envDefaultEndHint, false)
})

test("结尾提示：env 初始值 / 面板覆盖 / 落盘 / 来源独立 / 实时生效", async (t) => {
  const app = await startTestApp({ sessionEndHint: true })
  t.onTestFinished(() => app.close())

  let state = await readSettings(app)
  assert.equal(state.sessionEndHint, true, "env 开启应生效")
  assert.equal(state.sourceEndHint, "env", "没动过面板时来源是 env")
  // 结尾提示来源独立于开头提示：开头没开也没点过 → env
  assert.equal(state.source, "env")

  const before = await (await fetch(`${app.origin}/healthz`, { headers: JSON_ACCEPT })).json()
  assert.equal(before.sessionEndHint, true)

  const off = await fetch(`${app.origin}/admin/settings/api/session-end-hint`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(off.status, 200)
  assert.equal((await off.json()).sessionEndHint, false)

  const saved = JSON.parse(await readFile(join(app.home, "settings.json"), "utf8"))
  assert.equal(saved.sessionEndHint, false)
  assert.equal(saved.sessionHint, false, "落盘会物化全部键，不擦掉其它开关")

  state = await readSettings(app)
  assert.equal(state.sessionEndHint, false)
  assert.equal(state.sourceEndHint, "panel", "点过后面板为准")

  const after = await (await fetch(`${app.origin}/healthz`, { headers: JSON_ACCEPT })).json()
  assert.equal(after.sessionEndHint, false, "改完立刻生效，无需重启")

  await app.close()
  const restarted = await startTestApp({ home: app.home, sessionEndHint: true })
  t.onTestFinished(() => restarted.close())
  const afterRestart = await readSettings(restarted)
  assert.equal(afterRestart.sessionEndHint, false, "重启后保持面板值，不回退 env")
})

test("env 的 SESSION_HINT 只是初始默认值：没动过面板时跟随 env", async (t) => {
  const app = await startTestApp({ sessionHint: true })
  t.onTestFinished(() => app.close())

  const state = await readSettings(app)
  assert.equal(state.sessionHint, true, "env 开启时应生效")
  assert.equal(state.source, "env", "没动过面板时来源仍是 env")
  assert.equal(state.envDefault, true)
})

test("点过面板开关后以面板为准，落盘 settings.json，重启后仍在", async (t) => {
  const app = await startTestApp({ sessionHint: true })
  t.onTestFinished(() => app.close())

  // 点一下关掉 → 应覆盖 env 的开启。
  const off = await fetch(`${app.origin}/admin/settings/api/session-hint`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(off.status, 200)
  assert.equal((await off.json()).sessionHint, false)

  // 落盘：面板值写进 settings.json。
  const saved = JSON.parse(await readFile(join(app.home, "settings.json"), "utf8"))
  assert.equal(saved.sessionHint, false)

  const state = await readSettings(app)
  assert.equal(state.sessionHint, false, "面板值应覆盖 env")
  assert.equal(state.source, "panel", "动过面板后来源应是 panel")

  // 重启（同一 home）→ 仍以面板为准，不回退到 env。
  await app.close()
  const restarted = await startTestApp({ home: app.home, sessionHint: true })
  t.onTestFinished(() => restarted.close())
  const after = await readSettings(restarted)
  assert.equal(after.sessionHint, false, "重启后应保持面板的值")
  assert.equal(after.source, "panel")
})

test("实时生效：改了开关不用重启，/healthz 立刻反映", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  const before = await (await fetch(`${app.origin}/healthz`, { headers: JSON_ACCEPT })).json()
  assert.equal(before.sessionHint, false)

  const on = await fetch(`${app.origin}/admin/settings/api/session-hint`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(on.status, 200)

  // 同一个进程、没重启 —— 读到的必须是新值。
  const after = await (await fetch(`${app.origin}/healthz`, { headers: JSON_ACCEPT })).json()
  assert.equal(after.sessionHint, true, "改完应立刻生效，无需重启")
})

test("渠道前缀装饰开关：落盘、重启后仍在，且改一个键不擦掉另一个", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  // 先关 sessionHint，再关装饰 —— 两个键要共存。
  await fetch(`${app.origin}/admin/settings/api/session-hint`, {
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
  assert.equal(saved.sessionHint, true, "改装饰不能擦掉 sessionHint")

  const state = await readSettings(app)
  assert.equal(state.modelNameDecor, false)
  assert.equal(state.sessionHint, true)
  // source 反映 sessionHint 的来源（上面点过它 → panel），与装饰开关无关。
  assert.equal(state.source, "panel")

  await app.close()
  const restarted = await startTestApp({ home: app.home })
  t.onTestFinished(() => restarted.close())
  const after = await readSettings(restarted)
  assert.equal(after.modelNameDecor, false, "重启后应保持装饰关")
})

test("坏输入：enabled 不是布尔 → 400", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  for (const path of ["session-hint", "model-name-decor"]) {
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

  const anonymousWrite = await fetch(`${app.origin}/admin/settings/api/session-hint`, {
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

test("关掉开关后：settings.json 落盘且内容正确（权限 0600）", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  await fetch(`${app.origin}/admin/settings/api/session-hint`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: true }),
  })

  const path = join(app.home, "settings.json")
  const raw = await readFile(path, "utf8")
  assert.equal(JSON.parse(raw).sessionHint, true)
  if (process.platform !== "win32") {
    const { stat } = await import("node:fs/promises")
    assert.equal((await stat(path)).mode & 0o777, 0o600, "设置文件应 0600")
  }
})

test("不碰 ~/.dsh：设置只落在自己的 home 里", async (t) => {
  const app = await startTestApp()
  t.onTestFinished(() => app.close())

  await fetch(`${app.origin}/admin/settings/api/session-hint`, {
    method: "PUT",
    headers: authed(app, { "content-type": "application/json" }),
    body: JSON.stringify({ enabled: true }),
  })

  const files = await readFile(join(app.home, "settings.json"), "utf8")
  assert.ok(files.includes("sessionHint"))
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
