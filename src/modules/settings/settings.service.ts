/**
 * 管理端设置（面板可改的运行时开关）。
 *
 * ## 为什么只有 SESSION_HINT
 *
 * 其余配置项要么是**启动期**才生效的（端口、鉴权、密钥），要么是**安全边界**
 * （`CODEARTS2API_ADMIN_AUTH`）。把它们做成界面开关只会制造「点了要重启」或
 * 「误点即裸奔」的错觉 —— 所以只搬「请求路径上、且改完立刻生效」的那一个。
 *
 * ## env 与面板的优先级：**面板为准**
 *
 * `SESSION_HINT=1` 只提供**初始默认值**：
 *
 * - 面板还没动过（`settings.json` 不存在）→ 用 env 的值，且**每次启动重读 env**；
 * - 用户在面板点过一次（`settings.json` 存在）→ 以面板为准，env 不再干扰。
 *
 * 为什么不是「env 强制优先」：那个语义下改了 env 必须重启才能改回来，与
 * 「点一下就生效」的诉求直接冲突。
 *
 * ## 持久化：`<home>/settings.json`
 *
 * 复用 `fs-store.ts` 的原子写（临时文件 + rename，0600）。**文件不存在就是
 * 「用户从没动过」** —— 所以不预先落盘 env 的值：没动过就永远跟随 env，
 * 只有用户真的点过开关才写文件。
 */

import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { readJson, writeJsonAtomic } from "../../core/fs-store.ts"

/** 设置文件名（落在本程序自己的状态目录里，不碰 `~/.dsh`）。 */
const SETTINGS_FILE = "settings.json"

export interface SettingsServiceOptions {
  home: string
  /** env 解析出的初始默认值（`SESSION_HINT`）。仅在用户**从未**动过面板时生效。 */
  envDefault?: boolean
}

/**
 * 创建设置服务。
 *
 * 内存里缓存一份，`sessionHintEnabled()` 是**同步**的 —— 网关反代在请求路径上
 * 需要同步判断开关（见 gateway.controller.ts），不能每次 await 读文件。
 */
export function createSettingsService(options: SettingsServiceOptions) {
  const home = options.home
  const file = join(home, SETTINGS_FILE)
  const envDefault = options.envDefault === true

  /** 内存缓存：`undefined` = 用户从没动过面板（此时用 env 默认值）。 */
  let cache: { sessionHint: boolean } | undefined

  /**
   * 读盘（启动时调一次）。文件不存在 = 用户从没动过 → 保持 cache 为 undefined。
   * 文件坏了也当没动过（fail-open：宁可回到 env 默认值，也不要整个服务起不来）。
   */
  async function load(): Promise<void> {
    const raw = await readJson(file)
    if (!raw || typeof raw !== "object") return
    cache = { sessionHint: raw.sessionHint === true }
  }

  /** 同步读当前生效值：面板值优先，没动过面板就用 env 默认值。 */
  function sessionHintEnabled(): boolean {
    return cache?.sessionHint ?? envDefault
  }

  /** 改开关并落盘（原子写）。返回生效后的值。 */
  async function setSessionHint(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { sessionHint: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.sessionHint
  }

  /** 给管理端看的视图（含「这个值来自哪」，供界面提示）。 */
  function view() {
    return {
      sessionHint: sessionHintEnabled(),
      /** 当前值来自面板（用户点过）还是 env 默认值。 */
      source: cache === undefined ? "env" : "panel",
      /** env 提供的默认值（供界面提示「初始默认值来自环境变量」）。 */
      envDefault,
    }
  }

  return { load, sessionHintEnabled, setSessionHint, view, file }
}
