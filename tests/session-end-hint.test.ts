/**
 * 会话结尾提示（在助手回复正文**末尾**追加用户可见文字）的回归测试。
 *
 * 结尾提示显示「当前模型 + 渠道剩余积分 + 本次 token 用量」：token 用量取自
 * 上游 usage，抓不到就不显示（绝不编造）。与开头提示一样失败全是静默的，
 * 故这里把纯函数 + 响应流注入都覆盖。
 */

import assert from "node:assert/strict"
import { test } from "vite-plus/test"

import {
  buildSessionEndHintText,
  createEndHintTransform,
  summarizeTokenUsage,
} from "../src/modules/gateway/session-hint.service.ts"

const MARK = "[网关提示]"
const MODEL = "trae/glm-5.1"
const BALANCE = "1200 credit"

/** 把若干 Buffer 喂进 Transform，收齐输出。 */
async function runTransform(stream: any, chunks: Buffer[]): Promise<string> {
  const out: Buffer[] = []
  stream.on("data", (c: Buffer) => out.push(Buffer.from(c)))
  const done = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve)
    stream.on("error", reject)
  })
  for (const c of chunks) stream.write(c)
  stream.end()
  await done
  return Buffer.concat(out).toString("utf8")
}

test("summarizeTokenUsage：OpenAI 口径 total + 输入/输出明细", () => {
  assert.equal(
    summarizeTokenUsage({ total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 }),
    "100（输入 60 / 输出 40）",
  )
  // input/output 口径
  assert.equal(summarizeTokenUsage({ input_tokens: 7, output_tokens: 3 }), "10（输入 7 / 输出 3）")
  // 只有 total
  assert.equal(summarizeTokenUsage({ total_tokens: 55 }), "55")
  // 抓不到 → null（不编造）
  assert.equal(summarizeTokenUsage(null), null)
  assert.equal(summarizeTokenUsage({}), null)
  assert.equal(summarizeTokenUsage({ total_tokens: "oops" }), null)
})

test("buildSessionEndHintText：模型 + 积分 + token，缺项不编造", () => {
  assert.equal(
    buildSessionEndHintText(MODEL, BALANCE, "100（输入 60 / 输出 40）"),
    `${MARK} 当前模型：${MODEL} · 渠道剩余积分：${BALANCE} · 本次 token 用量：100（输入 60 / 输出 40）。`,
  )
  // 无 token 用量 → 不出现「token」字样
  const withoutToken = buildSessionEndHintText(MODEL, BALANCE, null)
  assert.ok(withoutToken.includes(`当前模型：${MODEL}`))
  assert.ok(withoutToken.includes(`渠道剩余积分：${BALANCE}`))
  assert.ok(!withoutToken.includes("token"))
})

test("非流式：提示追加在正文**末尾**，原文与 usage 不变", async () => {
  const body = {
    id: "c1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 },
  }
  const stream = createEndHintTransform({ model: MODEL, balanceText: BALANCE, isStream: false })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  const obj = JSON.parse(out)
  assert.equal(obj.usage.total_tokens, 100)
  const content: string = obj.choices[0].message.content
  assert.ok(content.startsWith("你好\n\n"), "原文应在最前面")
  assert.ok(content.trimEnd().endsWith("。"), "提示应在末尾")
  assert.ok(content.includes("本次 token 用量：100（输入 60 / 输出 40）"))
})

test("非流式：抓不到 usage → 正文原样不动", async () => {
  const body = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "你好" } }] }
  const stream = createEndHintTransform({ model: MODEL, balanceText: BALANCE, isStream: false })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  assert.equal(JSON.parse(out).choices[0].message.content, "你好")
})

test("流式：提示帧插在 [DONE] 之前，携带 usage 数据", async () => {
  const frames = [
    'data: {"id":"c1","object":"chat.completion.chunk","model":"trae/glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"trae/glm-5.1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"trae/glm-5.1","choices":[],"usage":{"total_tokens":100,"prompt_tokens":60,"completion_tokens":40}}\n\n',
    "data: [DONE]\n\n",
  ]
  const stream = createEndHintTransform({ model: MODEL, balanceText: BALANCE, isStream: true })
  const out = await runTransform(
    stream,
    frames.map((f) => Buffer.from(f)),
  )
  const dataLines = out
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
  // 倒数第二条 data 是我们追加的提示帧，最后一条是 [DONE]
  assert.equal(dataLines.at(-1), "[DONE]")
  const hintFrame = JSON.parse(dataLines.at(-2)!)
  assert.ok(hintFrame.choices[0].delta.content.includes("本次 token 用量：100"))
  assert.equal(hintFrame.id, "c1")
})

test("流式：跨 chunk 的半帧也能正确注入", async () => {
  const full =
    'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"total_tokens":9}}\n\n' +
    "data: [DONE]\n\n"
  const cut = Math.floor(full.length / 2)
  const stream = createEndHintTransform({ model: MODEL, balanceText: BALANCE, isStream: true })
  const out = await runTransform(stream, [Buffer.from(full.slice(0, cut)), Buffer.from(full.slice(cut))])
  assert.ok(out.includes("本次 token 用量：9"))
  assert.ok(out.trimEnd().endsWith("data: [DONE]"))
})
