/**
 * MiMo 视觉识别 —— 浏览器半。
 *
 * 三件事：
 *
 * 1. **原生设置页**：座位同时挂在 `settings.section`（设置侧栏一页）与
 *    `plugins.item`（插件页卡片，与「网页搜索」同座位）。
 *
 *    **界面一律复用内核组件**，不自己造按钮/开关/标签：
 *      · 表单骨架 + 字段 + 密钥框：SettingsForm / SettingsValueField / SettingsSecretField
 *      · 布尔项：Switch（与「设置 → 通用 → 开发者工具」同款）
 *      · 动作按钮：Button（variant/size 与内置页一致）
 *      · 模型候选：Pill（有 onClick 时自身即 button）
 *      · 状态点：StateDot · 覆盖标记：Tag · 长解释折叠：ⓘ（IconInfoOutlineRegular）
 *    「已覆盖 / 恢复默认」由 SettingsValueField **内部**渲染，所以下面不再自己拼一套
 *    （历史版本自己拼过，样式与内置页不一致，正是「老样式」的来源）。
 *    SettingsValueField 与 SettingsSecretField 还内建 `help={{ label, content }}`
 *    （ⓘ 按钮 + region 折叠区 + aria-describedby），所以长解释走组件、不进常驻 hint。
 *
 *    只有「内核确实没有对应组件」的两处保留自建标记，但结构与指标逐项照抄官方：
 *      · 多行输入：primitives 无 textarea，自建 MimoMultilineField（同构 .field）
 *      · 布尔行  ：官方 Switch 无行布局，自建 .mimo-row（同构 DeveloperToolsRow）
 *
 *    primitives 的 CSS 是构建期哈希类名、不对外导出，因此这里只保留极少量
 *    「布局壳」CSS，且数值逐项对齐内核（字号/行高/圆角/边框粗细/token）。
 *
 *    读写走 `ctx.configForms.get('mimo-vision')` 与 `ctx.remote.credentials`，
 *    不自己造 transport —— rc.6+ 的客户端只挂载编译期生成的 Remote 清单，
 *    运行时注册的 TypertRemoteService 在浏览器侧拿不到命名空间。
 *
 * 2. **模型密钥**：只写不读。控件开始为空；留空保存即保持当前密钥（与内置
 *    「网页搜索」的 API Key 字段同一套语义）。密钥写在
 *    <DSH_HOME>/.credentials.yaml 的引用下（默认 MIMO_VISION_API_KEY），
 *    不落任何配置文件。
 *
 * 3. **发送拦截**：仅在「插件存活 + 开启自动识别 + 已配置密钥」时，把草稿里的
 *    图片经 `/mimo-vision/api/prepare` 暂存到宿主，再以「剔除图片后的附件 id」
 *    调用原始 sendSession。这一层必不可少：宿主 api-session-controller 在受理
 *    prompt 时就会按当前模型的 inputModalities 拒绝带图请求
 *    （session/attachment-invalid / MODEL_DOES_NOT_SUPPORT_IMAGES），
 *    发生在任何插件事件之前，宿主侧无法事后补救。
 *    其余任何情况一律回退原生流程，保留「当前模型不支持图片」提示。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mimo-vision',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const { createElement: h, useEffect, useState } = react
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * 缺组件时的兜底：渲染成空片段。
     *
     * primitives 的导出面随内核版本演进。这里逐个回退而不是直接解构抛错 —— 一个
     * 组件缺席不应该把整页（乃至整个客户端插件）带崩；退化为空片段后表单其余
     * 字段照常可用。
     * @param {unknown} component - 候选组件。
     * @returns {Function} 可安全当组件用的函数。
     */
    const optional = (component) => (typeof component === 'function' || typeof component === 'object' && component !== null ? component : () => null)

    const {
      Button: RawButton,
      IconInfoOutlineRegular: RawIconInfo,
      Pill: RawPill,
      SettingsForm,
      SettingsFormModel,
      SettingsSecretField,
      SettingsValueField,
      StateDot: RawStateDot,
      Switch: RawSwitch,
      Tag,
      settingsNumberField,
      settingsTextField,
    } = primitives

    const Button = optional(RawButton)
    const IconInfo = optional(RawIconInfo)
    const Pill = optional(RawPill)
    const StateDot = optional(RawStateDot)
    const Switch = optional(RawSwitch)
    /** 这些组件是否真的存在（决定退回「纯文本」还是「渲染组件」）。 */
    const hasSwitch = typeof RawSwitch === 'function'
    const hasButton = typeof RawButton === 'function'
    const hasPill = typeof RawPill === 'function'
    const hasStateDot = typeof RawStateDot === 'function'

    /**
     * 同一页面里两个座位会各建一个 controller，字段 id 必须彼此不同：
     * 否则设置弹窗打开时底层插件页仍挂载，`<label htmlFor>` 会指到错误的控件。
     * 模块级自增即可保证进程内唯一。
     */
    let instanceSeq = 0

    /** 必需服务：slots 挂座位、locale 出文案、configForms 读写表单、credentials 存密钥、timer 轮询兜底。 */
    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials', 'timer']

    /** 字典命名空间。 */
    const NS = 'settings.mimoVision'
    /** 设置命名空间 == profile 条目 id == cordis.patch.yml 里的 row id。 */
    const SETTINGS_NS = 'mimo-vision'
    /** 凭据引用名兜底值；正常由 Config.apiKeyEnv 提供。 */
    const DEFAULT_API_KEY_REF = 'MIMO_VISION_API_KEY'
    /** HTTP 面前缀，相对页面 base 解析（Electron 的 dsh-app:// 与反代子目录都能命中）。 */
    const API_PREFIX = 'mimo-vision/api'

    const zh = {
      title: 'MiMo 视觉识别',
      description: '对接小米 MiMo 模型，让 DSH 具备图片识别能力：发送带图消息时自动识别并注入上下文。',
      model: '模型名称',
      modelHint: '如 mimo-v2.5-pro；测试连接后可点选实际可用 id。',
      apiKey: '模型密钥',
      apiKeyHint: '留空表示保持当前密钥；只存部署凭据。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '未配置密钥。',
      baseUrl: '接口地址',
      baseUrlHint: '按量付费与 Token 套餐使用不同地址；留空使用默认地址。',
      maxTokens: '最大输出 tokens',
      maxTokensHint: '留空表示使用默认值 2048。',
      temperature: '温度',
      temperatureHint: '0–2，留空表示使用默认值 0.3。',
      defaultPrompt: '默认提示词',
      defaultPromptHint: '发送时未写提示词的情况下，用于让 MiMo 描述图片。',
      systemPrompt: '系统提示词（可选）',
      systemPromptHint: '留空使用内置的 MiMo 图片分析人格。',
      autoConvert: '发送时自动用 MiMo 识别图片',
      autoConvertHint: '图片交给 MiMo 识别后作为上下文进入对话。',
      autoConvertHelp: '开启后，发送带图片的消息时自动调用 MiMo 识别，识别结果作为上下文进入对话。关闭后按原生方式发送图片，界面会提示「当前模型不支持图片」。',
      autoConvertHelpLabel: '自动识别的行为说明',
      test: '测试连接',
      testing: '测试中…',
      pickModel: '点选填入模型名称：',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      switchUnavailable: '本部署的内核没有提供开关组件，无法在此切换。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      invalidNumber: '请填数字；留空表示使用默认值。',
      testOk: (count) => `已连接 · ${count} 个模型`,
      statusLine: (configured, apiKeyEnv) =>
        configured ? `密钥已配置（${apiKeyEnv}）` : `未配置密钥（将写入 ${apiKeyEnv}）`,
    }

    const en = {
      title: 'MiMo Vision',
      description: 'Image understanding through Xiaomi MiMo: images in a message are described automatically and injected into context.',
      model: 'Model',
      modelHint: 'e.g. mimo-v2.5-pro; test the connection to pick a live id.',
      apiKey: 'API key',
      apiKeyHint: 'Leave blank to keep the current key; stored in deployment credentials.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key.',
      baseUrl: 'Endpoint',
      baseUrlHint: 'Pay-as-you-go and token bundles use different endpoints. Leave blank for the default.',
      maxTokens: 'Max output tokens',
      maxTokensHint: 'Leave blank to use the default (2048).',
      temperature: 'Temperature',
      temperatureHint: '0–2. Leave blank to use the default (0.3).',
      defaultPrompt: 'Default prompt',
      defaultPromptHint: 'Used to describe an image when the message carries no prompt.',
      systemPrompt: 'System prompt (optional)',
      systemPromptHint: 'Leave blank to use the built-in MiMo image-analysis persona.',
      autoConvert: 'Recognize images with MiMo on send',
      autoConvertHint: 'Images are described by MiMo and enter the conversation as context.',
      autoConvertHelp: 'When on, images in an outgoing message are recognized by MiMo and the result enters the conversation as context. When off, images are sent the native way and the "model does not support images" notice stays.',
      autoConvertHelpLabel: 'How automatic recognition behaves',
      test: 'Test connection',
      testing: 'Testing…',
      pickModel: 'Pick a model id to fill: ',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      switchUnavailable: 'This kernel ships no switch control, so the toggle cannot be changed here.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      testOk: (count) => `Connected · ${count} model(s)`,
      statusLine: (configured, apiKeyEnv) =>
        configured ? `Key configured (${apiKeyEnv})` : `No key yet (writes ${apiKeyEnv})`,
    }

    /** 布尔字段的转换 spec（与 settingsTextField / settingsNumberField 同构）。 */
    const settingsBooleanField = (field) => ({
      field,
      format: (value) => (value !== false ? 'true' : 'false'),
      parse: (text) => ({ kind: 'set', value: text === 'true' }),
    })

    /** 表单框架需要的文案。 */
    const formLabels = (t) => ({
      unavailable: t('unavailable'),
      readOnly: t('readOnly'),
      saveFailed: t('saveFailed'),
      save: t('save'),
      saving: t('saving'),
    })

    /**
     * 往宿主 HTTP 面发一次 POST。
     * 用页面 base 解析相对地址：Electron 里页面是 dsh-app://app/，壳会把非静态路径
     * 转发给 Host；反向代理挂在子目录时相对地址也不会跑出前缀。
     * @param {string} method - API 方法名。
     * @param {object} [payload] - 请求体。
     * @returns {Promise<object>} 宿主回答（永远带 ok 字段）。
     */
    async function post(method, payload) {
      try {
        const url = new URL(`${API_PREFIX}/${method}`, document.baseURI).href
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const parsed = await response.json()
        return parsed !== null && typeof parsed === 'object' ? parsed : { ok: false, error: 'MiMo 宿主返回格式异常' }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }

    /**
     * 从表单快照里取当前要用的凭据引用名。
     * @param {object} snapshot - 表单快照。
     * @returns {string} 引用名。
     */
    function refOf(snapshot) {
      const declared = snapshot && snapshot.value ? snapshot.value.apiKeyEnv : undefined
      return typeof declared === 'string' && declared.trim().length > 0 ? declared.trim() : DEFAULT_API_KEY_REF
    }

    /**
     * 设置页控制器：把 configForms 的共享表单、凭据域、「测试连接」绑成一处。
     * 两个座位各建一个实例，彼此独立、行为一致。
     * @param {object} ctx - 浏览器插件上下文。
     * @param {(key: string, params?: object) => string} t - 该字典的取词函数。
     * @returns {object} 控制器。
     */
    function createController(ctx, t) {
      const scope = ctx.configForms.get(SETTINGS_NS)
      instanceSeq += 1
      /** 本实例的 DOM id 前缀：两个座位各一份表单，id 必须不重叠。 */
      const idPrefix = `plugin-config-mimo-${instanceSeq}`
      const form = new SettingsFormModel(
        scope,
        [
          settingsTextField('model'),
          settingsTextField('baseUrl'),
          settingsNumberField('maxTokens'),
          settingsNumberField('temperature'),
          settingsTextField('defaultPrompt'),
          settingsTextField('systemPrompt'),
          settingsBooleanField('autoConvertImages'),
        ],
        [{
          field: 'apiKey',
          write: (text) => ctx.remote.credentials.set(refOf(scope.getSnapshot()), text),
        }],
      )

      /** 表单之外的页面态：密钥是否已配置、测试结果、提示行。 */
      const extra = { configured: false, writable: true, apiKeyEnv: DEFAULT_API_KEY_REF, source: undefined, note: { kind: '', text: '' }, models: [], testing: false }

      const projection = () => ({
        ...form.shell(),
        model: form.field('model'),
        baseUrl: form.field('baseUrl'),
        maxTokens: form.field('maxTokens'),
        temperature: form.field('temperature'),
        defaultPrompt: form.field('defaultPrompt'),
        systemPrompt: form.field('systemPrompt'),
        autoConvertImages: form.field('autoConvertImages'),
        apiKey: form.field('apiKey'),
        apiKeyConfigured: extra.configured,
        apiKeyWritable: extra.writable,
        apiKeyEnv: extra.apiKeyEnv,
        apiKeySource: extra.source,
        note: extra.note,
        testModels: extra.models,
        testing: extra.testing,
      })

      // form.bind 会订阅 scope 与本地草稿：范围值或草稿一动，投影就重发。
      const store = form.bind(projection)
      const publish = () => store.set(projection())

      /** 问一次凭据域：密钥是否已配置、能不能写。 */
      const readCredential = async () => {
        const ref = refOf(scope.getSnapshot())
        let view = undefined
        try {
          const response = await ctx.remote.credentials.describe([ref])
          if (response && response.ok) view = response.value ? response.value[ref] : undefined
        } catch {
          view = undefined
        }
        const next = {
          configured: Boolean(view && view.configured === true),
          writable: !(view && view.writable === false),
          apiKeyEnv: ref,
          source: view ? view.source : undefined,
        }
        if (
          next.configured === extra.configured
          && next.writable === extra.writable
          && next.apiKeyEnv === extra.apiKeyEnv
          && next.source === extra.source
        ) return
        Object.assign(extra, next)
        publish()
      }

      /** 顺带问一次宿主状态（拿到权威的 apiKeyEnv），再读凭据。 */
      const readStatus = async () => {
        const status = await post('status')
        if (status.ok === true && typeof status.apiKeyEnv === 'string' && status.apiKeyEnv.trim().length > 0) {
          extra.apiKeyEnv = status.apiKeyEnv.trim()
        }
        await readCredential()
      }

      const test = async () => {
        extra.testing = true
        extra.note = { kind: '', text: t('testing') }
        publish()
        const result = await post('test')
        extra.testing = false
        if (result.ok === true) {
          extra.models = Array.isArray(result.models) ? result.models.filter((item) => item && typeof item.id === 'string') : []
          extra.note = { kind: 'ok', text: t('testOk')(extra.models.length) }
        } else {
          extra.models = []
          extra.note = { kind: 'error', text: String(result.error || 'unknown error') }
        }
        publish()
      }

      return {
        scope,
        form,
        store,
        idPrefix,
        readStatus,
        refreshCredential(ref) {
          if (ref !== refOf(scope.getSnapshot())) return
          readCredential()
        },
        test,
        /** 两个座位共用的一组注入面。 */
        injected() {
          return {
            hooks: { form: store },
            /** 本实例的字段 id 前缀 —— 必须进注入面，否则两个座位会生成同名 id。 */
            idPrefix,
            edit: (field, text) => form.actions().edit(field, text),
            resetField: (field) => form.actions().resetField(field),
            save: () => form.actions().save(),
            discard: () => form.actions().discard(),
            test: () => test(),
            pickModel: (id) => form.actions().edit('model', id),
            readStatus: () => readStatus(),
          }
        },
        dispose() {
          form.dispose()
        },
      }
    }

    /**
     * 字段行外壳：与内核 settings-form 的字段结构逐项同构
     * （`head > label(+badges+reset)` → 控件 → `hint`）。
     *
     * 只给「内核没有对应组件」的字段用（多行输入、布尔行）。能用
     * SettingsValueField / SettingsSecretField 的一律用官方的 ——
     * 那两个组件内部已经处理了「已覆盖 + 恢复默认」与 aria 关联。
     *
     * @param {object} props - 字段信息。
     * @param {string} props.htmlFor - 控件 id。
     * @param {string} props.label - 字段名。
     * @param {string} [props.hint] - 字段说明。
     * @param {object} [props.help] - 官方 ⓘ 折叠区：`{ label, content }`。
     * @param {boolean} [props.overridden] - 用户层是否覆盖了该字段。
     * @param {string} props.overriddenLabel - 「已覆盖」文案。
     * @param {string} props.resetLabel - 「恢复默认」文案。
     * @param {boolean} props.disabled - 是否只读。
     * @param {Function} [props.onReset] - 恢复默认动作。
     * @param {object} [props.control] - 控件本体。
     * @returns {object} 字段元素。
     */
    function fieldShell(props) {
      const [helpOpen, setHelpOpen] = useState(false)
      const helpId = `${props.htmlFor}-help`
      const help = props.help
      return h('div', { className: 'mimo-field', key: props.fieldKey },
        h('div', { className: 'mimo-head' },
          h('div', { className: 'mimo-labelGroup' },
            h('label', { className: 'mimo-label', htmlFor: props.htmlFor }, props.label),
            help !== undefined
              ? h('button', {
                type: 'button',
                className: 'mimo-helpButton',
                'aria-label': help.label,
                'aria-expanded': helpOpen,
                'aria-controls': helpId,
                onClick: () => setHelpOpen(!helpOpen),
              }, h(IconInfo, { size: 12 }))
              : null),
          props.overridden === true
            ? h('span', { className: 'mimo-badges' },
              h(Tag, { tone: 'neutral' }, props.overriddenLabel),
              h('button', {
                type: 'button',
                className: 'mimo-reset',
                disabled: props.disabled,
                onClick: props.onReset,
              }, props.resetLabel))
            : null),
        props.control,
        props.hint ? h('p', { className: 'mimo-hint' }, props.hint) : null,
        help !== undefined && helpOpen
          ? h('div', {
            id: helpId,
            className: 'mimo-help',
            role: 'region',
            'aria-label': help.label,
          }, help.content)
          : null)
    }

    /**
     * 多行文本字段。
     *
     * primitives 里没有 textarea 组件（内核各处都是各自手写），所以这一处是新标记；
     * 但暂存/校验/清除仍走官方的 settingsTextField spec，只在「渲染」上换成多行。
     * 样式指标照抄官方 `.input`：0.5px 边框、radius-md、bg-layer-3、13px/1.5。
     *
     * @param {object} props - 字段 props。
     * @returns {object} 字段元素。
     */
    function multilineField(props) {
      const { state, idPrefix, field, label, hint, help, disabled, overriddenLabel, resetLabel } = props
      const id = `${idPrefix}-${field}`
      const current = state[field]
      return fieldShell({
        fieldKey: field,
        htmlFor: id,
        label,
        hint,
        help,
        overridden: current.overridden,
        overriddenLabel,
        resetLabel,
        disabled,
        onReset: () => props.onReset(field),
        control: h('textarea', {
          id,
          className: 'mimo-input mimo-textarea',
          rows: 3,
          value: current.text,
          disabled,
          spellCheck: false,
          onChange: (event) => props.onEdit(field, event.target.value),
        }),
      })
    }

    /**
     * 布尔行：左边标题 + 一句话说明，右边 Switch。
     * 布局照内核 `DeveloperToolsRow` 的真实 CSS：
     *   `.row { border-bottom:0.5px solid border-l2; justify-content:space-between;
     *           align-items:center; gap:24px; padding:16px 0; display:flex }`
     *   `.title { font-size:14px; line-height:20px }`
     *   `.description { label-secondary; margin-top:4px; font-size:12px; line-height:18px }`
     *
     * 内核没导出 Switch 时**不再退回 `input[type=checkbox]`**（那正是要清掉的
     * 「手写老控件」），改为把开关位置留空、行内给一句只读提示：字段语义（暂存、
     * 覆盖标记、恢复默认）照常，只是此处不能切换。
     *
     * @param {object} props - 字段 props。
     * @returns {object} 行元素。
     */
    function booleanRow(props) {
      const { state, idPrefix, field, label, description, help, fallbackNote, disabled, overriddenLabel, resetLabel } = props
      const [helpOpen, setHelpOpen] = useState(false)
      const current = state[field]
      const checked = current.text === 'true'
      // 与官网字段一致地带上实例前缀：两个座位同时展开帮助区也不会撞 id。
      const helpId = `${idPrefix}-${field}-help`
      const control = hasSwitch
        ? h(Switch, {
          checked,
          disabled,
          label,
          onChange: (next) => props.onEdit(field, next ? 'true' : 'false'),
        })
        : h('span', { className: 'mimo-rowFallback', role: 'status' }, fallbackNote)
      return h('div', { className: 'mimo-row', key: field },
        h('div', { className: 'mimo-rowText' },
          h('div', { className: 'mimo-rowTitle' },
            label,
            help !== undefined
              ? h('button', {
                type: 'button',
                className: 'mimo-helpButton',
                'aria-label': help.label,
                'aria-expanded': helpOpen,
                'aria-controls': helpId,
                onClick: () => setHelpOpen(!helpOpen),
              }, h(IconInfo, { size: 12 }))
              : null,
            current.overridden
              ? h('span', { className: 'mimo-badges' },
                h(Tag, { tone: 'neutral' }, overriddenLabel),
                h('button', {
                  type: 'button',
                  className: 'mimo-reset',
                  disabled,
                  onClick: () => props.onReset(field),
                }, resetLabel))
              : null),
          h('div', { className: 'mimo-rowDesc' }, description),
          help !== undefined && helpOpen
            ? h('div', {
              id: helpId,
              className: 'mimo-help',
              role: 'region',
              'aria-label': help.label,
            }, help.content)
            : null),
        control)
    }

    /**
     * 表单主体：字段顺序 = 模型名称 → 模型密钥 → 接口地址 → 最大输出 →
     * 温度 → 默认提示词 → 系统提示词 → 自动识别开关 → 测试连接。
     *
     * 「已覆盖 / 恢复默认」由 SettingsValueField 内部渲染；本函数只负责挑选组件
     * 与摆放顺序，不重复实现那套交互。
     */
    function MimoForm(props) {
      const { t } = props
      const state = props.useForm((snapshot) => snapshot)
      const disabled = !state.writable
      const overriddenLabel = t('overridden')
      const resetLabel = t('reset')
      const invalidLabel = t('invalidNumber')
      const idPrefix = props.idPrefix

      /** 官方的单行字段控件。 */
      const valueField = (field, label, hint, options) =>
        h(SettingsValueField, {
          key: field,
          id: `${idPrefix}-${field}`,
          label,
          hint,
          overriddenLabel,
          resetLabel,
          invalidLabel,
          disabled,
          ...state[field],
          onEdit: (text) => props.edit(field, text),
          onReset: () => props.resetField(field),
          ...(options || {}),
        })

      /** 多行字段（内核没有对应组件）。 */
      const textareaField = (field, label, hint, help) =>
        multilineField({
          key: field,
          state,
          idPrefix,
          field,
          label,
          hint,
          help,
          disabled,
          overriddenLabel,
          resetLabel,
          onEdit: (name, text) => props.edit(name, text),
          onReset: (name) => props.resetField(name),
        })

      const models = Array.isArray(state.testModels) ? state.testModels : []
      const note = state.note || { kind: '', text: '' }

      /** 状态行：状态点 + 一句短文本（对齐内核 statusWithDot 的呈现）。 */
      const statusLine = h('p', { key: 'status', className: 'mimo-status', role: 'status' },
        hasStateDot ? h(StateDot, { state: state.apiKeyConfigured ? 'done' : 'idle' }) : null,
        h('span', null, t('statusLine')(state.apiKeyConfigured, state.apiKeyEnv)))

      /** 模型候选：Pill（有 onClick 时组件自身就是 button）。 */
      const modelPicks = models.length > 0
        ? h('div', { key: 'models', className: 'mimo-models' },
          h('span', { className: 'mimo-modelsLabel' }, t('pickModel')),
          ...models.map((item) => (hasPill
            ? h(Pill, { key: item.id, onClick: () => props.pickModel(item.id) }, item.id)
            : h('button', {
              key: item.id,
              type: 'button',
              className: 'mimo-modelFallback',
              onClick: () => props.pickModel(item.id),
            }, item.id))))
        : null

      /** 测试连接：官方 Button（outline + sm，与内置页的次级动作一致）。 */
      const testRow = h('div', { key: 'actions', className: 'mimo-actions' },
        hasButton
          ? h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: state.testing,
            onClick: () => props.test(),
          }, state.testing ? t('testing') : t('test'))
          : h('button', {
            type: 'button',
            className: 'mimo-modelFallback',
            disabled: state.testing,
            onClick: () => props.test(),
          }, state.testing ? t('testing') : t('test')),
        note.text
          ? h('span', {
            className: note.kind === 'error' ? 'mimo-noteError' : note.kind === 'ok' ? 'mimo-noteOk' : 'mimo-note',
            role: 'status',
          }, note.text)
          : null)

      return h(SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
      }, [
        statusLine,
        valueField('model', t('model'), t('modelHint'), { placeholder: 'mimo-v2.5-pro' }),
        modelPicks,
        h(SettingsSecretField, {
          key: 'apiKey',
          id: `${idPrefix}-apiKey`,
          label: t('apiKey'),
          hint: t('apiKeyHint'),
          disabled: !state.apiKeyWritable,
          text: state.apiKey.text,
          configured: state.apiKeyConfigured,
          stateLabel: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
          onEdit: (text) => props.edit('apiKey', text),
        }),
        valueField('baseUrl', t('baseUrl'), t('baseUrlHint')),
        valueField('maxTokens', t('maxTokens'), t('maxTokensHint'), { numeric: true }),
        valueField('temperature', t('temperature'), t('temperatureHint'), { numeric: true }),
        textareaField('defaultPrompt', t('defaultPrompt'), t('defaultPromptHint')),
        textareaField('systemPrompt', t('systemPrompt'), t('systemPromptHint')),
        booleanRow({
          key: 'autoConvertImages',
          state,
          idPrefix,
          field: 'autoConvertImages',
          label: t('autoConvert'),
          description: t('autoConvertHint'),
          help: { label: t('autoConvertHelpLabel'), content: h('p', null, t('autoConvertHelp')) },
          fallbackNote: t('switchUnavailable'),
          disabled,
          overriddenLabel,
          resetLabel,
          onEdit: (name, text) => props.edit(name, text),
          onReset: (name) => props.resetField(name),
        }),
        testRow,
      ])
    }

    /**
     * `plugins.item` 座位：卡片 + 该插件的配置页。
     *
     * `view === 'summary'` 只返回一行说明 —— 这是该座位的契约：卡片列表与详情页
     * 顶部的那行摘要读的就是它。注意**不要再在这里渲染说明文字**：插件页已经
     * 渲染了 `item.label` 标题和这一行摘要（见 plugin-manager 的 ItemDetail），
     * 多渲染一次就会出现两遍同样的描述。
     */
    function MimoPluginCard(props) {
      const { t, view } = props
      props.useForm((snapshot) => snapshot)
      useEffect(() => {
        props.readStatus().catch(() => {})
      }, [])
      if (view === 'summary') return t('description')
      return h('div', { className: 'mimo-page' }, h(MimoForm, props))
    }

    /**
     * `settings.section` 座位：设置侧栏里的一整页。
     */
    function MimoSettingsSection(props) {
      const { t } = props
      useEffect(() => {
        props.readStatus().catch(() => {})
      }, [])
      return h('section', { className: 'mimo-section' },
        h('h2', { className: 'mimo-heading' }, t('title')),
        h('p', { className: 'mimo-intro' }, t('description')),
        h(MimoForm, props))
    }

    /**
     * 安装发送拦截。
     *
     * 只在「插件存活 + 开启自动识别 + 已配置密钥」时把图片交给宿主；其余情况
     * （包括任何异常）一字不改地走原始 sendSession，保证原生提示不丢。
     *
     * @param {object} ctx - 浏览器插件上下文。
     * @param {object} conversation - conversation 服务。
     * @param {object} controller - 表单控制器（读配置与密钥状态）。
     * @returns {boolean} 是否装上了。
     */
    function installSendInterception(ctx, conversation, controller) {
      if (!conversation || typeof conversation.sendSession !== 'function') return false
      if (conversation.__mimoVisionWrapped === true) return true
      const original = conversation.sendSession
      const wrapped = async function (session, text, attachmentIds, mode, signal) {
        const ids = Array.isArray(attachmentIds) ? attachmentIds : []
        if (ids.length === 0) return original.call(this, session, text, ids, mode, signal)
        try {
          const state = controller.store.getSnapshot()
          if (state.available !== true || state.apiKeyConfigured !== true) return original.call(this, session, text, ids, mode, signal)
          if (state.autoConvertImages.text === 'false') return original.call(this, session, text, ids, mode, signal)

          const attachments = typeof this.resolveDraftAttachments === 'function' ? this.resolveDraftAttachments(ids) : []
          if (attachments.length !== ids.length) return original.call(this, session, text, ids, mode, signal)

          const images = []
          const keptIds = []
          for (let index = 0; index < attachments.length; index += 1) {
            const attachment = attachments[index]
            if (attachment && attachment.kind === 'image') images.push(await this.encodeImage(attachment.file))
            else keptIds.push(ids[index])
          }
          if (images.length === 0) return original.call(this, session, text, ids, mode, signal)

          const sessionId = String((session && session.sessionId) || '')
          if (sessionId.length === 0) return original.call(this, session, text, ids, mode, signal)

          const sendText = typeof text === 'string' && text.trim().length > 0 ? text : '请识别这张图片并回复我。'
          const prepared = await post('prepare', { sessionId, images, prompt: sendText })
          if (prepared.ok !== true) return original.call(this, session, text, ids, mode, signal)

          const result = await original.call(this, session, sendText, keptIds, mode, signal)
          // 图片已由宿主消费：释放预览 URL 与草稿登记，免得 composer 又把它们画回来。
          try {
            if (typeof this.releaseDraftAttachments === 'function') {
              this.releaseDraftAttachments(attachments.filter((attachment) => attachment && attachment.kind === 'image'))
            }
          } catch {
            // 释放失败不影响本次发送
          }
          return result
        } catch {
          // 任何意外都在这里收敛：回退原生流程。
          return original.call(this, session, text, ids, mode, signal)
        }
      }
      conversation.sendSession = wrapped
      conversation.__mimoVisionWrapped = true
      ctx.effect(() => () => {
        if (conversation.sendSession === wrapped) {
          conversation.sendSession = original
          conversation.__mimoVisionWrapped = false
        }
      }, 'mimo-vision: send interception')
      return true
    }

    /** 插件入口。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mimo-vision: dictionaries')
      const t = ctx.locale.bind(NS)

      const pluginController = createController(ctx, t)
      const sectionController = createController(ctx, t)
      ctx.effect(() => () => {
        pluginController.dispose()
        sectionController.dispose()
      }, 'mimo-vision: form controllers')

      // 启动即读一次宿主状态与凭据。
      //
      // 这一步不能只交给设置页组件：发送拦截要判断「密钥是否已配置」，
      // 而用户完全可能整场会话都不打开设置页 —— 那样自动识别会一声不响地永不生效。
      // 所以由 apply 主动拉一次，并在连接重置或凭据变动时刷新。
      const refreshCredentials = () => {
        for (const controller of [pluginController, sectionController]) {
          controller.readStatus().catch(() => {})
        }
      }
      refreshCredentials()
      ctx.effect(() => ctx.on('connection/reset', refreshCredentials), 'mimo-vision: status refresh on reconnect')

      // 凭据在别处被改（例如模型页写了同一个引用）时，两处页面一起刷新。
      ctx.effect(() => ctx.remote.$on('credentials/reference-updated', (ref) => {
        pluginController.refreshCredential(ref)
        sectionController.refreshCredential(ref)
      }), 'mimo-vision: credential invalidations')

      // 座位 1：设置侧栏里的一整页。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SETTINGS_NS,
        order: 25,
        label: () => t('title'),
        locale: NS,
        inject: () => sectionController.injected(),
      }, MimoSettingsSection))

      // 座位 2：插件页卡片，与内置「网页搜索」并列；宿主不再服务该命名空间时自动消失。
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: SETTINGS_NS,
        order: 50,
        label: () => t('title'),
        locale: NS,
        inject: () => pluginController.injected(),
      }, MimoPluginCard))), 'mimo-vision: plugins page card')

      // ─────────────────────────── 样式 ───────────────────────────
      //
      // primitives 的 CSS 是构建期哈希类名，不对外导出，所以这里只能保留一层
      // 「布局壳」。每一项数值都对齐内核，改动它们就会重新偏离内置页面：
      //   · section  : max-width 720px、gap 12px        ← ui-settings-models 的 _section
      //   · title    : 16px / 500 / line-height 24px     ← _title
      //   · intro    : 14px / 22px                       ← _intro
      //   · 字段分隔  : 0.5px（不是 1px！）              ← settings-form/fields.module.css
      //   · 字段行    : gap 6px、padding 12px 0          ← 同上
      //   · label    : 13px / 500 / 1.5、labelGroup gap 4px ← 同上
      //   · helpButton: 24×24、radius-sm、label-tertiary ← 同上
      //   · help     : 12px / 1.6、label-secondary、padding 10px 0 0 ← 同上
      //   · reset    : 12px / 1.5、label-secondary、无下划线
      //   · 布尔行    : space-between / gap 24px / padding 16px 0 ← DeveloperToolsRow
      //   · 提示      : success-primary、warn-label      ← _savedNotice / _notice
      const css = [
        // —— 页面壳 ——
        '.mimo-section{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}',
        '.mimo-heading{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
        '.mimo-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
        '.mimo-page{display:flex;flex-direction:column}',

        // —— 状态行（状态点 + 短文本）——
        '.mimo-status{display:inline-flex;align-items:center;gap:6px;margin:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

        // —— 模型候选（Pill 由组件渲染，这里只管换行与间距）——
        '.mimo-models{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
        '.mimo-modelsLabel{color:var(--dsw-alias-label-tertiary)}',
        // 兜底按钮（内核未导出 Pill/Button 时才会出现）
        '.mimo-modelFallback{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 10px}',

        // —— 字段外壳（与 settings-form/fields.module.css 同构）——
        '.mimo-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
        '.mimo-field + .mimo-field,.mimo-row + .mimo-field,.mimo-field + .mimo-row,.mimo-row + .mimo-row{border-top:.5px solid var(--dsw-alias-border-l2)}',
        '.mimo-head{display:flex;align-items:center;gap:8px}',
        '.mimo-labelGroup{display:flex;align-items:center;gap:4px;flex:1;min-width:0}',
        '.mimo-label{flex:0 1 auto;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
        '.mimo-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
        '.mimo-badges{display:inline-flex;align-items:center;gap:8px}',
        '.mimo-reset{border:0;background:0 0;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.mimo-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
        '.mimo-reset:disabled{cursor:default}',
        // ⓘ 折叠区（照抄官方 .helpButton / .help）
        '.mimo-helpButton{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
        '.mimo-helpButton:hover,.mimo-helpButton[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
        '.mimo-help{padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
        '.mimo-help > p{margin:0}',

        // —— 多行输入（内核无对应组件；指标照抄官方 .input）——
        '.mimo-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);padding:8px 12px}',
        '.mimo-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
        '.mimo-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
        '.mimo-textarea{min-height:72px;resize:vertical}',

        // —— 布尔行（与 DeveloperToolsRow 同构）——
        '.mimo-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0}',
        '.mimo-rowText{min-width:0}',
        '.mimo-rowTitle{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
        '.mimo-rowDesc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        // 内核缺 Switch 时的只读占位（不放 checkbox）
        '.mimo-rowFallback{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

        // —— 动作行与就地反馈 ——
        '.mimo-actions{display:flex;align-items:center;gap:8px;padding-top:16px}',
        '.mimo-note,.mimo-noteOk,.mimo-noteWarn,.mimo-noteError{font-size:12px;line-height:1.5}',
        '.mimo-note{color:var(--dsw-alias-label-tertiary)}',
        '.mimo-noteOk{color:var(--dsw-alias-state-success-primary)}',
        '.mimo-noteWarn{color:var(--dsw-alias-state-warn-label)}',
        '.mimo-noteError{color:var(--dsw-alias-state-error-primary)}',
      ].join('\n')
      const tagId = 'dsh-mimo-vision/settings.css'
      // 注意：这里是「挂载即注入」——ctx.effect 立即调用回调，取其返回值当清理函数。
      // 写成 `ctx.effect(() => () => {...})` 会把注入推迟到卸载时，整页也就一直没样式。
      ctx.effect(() => {
        if (typeof document === 'undefined') return
        const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)
        if (existing !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-mimo-vision'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            // 已被别处移除
          }
        }
      }, 'mimo-vision: styles')

      // 发送拦截：conversation 服务可能晚于本插件激活，用定时器兜底。
      if (!installSendInterception(ctx, ctx.get('conversation'), pluginController)) {
        let dispose = null
        dispose = ctx.timer.interval(() => {
          if (installSendInterception(ctx, ctx.get('conversation'), pluginController) && dispose !== null) {
            dispose()
            dispose = null
          }
        }, 300)
        ctx.effect(() => () => {
          if (dispose !== null) dispose()
        }, 'mimo-vision: send interception watcher')
      }
    }

    exports.NS = NS
    exports.SETTINGS_NS = SETTINGS_NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
