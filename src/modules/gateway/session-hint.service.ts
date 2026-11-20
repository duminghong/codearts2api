/**
 * 会话提示（session hint）：在**每轮助手回复正文的最开头**插入一条用户可见的提示，
 * 报当前模型与该渠道剩余积分。默认关闭（SESSION_HINT=1 开启）。
 *
 * ## 形态
 *
 * 提示出现在「用户看到的会话里」，不是发给模型的 system 消息 —— 网关控制不了
 * 客户端 UI，没法画独立横幅，所以唯一可行的形态是把文字插进助手回复正文的开头。
 * 用户能看到、能复制；代价是这段文字属于回复内容（不计入上游 usage，上游根本没见过它）。
 *
 * ## 注入判定
 *
 * 网关只见一次次独立请求，没有会话概念。只要 messages 里有 user 消息就注入
 * （含续会话）；但任意历史消息（system / assistant / user）已带本标记时跳过 ——
 * agent 一次用户请求内会发多轮 HTTP（每轮工具调用后一轮），客户端把上一轮的助手
 * 回复连同提示回填进 assistant 历史；若只查 system，每轮都会重新注入，一个会话
 * 很快刷屏。标记即「本会话已有提示」的信号，保证一个会话只注入一次。
 *
 * ## 失败语义 fail-open
 *
 * 任何解析/RPC 失败都原样透传，绝不因为提示功能把请求或回复吞掉。
 */

import { Transform } from "node:stream"

/** 注入文本的识别标记：既用于幂等，也方便用户/客户端按需过滤。 */
export const SESSION_HINT_MARKER = "[网关提示]"

/** 开头提示文本：只报渠道剩余积分（发请求前的预算感知）；查不到积分则空串。 */
export function buildSessionHintText(balanceText: string | null) {
  if (!balanceText) return ""
  return `${SESSION_HINT_MARKER} 渠道剩余积分：${balanceText}。`
}

/**
 * 判定本轮是否该注入：有 user 消息就注入（含续会话），但任意消息已带标记则跳过
 * （agent 一次请求内的多轮 HTTP 会把带提示的助手回复回填进 assistant 历史，
 *  只查 system 会导致每轮重新注入、一个会话刷屏）。请求体形态不认识 → false（不注入）。
 */
export function shouldInjectHint(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages) return false
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    // ponytail: 任意角色的历史消息含标记就视为「本会话已提示过」；content 也可能是多模态数组。
    const content = m.content
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
          : ""
    if (text.includes(SESSION_HINT_MARKER)) return false
  }
  return hasUserMessage(body)
}

/** 请求体里有没有 user 消息（没有 ⇒ 不是一次「用户发起的对话」，不注入提示）。 */
function hasUserMessage(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages) return false
  return messages.some((m: any) => m && typeof m === "object" && m.role === "user")
}

/**
 * 单渠道积分文本：取该渠道账本里**有效**余额合计；查不到返回 null（不注积分）。
 *
 * ⚠️ `credits.balances` 的返回值**直接就是** `{ accounts: [...] }`（不按 provider 键控）——
 *    与 dashboard.service.ts 的 `collectCredits` 同一口径。
 *
 * ## 口径：取 `balance.total`，**不**自己求和 `packages[].remaining`
 *
 * 上游 `CreditBalance.total` 的定义是「当前可用总余额（各**有效**包的本周期剩余之和）」，
 * 与 IDE 顶部的 "Credits Balance" 一致 —— 即**已经**做过失效过滤的权威值。
 * 自己按包求和会**多算**，原因是上游的 `packages` 里含两类不该进合计的条目：
 *
 * 1. **已失效的包**（`active === false` / 已过 `deductionEndTime`）—— 仍在 `packages` 里，
 *    只是不可扣费；
 * 2. **独立池**（池名含「独立池」标记，如 AStudio 的「星火积分」）—— 上游**刻意**把它
 *    排除在主池合计之外（包名里就写明了「不参与主池合计」）。
 *
 * ⚠️ 单位：上游 `normalizeCreditUnit` 把除 `token` 外的单位一律归一为 `credit`。
 */
export function summarizeProviderBalance(balanceEntry: any) {
  if (!balanceEntry || balanceEntry.error) return null
  const accounts = Array.isArray(balanceEntry.accounts) ? balanceEntry.accounts : []
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const unitOf = (u: unknown) => (u === "token" ? "token" : "credit")
  const byUnit = new Map<string, { unit: string; remaining: number }>()
  for (const acc of accounts) {
    const bal = acc?.balance
    if (!bal) continue
    const hasTotal = typeof bal.total === "number" && Number.isFinite(bal.total)
    if (hasTotal) {
      const unit = unitOf(bal.unit)
      const u = byUnit.get(unit) || { unit, remaining: 0 }
      u.remaining += bal.total
      byUnit.set(unit, u)
      continue
    }
    for (const p of Array.isArray(bal.packages) ? bal.packages : []) {
      if (p?.active === false) continue
      if (typeof p?.name === "string" && p.name.includes("独立池")) continue
      const endAt = Number.isFinite(p?.deductionEndTime) ? p.deductionEndTime : Date.parse(p?.expiredTime)
      if (Number.isFinite(endAt) && endAt <= Date.now()) continue
      const unit = unitOf(p?.unit)
      const u = byUnit.get(unit) || { unit, remaining: 0 }
      u.remaining += num(p?.remaining)
      byUnit.set(unit, u)
    }
  }
  if (byUnit.size === 0) return null
  return [...byUnit.values()].map((u) => `${Math.round(u.remaining)} ${u.unit}`).join(" + ")
}

/**
 * 非流式响应注入：把提示加到 `choices[0].message.content` 最前面。
 * 形态不认识 / 解析失败 → null（原样透传）。
 */
export function injectHintIntoJson(raw: Buffer, hintText: string): Buffer | null {
  let obj: any
  try {
    obj = JSON.parse(raw.toString("utf8"))
  } catch {
    return null
  }
  const message = obj?.choices?.[0]?.message
  if (!message || typeof message.content !== "string") return null
  message.content = `${hintText}\n\n${message.content}`
  return Buffer.from(JSON.stringify(obj), "utf8")
}

/**
 * 流式：在第一个带 `delta` 的 SSE 数据帧前，把提示塞进 `delta.content` 最前面。
 * 这样 id / model / object 全部沿用上游真实帧，客户端不会因为 id 不一致丢帧。
 * 返回改写后的 data 文本；该帧不适合注入 → null（等下一帧）。
 */
export function injectHintIntoSseFrame(data: string, hintText: string): string | null {
  let obj: any
  try {
    obj = JSON.parse(data)
  } catch {
    return null
  }
  const choice = obj?.choices?.[0]
  const delta = choice?.delta
  if (!choice || !delta || typeof delta !== "object") return null
  if (delta.content != null && typeof delta.content !== "string") return null
  const next = {
    ...obj,
    choices: [{ ...choice, delta: { ...delta, content: `${hintText}\n\n${delta.content ?? ""}` } }],
  }
  return JSON.stringify(next)
}

/** 把一帧里所有 `data:` 行替换为 newData，其余行（含末尾空行）原样保留。 */
function rewriteDataFrame(frame: string, newData: string) {
  const lines = frame.replace(/\r\n/g, "\n").split("\n")
  let first = true
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith("data:")) {
      if (first) out.push(`data: ${newData}`)
      first = false
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

/**
 * 响应流注入 Transform。挂在 usage 记录之后：usage 看的是原始字节，不受提示影响。
 *
 * - 流式：逐帧缓冲，命中第一个可注入的帧就改写，之后纯透传；
 * - 非流式：整段 buffer（有上限），结束时一次性解析注入。
 *
 * 任何一步失败都把已收到的字节原样吐出（fail-open）。
 */
export function createResponseHintTransform({
  hintText,
  isStream,
  logger,
}: {
  hintText: string
  isStream: boolean
  logger?: any
}): Transform {
  const LIMIT = 32 * 1024 * 1024
  let injected = false
  let buf = ""
  const pending: Buffer[] = []
  let total = 0
  let overflow = false

  function frame(chunk: string): string {
    if (injected) return chunk
    const data = chunk
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    if (data === "" || data === "[DONE]") return chunk
    const next = injectHintIntoSseFrame(data, hintText)
    if (next === null) return chunk
    injected = true
    return rewriteDataFrame(chunk, next)
  }

  /** 找到最早完整帧的结束位置（兼容 \n\n 与 \r\n\r\n），找不到返回 -1。 */
  function frameEnd(s: string): { at: number; len: number } {
    const lf = s.indexOf("\n\n")
    const crlf = s.indexOf("\r\n\r\n")
    if (lf < 0) return crlf < 0 ? { at: -1, len: 0 } : { at: crlf, len: 4 }
    if (crlf < 0) return { at: lf, len: 2 }
    return lf <= crlf ? { at: lf, len: 2 } : { at: crlf, len: 4 }
  }

  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      try {
        if (isStream) {
          buf += chunk.toString("utf8")
          for (;;) {
            const { at, len } = frameEnd(buf)
            if (at < 0) break
            const rawFrame = buf.slice(0, at + len)
            buf = buf.slice(at + len)
            this.push(frame(rawFrame))
          }
          // ponytail: 单帧超过 32MB 就不缓冲，原样吐出（正常的 chat chunk 远小于此）。
          if (buf.length > LIMIT) {
            this.push(buf)
            buf = ""
          }
        } else {
          if (overflow) {
            this.push(chunk)
          } else if ((total += chunk.length) > LIMIT) {
            overflow = true
            for (const p of pending) this.push(p)
            pending.length = 0
            this.push(chunk)
          } else {
            pending.push(chunk)
          }
        }
      } catch (error) {
        logger?.debug?.(`[session-hint] 响应扫描失败，原样透传：${String(error)}`)
        this.push(chunk)
      }
      callback()
    },
    flush(callback) {
      try {
        if (isStream) {
          if (buf) this.push(frame(buf))
        } else if (!overflow) {
          const raw = Buffer.concat(pending)
          const rewritten = injectHintIntoJson(raw, hintText)
          this.push(rewritten ?? raw)
        }
      } catch (error) {
        logger?.debug?.(`[session-hint] 响应注入失败，原样透传：${String(error)}`)
        if (isStream && buf) this.push(buf)
        else if (!overflow) for (const p of pending) this.push(p)
      }
      callback()
    },
  })
}

/**
 * 结尾提示文本：实际命中的模型 + 本次 token 用量（账单感信息）。
 * 不报积分（与开头提示重复）；与开头共用 `[网关提示]` 标记（幂等/可过滤）；
 * `tokenText` 抓不到时为 null（不编造）。
 */
export function buildSessionEndHintText(model: string, tokenText: string | null) {
  if (!tokenText) return ""
  return `${SESSION_HINT_MARKER} 当前模型：${model} · 本次 token 用量：${tokenText}。`
}

/** 从 OpenAI 口径 usage 里取「本次 token 用量」文本；抓不到返回 null（fail-open）。 */
export function summarizeTokenUsage(usage: any): string | null {
  if (!usage || typeof usage !== "object") return null
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = usage[k]
      if (typeof v === "number" && Number.isFinite(v)) return v
    }
    return null
  }
  const total = pick("total_tokens", "totalTokens")
  const input = pick("prompt_tokens", "input_tokens", "inputTokens")
  const output = pick("completion_tokens", "output_tokens", "outputTokens")
  if (total === null && input === null && output === null) return null
  const t = total ?? (input ?? 0) + (output ?? 0)
  const detail = input !== null && output !== null ? `（输入 ${input} / 输出 ${output}）` : ""
  return `${t}${detail}`
}

/**
 * 结尾提示响应 Transform：把提示追加到助手回复正文**末尾**。
 *
 * - 非流式：整段 buffer（有上限），结束时解析 JSON、取 `usage`，追加到 `message.content`；
 * - 流式：逐帧透传，边看边抓 usage 与首帧 id/model；在 `[DONE]` 前**另起一帧**写入提示，
 *   不改上游任何已有字节（id 沿用首帧，客户端不会丢帧）。
 *
 * ## 只在「最终轮」注入（2026-11-20）
 *
 * agent 一次用户请求会发**多轮** HTTP（每轮工具调用后再一轮）。中间轮的
 * `finish_reason` 是 `tool_calls`、正文常为空 —— **每轮都注入**会让会话里堆出一串
 * 提示（用户报障：「提示还是会重复」）。⇒ **`finish_reason === "tool_calls"` 不注入**，
 * 其余（`stop` / `length` / 字段缺失）照常注入 —— 宽松口径：宁可多一条，也不让提示
 * 在老客户端/异常形态下彻底消失（fail-open）。
 *
 * ## 「当前模型」显示实际命中的渠道
 *
 * 上游回显的 `model` 是**请求的路由**（aggregate 路由恒为 `aggregate/*`），不是真正
 * 发往的渠道。真实渠道只能问上游 `aggregate.activeProvider`（`resolveProvider` 回调），
 * 且只在**回显仍是 `aggregate/*`** 时才问（直连渠道上游本来就会回显渠道名）。
 *
 * 全程 fail-open：解析失败 / 超上限 / 抓不到 usage 都只影响提示，绝不吞请求。
 */
export function createEndHintTransform({
  model,
  isStream,
  logger,
  resolveProvider,
}: {
  model: string
  isStream: boolean
  logger?: any
  /** 取「本次实际命中的渠道」（如 `trae`）；取不到返回 null（回退到响应/请求里的模型名）。 */
  resolveProvider?: () => Promise<string | null>
}): Transform {
  const LIMIT = 32 * 1024 * 1024
  // 响应里的 model 是**请求的路由**（aggregate/auto 永远是它）；真实渠道靠 resolveProvider 问上游。
  let resolvedModel = model
  let providerName: string | null = null
  // 上游的 finish_reason：只有 `stop` 是最终轮（`tool_calls` 是 agent 的中间轮）。
  let finishReason: string | null = null
  const suffixOf = (usage: any) => {
    const tokenText = summarizeTokenUsage(usage)
    if (!tokenText) return null
    return `\n\n${buildSessionEndHintText(providerName ?? resolvedModel, tokenText)}`
  }

  // 非流式：整段 buffer
  const pending: Buffer[] = []
  let total = 0
  let overflow = false

  // 流式：帧缓冲 + 抓取
  let buf = ""
  let usage: any = null
  let template: any = null
  let injected = false

  function capture(obj: any) {
    if (!obj || typeof obj !== "object") return
    if (!template) template = obj
    if (typeof obj.model === "string" && obj.model) resolvedModel = obj.model
    if (obj.usage && typeof obj.usage === "object") usage = obj.usage
    const fr = obj?.choices?.[0]?.finish_reason
    if (typeof fr === "string" && fr) finishReason = fr
  }

  /** 提示是否该出现在本轮：中间工具轮（`tool_calls`）不注入。 */
  function shouldInject() {
    return finishReason !== "tool_calls"
  }

  /**
   * 取「本次实际命中的渠道」。
   *
   * ⚠️ 只在**回显仍是 aggregate 路由**时才问上游：直连渠道上游本来就会回显渠道名，
   *    多问一次是白费。问不到（RPC 失败 / 无历史）就回退到回显的模型名（fail-open）。
   */
  async function resolveProviderName() {
    if (providerName !== null) return providerName
    if (!resolveProvider) return null
    if (!resolvedModel.startsWith("aggregate/")) return null
    try {
      providerName = (await resolveProvider()) ?? null
    } catch (error) {
      logger?.debug?.(`[session-end-hint] 取实际渠道失败，回退到模型名：${String(error)}`)
      providerName = null
    }
    return providerName
  }

  /** 另起一帧的提示文本（含结尾空行）；抓不到 usage 时空串（不注入）。 */
  function hintFrameText(): string {
    const text = suffixOf(usage)
    if (!text) return ""
    const base = template ?? {}
    const frame = {
      ...(base.id ? { id: base.id } : {}),
      object: "chat.completion.chunk",
      ...(base.created != null ? { created: base.created } : {}),
      ...(base.model ? { model: base.model } : {}),
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }
    return `data: ${JSON.stringify(frame)}\n\n`
  }

  function frameEnd(s: string): { at: number; len: number } {
    const lf = s.indexOf("\n\n")
    const crlf = s.indexOf("\r\n\r\n")
    if (lf < 0) return crlf < 0 ? { at: -1, len: 0 } : { at: crlf, len: 4 }
    if (crlf < 0) return { at: lf, len: 2 }
    return lf <= crlf ? { at: lf, len: 2 } : { at: crlf, len: 4 }
  }

  async function processStreamText(text: string, push: (s: string) => void) {
    buf += text
    for (;;) {
      const { at, len } = frameEnd(buf)
      if (at < 0) break
      const rawFrame = buf.slice(0, at + len)
      buf = buf.slice(at + len)
      for (const line of rawFrame.replace(/\r\n/g, "\n").split("\n")) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") continue
        try {
          capture(JSON.parse(data))
        } catch {
          /* 非 JSON 帧，忽略 */
        }
      }
      // ponytail: 提示帧插在 [DONE] 前：此时 usage 已到齐；多一个 delta.content 帧是
      // OpenAI 兼容客户端的标准行为（usage 帧本身也在 finish_reason 之后）。
      // ⚠️ 中间工具轮（finish_reason=tool_calls）**不注入** —— 那是 agent 的中间步骤，
      //    每轮都注入会让会话堆出一串提示（用户报障：「提示还是会重复」）。
      if (!injected && /\[DONE\]/.test(rawFrame)) {
        injected = true
        if (shouldInject()) {
          await resolveProviderName()
          const extra = hintFrameText()
          if (extra) push(extra)
        }
      }
      push(rawFrame)
    }
    // ponytail: 单帧超过 32MB 就不缓冲，原样吐出（正常 chat chunk 远小于此）。
    if (buf.length > LIMIT) {
      push(buf)
      buf = ""
    }
  }

  return new Transform({
    async transform(chunk: Buffer, _enc, callback) {
      try {
        if (isStream) {
          await processStreamText(chunk.toString("utf8"), (s) => this.push(s))
        } else if (overflow) {
          this.push(chunk)
        } else if ((total += chunk.length) > LIMIT) {
          overflow = true
          for (const p of pending) this.push(p)
          pending.length = 0
          this.push(chunk)
        } else {
          pending.push(chunk)
        }
      } catch (error) {
        logger?.debug?.(`[session-end-hint] 响应扫描失败，原样透传：${String(error)}`)
        this.push(chunk)
      }
      callback()
    },
    async flush(callback) {
      try {
        if (isStream) {
          await processStreamText("\n\n", (s) => this.push(s)) // 凑齐末帧
          if (!injected) {
            injected = true
            if (shouldInject()) {
              await resolveProviderName()
              const extra = hintFrameText()
              if (extra) this.push(extra)
            }
          }
        } else if (!overflow) {
          const raw = Buffer.concat(pending)
          let out = raw
          try {
            const obj = JSON.parse(raw.toString("utf8"))
            usage = obj?.usage
            if (typeof obj?.model === "string" && obj.model) resolvedModel = obj.model
            const fr = obj?.choices?.[0]?.finish_reason
            if (typeof fr === "string" && fr) finishReason = fr
            const message = obj?.choices?.[0]?.message
            // ⚠️ 中间工具轮（finish_reason=tool_calls）**不注入** —— 每轮都注入
            //    会让会话堆出一串提示（用户报障：「提示还是会重复」）。
            if (shouldInject() && message && typeof message.content === "string") {
              await resolveProviderName()
              const suffix = suffixOf(usage)
              if (suffix) {
                message.content = `${message.content}${suffix}`
                out = Buffer.from(JSON.stringify(obj), "utf8")
              }
            }
          } catch {
            /* 形态不认识：原样透传 */
          }
          this.push(out)
        }
      } catch (error) {
        logger?.debug?.(`[session-end-hint] 响应注入失败，原样透传：${String(error)}`)
        if (isStream && buf) this.push(buf)
        else if (!overflow) for (const p of pending) this.push(p)
      }
      callback()
    },
  })
}

/**
 * 组装运行期对象：积分查询（带 TTL 缓存与并发去重）+ 首轮判定 + 提示文本生成。
 *
 * `enabled` / `endEnabled` 可以是布尔常量，也可以是 **getter**（`() => boolean`）——
 * 管理端面板开关要能实时生效。
 */
export function createSessionHint({
  enabled,
  endEnabled,
  rpc,
  logger,
  allProviders,
}: {
  enabled: boolean | (() => boolean)
  /** 结尾提示开关；缺省时跟随 `enabled`（纯开头提示的老调用方无需改）。 */
  endEnabled?: boolean | (() => boolean)
  rpc: any
  logger?: any
  /** 已注册渠道 id（aggregate 要用它汇总所有渠道）；getter 以跟随启动后的实际注册表。 */
  allProviders?: () => string[]
}) {
  const TTL_MS = 5 * 60 * 1000
  /** 积分查询要逐账号发网络请求（墙外渠道实测 10s+），必须限时，否则首轮请求被拖死。 */
  const RPC_TIMEOUT_MS = 8000
  const PROVIDER_CACHE: Record<string, { at: number; accounts: any[] | null } | undefined> = {}
  const inflight: Record<string, Promise<any[] | null> | undefined> = {}

  /** 查单渠道的原始 accounts（带 TTL 缓存 + 并发去重）；失败/不支持返回 null。 */
  async function providerAccounts(provider: string): Promise<any[] | null> {
    const hit = PROVIDER_CACHE[provider]
    if (hit && Date.now() - hit.at < TTL_MS) return hit.accounts
    const pending = inflight[provider]
    if (pending) return pending
    const task = (async () => {
      try {
        const value = await Promise.race([
          rpc("credits.balances", { provider }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), RPC_TIMEOUT_MS)),
        ])
        const accounts = value && !value.error && Array.isArray(value.accounts) ? value.accounts : null
        PROVIDER_CACHE[provider] = { at: Date.now(), accounts }
        return accounts
      } catch (error) {
        // ponytail: 失败直接吞 —— 提示是锦上添花，不值得为它重试或报错。
        logger?.debug?.(`[session-hint] 查询 ${provider} 积分失败：${String(error)}`)
        return null
      } finally {
        delete inflight[provider]
      }
    })()
    inflight[provider] = task
    return task
  }

  /** aggregate/auto：没有自己的余额，遍历所有渠道合并 accounts 后按同一口径求和。 */
  async function allChannelsBalanceText(): Promise<string | null> {
    const list = (allProviders?.() ?? []).filter((p) => p && p !== "aggregate")
    const settled = await Promise.all(list.map((p) => providerAccounts(p)))
    const merged = settled.flatMap((a) => a ?? [])
    return merged.length ? summarizeProviderBalance({ accounts: merged }) : null
  }

  async function balanceTextOf(provider: string | null): Promise<string | null> {
    if (!provider) return null
    if (provider === "aggregate") return allChannelsBalanceText()
    const accounts = await providerAccounts(provider)
    return accounts ? summarizeProviderBalance({ accounts }) : null
  }

  const flag = (v: boolean | (() => boolean)) => (typeof v === "function" ? v() === true : v === true)

  /**
   * 虚拟模型 id（上游 `aggregate.activeProvider` 的键）。
   *
   * 上游按**虚拟模型**分别记忆「上次实际选中的渠道」（`activeProviderByModel` 的键是
   * `dispatch` 收到的 modelKey = 虚拟模型 id，如 `auto` / `minimax-m3-1-flash`）。
   * ⇒ 只有 aggregate 路由需要问；直连渠道上游本来就会在响应里回显渠道名。
   */
  function canonicalIdOf(model: string): string | null {
    const slash = model.indexOf("/")
    if (slash <= 0) return null
    if (model.slice(0, slash) !== "aggregate") return null
    return model.slice(slash + 1) || null
  }

  /**
   * 问上游「本次实际命中的渠道」（纯内存读、零网络；无历史返回 null）。
   *
   * ⚠️ 上游语义是**真实历史**（已发生的转发），按虚拟模型记忆 ⇒ 并发同模型请求时
   *    可能读到另一次请求的渠道。ponytail: 这是上游提供的唯一口径，本项目不另造
   *    「本次命中」的判定（要准确得上游在响应里回显，而它不回显）。
   */
  async function activeProvider(canonicalId: string): Promise<string | null> {
    try {
      const value = await Promise.race([
        rpc("aggregate.activeProvider", { canonicalId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), RPC_TIMEOUT_MS)),
      ])
      const provider = value && typeof value.provider === "string" ? value.provider : null
      return provider && provider !== "aggregate" ? provider : null
    } catch (error) {
      logger?.debug?.(`[session-end-hint] 查询实际渠道失败：${String(error)}`)
      return null
    }
  }

  /** 请求侧公共解析：判定注入条件 + 模型；withBalance 时才查渠道余额（开头提示要，结尾不要）。 */
  async function resolve(raw: Buffer, model: string | null, withBalance: boolean) {
    let body: any
    try {
      body = JSON.parse(raw.toString("utf8"))
    } catch (error) {
      logger?.debug?.(`[session-hint] 判定失败，跳过提示：${String(error)}`)
      return null
    }
    if (!shouldInjectHint(body)) return null
    const effectiveModel = model || (typeof body?.model === "string" ? body.model : null)
    if (!effectiveModel) return null
    if (!withBalance) return { model: effectiveModel }
    const slash = effectiveModel.indexOf("/")
    const provider = slash > 0 ? effectiveModel.slice(0, slash) : null
    return { model: effectiveModel, balanceText: await balanceTextOf(provider) }
  }

  /**
   * 请求侧只做判定 + 生成提示文本（**不改写请求体** —— 提示给用户，不给模型）。
   * @returns 开关开着且符合条件时返回开头提示文本，否则 null。
   */
  async function prepare(raw: Buffer, model: string | null): Promise<string | null> {
    if (!flag(enabled)) return null
    const ctx = await resolve(raw, model, true)
    // 查不到积分时不注入（不再有「只有模型名」的降级提示可显示）。
    return ctx?.balanceText ? buildSessionHintText(ctx.balanceText) : null
  }

  /**
   * 结尾提示的请求侧准备：只判定 + 取回退模型，不查积分（省一次 RPC）。
   * token 用量与实际命中模型都要等响应里才有。
   */
  async function prepareEnd(raw: Buffer, model: string | null) {
    if (!flag(endEnabled ?? enabled)) return null
    const ctx = await resolve(raw, model, false)
    if (!ctx) return null
    const canonicalId = canonicalIdOf(ctx.model)
    return {
      model: ctx.model,
      /** 取本次实际命中的渠道；直连渠道（canonicalId 为 null）不需要问上游。 */
      resolveProvider: canonicalId ? () => activeProvider(canonicalId) : undefined,
    }
  }

  return { prepare, prepareEnd }
}
