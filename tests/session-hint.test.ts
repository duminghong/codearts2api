/**
 * 会话开头提示（首轮注入「模型 + 渠道积分」）的回归测试。
 *
 * ## 为什么这组测试重要
 *
 * 注入改的是**发给上游的请求体**，失败模式全是静默的：
 *
 * 1. 首轮判错 —— 多轮对话每轮都注入（白烧 token），或该注不注（功能等于没有）；
 * 2. 幂等破了 —— 客户端把上一轮带 hint 的 messages 原样回传，提示会一层层套娃；
 * 3. fail-open 破了 —— 积分查询失败把请求吞掉，网关直接不可用；
 * 4. 聚合路由注了具体渠道 —— 上游还没选号，提示里的积分是「张冠李戴」。
 *
 * ## 为什么直接单测
 *
 * 改写逻辑是纯函数（body -> body）；起 HTTP 服务只会把断言变成测 fetch 库。
 */

import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import {
  buildSessionHintMessage,
  createSessionHint,
  injectSessionHint,
  isFirstTurnOfSession,
  summarizeProviderBalance,
} from "../src/modules/gateway/session-hint.service.ts"

const MARK = "[网关提示]"

test("首轮判定：没有 assistant 消息才算首轮", () => {
  assert.equal(isFirstTurnOfSession({ messages: [{ role: "user", content: "hi" }] }), true)
  assert.equal(
    isFirstTurnOfSession({
      messages: [
        { role: "system", content: "you are a bot" },
        { role: "user", content: "hi" },
      ],
    }),
    true,
    "有 system 但没有 assistant 仍是首轮",
  )
  assert.equal(
    isFirstTurnOfSession({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
    }),
    false,
    "有 assistant 说明是后续轮次",
  )
  assert.equal(isFirstTurnOfSession({ messages: [] }), false, "空 messages 不是首轮")
  assert.equal(isFirstTurnOfSession({}), false, "没有 messages 字段不注入")
  assert.equal(isFirstTurnOfSession({ messages: "not-array" }), false, "非法形态不注入")
})

test("幂等：已带提示标记的请求不再注入", () => {
  const body = {
    messages: [
      { role: "system", content: `${MARK} 当前模型：x/y。渠道剩余积分：1 credit。该提示由网关自动附加，无需回应。` },
      { role: "user", content: "hi" },
    ],
  }
  assert.equal(isFirstTurnOfSession(body), false)
  assert.equal(injectSessionHint(body, "x/y", "1 credit"), null, "不该二次注入")
})

test("注入结果：system 提示在最前面，其余字段原样保留", () => {
  const body = { model: "trae/glm-5.1", stream: true, messages: [{ role: "user", content: "hi" }] }
  const text = injectSessionHint(body, "trae/glm-5.1", "1200 credit")
  assert.ok(text)
  const out = JSON.parse(text)
  assert.equal(out.messages.length, 2)
  assert.equal(out.messages[0].role, "system")
  assert.ok(out.messages[0].content.includes("trae/glm-5.1"))
  assert.ok(out.messages[0].content.includes("1200 credit"))
  assert.deepEqual(out.messages[1], body.messages[0], "用户消息原样保留")
  assert.equal(out.model, "trae/glm-5.1")
  assert.equal(out.stream, true)
})

test("积分查不到时只报模型名，不编造数字", () => {
  const body = { messages: [{ role: "user", content: "hi" }] }
  const out = JSON.parse(injectSessionHint(body, "trae/glm-5.1", null))
  assert.ok(out.messages[0].content.includes("trae/glm-5.1"))
  assert.ok(!/\d/.test(out.messages[0].content.replace(/glm-5\.1/g, "")), "查不到积分时不该出现数字余额")
})

test("积分汇总：取权威口径 balance.total，不按包求和（否则多算失效包与独立池）", () => {
  const now = Date.now()
  const text = summarizeProviderBalance({
    accounts: [
      {
        balance: {
          // 上游 total = 各**有效**包的本周期剩余之和（已过滤失效包）。
          total: 100,
          packages: [
            { name: "有效包", unit: "credit", remaining: 100, deductionEndTime: now + 60_000 },
            // 失效包：仍在 packages 里但不可扣费，求和会多算 50。
            { name: "过期包", unit: "credit", remaining: 50, active: false },
            // 独立池：上游刻意排除在主池合计外，求和会多算 999。
            { name: "星火积分（独立池，不参与主池合计）", unit: "credit", remaining: 999 },
          ],
        },
      },
    ],
  })
  assert.equal(text, "100 credit", "必须等于 total，不能是 1149")
})

test("积分汇总：没有 total 的降级响应才退回按包求和，且跳过失效包与独立池", () => {
  const now = Date.now()
  const text = summarizeProviderBalance({
    accounts: [
      {
        balance: {
          packages: [
            { name: "有效包", unit: "credit", remaining: 100, deductionEndTime: now + 60_000 },
            { name: "过期包", unit: "credit", remaining: 50, active: false },
            { name: "已过期包", unit: "credit", remaining: 999, deductionEndTime: now - 1000 },
            { name: "星火积分（独立池，不参与主池合计）", unit: "credit", remaining: 888 },
          ],
        },
      },
    ],
  })
  assert.equal(text, "100 credit")
})

test("积分汇总：单位归一（credit/credits 同一单位，token 单列）", () => {
  const text = summarizeProviderBalance({
    accounts: [
      { balance: { total: 100, unit: "credit" } },
      { balance: { total: 20, unit: "credits" } },
      { balance: { total: 5, unit: "token" } },
    ],
  })
  assert.ok(text.includes("120 credit"), "credit 与 credits 必须合并成一个数")
  assert.ok(text.includes("5 token"), "token 不与积分折算")
})

test("积分汇总：空账本/出错时返回 null（不注积分）", () => {
  assert.equal(summarizeProviderBalance({ accounts: [] }), null)
  assert.equal(summarizeProviderBalance({ error: "boom" }), null)
  assert.equal(summarizeProviderBalance(null), null)
  assert.equal(summarizeProviderBalance(undefined), null)
})

test("fail-open：RPC 失败时仍注入（只缺积分），请求不丢", async () => {
  const hint = createSessionHint({
    enabled: true,
    rpc: async () => {
      throw new Error("upstream down")
    },
  })
  const raw = Buffer.from(JSON.stringify({ model: "trae/x", messages: [{ role: "user", content: "hi" }] }))
  const out = JSON.parse((await hint.rewrite(raw, "trae/x")).toString("utf8"))
  assert.equal(out.messages.length, 2)
  assert.ok(out.messages[0].content.includes("trae/x"))
})

test("fail-open：请求体不是合法 JSON 时原样透传", async () => {
  const hint = createSessionHint({ enabled: true, rpc: async () => ({ accounts: [] }) })
  const raw = Buffer.from("not-json")
  const out = await hint.rewrite(raw, "trae/x")
  assert.equal(out, raw, "解析失败必须原样返回")
})

test("关闭开关时完全不动请求体", async () => {
  const hint = createSessionHint({ enabled: false, rpc: async () => ({ accounts: [] }) })
  const raw = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))
  const out = await hint.rewrite(raw, "trae/x")
  assert.equal(out, raw)
})

test("非首轮不注入", async () => {
  const hint = createSessionHint({ enabled: true, rpc: async () => ({ accounts: [] }) })
  const raw = Buffer.from(
    JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
    }),
  )
  const out = await hint.rewrite(raw, "trae/x")
  assert.equal(out, raw, "多轮请求不该被改写")
})

test("积分缓存：同一渠道 5 分钟内只查一次", async () => {
  let calls = 0
  const hint = createSessionHint({
    enabled: true,
    rpc: async () => {
      calls += 1
      return {
        accounts: [{ balance: { total: 7, unit: "credit" } }],
      }
    },
  })
  const raw = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))
  await hint.rewrite(raw, "trae/x")
  await hint.rewrite(raw, "trae/x")
  assert.equal(calls, 1, "第二次应命中缓存")
})

test("提示文本包含模型与积分，便于人工核对", () => {
  const msg = buildSessionHintMessage("trae/glm-5.1", "1200 credit")
  assert.equal(msg.role, "system")
  assert.ok(msg.content.startsWith(MARK))
  assert.ok(msg.content.includes("trae/glm-5.1"))
  assert.ok(msg.content.includes("1200 credit"))
})
