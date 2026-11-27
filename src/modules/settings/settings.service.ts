/**
 * 管理端设置（面板可改的运行时开关）。
 *
 * 只搬「请求路径上、且改完立刻生效」的开关：模型名装饰、报错落盘、换渠道重试。
 * 其余配置项要么是启动期才生效的，要么是安全边界，仍留在环境变量。
 *
 * ## 持久化：`<home>/settings.json`
 *
 * 复用 `fs-store.ts` 的原子写（临时文件 + rename，0600）。**文件不存在就是
 * 「用户从没动过」** —— 所以不预先落盘默认值：没动过就永远跟随代码默认值，
 * 只有用户真的点过开关才写文件。
 */

import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { readJson, writeJsonAtomic } from "../../core/fs-store.ts"

/** 设置文件名（落在本程序自己的状态目录里，不碰 `~/.dsh`）。 */
const SETTINGS_FILE = "settings.json"

export interface SettingsServiceOptions {
  home: string
}

/** 用户从没点过的键保持 undefined，读取时回退到各自的默认值。 */
interface SettingsCache {
  modelNameDecor?: boolean
  errorLog?: boolean
  retryFallback?: boolean
}

/** `/v1/models` 渠道前缀装饰的默认值：保持历史行为（一直开着）。 */
const MODEL_NAME_DECOR_DEFAULT = true
/** 网关报错落盘的默认值：开（诊断辅助，fail-open，磁盘可控）。 */
const ERROR_LOG_DEFAULT = true
/** 失败换渠道重试的默认值：关（会放大上游调用，需用户显式打开）。 */
const RETRY_FALLBACK_DEFAULT = false

/**
 * 创建设置服务。
 *
 * 内存里缓存一份，所有 getter 都是**同步**的 ——
 * 网关反代在请求路径上需要同步判断开关，不能每次 await 读文件。
 */
export function createSettingsService(options: SettingsServiceOptions) {
  const home = options.home
  const file = join(home, SETTINGS_FILE)

  /** 内存缓存：键缺失 = 用户从没动过该项（回退到代码默认值）。 */
  let cache: SettingsCache = {}

  /**
   * 读盘（启动时调一次）。文件不存在 = 用户从没动过 → 保持 cache 为空。
   * 文件坏了也当没动过（fail-open：宁可回到默认值，也不要整个服务起不来）。
   */
  async function load(): Promise<void> {
    const raw = await readJson(file)
    if (!raw || typeof raw !== "object") return
    if (typeof raw.modelNameDecor === "boolean") cache.modelNameDecor = raw.modelNameDecor
    if (typeof raw.errorLog === "boolean") cache.errorLog = raw.errorLog
    if (typeof raw.retryFallback === "boolean") cache.retryFallback = raw.retryFallback
  }

  /** 同步读装饰开关：没动过就是默认开。 */
  function modelNameDecorEnabled(): boolean {
    return cache.modelNameDecor ?? MODEL_NAME_DECOR_DEFAULT
  }

  /** 同步读报错落盘开关：没动过就是默认开。 */
  function errorLogEnabled(): boolean {
    return cache.errorLog ?? ERROR_LOG_DEFAULT
  }

  /** 同步读换渠道重试开关：没动过就是默认关。 */
  function retryFallbackEnabled(): boolean {
    return cache.retryFallback ?? RETRY_FALLBACK_DEFAULT
  }

  /** 完整当前值（含默认值）—— 落盘时用，保证改一个键不擦掉另一个。 */
  function current() {
    return {
      modelNameDecor: modelNameDecorEnabled(),
      errorLog: errorLogEnabled(),
      retryFallback: retryFallbackEnabled(),
    }
  }

  /** 改装饰开关并落盘（原子写）。返回生效后的值。 */
  async function setModelNameDecor(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { ...current(), modelNameDecor: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.modelNameDecor
  }

  /** 改报错落盘开关并落盘（原子写）。返回生效后的值。 */
  async function setErrorLog(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { ...current(), errorLog: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.errorLog
  }

  /** 改换渠道重试开关并落盘（原子写）。返回生效后的值。 */
  async function setRetryFallback(enabled: boolean): Promise<boolean> {
    await mkdir(home, { recursive: true })
    const next = { ...current(), retryFallback: enabled === true }
    await writeJsonAtomic(file, next)
    cache = next
    return next.retryFallback
  }

  /** 给管理端看的视图（含「这个值来自哪」，供界面提示）。 */
  function view() {
    return {
      modelNameDecor: modelNameDecorEnabled(),
      errorLog: errorLogEnabled(),
      retryFallback: retryFallbackEnabled(),
      /** 三个开关都没有 env，来源只有「点过面板」或「跟随默认」。 */
      sourceModelNameDecor: cache.modelNameDecor === undefined ? "default" : "panel",
      sourceErrorLog: cache.errorLog === undefined ? "default" : "panel",
      sourceRetryFallback: cache.retryFallback === undefined ? "default" : "panel",
    }
  }

  return {
    load,
    modelNameDecorEnabled,
    setModelNameDecor,
    errorLogEnabled,
    setErrorLog,
    retryFallbackEnabled,
    setRetryFallback,
    view,
    file,
  }
}
