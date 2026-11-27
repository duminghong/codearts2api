/** @vitest-environment jsdom */
/**
 * 设置页开关的**交互契约**（模型名装饰 / 报错落盘 / 重试共用同一套 toggle 机制）：
 * - 初始状态从后端读，读完前开关不可点（避免在未知状态上误操作）；
 * - 点击切换 → 乐观更新 + 发 PUT，请求回来以服务端值为准；
 * - 请求失败 → **回滚**到原值并显示错误（不能停在一个骗人的「已开启」上）；
 * - 值的来源（默认 / 面板）要如实告诉用户。
 */
import assert from "node:assert/strict"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, test, vi } from "vite-plus/test"

import Settings from "../web/pages/settings/index.tsx"

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** 模型名装饰开关按钮（role=switch + aria-label）。 */
function sw() {
  return screen.getByRole("switch", { name: "模型名显示渠道前缀" }) as HTMLButtonElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("读取后端状态：开关的初始值与后端一致", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ modelNameDecor: false }))

  render(<Settings />)

  // 读完之前开关是禁用的 —— 不能在未知状态上误点。
  assert.equal(sw().hasAttribute("disabled"), true)

  await waitFor(() => assert.equal(sw().getAttribute("aria-checked"), "false"))
  assert.equal(sw().hasAttribute("disabled"), false)
})

test("点击切换：乐观更新并发出 PUT，请求回来以服务端值为准", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ modelNameDecor: false }))
    .mockResolvedValueOnce(jsonResponse({ modelNameDecor: true }))

  render(<Settings />)
  await waitFor(() => assert.equal(sw().getAttribute("aria-checked"), "false"))

  fireEvent.click(sw())

  // 乐观更新：不用等网络往返就变。
  assert.equal(sw().getAttribute("aria-checked"), "true")
  // 在请求飞行中不允许连点（避免竞态）。
  assert.equal(sw().hasAttribute("disabled"), true)

  await waitFor(() => assert.equal(sw().hasAttribute("disabled"), false))
  assert.equal(fetchMock.mock.calls.length, 2)
  const [url, init] = fetchMock.mock.calls[1] as any[]
  assert.equal(url, "/admin/settings/api/model-name-decor")
  assert.equal(init.method, "PUT")
  assert.deepEqual(JSON.parse(String(init.body)), { enabled: true })
})

test("服务端返回的值与乐观值不同时，以服务端为准", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ modelNameDecor: false }))
    // 服务端「拒绝」开启（回 false）
    .mockResolvedValueOnce(jsonResponse({ modelNameDecor: false }))

  render(<Settings />)
  await waitFor(() => assert.equal(sw().getAttribute("aria-checked"), "false"))

  fireEvent.click(sw())
  await waitFor(() => assert.equal(sw().hasAttribute("disabled"), false))
  assert.equal(sw().getAttribute("aria-checked"), "false", "必须回到服务端的值")
})

test("请求失败：回滚原值并显示错误", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(jsonResponse({ modelNameDecor: false }))
    .mockResolvedValueOnce(jsonResponse({ error: "磁盘写不进去" }, 500))

  render(<Settings />)
  await waitFor(() => assert.equal(sw().getAttribute("aria-checked"), "false"))

  fireEvent.click(sw())

  await waitFor(() => assert.ok(screen.getByText("磁盘写不进去")))
  assert.equal(sw().getAttribute("aria-checked"), "false", "失败后必须回滚，不能停在骗人的「已开启」")
})
