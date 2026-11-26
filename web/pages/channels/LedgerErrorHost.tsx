/**
 * 「Token 用量」弹窗里的「错误日志」入口 —— portal 注入，点击跳转独立页面 /admin/errors。
 *
 * 上游弹窗（`.dim-jh-modal--ledger`）是**条件渲染**的：点「Token 用量」才出现，关闭即卸载。
 * 所以这里监听整个 document.body，弹窗一出现就往头部按钮区（`.dim-jh-modelPanelActions`）
 * 插一个按钮。上游结构变了 / 找不到锚点 → 什么都不做（静默降级，绝不影响原弹窗）。
 *
 * ponytail: 按钮沿用上游 `.dim-jh-btn` 类名白嫖视觉；日志内容在独立页，这里只是入口。
 */
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"

const LEDGER_MODAL = ".dim-jh-modal.dim-jh-modal--ledger"

export function LedgerErrorHost() {
  const navigate = useNavigate()
  const [btnHost, setBtnHost] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let btnEl: HTMLDivElement | null = null

    const ensure = () => {
      const modal = document.querySelector<HTMLElement>(LEDGER_MODAL)
      const actions = modal?.querySelector<HTMLElement>(".dim-jh-modelPanelActions")
      if (!modal || !actions) {
        if (btnEl) btnEl.style.display = "none"
        return // 上游结构对不上 → 静默降级
      }
      if (!btnEl) {
        btnEl = document.createElement("div")
        btnEl.setAttribute("data-c2a-errlog-btn", "1")
        btnEl.style.display = "inline-flex"
      }
      if (btnEl.parentElement !== actions) actions.insertBefore(btnEl, actions.firstChild)
      setBtnHost(btnEl)
    }

    ensure()
    const observer = new MutationObserver(() => ensure())
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      btnEl?.remove()
    }
  }, [])

  return btnHost
    ? createPortal(
        <button
          type="button"
          className="dim-jh-btn"
          style={{ marginRight: 6 }}
          onClick={() => void navigate("/errors")}
        >
          错误日志
        </button>,
        btnHost,
      )
    : null
}
