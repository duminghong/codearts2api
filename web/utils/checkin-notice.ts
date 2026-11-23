/**
 * 「一键签到」结果提示的 DOM 后处理。
 *
 * 上游（dsh-providers-hub/client）把每个渠道无条件拼进提示，连「无账号」也列出来，
 * 且顺序固定能力表顺序。这里在提示渲染后改写文本：有账号的渠道在前（按账号数降序）、
 * 无账号渠道整条省略、末尾追加一句指向全量明细的引导。
 *
 * 只认 `一键签到：` 前缀 —— 另一条 `全部渠道：` 提示本身就是全量明细，不碰。
 * 上游 bundle 每次 pnpm install / 自动升级都会覆盖，所以落在本仓库而不是改产物。
 */

const PREFIX = "一键签到："
const HINT = " · 全部渠道签到明细见「总览 → 自动签到」"

/**
 * 纯函数：改写一键签到提示文本；非一键签到文本原样返回。幂等（含引导句则不再改）。
 *
 * ponytail: 靠上游拼接用的「，」反推渠道边界 —— 上游 parts 与 bits 都用「，」，
 * 用「首段是「标签 + 空格」且标签不是纯数字/+开头」识别新渠道。
 * 已知上限：失败原因里若含中文逗号会被拆成两段；签到成功数被上游换成「+30积分」金额，
 * 丢失了具体个数，这里按「有金额即至少 1 个账号」折算，故排序是近似值（不影响「有账号在前」）。
 * 升级路径：若上游改用结构化 DOM（如每个渠道一个 <li>），改成按元素遍历即可，无需正则。
 */
export function rewriteCheckinNotice(text: string): string {
  if (typeof text !== "string" || !text.startsWith(PREFIX) || text.includes(HINT)) return text

  const body = text.slice(PREFIX.length)

  // 末尾的（共 ...）单独摘出，排序后原样贴回
  const totalMatch = /（共 [^）]*）$/.exec(body)
  const total = totalMatch ? totalMatch[0] : ""
  const core = total ? body.slice(0, -total.length) : body

  if (core === "没有可领取的渠道") return PREFIX + core + HINT

  const segments = core.split("，")
  const parts: { text: string; count: number }[] = []

  const isPartStart = (seg: string): boolean => {
    const m = /^([^\s+]\S*) (.+)$/.exec(seg)
    if (!m) return false
    const first = m[1]
    return !/^\d+$/.test(first) && !first.startsWith("+")
  }
  const countOf = (s: string): number => {
    let n = 0
    for (const m of s.matchAll(/(\d+) 个/g)) n += Number(m[1])
    // 签到成功数被上游换成金额（+30积分），个数丢失：有金额即至少 1 个账号
    if (n === 0 && /[+＋]\d/.test(s)) n = 1
    return n
  }

  for (const seg of segments) {
    if (isPartStart(seg)) {
      parts.push({ text: seg, count: countOf(seg) })
    } else if (parts.length > 0) {
      const last = parts[parts.length - 1]
      last.text += "，" + seg
      last.count += countOf(seg)
    } else {
      parts.push({ text: seg, count: countOf(seg) })
    }
  }

  const kept = parts.filter((p) => !/无账号/.test(p.text))
  // ES2019+ Array#sort 稳定：同账号数保持原（能力表）顺序
  kept.sort((a, b) => b.count - a.count)

  const body2 = kept.length > 0 ? kept.map((p) => p.text).join("，") + total : "没有可领取的渠道"
  return PREFIX + body2 + HINT
}

/** 安装 DOM 后处理（幂等，浏览器环境）。只处理 .dim-jh-probeNotice 的首个子 div。 */
export function installCheckinNoticeRewrite(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return
  const w = window as any
  if (w.__c2aCheckinRewriteLoaded) return
  w.__c2aCheckinRewriteLoaded = true

  const fixNotice = (notice: Element) => {
    const first = notice.firstElementChild
    if (!first || first.tagName !== "DIV") return
    const text = first.textContent || ""
    if (!text.startsWith(PREFIX)) return
    const next = rewriteCheckinNotice(text)
    if (next !== text) first.textContent = next
  }

  const fixNode = (root: Node) => {
    if (root.nodeType !== 1) return
    const el = root as Element
    if (el.classList?.contains("dim-jh-probeNotice")) fixNotice(el)
    el.querySelectorAll?.(".dim-jh-probeNotice").forEach(fixNotice)
  }

  const start = () => {
    fixNode(document.body)
    const observer = new MutationObserver((mutations) => {
      for (const mu of mutations) {
        if (mu.type === "characterData") {
          // 文本节点被就地改写：它的 parent 是 <div>，grandparent 是 .dim-jh-probeNotice
          fixNode(mu.target.parentElement?.parentElement || document.body)
          continue
        }
        mu.addedNodes.forEach((node) => fixNode(node))
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
}
