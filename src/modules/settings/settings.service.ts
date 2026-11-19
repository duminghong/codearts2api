/**
 * 管理端设置（面板可改的运行时开关）。
 *
 * ## 为什么只有这两个开关
 *
 * 其余配置项要么是**启动期**才生效的（端口、鉴权、密钥），要么是**安全边界**
 * （`CODEARTS2API_ADMIN_AUTH`）。把它们做成界面开关只会制造「点了要重启」或
 * 「误点即裸奔」的错觉 —— 所以只搬「请求路径上、且改完立刻生效」的那几个：
 * `sessionHint`（会话开头提示）与 `modelNameDecor`（/v1/models 渠道前缀装饰）。
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
 * `modelNameDecor` 没有 env 变量，默认值直接写在代码里（开），保持历史行为。
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
  /** env 解析出的结尾提示初始默认值（`SESSION_END_HINT`）。 */
  envDefaultEndHint?: boolean
}

/** 用户从没点过的键保持 undefined，读取时回退到各自的默认值。 */
interface SettingsCache {
  sessionHint?: boolean
  sessionEndHint?: boolean
  modelNameDecor?: boolean
}

/** `/v1/models` 渠道前缀装饰的默认值：保持历史行为（一直开着）。 */
const MODEL_NAME_DECOR_DEFAULT = true

/**
 * 创建设置服务。
 *
 * 内存里缓存一份，`sessionHintEnabled()` / `modelNameDecorEnabled()` 是**同步**的 ——
 * 网关反代在请求路径上需要同步判断开关（见 gateway.controller.ts），不能每次 await 读文件。
 */
export function createSettingsService(options: SettingsServiceOptions) {
  const home = options.home
  const file = join(home, SETTINGS_FILE)
  const envDefault = options.envDefault === true
  const envDefaultEndHint = options.envDefaultEndHint === true

  /** 内存缓存：键缺失 = 用户从没动过该项（sessionHint 用 env 默认值，装饰用代码默认值）。 */
  let cache: SettingsCache = {}

  /**
   * 读盘（启动时调一次）。文件不存在 = 用户从没动过 → 保持 cache 为空。
   * 文件坏了也当没动过（fail-open：宁可回到默认值，也不要整个服务起不来）。
   * 按**键**读取：旧 settings.json 只有 sessionHint，缺的键回退默认，不误判成「动过」。
   */
  async function load(): Promise<void> {
    const raw = await readJson(file)
    if (!raw || typeof raw !== "object") return
    if (typeof raw.sessionHint === "boolean") cache.sessionHint = raw.sessionHint
    if (typeof raw.sessionEndHint === "boolean") cache.sessionEndHint = raw.sessionEndHint
    if (typeof raw.modelNameDecor === "boolean") cache.modelNameDecor = raw.modelNameDecor
  }

  /** 同步读当前生效值：面板值优先，没动过面板就用 env 默认值。 */
  function sessionHintEnabled(): boolean {
    return cache.sessionHint ?? envDefault
  }

  /** 同步读结尾提示开关：面板值优先，没动过面板就用 env 默认值。 */
  function sessionEndHintEnabled(): boolean {
    return cache.sessionEndHint ?? envDefaultEndHint
  }

  /** 同步读装饰开关：面板值优先，没动过就是默认开。 */
  function modelNameDecorEnabled(): boolean {
    return cache.modelNameDecor ?? MODEL_NAME_DECOR_DEFAULT
  }

  /** 完整当前值（含默认值）—— 落盘时用，保证改一个键不擦掉另一个。 */
  function current() {
    return {
      sessionHint: sessionHintEnabled(),
      sessionEndHint: sessionEndHintEnabled(),
      modelNameDecor: modelNameDecorEnabled(),
    }
  }

  /** 改开关并落盘（原子写）。返回生效后的值。 */
  async function setSessionHint(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { ...current(), sessionHint: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.sessionHint
  }

  /** 改结尾提示开关并落盘（原子写）。返回生效后的值。 */
  async function setSessionEndHint(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { ...current(), sessionEndHint: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.sessionEndHint
  }

  /** 改装饰开关并落盘（原子写）。返回生效后的值。 */
  async function setModelNameDecor(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { ...current(), modelNameDecor: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.modelNameDecor
  }

  /** 给管理端看的视图（含「这个值来自哪」，供界面提示）。 */
  function view() {
    return {
      sessionHint: sessionHintEnabled(),
      sessionEndHint: sessionEndHintEnabled(),
      modelNameDecor: modelNameDecorEnabled(),
      /** sessionHint 当前值来自面板（用户点过）还是 env 默认值。 */
      source: cache.sessionHint === undefined ? "env" : "panel",
      /** 结尾提示的值来源（独立于开头提示）。 */
      sourceEndHint: cache.sessionEndHint === undefined ? "env" : "panel",
      /** env 提供的默认值（供界面提示「初始默认值来自环境变量」）。 */
      envDefault,
      envDefaultEndHint,
    }
  }

  return {
    load,
    sessionHintEnabled,
    setSessionHint,
    sessionEndHintEnabled,
    setSessionEndHint,
    modelNameDecorEnabled,
    setModelNameDecor,
    view,
    file,
  }
}
