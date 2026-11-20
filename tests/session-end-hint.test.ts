/**
 * 会话结尾提示（在助手回复正文**末尾**追加用户可见文字）的回归测试。
 *
 * 结尾提示显示「实际命中的模型 + 本次 token 用量」：token 用量取自
 * 上游 usage，抓不到就不显示（绝不编造）。不报积分（与开头提示重复）。
 * 与开头提示一样失败全是静默的，故这里把纯函数 + 响应流注入都覆盖。
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

test("buildSessionEndHintText：模型 + token，缺 token 返回空串（不编造、不显示空提示）", () => {
  assert.equal(
    buildSessionEndHintText(MODEL, "100（输入 60 / 输出 40）"),
    `${MARK} 当前模型：${MODEL} · 本次 token 用量：100（输入 60 / 输出 40）。`,
  )
  assert.ok(!buildSessionEndHintText(MODEL, "100").includes("积分"), "结尾不报积分（与开头重复）")
  assert.equal(buildSessionEndHintText(MODEL, null), "")
})

test("非流式：提示追加在正文**末尾**，原文与 usage 不变", async () => {
  const body = {
    id: "c1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 },
  }
  const stream = createEndHintTransform({ model: MODEL, isStream: false })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  const obj = JSON.parse(out)
  assert.equal(obj.usage.total_tokens, 100)
  const content: string = obj.choices[0].message.content
  assert.ok(content.startsWith("你好\n\n"), "原文应在最前面")
  assert.ok(content.trimEnd().endsWith("。"), "提示应在末尾")
  assert.ok(content.includes("本次 token 用量：100（输入 60 / 输出 40）"))
})

test("非流式：显示响应里实际命中的模型，而非请求的 aggregate", async () => {
  const body = {
    id: "c1",
    model: "trae/glm-5.1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 },
  }
  // 请求侧传的是 aggregate/auto，响应实际命中 trae/glm-5.1。
  const stream = createEndHintTransform({ model: "aggregate/auto", isStream: false })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  const content: string = JSON.parse(out).choices[0].message.content
  assert.ok(content.includes(`当前模型：trae/glm-5.1`), "应显示响应里的实际模型")
  assert.ok(!content.includes("当前模型：aggregate/auto"), "不应显示请求的聚合模型")
})

test("非流式：响应没带 model 时回退到请求模型", async () => {
  const body = {
    id: "c1",
    choices: [{ index: 0, message: { role: "assistant", content: "你好" } }],
    usage: { total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 },
  }
  const stream = createEndHintTransform({ model: "trae/glm-5.1", isStream: false })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  assert.ok(JSON.parse(out).choices[0].message.content.includes("当前模型：trae/glm-5.1"))
})

test("非流式：抓不到 usage → 正文原样不动", async () => {
  const body = { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "你好" } }] }
  const stream = createEndHintTransform({ model: MODEL, isStream: false })
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
  // 请求传 aggregate/auto，但响应帧 model 是 trae/glm-5.1 → 结尾应显示后者。
  const stream = createEndHintTransform({ model: "aggregate/auto", isStream: true })
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
  assert.ok(hintFrame.choices[0].delta.content.includes("当前模型：trae/glm-5.1"), "流式也要显示命中的模型")
  assert.ok(!hintFrame.choices[0].delta.content.includes("当前模型：aggregate/auto"))
  assert.equal(hintFrame.id, "c1")
})

test("流式：跨 chunk 的半帧也能正确注入", async () => {
  const full =
    'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"total_tokens":9}}\n\n' +
    "data: [DONE]\n\n"
  const cut = Math.floor(full.length / 2)
  const stream = createEndHintTransform({ model: MODEL, isStream: true })
  const out = await runTransform(stream, [Buffer.from(full.slice(0, cut)), Buffer.from(full.slice(cut))])
  assert.ok(out.includes("本次 token 用量：9"))
  assert.ok(out.trimEnd().endsWith("data: [DONE]"))
})

test("非流式：中间工具轮（finish_reason=tool_calls）不注入结尾提示", async () => {
  // 用户报障「提示还是会重复」：agent 一轮请求发多次 HTTP，中间轮也注入 ⇒ 会话堆一串提示。
  const body = {
    id: "c1",
    model: "aggregate/auto",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "tool_calls",
      },
    ],
    usage: { total_tokens: 48988, prompt_tokens: 48521, completion_tokens: 467 },
  }
  const stream = createEndHintTransform({ model: "aggregate/auto", isStream: false })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  const obj = JSON.parse(out)
  assert.equal(obj.choices[0].message.content, "", "中间轮正文应原样为空，不追加提示")
  assert.ok(!out.includes("本次 token 用量"), "中间轮不应出现结尾提示")
})

test("流式：中间工具轮（finish_reason=tool_calls）不注入结尾提示", async () => {
  const frames = [
    'data: {"id":"c1","object":"chat.completion.chunk","model":"aggregate/auto","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"aggregate/auto","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"aggregate/auto","choices":[],"usage":{"total_tokens":48988}}\n\n',
    "data: [DONE]\n\n",
  ]
  const stream = createEndHintTransform({ model: "aggregate/auto", isStream: true })
  const out = await runTransform(
    stream,
    frames.map((f) => Buffer.from(f)),
  )
  assert.ok(!out.includes("本次 token 用量"), "中间轮不应出现结尾提示")
  assert.ok(!out.includes("[网关提示]"), "中间轮不应出现任何提示")
  assert.ok(out.trimEnd().endsWith("data: [DONE]"), "流仍应正常结束")
})

test("流式：最终轮（finish_reason=stop）才注入，且显示实际命中的渠道", async () => {
  const frames = [
    'data: {"id":"c1","object":"chat.completion.chunk","model":"aggregate/auto","choices":[{"index":0,"delta":{"content":"好了"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"aggregate/auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","model":"aggregate/auto","choices":[],"usage":{"total_tokens":49399}}\n\n',
    "data: [DONE]\n\n",
  ]
  // 上游回显的 model 是**请求的路由**（aggregate/auto），真实渠道只能问上游。
  let asked = 0
  const stream = createEndHintTransform({
    model: "aggregate/auto",
    isStream: true,
    resolveProvider: async () => {
      asked++
      return "minimax"
    },
  })
  const out = await runTransform(
    stream,
    frames.map((f) => Buffer.from(f)),
  )
  assert.ok(out.includes("当前模型：minimax"), "应显示实际命中的渠道")
  assert.ok(!out.includes("当前模型：aggregate/auto"), "不应显示请求的聚合路由")
  assert.ok(out.includes("本次 token 用量：49399"))
  assert.equal(asked, 1, "只在注入那一刻问一次上游")
})

test("结尾提示：问不到实际渠道时回退到回显的模型名（fail-open）", async () => {
  const body = {
    id: "c1",
    model: "aggregate/auto",
    choices: [{ index: 0, message: { role: "assistant", content: "好了" }, finish_reason: "stop" }],
    usage: { total_tokens: 10 },
  }
  const stream = createEndHintTransform({
    model: "aggregate/auto",
    isStream: false,
    resolveProvider: async () => {
      throw new Error("rpc down")
    },
  })
  const out = await runTransform(stream, [Buffer.from(JSON.stringify(body))])
  const content: string = JSON.parse(out).choices[0].message.content
  assert.ok(content.includes("当前模型：aggregate/auto"), "问不到就回退到回显模型")
  assert.ok(content.includes("本次 token 用量：10"), "提示仍要出")
})
