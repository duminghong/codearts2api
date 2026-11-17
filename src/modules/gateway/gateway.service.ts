/** 网关状态与目标地址解析（服务层，供 /healthz 与 /v1 反代使用）。 */
import { JET_HUB_PATH, rpcEnvelope } from "../../core/upstream.ts"

const TARGET_TTL_MS = 5_000

/**
 * `/v1/models` 展示名装饰：渠道前缀 + 图片模态标记。
 *
 * 背景：网关目录里的展示名只有模型自身（`GLM-5.1 · x0.83`），渠道信息只存在于
 * id 前缀（`trae/glm-5.1`），能否收图只存在于 `input` 数组（`["text","image"]`）。
 * 而 DSH「获取可用模型」把条目的 `name` 直接当显示名，并且**只读
 * id/name/contextWindow/maxTokens 四个字段** —— `input` 会被丢掉，界面拿不到。
 * 于是用户在模型选择器里既分不清渠道，也看不出谁支持贴图。这里在反代出口把
 * `name` 改成 `[TRAE] 🖼️ Seed-Code · x0.12→x0.06`，原始名保留进 `display_name`。
 *
 * ⚠️ 只改 `name` 不改 `id`：id 是请求体里要回填的 wire 值，动了就全断。
 * ⚠️ 只覆盖走本反代（:8080/v1）的客户端；直连插件网关（:8326）的拿不到装饰。
 * ⚠️ 标记用 emoji 而不是自绘图标：DSH 的模型名是纯文本，塞不进 SVG。
 */
const PROVIDER_NAME_LABELS: Record<string, string> = {
  codearts: "CodeArts",
  buddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
  lobsterai: "LobsterAI",
  qoder: "Qoder",
  qodercn: "QoderCN",
  trae: "TRAE",
  cline: "Cline",
  loomy: "Loomy",
  raccoon: "Raccoon",
  minimax: "MiniMax",
  minimaxintl: "MiniMaxIntl",
  gemini: "Gemini",
  officeace: "OfficeAce",
  accio: "Accio",
  astudio: "AStudio",
  autoclaw: "AutoClaw",
  autoclawintl: "AutoClawIntl",
  qiniu: "Qiniu",
  codely: "Codely",
  magicrew: "MagicRew",
  magicrewintl: "MagicRewIntl",
  aggregate: "聚合",
  "jet-hub-auto": "Auto",
  modelscope: "ModelScope",
  opencode: "OpenCode",
  monkeycode: "MonkeyCode",
  monkeycodeintl: "MonkeyCodeIntl",
  baizhi: "Baizhi",
  zcode: "ZCode",
}

/** 渠道 id → 展示标签；表里没有就首字母大写兜底，保证永远有可读前缀。 */
function providerNameLabel(prov: string) {
  if (!prov) return ""
  const known = PROVIDER_NAME_LABELS[prov]
  if (known) return known
  return prov.charAt(0).toUpperCase() + prov.slice(1)
}

/**
 * 支持图片输入的模型，插在渠道前缀之后的标记。
 *
 * 位置选「前缀后、名字前」而不是末尾：宿主里模型行这类单行标签一律带
 * `text-overflow:ellipsis`，长名字从**右侧**截断 —— 标记放末尾时，恰恰是最长、
 * 最需要一眼看出模态的名字最先丢掉图标。放左侧则永远可见。
 */
const IMAGE_MODALITY_MARK = "\u{1F5BC}\uFE0F"

/**
 * 就地装饰 `{ data: [...] }` 形态的模型列表：
 *
 * ```
 * Seed-Code · x0.12→x0.06   →   [TRAE] 🖼️ Seed-Code · x0.12→x0.06
 * GLM-5.0 · x0.80           →   [CodeBuddy] GLM-5.0 · x0.80        （纯文本不加图标）
 * ```
 *
 * 渠道取自 id 前缀，能否收图取自 `input` 数组。原始名保留在 `display_name`，
 * 因此**天然幂等**：重复执行都从原始名重建，不会叠出 `[[TRAE]]` 或两个图标。
 * 无 data 数组原样返回。
 */
export function decorateModelsWithProvider(payload: any) {
  const data = Array.isArray(payload?.data) ? payload.data : null
  if (!data) return payload
  for (const item of data) {
    if (!item || typeof item !== "object") continue
    const id = typeof item.id === "string" ? item.id : ""
    const slash = id.indexOf("/")
    if (slash <= 0) continue
    const label = providerNameLabel(id.slice(0, slash))
    if (!label) continue
    // 原始名：装饰过的条目读回 display_name，这是幂等的根据。
    const raw =
      (typeof item.display_name === "string" && item.display_name) || (typeof item.name === "string" && item.name) || id
    const supportsImage = Array.isArray(item.input) && item.input.includes("image")
    item.name = `[${label}]${supportsImage ? ` ${IMAGE_MODALITY_MARK}` : ""} ${raw}`
    item.display_name = raw
  }
  return payload
}

/** 装饰 /v1/models 响应时接受缓冲的上限（模型列表通常 <100KB，留足余量）。 */
export const MODEL_DECOR_LIMIT = 8 * 1024 * 1024

/** 读网关状态；失败返回 null。 */
export async function readGatewayState(host: any) {
  try {
    const route = host.routes.get(JET_HUB_PATH)
    if (route === undefined) return null
    const web = await route.fetch(
      new Request(`http://127.0.0.1${JET_HUB_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpcEnvelope("gateway.getEnabled", {}, "healthz")),
      }),
    )
    const parsed = await web.json()
    const value = parsed?.result?.value
    if (value === undefined) return null
    return {
      enabled: value.enabled,
      running: value.running,
      blockedByEnv: value.blockedByEnv,
      address: value.address,
      modelsSource: value.modelsSource,
      modelCount: Array.isArray(value.models) ? value.models.length : 0,
    }
  } catch {
    return null
  }
}

/** 已注册的 llm provider id（读不到就空数组）。 */
export function providerIds(host: any) {
  try {
    const llm = host.ctx.get("llm")
    const listed = llm?.listProviders?.()
    return Array.isArray(listed) ? listed.map((entry: any) => entry.id) : []
  } catch {
    return []
  }
}

/** 网关目标地址（优先取上游实际监听地址，其次 DSH_OPENAI_GATEWAY_PORT/8326），带 5s 缓存。 */
export function createGatewayTargetResolver({ host }: { host: any }) {
  let cache: { at: number; host?: string; port?: number } = { at: 0 }
  return async function resolveGatewayTarget() {
    if (Date.now() - cache.at < TARGET_TTL_MS) return cache
    let resolved: { host: string; port: number }
    const state = await readGatewayState(host).catch(() => null)
    if (state?.address?.port !== undefined) {
      resolved = { host: state.address.host, port: state.address.port }
    } else {
      const raw = process.env.DSH_OPENAI_GATEWAY_PORT
      const port = raw === undefined || raw.trim() === "" ? 8326 : Number.parseInt(raw, 10)
      resolved = { host: "127.0.0.1", port: Number.isInteger(port) ? port : 8326 }
    }
    cache = { at: Date.now(), ...resolved }
    return cache
  }
}
