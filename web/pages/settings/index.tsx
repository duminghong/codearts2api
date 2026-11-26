/**
 * 设置视图 —— 面板上可改的运行时开关。
 *
 * 两个开关：「会话开头提示」与「/v1/models 渠道前缀装饰」—— 都在**请求路径上**、
 * 改完**立刻生效**（不必重启），所以适合搬进面板。端口 / 鉴权 / 密钥那类是启动期
 * 配置或安全边界，仍留在环境变量。
 *
 * 语义：**面板为准**。`SESSION_HINT` 环境变量只提供「用户从没动过面板时」的初始默认值；
 * 一旦点过开关，就以面板的值为准（落盘在 `<home>/settings.json`）。
 */
import { useEffect, useState } from "react"

import {
  getSettings,
  setErrorLog,
  setModelNameDecor,
  setRetryFallback,
  setSessionEndHint,
  setSessionHint,
  type SettingsState,
} from "../../api/settings"
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

  async function toggle(
    key: "sessionHint" | "sessionEndHint" | "modelNameDecor" | "errorLog" | "retryFallback",
    next: boolean,
  ) {
    setBusy(true)
    setError(null)
    // 先乐观更新，失败再回滚 —— 开关的往返延迟要短到「感觉是即时的」。
    const prev = state
    setState((s) => (s ? { ...s, [key]: next } : s))
    try {
      if (key === "sessionHint") {
        const out = await setSessionHint(next)
        setState((s) => (s ? { ...s, sessionHint: out.sessionHint } : s))
      } else if (key === "sessionEndHint") {
        const out = await setSessionEndHint(next)
        setState((s) => (s ? { ...s, sessionEndHint: out.sessionEndHint } : s))
      } else if (key === "errorLog") {
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

  const on = state?.sessionHint === true
  const endOn = state?.sessionEndHint === true
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
                <div className={styles.rowTitle}>会话开头提示</div>
                <div className={styles.rowDesc}>
                  在每次会话的<strong>首轮</strong>
                  助手回复正文开头，显示一条提示，报告渠道剩余积分，方便你判断还能不能用（给用户看，不发给模型）。
                  首轮判定用的是「没有 assistant 消息」这个保守启发式；提示只出现一次，不会重复打扰。
                  <code>[网关提示] 渠道剩余积分：16608。</code>
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
                onClick={() => toggle("sessionHint", !on)}
              />
            </div>

            <div className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>会话结尾提示</div>
                <div className={styles.rowDesc}>
                  在每次助手回复正文<strong>末尾</strong>
                  追加一条提示，显示本次实际命中的模型与 token
                  用量，方便你核对用了啥、花了多少（给用户看，不发给模型）。 token 用量取自上游返回的
                  usage；取不到时不显示这条提示。
                  <code>[网关提示] 当前模型：trae/glm-5.1 · 本次 token 用量：100（输入 60 / 输出 40）。</code>
                </div>
                <div className={styles.rowMeta}>
                  {state ? (
                    state.sourceEndHint === "panel" ? (
                      <>
                        当前值来自<strong>面板设置</strong>（已覆盖环境变量）
                      </>
                    ) : (
                      <>
                        当前值来自环境变量 <code>SESSION_END_HINT</code> 的初始默认值
                        {state.envDefaultEndHint ? "（已开启）" : "（未开启）"}
                      </>
                    )
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className={styles.sw}
                role="switch"
                aria-checked={endOn ? "true" : "false"}
                aria-label="会话结尾提示"
                disabled={busy || !state}
                onClick={() => toggle("sessionEndHint", !endOn)}
              />
            </div>

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
