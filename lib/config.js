/**
 * MiMo 视觉识别 —— 插件配置契约（宿主与文档共用一份常量）。
 *
 * 这里的字段就是设置页能改的全部内容：
 *   - 每个字段都必须 `.volatile()`，否则 @deepseek-ai/dsh-settings 不会把它投进表单；
 *   - `.volatile()` 的字段不能嵌套在另一个 `.volatile()` 字段内部（schemastery 会
 *     抛 ValidationError），所以本 schema 是「扁平的 volatile 字段集合」；
 *   - `apiKey` 是 `.role('secret')`：官方设置服务对外只回答「是否已配置」，
 *     字面值不会出现在 describe() 的响应里。
 *
 * 用户最关心的三项映射：
 *   模型名称  → `model`
 *   模型密钥  → `apiKey`（可选字面量）或 `apiKeyEnv` 指向的凭据（默认 MIMO_VISION_API_KEY）
 *   默认提示词 → `defaultPrompt`
 *
 * @module dsh-mimo-vision/config
 */
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名：Loader 诊断与日志里可见。 */
export const name = 'mimo-vision'

/**
 * 设置命名空间 / profile 条目 id。
 * 必须与 cordis.patch.yml 里的 `id` 完全一致，设置页才有可读写的表单。
 */
export const SETTINGS_NAMESPACE = 'mimo-vision'

/** 默认凭据引用名（写在 <DSH_HOME>/.credentials.yaml 的 refs 下）。 */
export const DEFAULT_API_KEY_REF = 'MIMO_VISION_API_KEY'

/** 历史版本把整份配置塞进这个 ref 的 JSON 字符串里；启动时一次性迁移后删除。 */
export const LEGACY_CONFIG_REF = 'MIMO_VISION_CONFIG'

/** 默认接口地址：按量付费与 Token 套餐使用不同地址。 */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'

/** 官方标注支持图片理解的模型；仅作为下拉/数据列表的提示，不限制输入。 */
export const SUGGESTED_MODELS = ['mimo-v2.5-pro', 'mimo-v2.5']

/** 默认提示词：发送时未写提示词的情况下用它描述图片。 */
export const DEFAULT_PROMPT = '请详细描述这张图片的内容，包括主体、场景、细节、文字信息等。'

/** 上传图片的硬上限（超过直接报错，不静默截断）。 */
export const IMAGE_LIMITS = Object.freeze({
  /** 单张图片解码后的字节上限。 */
  maxImageBytes: 12 * 1024 * 1024,
  /** 一条消息里所有图片的字节总上限。 */
  maxTotalBytes: 40 * 1024 * 1024,
  /** 一条消息最多几张图。 */
  maxCount: 16,
  /** `prepare` 请求体上限（base64 膨胀约 4/3，留出余量）。 */
  maxRequestBytes: 48 * 1024 * 1024,
})

/** 浏览器端接受的图片 MIME（与 @deepseek-ai/dsh-client-ui-conversation 一致）。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 暂存图片在宿主侧的存活时间；超过即丢弃（客户端没发、或发送失败）。 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** 插件 Config：设置页表单的唯一数据源。 */
export const Config = z.object({
  /** 凭据引用名：设置页「模型密钥」写入的地址，可改成 XIAOMI_API_KEY 复用已有密钥。 */
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_REF).volatile(),
  /** 可选的字面量密钥；一般留空，改用凭据引用。 */
  apiKey: z.string().role('secret').volatile(),
  /** 接口地址（含 /v1）。 */
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  /** 模型名称：自由文本，测试连接后可点选实际可用 id。 */
  model: z.string().default(SUGGESTED_MODELS[0]).volatile(),
  /** 最大输出 token。 */
  maxTokens: z.natural().min(64).max(65536).default(2048).volatile(),
  /** 采样温度。 */
  temperature: z.number().min(0).max(2).default(0.3).volatile(),
  /** 默认提示词。 */
  defaultPrompt: z.string().default(DEFAULT_PROMPT).volatile(),
  /** 系统提示词；留空用内置的 MiMo 图片分析人格。 */
  systemPrompt: z.string().default('').volatile(),
  /** 发送带图消息时是否自动用 MiMo 识别并注入上下文。 */
  autoConvertImages: z.boolean().default(true).volatile(),
})

/**
 * 取出一个 Config 字段的实际值。
 *
 * Loader 传进 apply 的 config 里，`.volatile()` 字段是「引用对象」
 * （形如 `{ get(): T }`，值由 Loader 在热重载时整体替换），普通字段就是裸值。
 * 官方提供方同样按 `config.apiKey.get()` 逐个取值，这里统一处理，
 * 让下游（归一化、HTTP 面、pre-step）只面对普通对象。
 *
 * @param {unknown} value - 字段值或引用。
 * @returns {unknown} 实际值。
 */
export function readConfigField(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * 归一化一份配置。
 *
 * 传入的既可以是 Loader 的 Config（volatile 字段是引用），也可以是普通对象
 * （测试、迁移、脚本）——两种形态都能吃。
 *
 * @param {object | undefined | null} raw - 插件 Config 值。
 * @returns {{apiKeyEnv: string, apiKey: string, baseUrl: string, model: string, maxTokens: number, temperature: number, defaultPrompt: string, systemPrompt: string, autoConvertImages: boolean}}
 */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  const value = {
    apiKeyEnv: readConfigField(source.apiKeyEnv),
    apiKey: readConfigField(source.apiKey),
    baseUrl: readConfigField(source.baseUrl),
    model: readConfigField(source.model),
    maxTokens: readConfigField(source.maxTokens),
    temperature: readConfigField(source.temperature),
    defaultPrompt: readConfigField(source.defaultPrompt),
    systemPrompt: readConfigField(source.systemPrompt),
    autoConvertImages: readConfigField(source.autoConvertImages),
  }
  return {
    apiKeyEnv: typeof value.apiKeyEnv === 'string' && value.apiKeyEnv.trim() ? value.apiKeyEnv.trim() : DEFAULT_API_KEY_REF,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    baseUrl: (typeof value.baseUrl === 'string' && value.baseUrl.trim() ? value.baseUrl.trim() : DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : SUGGESTED_MODELS[0],
    maxTokens: Number.isFinite(value.maxTokens) ? Math.max(64, Math.min(65536, Math.trunc(value.maxTokens))) : 2048,
    temperature: Number.isFinite(value.temperature) ? Math.max(0, Math.min(2, value.temperature)) : 0.3,
    defaultPrompt: typeof value.defaultPrompt === 'string' ? value.defaultPrompt : DEFAULT_PROMPT,
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : '',
    autoConvertImages: value.autoConvertImages !== false,
  }
}
