/**
 * `/v1/models` 展示名装饰（渠道前缀 + 图片标记）的回归测试。
 *
 * ## 为什么这组测试重要
 *
 * 装饰发生在**反代出口**，改的是客户端唯一会读的那个字段（`name`）。判错的
 * 后果都不报错，只会静默误导：
 *
 * 1. 动了 `id` —— 客户端照它回填请求体，整条链路直接 404；
 * 2. 幂等性破了 —— 叠成 `[[TRAE]]` 或两个图标，用户照着错名字填配置；
 * 3. 图片标记判反 —— 把纯文本模型标成支持贴图，用户传图后拿到上游报错。
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

const IMAGE_MARK = "\u{1F5BC}\uFE0F"

test("渠道前缀取自 id，原始名保留进 display_name", () => {
  const out = decorateModelsWithProvider({
    data: [{ id: "trae/glm-5.1", name: "GLM-5.1 · x0.83", input: ["text"] }],
  })
  assert.equal(out.data[0].name, "[TRAE] GLM-5.1 · x0.83")
  assert.equal(out.data[0].display_name, "GLM-5.1 · x0.83")
})

test("input 含 image 时在前缀后追加图片标记，纯文本不加", () => {
  const out = decorateModelsWithProvider({
    data: [
      { id: "trae/Doubao-Seed-Code", name: "Seed-Code · x0.12→x0.06", input: ["text", "image"] },
      { id: "buddy/glm-5.0", name: "GLM-5.0", input: ["text"] },
    ],
  })
  assert.equal(out.data[0].name, `[TRAE] ${IMAGE_MARK} Seed-Code · x0.12→x0.06`)
  assert.equal(out.data[1].name, "[CodeBuddy] GLM-5.0")
  assert.ok(!out.data[1].name.includes(IMAGE_MARK), "纯文本模型不该带图片标记")
})

test("标记放左侧：名字再长也不会被 ellipsis 截掉", () => {
  // 宿主的单行标签一律 text-overflow:ellipsis，从右侧截断。
  // 标记在前缀后 => 永远排在名字前面，截断只会丢名字的尾巴。
  const long = "Extremely-Long-Model-Name-That-Would-Certainly-Be-Truncated-By-The-Composer-Row"
  const out = decorateModelsWithProvider({ data: [{ id: "trae/x", name: long, input: ["text", "image"] }] })
  assert.ok(out.data[0].name.startsWith(`[TRAE] ${IMAGE_MARK} `), "标记必须紧跟前缀，位于名字之前")
})

test("幂等：重复装饰不叠前缀、不叠图标，且标记随 input 重算", () => {
  const payload = { data: [{ id: "trae/glm-5.1", name: "GLM-5.1", input: ["text", "image"] }] }
  decorateModelsWithProvider(payload)
  decorateModelsWithProvider(payload)
  decorateModelsWithProvider(payload)
  assert.equal(payload.data[0].name, `[TRAE] ${IMAGE_MARK} GLM-5.1`)

  // 上游若改口说不支持图片，重跑必须把标记摘掉 —— 不能因为「已经装饰过」而留着。
  payload.data[0].input = ["text"]
  decorateModelsWithProvider(payload)
  assert.equal(payload.data[0].name, "[TRAE] GLM-5.1")
})

test("id 一个字节都不能动", () => {
  const data = [
    { id: "trae/glm-5.1", name: "GLM-5.1", input: ["text", "image"] },
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
    { id: "noSlashModel", name: "No Slash", input: ["text", "image"] },
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
  // input 形态非法时按「不支持图片」处理，但渠道前缀照加 —— 宁可少标图标。
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
