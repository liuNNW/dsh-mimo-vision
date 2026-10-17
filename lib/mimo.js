/**
 * MiMo HTTP 客户端（宿主进程内直接 fetch，无子进程、不依赖内核包）。
 *
 * 鉴权：小米开放平台同时接受 `Authorization: Bearer <key>` 与 `api-key: <key>`，
 * 两个都带上，按量付费（sk-）与 Token 套餐（tp-）都能用。
 *
 * @module dsh-mimo-vision/mimo
 */

/** 单次请求的超时（毫秒）。图片理解可能较慢。 */
const REQUEST_TIMEOUT_MS = 180_000
/** `GET /models` 的超时。 */
const MODELS_TIMEOUT_MS = 30_000
/** 错误信息里回显响应体的长度上限。 */
const ERROR_BODY_CHARS = 500

/**
 * 抹掉可能出现在文本里的密钥片段，避免错误信息把密钥带回日志或界面。
 * @param {string} text - 任意文本。
 * @returns {string} 脱敏后的文本。
 */
export function redactSecrets(text) {
  return String(text ?? '').replace(/\b(?:sk|tp)-[A-Za-z0-9_-]{6,}/g, 'sk-***')
}

/**
 * 解析本次调用要用的密钥。
 *
 * 顺序：配置字面量 → 凭据服务（按 apiKeyEnv 引用）→ 启动环境变量同名值。
 * 凭据服务每次调用都重新解析，所以设置页刚保存的密钥下一次发送即生效。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主插件上下文。
 * @param {{apiKey?: string, apiKeyEnv?: string}} config - 归一化配置。
 * @returns {Promise<string | undefined>} 可用密钥，或 undefined。
 */
export async function resolveApiKey(ctx, config) {
  const literal = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (literal.length > 0) return literal
  const ref = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim() ? config.apiKeyEnv.trim() : ''
  if (ref.length === 0) return undefined
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      const value = resolved === undefined || resolved === null ? undefined : resolved.value
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // 凭据后端不可用时不致命：继续尝试启动环境。
    }
  }
  const envValue = optionalEnv(ref)
  return envValue
}

/**
 * 读一个环境变量。
 * @param {string} key - 变量名。
 * @returns {string | undefined} 非空值。
 */
function optionalEnv(key) {
  try {
    const value = process.env[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 造鉴权头。
 * @param {string} apiKey - 密钥。
 * @returns {Record<string, string>} 请求头。
 */
function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}`, 'api-key': apiKey }
}

/**
 * 把一次失败响应整理成一句人话加原始片段。
 * @param {string} action - 动作描述。
 * @param {Response} response - fetch 响应。
 * @param {string} body - 已读取的响应体文本。
 * @returns {string} 错误信息。
 */
function httpError(action, response, body) {
  const status = response.status
  const trimmed = redactSecrets(body).slice(0, ERROR_BODY_CHARS).trim()
  let hint = ''
  if (status === 401 || status === 403) hint = '密钥无效或没有该模型的权限，请检查「模型密钥」。'
  else if (status === 404) hint = '接口地址或模型名称不对，请检查「接口地址」与「模型名称」。'
  else if (status === 429) hint = '触发限流，稍后重试或降低调用频率。'
  else if (status >= 500) hint = 'MiMo 服务端错误，稍后重试。'
  const detail = trimmed.length > 0 ? `：${trimmed}` : ''
  return `MiMo ${action}失败（HTTP ${status}）${detail}${hint ? ` ${hint}` : ''}`
}

/**
 * 把「本机超时」与「调用方取消」合成一个信号。
 *
 * `AbortSignal.any` 对非 AbortSignal 入参会直接抛 TypeError —— 所以这里逐个甄别：
 * 只有真正是 AbortSignal 的才参与合成，其余忽略。
 *
 * @param {number} timeoutMs - 本机超时毫秒。
 * @param {AbortSignal | undefined} external - 调用方的取消信号。
 * @returns {AbortSignal} 合成信号。
 */
function composeSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!(external instanceof AbortSignal)) return timeout
  return AbortSignal.any([timeout, external])
}

/**
 * 读取接口上的模型列表。
 * @param {{apiKey: string, baseUrl: string}} options - 密钥与接口地址。
 * @returns {Promise<{ok: true, models: Array<{id: string, ownedBy?: string}>} | {ok: false, error: string}>} 结果。
 */
export async function listModels({ apiKey, baseUrl }) {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
    const body = await response.text()
    if (!response.ok) return { ok: false, error: httpError('测试连接', response, body) }
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, error: `MiMo 测试连接返回的不是 JSON：${redactSecrets(body).slice(0, ERROR_BODY_CHARS)}` }
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : []
    const models = list
      .map((item) => ({
        id: String(item?.id ?? '').trim(),
        ...(typeof item?.owned_by === 'string' && item.owned_by.length > 0 ? { ownedBy: item.owned_by } : {}),
      }))
      .filter((item) => item.id.length > 0)
    return { ok: true, models }
  } catch (error) {
    return { ok: false, error: `MiMo 测试连接失败：${redactSecrets(errorMessage(error))}` }
  }
}

/**
 * 归一化任意抛出物为文本。
 * @param {unknown} error - 抛出物。
 * @returns {string} 文本。
 */
function errorMessage(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时'
    if (error.name === 'AbortError') return '请求已取消'
    return error.message
  }
  return String(error)
}

/**
 * 调一次 MiMo 图片理解。
 *
 * `max_completion_tokens` 是当前接口的字段名；少数网关只认旧名 `max_tokens`，
 * 收到对应 400 时自动改名重试一次。
 *
 * @param {object} options - 调用参数。
 * @returns {Promise<{ok: true, description: string, model: string, usage: object | null} | {ok: false, error: string}>} 结果。
 */
export async function analyzeImage(options) {
  const { baseUrl, apiKey, model, imageUrl, prompt, systemPrompt, maxTokens = 2048, temperature = 0.3, signal } = options
  const system = typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
    ? systemPrompt.trim()
    : `你是 MiMo，是小米公司研发的 AI 智能助手，同时是专业的图片分析助手。今天是 ${currentDateText()}。你的知识截止日期是 2024 年 12 月。请仔细观察图片，根据用户要求给出准确、详细、结构化的分析。`
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : '请详细描述这张图片的内容。' },
        ],
      },
    ],
    max_completion_tokens: maxTokens,
    temperature,
    stream: false,
  }

  const send = async (payload) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(payload),
      signal: composeSignal(REQUEST_TIMEOUT_MS, signal),
    })
    const text = await response.text()
    return { response, text }
  }

  try {
    let { response, text } = await send(body)
    if (response.status === 400 && /max_completion_tokens|unknown field|unrecognized/i.test(text)) {
      const renamed = { ...body, max_tokens: body.max_completion_tokens }
      delete renamed.max_completion_tokens
      ;({ response, text } = await send(renamed))
    }
    if (!response.ok) return { ok: false, error: httpError('识别图片', response, text) }
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, error: `MiMo 返回的不是 JSON：${redactSecrets(text).slice(0, ERROR_BODY_CHARS)}` }
    }
    const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined
    const content = choice?.message?.content
    const description = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : ''
    if (description.trim().length === 0) return { ok: false, error: 'MiMo 返回了空的识别结果' }
    return {
      ok: true,
      description,
      model: typeof parsed?.model === 'string' && parsed.model.length > 0 ? parsed.model : model,
      usage: parsed?.usage ?? null,
    }
  } catch (error) {
    if (signal !== undefined && signal.aborted) throw error
    return { ok: false, error: `MiMo 识别图片失败：${redactSecrets(errorMessage(error))}` }
  }
}

/**
 * 当前日期的人读文本，用于内置系统提示词。
 * @returns {string} 例如「2026年2月14日」。
 */
function currentDateText() {
  const now = new Date()
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
}

/**
 * 把浏览器传来的图片负载解成字节数，用于体积校验。
 * @param {{mediaType?: string, data?: string}} image - 负载。
 * @returns {{mediaType: string, bytes: number} | {error: string}} 结果。
 */
export function measureBrowserImage(image) {
  const mediaType = String(image?.mediaType ?? '').trim().toLowerCase()
  const data = String(image?.data ?? '')
  if (!/^image\/[a-z0-9.+-]+$/.test(mediaType)) return { error: `不支持的图片类型：${mediaType || '(空)'}` }
  if (data.length === 0) return { error: '图片数据为空' }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) return { error: '图片数据不是合法 base64' }
  return { mediaType, bytes: Math.floor((data.replace(/[\r\n]/g, '').length * 3) / 4) }
}
