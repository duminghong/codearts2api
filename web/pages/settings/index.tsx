/**
 * 设置视图 —— 面板上可改的运行时开关。
 *
 * 目前只有「会话开头提示」一个开关：它在**请求路径上**、改完**立刻生效**（不必重启），
 * 所以适合搬进面板。端口 / 鉴权 / 密钥那类是启动期配置或安全边界，仍留在环境变量。
 *
 * 语义：**面板为准**。`SESSION_HINT` 环境变量只提供「用户从没动过面板时」的初始默认值；
 * 一旦点过开关，就以面板的值为准（落盘在 `<home>/settings.json`）。
 */
import { useEffect, useState } from "react"

import { getSettings, setSessionHint, type SettingsState } from "../../api/settings"
import styles from "./index.module.less"

export default function Settings({ active = true }: { active?: boolean }) {
  const [state, setState] = useState<SettingsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let alive = true
    void getSettings()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch((e: any) => {
        if (alive) setError(e.message || String(e))
      })
    return () => {
      alive = false
    }
  }, [active])

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    // 先乐观更新，失败再回滚 —— 开关的往返延迟要短到「感觉是即时的」。
    const prev = state
    setState((s) => (s ? { ...s, sessionHint: next, source: "panel" } : s))
    try {
      const out = await setSessionHint(next)
      setState((s) => (s ? { ...s, sessionHint: out.sessionHint, source: "panel" } : s))
    } catch (e: any) {
      if (prev) setState(prev)
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const on = state?.sessionHint === true

  return (
    <section className="c2a-view" id="c2a-view-settings" data-view="settings" role="tabpanel" aria-label="设置">
      <div className="c2a-page" data-c2a-page="settings">
        <div className="c2a-page-head">
          <div>
            <h1 className="c2a-page-title">设置</h1>
            <p className="c2a-page-sub">这里改的是运行时开关 —— 点一下立即生效，不需要重启服务。</p>
          </div>
        </div>

        <div className={styles.body}>
          <div className={styles.group}>
            <div className={styles.groupTitle}>网关行为</div>

            <div className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>会话开头提示</div>
                <div className={styles.rowDesc}>
                  在每次会话的<strong>首轮</strong>聊天请求里，插入一条 system 消息，说明当前模型与该渠道的剩余积分。
                  首轮判定用的是「没有 assistant 消息」这个保守启发式；提示只附加一次，不会重复打扰。
                </div>
                <div className={styles.rowMeta}>
                  {state ? (
                    state.source === "panel" ? (
                      <>
                        当前值来自<strong>面板设置</strong>（已覆盖环境变量）
                      </>
                    ) : (
                      <>
                        当前值来自环境变量 <code>SESSION_HINT</code> 的初始默认值
                        {state.envDefault ? "（已开启）" : "（未开启）"}
                      </>
                    )
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className={styles.sw}
                role="switch"
                aria-checked={on ? "true" : "false"}
                aria-label="会话开头提示"
                disabled={busy || !state}
                onClick={() => toggle(!on)}
              />
            </div>
          </div>

          {error ? <div className={styles.err}>{error}</div> : null}
        </div>
      </div>
    </section>
  )
}
