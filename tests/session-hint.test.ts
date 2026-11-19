/**
 * 会话提示（每轮在**助手回复正文开头**插入用户可见文字）的回归测试。
 *
 * 提示给用户看（不是给模型的 system 消息），网关控制不了客户端 UI，
 * 所以唯一形态是往回复正文最前面塞一段文字。失败模式全是静默的，
 * 故这里把纯函数 + 响应流注入都覆盖。
 */

import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import {
  buildSessionHintText,
  createResponseHintTransform,
  createSessionHint,
  injectHintIntoJson,
  injectHintIntoSseFrame,
  shouldInjectHint,
  summarizeProviderBalance,
} from "../src/modules/gateway/session-hint.service.ts"

const MARK = "[网关提示]"
const HINT = `${MARK} 当前模型：trae/glm-5.1 · 渠道剩余积分：1200 credit。`

test("注入判定：每轮只要有 user 消息就注入（含续会话）", () => {
  assert.equal(shouldInjectHint({ messages: [{ role: "user", content: "hi" }] }), true)
  assert.equal(
    shouldInjectHint({
      messages: [
        { role: "system", content: "you are a bot" },
        { role: "user", content: "hi" },
      ],
    }),
    true,
    "有 system 也注入",
  )
  assert.equal(
    shouldInjectHint({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "again" },
      ],
    }),
    true,
    "续会话（有 assistant 历史）同样注入",
  )
  assert.equal(shouldInjectHint({ messages: [] }), false, "空 messages 不注入")
  assert.equal(shouldInjectHint({}), false, "没有 messages 字段不注入")
  assert.equal(shouldInjectHint({ messages: "not-array" }), false, "非法形态不注入")
  assert.equal(shouldInjectHint({ messages: [{ role: "assistant", content: "yo" }] }), false, "没有 user 不注入")
})

test("幂等：已带提示标记的请求不再注入", () => {
  const body = {
    messages: [
      { role: "system", content: HINT },
      { role: "user", content: "hi" },
    ],
  }
  assert.equal(shouldInjectHint(body), false)
})

test("提示文本：含模型与积分，查不到积分时不编造数字", () => {
  const full = buildSessionHintText("trae/glm-5.1", "1200 credit")
  assert.ok(full.startsWith(MARK))
  assert.ok(full.includes("trae/glm-5.1"))
  assert.ok(full.includes("1200 credit"))
  const noBalance = buildSessionHintText("trae/glm-5.1", null)
  assert.ok(noBalance.includes("trae/glm-5.1"))
  assert.ok(!noBalance.includes("积分"), "查不到积分时不该出现积分字样")
})

test("非流式注入：提示加到 message.content 最前面，其余字段原样", () => {
  const raw = Buffer.from(
    JSON.stringify({
      id: "chatcmpl-1",
      model: "trae/glm-5.1",
      choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  )
  const out = injectHintIntoJson(raw, HINT)
  assert.ok(out)
  const obj = JSON.parse(out.toString("utf8"))
  assert.ok(obj.choices[0].message.content.startsWith(HINT))
  assert.ok(obj.choices[0].message.content.endsWith("你好"))
  assert.equal(obj.id, "chatcmpl-1")
  assert.equal(obj.model, "trae/glm-5.1")
  assert.deepEqual(obj.usage, { prompt_tokens: 10, completion_tokens: 5 }, "usage 不能被动")
})

test("非流式注入：形态不认识/坏 JSON 时返回 null（原样透传）", () => {
  assert.equal(injectHintIntoJson(Buffer.from("not-json"), HINT), null)
  assert.equal(injectHintIntoJson(Buffer.from('{"foo":1}'), HINT), null)
  assert.equal(injectHintIntoJson(Buffer.from('{"choices":[{}]}'), HINT), null)
  const noContent = Buffer.from(JSON.stringify({ choices: [{ message: { role: "assistant" } }] }))
  assert.equal(injectHintIntoJson(noContent, HINT), null, "content 非字符串不注入")
})

test("流式注入：提示塞进第一个 delta.content 帧，沿用上游 id/model", () => {
  const obj = {
    id: "chatcmpl-1",
    model: "trae/glm-5.1",
    choices: [{ index: 0, delta: { role: "assistant", content: "你" }, finish_reason: null }],
  }
  const out = injectHintIntoSseFrame(JSON.stringify(obj), HINT)
  assert.ok(out)
  const next = JSON.parse(out!)
  assert.equal(next.id, "chatcmpl-1")
  assert.equal(next.model, "trae/glm-5.1")
  assert.ok(next.choices[0].delta.content.startsWith(HINT))
  assert.ok(next.choices[0].delta.content.endsWith("你"))
  assert.deepEqual(next.choices[0].delta.role, "assistant")
})

test("流式注入：role-only 首帧（delta 无 content）也能注入", () => {
  const obj = { id: "x", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }
  const out = injectHintIntoSseFrame(JSON.stringify(obj), HINT)
  assert.ok(out)
  assert.ok(JSON.parse(out!).choices[0].delta.content.startsWith(HINT))
})

test("流式注入：DONE / 非 JSON / 无 delta 帧返回 null", () => {
  assert.equal(injectHintIntoSseFrame("[DONE]", HINT), null)
  assert.equal(injectHintIntoSseFrame("not-json", HINT), null)
  assert.equal(injectHintIntoSseFrame('{"choices":[]}', HINT), null)
})

test("积分汇总：取权威口径 balance.total，不按包求和（否则多算失效包与独立池）", () => {
  const now = Date.now()
  const text = summarizeProviderBalance({
    accounts: [
      {
        balance: {
          total: 100,
          packages: [
            { name: "有效包", unit: "credit", remaining: 100, deductionEndTime: now + 60_000 },
            { name: "过期包", unit: "credit", remaining: 50, active: false },
            { name: "星火积分（独立池，不参与主池合计）", unit: "credit", remaining: 999 },
          ],
        },
      },
    ],
  })
  assert.equal(text, "100 credit", "必须等于 total，不能是 1149")
})

test("积分汇总：没有 total 的降级响应才退回按包求和", () => {
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
  assert.ok(text!.includes("120 credit"))
  assert.ok(text!.includes("5 token"))
})

test("积分汇总：空账本/出错时返回 null", () => {
  assert.equal(summarizeProviderBalance({ accounts: [] }), null)
  assert.equal(summarizeProviderBalance({ error: "boom" }), null)
  assert.equal(summarizeProviderBalance(null), null)
  assert.equal(summarizeProviderBalance(undefined), null)
})

// ---- prepare：请求侧判定 + 生成提示文本 ----

test("prepare：首轮返回提示文本，且不改写请求体（只返回文本）", async () => {
  const hint = createSessionHint({
    enabled: true,
    rpc: async () => ({ accounts: [{ balance: { total: 7, unit: "credit" } }] }),
  })
  const raw = Buffer.from(JSON.stringify({ model: "trae/x", messages: [{ role: "user", content: "hi" }] }))
  const text = await hint.prepare(raw, "trae/x")
  assert.ok(text)
  assert.ok(text.startsWith(MARK))
  assert.ok(text.includes("trae/x"))
  assert.ok(text.includes("7 credit"))
})

test("prepare：fail-open —— RPC 失败仍返回只有模型名的提示", async () => {
  const hint = createSessionHint({
    enabled: true,
    rpc: async () => {
      throw new Error("upstream down")
    },
  })
  const raw = Buffer.from(JSON.stringify({ model: "trae/x", messages: [{ role: "user", content: "hi" }] }))
  const text = await hint.prepare(raw, "trae/x")
  assert.ok(text)
  assert.ok(text.includes("trae/x"))
  assert.ok(!text.includes("积分"))
})

test("prepare：关闭/无 user/坏 JSON/无模型时返回 null", async () => {
  const rpc = async () => ({ accounts: [] })
  const off = createSessionHint({ enabled: false, rpc })
  const on = createSessionHint({ enabled: true, rpc })
  const first = Buffer.from(JSON.stringify({ model: "trae/x", messages: [{ role: "user", content: "hi" }] }))
  const noUser = Buffer.from(
    JSON.stringify({
      model: "trae/x",
      messages: [{ role: "assistant", content: "yo" }],
    }),
  )
  const multi = Buffer.from(
    JSON.stringify({
      model: "trae/x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
        { role: "user", content: "again" },
      ],
    }),
  )
  assert.equal(await off.prepare(first, "trae/x"), null, "关闭时不提示")
  assert.equal(await on.prepare(noUser, "trae/x"), null, "没有 user 不提示")
  assert.ok(await on.prepare(multi, "trae/x"), "续会话有 user 要提示")
  assert.equal(await on.prepare(Buffer.from("not-json"), "trae/x"), null, "坏 JSON 不提示")
  assert.equal(
    await on.prepare(Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] })), null),
    null,
    "无模型不提示",
  )
})

test("prepare：积分缓存 —— 同一渠道 5 分钟内只查一次", async () => {
  let calls = 0
  const hint = createSessionHint({
    enabled: true,
    rpc: async () => {
      calls += 1
      return { accounts: [{ balance: { total: 7, unit: "credit" } }] }
    },
  })
  const raw = Buffer.from(JSON.stringify({ model: "trae/x", messages: [{ role: "user", content: "hi" }] }))
  await hint.prepare(raw, "trae/x")
  await hint.prepare(raw, "trae/x")
  assert.equal(calls, 1, "第二次应命中缓存")
})

test("prepare：aggregate/auto 汇总所有渠道积分（跳过自身）", async () => {
  const seen: string[] = []
  const hint = createSessionHint({
    enabled: true,
    rpc: async (_method, params) => {
      seen.push(params.provider)
      const totals: Record<string, number> = { trae: 7, gemini: 3, opencode: 5 }
      return { accounts: [{ balance: { total: totals[params.provider] ?? 0, unit: "credit" } }] }
    },
    allProviders: () => ["aggregate", "trae", "gemini", "opencode"],
  })
  const raw = Buffer.from(JSON.stringify({ model: "aggregate/auto", messages: [{ role: "user", content: "hi" }] }))
  const text = await hint.prepare(raw, "aggregate/auto")
  assert.ok(text)
  assert.ok(text.includes("aggregate/auto"))
  assert.ok(text.includes("15 credit"), `应汇总三个渠道共 15，实际：${text}`)
  assert.ok(!seen.includes("aggregate"), "不该拿 aggregate 自己去查余额")
})

// ---- createResponseHintTransform：响应流注入 ----

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString("utf8")
}

test("响应 Transform（非流式）：正文开头出现提示，只注一次", async () => {
  const body = JSON.stringify({
    id: "c1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
  })
  const t = createResponseHintTransform({ hintText: HINT, isStream: false })
  t.end(Buffer.from(body))
  const out = await collect(t)
  const obj = JSON.parse(out)
  assert.ok(obj.choices[0].message.content.startsWith(HINT))
  assert.equal((obj.choices[0].message.content.match(/\[网关提示\]/g) ?? []).length, 1)
})

test("响应 Transform（流式，LF）：第一个 delta 帧带提示，DONE 帧原样", async () => {
  const frames = [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "你" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "好" }, finish_reason: null }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
  const t = createResponseHintTransform({ hintText: HINT, isStream: true })
  t.end(Buffer.from(frames))
  const out = await collect(t)
  const dataFrames = out
    .split("\n\n")
    .filter(Boolean)
    .map((f) => f.replace(/^data: /, ""))
  assert.ok(JSON.parse(dataFrames[0]).choices[0].delta.content.startsWith(HINT))
  assert.equal(JSON.parse(dataFrames[1]).choices[0].delta.content, "好", "后续帧原样")
  assert.equal(dataFrames[2], "[DONE]")
})

test("响应 Transform（流式，CRLF）：也能正确切帧并注入", async () => {
  const frame = `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] })}\r\n\r\n`
  const t = createResponseHintTransform({ hintText: HINT, isStream: true })
  t.end(Buffer.from(frame))
  const out = await collect(t)
  const obj = JSON.parse(out.split("\r\n\r\n")[0].replace(/^data: /, ""))
  assert.ok(obj.choices[0].delta.content.startsWith(HINT))
})

test("响应 Transform：跨 chunk 的半帧能正确拼接后再注入", async () => {
  const data = JSON.stringify({
    id: "c1",
    choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
  })
  const t = createResponseHintTransform({ hintText: HINT, isStream: true })
  t.write(Buffer.from(`data: ${data.slice(0, 20)}`))
  t.end(Buffer.from(`${data.slice(20)}\n\n`))
  const out = await collect(t)
  const obj = JSON.parse(out.replace(/^data: /, "").trim())
  assert.ok(obj.choices[0].delta.content.startsWith(HINT))
})

test("响应 Transform：上游回复形态不认识时原样透传（fail-open）", async () => {
  const t = createResponseHintTransform({ hintText: HINT, isStream: false })
  const raw = '{"foo":"bar"}'
  t.end(Buffer.from(raw))
  assert.equal(await collect(t), raw)
})
