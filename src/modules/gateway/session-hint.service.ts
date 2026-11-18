/**
 * 会话开头提示（session hint）：给「首轮」聊天请求注入一条 system 消息，
 * 报当前模型与该渠道剩余积分。默认关闭（SESSION_HINT=1 开启）。
 *
 * 为什么是「首轮启发式」而不是真会话：网关只见一次次独立请求，没有会话概念。
 * 判据取最保守的形态 —— messages 里一条 assistant 都没有 且 已有 system 不含
 * 本标记。客户端重试/多轮会自然跳过注入，多耗的只有首轮那几十个 token。
 *
 * 失败语义 **fail-open**：任何解析/RPC 失败都原样返回原始 body，
 * 绝不因为提示功能把请求吞掉（与 provider-name-decor 同一原则）。
 */

/** 注入消息的识别标记：既用来幂等防重复注入，也方便客户端按需过滤。 */
export const SESSION_HINT_MARKER = "[网关提示]"

/** 注入文本的生成（纯函数，测试友好）。 */
export function buildSessionHintMessage(model: string, balanceText: string) {
  const content = `${SESSION_HINT_MARKER} 当前模型：${model}。渠道剩余积分：${balanceText}。该提示由网关自动附加，无需回应。`
  return { role: "system", content }
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
 * 上游自己的客户端也是累加 `balance.total`（`client/jet-hub.js` 的 global stats），
 * 所以跟着它走不会与管理界面出现两个口径。
 *
 * ⚠️ 单位：上游 `normalizeCreditUnit` 把除 `token` 外的单位一律归一为 `credit`
 *    （服务端实测会下发 `credit` / `credits` 两种写法）。这里照抄那套归一化，
 *    否则同一笔积分会被拆成两个数。
 */
export function summarizeProviderBalance(balanceEntry: any) {
  if (!balanceEntry || balanceEntry.error) return null
  const accounts = Array.isArray(balanceEntry.accounts) ? balanceEntry.accounts : []
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  // 单位归一化：与上游 normalizeCreditUnit 同源（token 单独成组，不与积分折算）。
  const unitOf = (u: unknown) => (u === "token" ? "token" : "credit")
  const byUnit = new Map<string, { unit: string; remaining: number }>()
  for (const acc of accounts) {
    const bal = acc?.balance
    if (!bal) continue
    // 权威口径：balance.total。没有 total 的账号（老/降级响应）才退回按包求和，
    // 且跳过失效包与独立池 —— 与 total 的口径保持一致。
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
 * 请求体注入（纯函数）：返回改写后的 JSON 文本；形态不认识/非 chat 形态原样返回 null。
 * 只处理 `messages` 数组形态（/v1/chat/completions 的标准形态）。
 */
export function injectSessionHint(body: any, model: string, balanceText: string | null) {
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (!messages || !isFirstTurnOfSession(body)) return null
  const hint = buildSessionHintMessage(model, balanceText ?? "查询暂不可用")
  const hintBody = { ...body, messages: [hint, ...messages] }
  return JSON.stringify(hintBody)
}

/**
 * 组装运行期对象：积分查询（带 TTL 缓存与并发去重）+ 请求体改写。
 * rpc 失败/超时一律吞掉返回 null，让注入退化成「只有模型名」。
 *
 * `enabled` 可以是布尔常量，也可以是 **getter**（`() => boolean`）——
 * 后者是管理端面板开关要的：用户在 /admin 点一下就生效，不必重启。
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
   * 给已 buffer 的请求体注入提示。任何一步失败都原样返回 raw。
   * model 可为 null：此时从 body.model 取。
   * @returns 注入后的 Buffer（或原 raw）
   */
  async function rewrite(raw: Buffer, model: string | null): Promise<Buffer> {
    const on = typeof enabled === "function" ? enabled() : enabled
    if (!on) return raw
    try {
      const body = JSON.parse(raw.toString("utf8"))
      if (!isFirstTurnOfSession(body)) return raw
      const effectiveModel = model || (typeof body?.model === "string" ? body.model : null)
      if (!effectiveModel) return raw
      const slash = effectiveModel.indexOf("/")
      const provider = slash > 0 ? effectiveModel.slice(0, slash) : null
      const balanceText = provider ? await providerBalanceText(provider) : null
      const text = injectSessionHint(body, effectiveModel, balanceText)
      return text === null ? raw : Buffer.from(text, "utf8")
    } catch (error) {
      logger?.debug?.(`[session-hint] 注入失败，原样透传：${String(error)}`)
      return raw
    }
  }

  return { rewrite }
}
