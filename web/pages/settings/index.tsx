/**
 * 设置视图 —— 面板上可改的运行时开关。
 *
 * 三个开关：模型名装饰、报错落盘、换渠道重试 —— 都在**请求路径上**、
 * 改完**立刻生效**（不必重启）。端口 / 鉴权 / 密钥那类是启动期
 * 配置或安全边界，仍留在环境变量。
 */
import { useEffect, useState } from "react"

import { getSettings, setErrorLog, setModelNameDecor, setRetryFallback, type SettingsState } from "../../api/settings"
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

  async function toggle(key: "modelNameDecor" | "errorLog" | "retryFallback", next: boolean) {
    setBusy(true)
    setError(null)
    const prev = state
    setState((s) => (s ? { ...s, [key]: next } : s))
    try {
      if (key === "errorLog") {
        const out = await setErrorLog(next)
        setState((s) => (s ? { ...s, errorLog: out.errorLog } : s))
      } else if (key === "retryFallback") {
        const out = await setRetryFallback(next)
        setState((s) => (s ? { ...s, retryFallback: out.retryFallback } : s))
      } else {
        const out = await setModelNameDecor(next)
        setState((s) => (s ? { ...s, modelNameDecor: out.modelNameDecor } : s))
      }
    } catch (e: any) {
      if (prev) setState(prev)
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const decorOn = state?.modelNameDecor === true
  const errLogOn = state?.errorLog === true
  const retryOn = state?.retryFallback === true

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
                <div className={styles.rowTitle}>模型名显示渠道前缀</div>
                <div className={styles.rowDesc}>
                  在通过本反代的 /v1/models 返回的模型展示名前面加上<strong>渠道前缀</strong>
                  ，方便在模型选择器里区分同名模型的渠道。关掉则原样返回上游的模型名。
                  <code>[TRAE] GLM-5.1</code>
                </div>
                <div className={styles.rowMeta}>{state ? <>以面板开关为准，未点过时默认开启</> : null}</div>
              </div>
              <button
                type="button"
                className={styles.sw}
                role="switch"
                aria-checked={decorOn ? "true" : "false"}
                aria-label="模型名显示渠道前缀"
                disabled={busy || !state}
                onClick={() => toggle("modelNameDecor", !decorOn)}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>网关报错落盘</div>
                <div className={styles.rowDesc}>
                  把<strong>对话请求</strong>命中上游时的失败逐条写入日志文件（
                  <code>gateway-errors/&lt;日期&gt;.jsonl</code>
                  ，按天分文件），记录渠道 / 模型 / 调用方 / 重试轮次与错误详情，供在「Token 用量」弹窗里查看。
                  写入失败只记告警，绝不影响正常请求。
                </div>
                <div className={styles.rowMeta}>{state ? <>以面板开关为准，未点过时默认开启</> : null}</div>
              </div>
              <button
                type="button"
                className={styles.sw}
                role="switch"
                aria-checked={errLogOn ? "true" : "false"}
                aria-label="网关报错落盘"
                disabled={busy || !state}
                onClick={() => toggle("errorLog", !errLogOn)}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>失败换渠道重试</div>
                <div className={styles.rowDesc}>
                  对话请求失败且错误<strong>可恢复</strong>（限流 / 超时 / 服务异常等）时，自动换到
                  <strong>同样提供该模型</strong>的其他渠道重试，最多 2 次；候选渠道仍受调用方白名单约束。
                  参数错误、鉴权失败、模型不存在等换渠道也没用的错误<strong>不会</strong>重试。
                  响应保持真实命中的渠道，不做改写。会放大上游调用量，默认关闭。
                </div>
                <div className={styles.rowMeta}>{state ? <>以面板开关为准，未点过时默认关闭</> : null}</div>
              </div>
              <button
                type="button"
                className={styles.sw}
                role="switch"
                aria-checked={retryOn ? "true" : "false"}
                aria-label="失败换渠道重试"
                disabled={busy || !state}
                onClick={() => toggle("retryFallback", !retryOn)}
              />
            </div>
          </div>

          {error ? <div className={styles.err}>{error}</div> : null}
        </div>
      </div>
    </section>
  )
}
