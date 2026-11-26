/**
 * 错误日志页 —— /admin/errors。
 *
 * 网关报错落盘（`gateway-errors/<日期>.jsonl`）的独立查看页。「Token 用量」弹窗里的
 * 「错误日志」按钮与总览「成功率」卡片都只是跳到这里；上游结构变化导致入口注入失败时，
 * 本页仍可直接访问，不受影响。
 */
import { useEffect, useState } from "react"

import { listDays, listEntries, type GatewayErrorEntry } from "../../api/gateway-errors"
import styles from "./index.module.less"

function formatTs(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("zh-CN", { hour12: false })
}

export default function ErrorsPage() {
  const [days, setDays] = useState<string[]>([])
  const [day, setDay] = useState("")
  const [entries, setEntries] = useState<GatewayErrorEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void listDays()
      .then((out) => {
        if (!alive) return
        setDays(out.days)
        if (out.days.length > 0) setDay(out.days[0] as string)
        else setLoading(false)
      })
      .catch((e: any) => {
        if (alive) {
          setError(e.message || String(e))
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!day) return
    let alive = true
    setLoading(true)
    setError(null)
    void listEntries(day)
      .then((out) => {
        if (alive) setEntries(out.entries)
      })
      .catch((e: any) => {
        if (alive) setError(e.message || String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [day])

  return (
    <section className="c2a-view" id="c2a-view-errors" data-view="errors" role="tabpanel" aria-label="错误日志">
      <div className="c2a-page" data-c2a-page="errors">
        <div className="c2a-page-head">
          <div>
            <h1 className="c2a-page-title">错误日志</h1>
            <p className="c2a-page-sub">
              网关请求命中上游失败的逐条记录（按天落盘）。「失败换渠道重试」开启时，每条记录的「轮次」列对应一次真实尝试。
            </p>
          </div>
        </div>

        {error ? (
          <div className={styles.err}>错误日志加载失败：{error}</div>
        ) : loading ? (
          <div className={styles.hint}>正在加载错误日志…</div>
        ) : days.length === 0 ? (
          <div className={styles.hint}>还没有任何错误记录。</div>
        ) : (
          <div className={styles.wrap}>
            <div className={styles.tools}>
              <label className={styles.label}>
                日期
                <select className={styles.select} value={day} onChange={(e) => setDay(e.target.value)}>
                  {days.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <span className={styles.count}>
                {entries.length} 条{entries.length >= 500 ? "（仅显示最近 500 条）" : ""}
              </span>
            </div>
            {entries.length === 0 ? (
              <div className={styles.hint}>这一天没有错误记录。</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>渠道</th>
                    <th>模型</th>
                    <th>轮次</th>
                    <th>HTTP</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i}>
                      <td className={styles.mono}>{formatTs(e.ts)}</td>
                      <td>{e.provider}</td>
                      <td className={styles.mono}>{e.model}</td>
                      <td className={styles.mono}>{e.attempt}</td>
                      <td className={styles.mono}>{e.error.status}</td>
                      <td className={styles.msg} title={`${e.error.code ?? ""} ${e.error.message}`}>
                        {e.error.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
