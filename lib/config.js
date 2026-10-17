/**
 * MiMo 视觉识别 —— 配置契约（宿主半与浏览器半共用一份常量）。
 *
 * 与内核 0.2.x 的契约：
 *   - 每个可编辑字段都带 `role('volatile')` 之外的普通 schema；设置页的读取/写回
 *     走 <DSH_HOME>/.dsh-mimo-vision.json 由本插件自己拥有，不依赖内核设置服务
 *     的 volatile 机制（该机制在 0.2.x 已改名并只在 loader 内部使用）。
 *   - `apiKey` 用 `role('secret')`：任何 describe/status 响应都不会带出字面值。
 *   - 密钥本体存 <DSH_HOME>/.credentials.yaml（refs 下），配置文件只存引用名。
 *
 * @module dsh-mimo-vision/config
 */

/** 插件名 / 日志标签。 */
export const name = 'mimo-vision'

/** 配置与 HTTP 面的命名空间；同时是 profile row id。 */
export const SETTINGS_NAMESPACE = 'mimo-vision'

/** 默认凭据引用名（写在 .credentials.yaml 的 refs 下）。 */
export const DEFAULT_API_KEY_REF = 'MIMO_VISION_API_KEY'

/** 旧版把整份配置塞进这个 ref 的 JSON 字符串里；启动时一次性迁移。 */
export const LEGACY_CONFIG_REF = 'MIMO_VISION_CONFIG'

/** 默认接口地址。 */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'

/** 建议模型名（仅作提示，不限制输入）。 */
export const SUGGESTED_MODELS = ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.6-pro']

/** 默认提示词。 */
export const DEFAULT_PROMPT = '请详细描述这张图片的内容，包括主体、场景、细节、文字信息等。'

/** 图片体积上限。 */
export const IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 12 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
  maxCount: 16,
  maxRequestBytes: 48 * 1024 * 1024,
})

/** 浏览器端接受的图片 MIME。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 暂存图片存活时间。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** 配置字段默认值（单一事实来源：schema 默认、运行时回退、设置页初值都读它）。 */
export const CONFIG_DEFAULTS = Object.freeze({
  apiKeyEnv: DEFAULT_API_KEY_REF,
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  model: SUGGESTED_MODELS[0],
  maxTokens: 2048,
  temperature: 0.3,
  defaultPrompt: DEFAULT_PROMPT,
  systemPrompt: '',
  autoConvertImages: true,
})

/**
 * 设置页的字段清单，宿主与浏览器共用。
 * `kind` 决定浏览器半渲染成单行/多行/数字/开关。
 */
export const CONFIG_FIELDS = Object.freeze([
  { key: 'model', kind: 'text', label: '模型名称', hint: '如 mimo-v2.5-pro；测试连接后可点选实际可用 id。' },
  { key: 'apiKeyEnv', kind: 'text', label: '密钥引用名', hint: '密钥保存在宿主凭据文件里，这里只填引用名。' },
  { key: 'baseUrl', kind: 'text', label: '接口地址', hint: '留空使用默认地址。' },
  { key: 'maxTokens', kind: 'number', label: '最大输出 tokens', hint: '留空使用默认值 2048。' },
  { key: 'temperature', kind: 'number', label: '温度', hint: '0–2，留空使用默认值 0.3。' },
  { key: 'defaultPrompt', kind: 'multiline', label: '默认提示词', hint: '发送时未写提示词时用它让 MiMo 描述图片。' },
  { key: 'systemPrompt', kind: 'multiline', label: '系统提示词（可选）', hint: '留空使用内置的图片分析人格。' },
  { key: 'autoConvertImages', kind: 'boolean', label: '发送时自动用 MiMo 识别图片', hint: '识别结果作为上下文进入对话。' },
])

/** 允许出现在配置文件里的键（其余一律丢弃，避免脏数据扩散）。 */
const STRING_KEYS = ['apiKeyEnv', 'apiKey', 'baseUrl', 'model', 'defaultPrompt', 'systemPrompt']
const NUMBER_KEYS = ['maxTokens', 'temperature']
const BOOLEAN_KEYS = ['autoConvertImages']

/**
 * 归一化一份配置：接受任意来源（配置文件、旧版迁移、测试）并补齐默认值。
 * @param {unknown} raw - 原始配置对象。
 * @returns {typeof CONFIG_DEFAULTS & {apiKey: string}} 完整配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (key) => unwrapValue(source[key])

  const text = (key, fallback) => {
    const value = pick(key)
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  }
  const number = (key, fallback, min, max) => {
    const value = pick(key)
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.max(min, Math.min(max, numeric))
  }

  return {
    apiKeyEnv: text('apiKeyEnv', CONFIG_DEFAULTS.apiKeyEnv),
    apiKey: typeof pick('apiKey') === 'string' ? String(pick('apiKey')).trim() : '',
    baseUrl: text('baseUrl', CONFIG_DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: text('model', CONFIG_DEFAULTS.model),
    maxTokens: Math.trunc(number('maxTokens', CONFIG_DEFAULTS.maxTokens, 64, 65536)),
    temperature: number('temperature', CONFIG_DEFAULTS.temperature, 0, 2),
    defaultPrompt: typeof pick('defaultPrompt') === 'string' ? String(pick('defaultPrompt')) : CONFIG_DEFAULTS.defaultPrompt,
    systemPrompt: typeof pick('systemPrompt') === 'string' ? String(pick('systemPrompt')) : '',
    autoConvertImages: pick('autoConvertImages') !== false,
  }
}

/**
 * 只保留已知键的持久化副本（写盘用）。
 * @param {object} config - 归一化配置。
 * @returns {object} 干净对象。
 */
export function persistentConfig(config) {
  const value = normalizeConfig(config)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of [...STRING_KEYS, ...NUMBER_KEYS, ...BOOLEAN_KEYS]) out[key] = value[key]
  return out
}

/**
 * 解开可能存在的 `{ get(): T }` 引用（兼容 Loader 传入的 volatile 包装）。
 * @param {unknown} value - 字段值或引用。
 * @returns {unknown} 实际值。
 */
function unwrapValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}
