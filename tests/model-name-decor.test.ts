/**
 * `/v1/models` 展示名装饰（渠道前缀）的回归测试。
 *
 * ## 为什么这组测试重要
 *
 * 装饰发生在**反代出口**，改的是客户端唯一会读的那个字段（`name`）。判错的
 * 后果都不报错，只会静默误导：
 *
 * 1. 动了 `id` —— 客户端照它回填请求体，整条链路直接 404；
 * 2. 幂等性破了 —— 叠成 `[[TRAE]]`，用户照着错名字填配置。
 *
 * 所以这里断言的是**字段边界**，而不是某个显示效果。
 *
 * ## 为什么直接单测而不是起服务
 *
 * 装饰是纯函数（`payload -> payload`）；起 HTTP 服务只会把断言变成测 fetch 库。
 */

import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import { decorateModelsWithProvider } from "../src/modules/gateway/gateway.service.ts"

test("渠道前缀取自 id，原始名保留进 display_name", () => {
  const out = decorateModelsWithProvider({
    data: [{ id: "trae/glm-5.1", name: "GLM-5.1 · x0.83", input: ["text"] }],
  })
  assert.equal(out.data[0].name, "[TRAE] GLM-5.1 · x0.83")
  assert.equal(out.data[0].display_name, "GLM-5.1 · x0.83")
})

test("幂等：重复装饰不叠前缀", () => {
  const payload = { data: [{ id: "trae/glm-5.1", name: "GLM-5.1", input: ["text"] }] }
  decorateModelsWithProvider(payload)
  decorateModelsWithProvider(payload)
  decorateModelsWithProvider(payload)
  assert.equal(payload.data[0].name, "[TRAE] GLM-5.1")
})

test("id 一个字节都不能动", () => {
  const data = [
    { id: "trae/glm-5.1", name: "GLM-5.1", input: ["text"] },
    { id: "aggregate/auto", name: "Auto", input: ["text"] },
  ]
  const before = data.map((m) => m.id)
  decorateModelsWithProvider({ data })
  assert.deepEqual(
    data.map((m) => m.id),
    before,
  )
})

test("无 name 时回退 id；未知渠道首字母大写兜底", () => {
  const out = decorateModelsWithProvider({
    data: [
      { id: "newxyz/foo", input: ["text"] },
      { id: "opencode/big-pickle", input: ["text"] },
    ],
  })
  assert.equal(out.data[0].name, "[Newxyz] newxyz/foo")
  assert.equal(out.data[1].name, "[OpenCode] opencode/big-pickle")
})

test("不该被改动的形态：无斜杠 id、缺字段、非法项、无 data", () => {
  const data = [
    null,
    42,
    { name: "No Id" },
    { id: "noSlashModel", name: "No Slash", input: ["text"] },
    { id: "/leading", name: "Leading Slash", input: ["text"] },
    { id: "trae/x", name: "X", input: "not-an-array" },
    { id: "trae/y", name: "Y" },
  ]
  const out = decorateModelsWithProvider({ data })
  assert.equal(out.data[0], null)
  assert.equal(out.data[1], 42)
  assert.equal(out.data[2].name, "No Id", "无 id 的条目不该被装饰")
  assert.equal(out.data[3].name, "No Slash", "无渠道前缀的 id 原样保留")
  assert.equal(out.data[4].name, "Leading Slash", "空渠道名不装饰（否则会得到 [] …）")
  // input 形态非法不影响渠道前缀的添加。
  assert.equal(out.data[5].name, "[TRAE] X")
  assert.equal(out.data[6].name, "[TRAE] Y")

  assert.deepEqual(decorateModelsWithProvider({ object: "list" }), { object: "list" }, "无 data 原样返回")
  assert.equal(decorateModelsWithProvider(null), null)
  assert.equal(decorateModelsWithProvider(undefined), undefined)
})

test("display_name 已存在时以它为准，不吞掉上游的原始名", () => {
  // 上游若哪天自己下发 display_name，装饰要复用它，而不是把已装饰的 name 当原始名。
  const out = decorateModelsWithProvider({
    data: [{ id: "trae/glm-5.1", name: "[TRAE] GLM-5.1", display_name: "GLM-5.1", input: ["text"] }],
  })
  assert.equal(out.data[0].name, "[TRAE] GLM-5.1")
})
