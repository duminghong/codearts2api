/**
 * 会话开头提示（session hint）：在**助手回复正文的最开头**插入一条用户可见的提示，
 * 报当前模型与该渠道剩余积分。默认关闭（SESSION_HINT=1 开启）。
 *
 * ## 形态
 *
 * 提示出现在「用户看到的会话里」，不是发给模型的 system 消息 —— 网关控制不了
 * 客户端 UI，没法画独立横幅，所以唯一可行的形态是把文字插进助手回复正文的开头。
 * 用户能看到、能复制；代价是这段文字属于回复内容（不计入上游 usage，上游根本没见过它）。
 *
 * ## 首轮判定
 *
 * 网关只见一次次独立请求，没有会话概念。判据取最保守的形态 —— messages 里一条
 * assistant 都没有 且 已有 system 不含本标记。客户端重试/多轮会自然跳过注入。
 *
 * ## 失败语义 fail-open
 *
 * 任何解析/RPC 失败都原样透传，绝不因为提示功能把请求或回复吞掉。
 */

import { Transform } from "node:stream"

/** 注入文本的识别标记：既用于幂等，也方便用户/客户端按需过滤。 */
export const SESSION_HINT_MARKER = "[网关提示]"

/** 用户可见的提示文本（纯函数，测试友好）。 */
export function buildSessionHintText(model: string, balanceText: string | null) {
  const balance = balanceText ? ` · 渠道剩余积分：${balanceText}` : ""
  return `${SESSION_HINT_MARKER} 当前模型：${model}${balance}。`
}

/**
 * 判定是否「首轮」：没有 assistant 消息，且现有 system（若有）不含标记。
 * 请求体形态不认识 → false（不注入）。
 */
export function isFirstTurnOfSession(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages) return false
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    if (m.role === "assistant") return false
    if (m.role === "system" && typeof m.content === "string" && m.content.includes(SESSION_HINT_MARKER)) return false
  }
  return messages.length > 0
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
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
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
 * 组装运行期对象：积分查询（带 TTL 缓存与并发去重）+ 首轮判定 + 提示文本生成。
 *
 * `enabled` 可以是布尔常量，也可以是 **getter**（`() => boolean`）——
 * 管理端面板开关要能实时生效。
 */
export function createSessionHint({
  enabled,
  rpc,
  logger,
}: {
  enabled: boolean | (() => boolean)
  rpc: any
  logger?: any
}) {
  const TTL_MS = 5 * 60 * 1000
  /** 积分查询要逐账号发网络请求（墙外渠道实测 10s+），必须限时，否则首轮请求被拖死。 */
  const RPC_TIMEOUT_MS = 8000
  const PROVIDER_CACHE: Record<string, { at: number; text: string | null }> = {}
  const inflight: Record<string, Promise<string | null>> = {}

  async function providerBalanceText(provider: string): Promise<string | null> {
    const hit = PROVIDER_CACHE[provider]
    if (hit && Date.now() - hit.at < TTL_MS) return hit.text
    if (inflight[provider]) return inflight[provider]
    inflight[provider] = (async () => {
      try {
        const value = await Promise.race([
          rpc("credits.balances", { provider }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), RPC_TIMEOUT_MS)),
        ])
        const text = summarizeProviderBalance(value)
        PROVIDER_CACHE[provider] = { at: Date.now(), text }
        return text
      } catch (error) {
        // ponytail: 失败直接吞 —— 提示是锦上添花，不值得为它重试或报错。
        logger?.debug?.(`[session-hint] 查询 ${provider} 积分失败：${String(error)}`)
        return null
      } finally {
        delete inflight[provider]
      }
    })()
    return inflight[provider]
  }

  /**
   * 请求侧只做判定 + 生成提示文本（**不改写请求体** —— 提示给用户，不给模型）。
   * @returns 首轮且开关开着时返回提示文本，否则 null。
   */
  async function prepare(raw: Buffer, model: string | null): Promise<string | null> {
    const on = typeof enabled === "function" ? enabled() : enabled
    if (!on) return null
    try {
      const body = JSON.parse(raw.toString("utf8"))
      if (!isFirstTurnOfSession(body)) return null
      const effectiveModel = model || (typeof body?.model === "string" ? body.model : null)
      if (!effectiveModel) return null
      const slash = effectiveModel.indexOf("/")
      const provider = slash > 0 ? effectiveModel.slice(0, slash) : null
      const balanceText = provider ? await providerBalanceText(provider) : null
      return buildSessionHintText(effectiveModel, balanceText)
    } catch (error) {
      logger?.debug?.(`[session-hint] 判定失败，跳过提示：${String(error)}`)
      return null
    }
  }

  return { prepare }
}
