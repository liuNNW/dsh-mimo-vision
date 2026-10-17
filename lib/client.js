/**
 * MiMo 视觉识别 —— 浏览器半。
 *
 * 三件事：
 *
 * 1. **设置页**：同时挂在 `settings.section`（设置侧栏一整页）与
 *    `plugins.bundle.config`（插件页本 bundle 的配置区，key = 包名）。
 *    界面只用主题 token（`--dsw-alias-*`）自建控件，**不 require 任何内核
 *    Client 包**：那些包随时改且没有类型检查，一个抛错就会清空整个 slot。
 *
 * 2. **读写走插件自己的同源 HTTP 面** `/mimo-vision/api/*`：
 *    `fields` 拿字段表、`status` 拿当前值与密钥状态、`save` 写回、`test` 测连接。
 *    不用内核 configForms —— 该服务在 0.2.x 已不存在（整棵树零命中），
 *    早期版本依赖它就注定整页失效。
 *
 * 3. **发送拦截**：仅在「插件存活 + 开启自动识别 + 已配置密钥」时，把草稿里的
 *    图片经 `prepare` 暂存到宿主，再以「剔除图片后的 id 列表」调用原始
 *    sendSession。这一层必不可少：宿主 api-session-controller 在受理 prompt
 *    时就会按当前模型的 inputModalities 拒绝带图请求
 *    （MODEL_DOES_NOT_SUPPORT_IMAGES），发生在任何插件事件之前。
 *    其余任何情况一律回退原生流程，保留「当前模型不支持图片」提示。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mimo-vision',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 字典命名空间。 */
    const NS = 'settings.mimoVision'
    /** HTTP 面前缀，相对页面 base 解析（Electron 的 dsh-app:// 与反代子目录都能命中）。 */
    const API_PREFIX = 'mimo-vision/api'
    /** slot 里用的短 id。 */
    const SLOT_ID = 'mimo-vision'
    /** bundle 页配置区的 key：必须是包名。 */
    const BUNDLE_KEY = 'dsh-mimo-vision'

    /** 必需服务：slots 挂座位、locale 出文案。其余服务一律可选读取。 */
    const inject = ['slots', 'locale']

    const zh = {
      title: 'MiMo 视觉识别',
      intro: '对接小米 MiMo 模型，让 DSH 具备图片识别能力。发送带图消息时自动识别并注入上下文。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      loading: '读取中…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败：',
      test: '测试连接',
      testing: '测试中…',
      testOk: (n) => `已连接 · ${n} 个模型`,
      pickModel: '点选填入模型名称：',
      apiKey: '模型密钥',
      apiKeyHint: '留空表示保持当前密钥；密钥只写进宿主凭据文件。',
      apiKeySet: '已配置密钥。',
      apiKeyUnset: '未配置密钥。',
      invalidNumber: '请填数字；留空表示使用默认值。',
      statusOk: (ref) => `密钥已配置（${ref}）`,
      statusMissing: (ref) => `未配置密钥（将写入 ${ref}）`,
    }

    const en = {
      title: 'MiMo Vision',
      intro: 'Image understanding through Xiaomi MiMo. Images in an outgoing message are described and injected into context.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      loading: 'Loading…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed: ',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: (n) => `Connected · ${n} model(s)`,
      pickModel: 'Pick a model id to fill: ',
      apiKey: 'API key',
      apiKeyHint: 'Leave blank to keep the current key; it is written to the host credential file only.',
      apiKeySet: 'A key is configured.',
      apiKeyUnset: 'No key.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      statusOk: (ref) => `Key configured (${ref})`,
      statusMissing: (ref) => `No key yet (writes ${ref})`,
    }

    /**
     * 往宿主 HTTP 面发一次 POST。
     * 用页面 base 解析相对地址：Electron 的 `dsh-app://app/` 由壳转发给 Host，
     * 反代挂在子目录时相对地址也不会跑出前缀。
     * @param {string} method - API 方法名。
     * @param {object} [payload] - 请求体。
     * @returns {Promise<object>} 宿主回答（永远带 ok 字段）。
     */
    async function post(method, payload) {
      try {
        const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : ''
        const url = new URL(`${API_PREFIX}/${method}`, base || 'http://127.0.0.1/').href
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
     * 造一个设置控制器：持有字段表、当前值、密钥状态与测试结果。
     * @param {(key: string, params?: unknown) => string} t - 取词函数。
     * @returns {object} 控制器。
     */
    function createController(t) {
      let seq = 0
      const state = {
        ready: false,
        error: '',
        fields: [],
        defaults: {},
        value: {},
        apiKey: '',
        apiKeyConfigured: false,
        apiKeyEnv: '',
        note: { kind: '', text: '' },
        models: [],
        testing: false,
        saving: false,
        dirty: false,
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) {
          try {
            listener(state)
          } catch {
            // 单个订阅者出错不影响其余
          }
        }
      }
      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const set = (patch) => {
        Object.assign(state, patch)
        emit()
      }

      const load = async () => {
        const status = await post('status')
        if (status.ok !== true) {
          set({ ready: false, error: String(status.error || t('unavailable')) })
          return
        }
        set({
          ready: true,
          error: '',
          fields: Array.isArray(status.fields) ? status.fields : [],
          defaults: status.defaults && typeof status.defaults === 'object' ? status.defaults : {},
          value: status.value && typeof status.value === 'object' ? status.value : {},
          apiKeyConfigured: status.configured === true,
          apiKeyEnv: typeof status.apiKeyEnv === 'string' ? status.apiKeyEnv : '',
        })
      }

      const save = async () => {
        set({ saving: true, note: { kind: '', text: '' } })
        const result = await post('save', { value: state.value, apiKey: state.apiKey })
        if (result.ok === true) {
          set({
            saving: false,
            apiKey: '',
            dirty: false,
            apiKeyConfigured: state.apiKeyConfigured || result.secretSaved === true,
            value: result.value && typeof result.value === 'object' ? result.value : state.value,
            note: { kind: 'ok', text: t('saved') },
          })
        } else {
          set({ saving: false, note: { kind: 'error', text: `${t('saveFailed')}${result.error ?? ''}` } })
        }
      }

      const test = async () => {
        set({ testing: true, note: { kind: '', text: t('testing') } })
        const result = await post('test')
        if (result.ok === true) {
          const models = Array.isArray(result.models) ? result.models.filter((item) => item && typeof item.id === 'string') : []
          set({ testing: false, models, note: { kind: 'ok', text: t('testOk')(models.length) } })
        } else {
          set({ testing: false, models: [], note: { kind: 'error', text: String(result.error || 'unknown error') } })
        }
      }

      return {
        state,
        subscribe,
        load,
        save,
        test,
        edit(key, value) {
          set({ value: { ...state.value, [key]: value }, dirty: true })
        },
        editSecret(text) {
          set({ apiKey: text, dirty: true })
        },
        idPrefix: () => {
          seq += 1
          return `mimo-vision-field-${seq}`
        },
      }
    }

    /** 字段行外壳：label(+hint) → 控件。 */
    function fieldShell(props) {
      return h('div', { className: 'mv-field', key: props.fieldKey },
        h('div', { className: 'mv-head' },
          h('label', { className: 'mv-label', htmlFor: props.htmlFor }, props.label),
          props.badge
            ? h('span', { className: 'mv-badge' }, props.badge)
            : null),
        props.control,
        props.hint ? h('p', { className: 'mv-hint' }, props.hint) : null)
    }

    /**
     * 一个字段控件。
     * @param {object} props - 字段 props。
     * @returns {object} 元素。
     */
    function Field(props) {
      const { field, state, disabled, onChange } = props
      const id = props.idPrefix + '-' + field.key
      const raw = state.value[field.key]
      const text = raw === undefined || raw === null ? '' : String(raw)

      if (field.kind === 'boolean') {
        const checked = raw !== false
        return h('div', { className: 'mv-row', key: field.key },
          h('div', { className: 'mv-rowText' },
            h('div', { className: 'mv-rowTitle' }, field.label),
            field.hint ? h('div', { className: 'mv-rowDesc' }, field.hint) : null),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': checked,
            'aria-label': field.label,
            className: 'mv-switch' + (checked ? ' mv-switchOn' : ''),
            disabled,
            onClick: () => onChange(field.key, !checked),
          }, h('span', { className: 'mv-switchKnob' })))
      }

      const common = {
        id,
        className: 'mv-input' + (field.kind === 'multiline' ? ' mv-textarea' : ''),
        value: text,
        disabled,
        spellCheck: false,
        placeholder: field.kind === 'number' ? String(state.defaults[field.key] ?? '') : '',
        onChange: (event) => {
          const next = event.target.value
          if (field.kind === 'number') {
            // 空串表示「用默认值」，不要把空串写成 0。
            onChange(field.key, next.trim() === '' ? undefined : Number(next))
          } else {
            onChange(field.key, next)
          }
        },
      }
      if (field.kind === 'multiline') common.rows = 3
      if (field.kind === 'number') common.inputMode = 'decimal'

      const control = field.kind === 'multiline'
        ? h('textarea', common)
        : h('input', { ...common, type: field.kind === 'number' ? 'text' : 'text' })

      return h('div', { className: 'mv-fieldWrap', key: field.key },
        fieldShell({
          fieldKey: field.key,
          htmlFor: id,
          label: field.label,
          hint: field.hint,
          control,
        }))
    }

    /** 设置表单本体。 */
    function MimoForm(props) {
      const { controller, t } = props
      const idPrefix = React.useRef(controller.idPrefix()).current
      const [, force] = React.useReducer((n) => n + 1, 0)
      const [state, setState] = React.useState(controller.state)

      React.useEffect(() => {
        setState({ ...controller.state })
        const off = controller.subscribe((next) => setState({ ...next }))
        controller.load().catch(() => {})
        return off
      }, [controller])

      const disabled = state.saving

      if (state.ready !== true) {
        return h('div', { className: 'mv-page' },
          h('p', { className: 'mv-hint' }, state.error || t('loading')))
      }

      const note = state.note || { kind: '', text: '' }
      const models = Array.isArray(state.models) ? state.models : []

      const secretId = idPrefix + '-apiKey'
      const secretField = fieldShell({
        fieldKey: 'apiKey',
        htmlFor: secretId,
        label: t('apiKey'),
        hint: t('apiKeyHint'),
        badge: state.apiKeyConfigured ? t('apiKeySet') : t('apiKeyUnset'),
        control: h('input', {
          id: secretId,
          className: 'mv-input',
          type: 'password',
          autoComplete: 'off',
          spellCheck: false,
          value: state.apiKey,
          disabled,
          placeholder: state.apiKeyConfigured ? '••••••••' : '',
          onChange: (event) => controller.editSecret(event.target.value),
        }),
      })

      const statusLine = h('p', { className: 'mv-status', role: 'status' },
        h('span', { className: 'mv-dot' + (state.apiKeyConfigured ? ' mv-dotOn' : '') }),
        h('span', null, state.apiKeyConfigured
          ? t('statusOk')(state.apiKeyEnv)
          : t('statusMissing')(state.apiKeyEnv)))

      const modelPicks = models.length > 0
        ? h('div', { className: 'mv-models' },
          h('span', { className: 'mv-modelsLabel' }, t('pickModel')),
          ...models.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: 'mv-chip',
            onClick: () => controller.edit('model', item.id),
          }, item.id)))
        : null

      const actions = h('div', { className: 'mv-actions' },
        h('button', {
          type: 'button',
          className: 'mv-button mv-buttonPrimary',
          disabled: disabled || !state.dirty,
          onClick: () => controller.save(),
        }, state.saving ? t('saving') : t('save')),
        h('button', {
          type: 'button',
          className: 'mv-button',
          disabled: state.testing || disabled,
          onClick: () => controller.test(),
        }, state.testing ? t('testing') : t('test')),
        note.text
          ? h('span', {
            className: note.kind === 'error' ? 'mv-noteError' : note.kind === 'ok' ? 'mv-noteOk' : 'mv-note',
            role: 'status',
          }, note.text)
          : null)

      // 字段顺序：模型名称 → 模型候选 → 模型密钥 → 其余字段 → 动作行。
      const [firstField, ...restFields] = state.fields
      const firstRow = firstField
        ? h(Field, {
          key: firstField.key,
          field: firstField,
          state,
          disabled,
          idPrefix,
          onChange: (key, value) => controller.edit(key, value),
        })
        : null
      const restRows = restFields.map((field) => h(Field, {
        key: field.key,
        field,
        state,
        disabled,
        idPrefix,
        onChange: (key, value) => controller.edit(key, value),
      }))

      return h('div', { className: 'mv-page' },
        statusLine,
        firstRow,
        modelPicks,
        secretField,
        ...restRows,
        actions)
    }

    /** `settings.section` 座位：设置侧栏一整页。 */
    function MimoSettingsSection(props) {
      const { controller, t } = props.injected || props
      return h('section', { className: 'mv-section' },
        h('h2', { className: 'mv-heading' }, t('title')),
        h('p', { className: 'mv-intro' }, t('intro')),
        h(MimoForm, { controller, t }))
    }

    /** `plugins.bundle.config` 座位：插件页里本 bundle 的配置区。 */
    function MimoBundleConfig(props) {
      const { controller, t } = props.injected || props
      const view = props.view
      if (view === 'summary') return t('intro')
      return h('div', { className: 'mv-page' }, h(MimoForm, { controller, t }))
    }

    /**
     * 安装发送拦截。
     *
     * 现代 API（0.2.x）：
     *   - `conversation.serializeDraftImages(ids)` → `[{mediaType,data,name}]`（公开）
     *   - `conversation.sendSession(session, text, imageIds, mode, signal)`
     *   - `conversation.releaseDraftImage(id)` / `releaseDraftImages(attachments)`
     *
     * 旧版用的 `resolveDraftAttachments` / `encodeImage` / `releaseDraftAttachments`
     * 都已不存在，这正是升级后「带图消息没反应」的直接原因。
     *
     * @param {object} ctx - 浏览器插件上下文。
     * @param {object} conversation - conversation 服务。
     * @param {object} controller - 设置控制器（读配置与密钥状态）。
     * @returns {boolean} 是否装上了。
     */
    function installSendInterception(ctx, conversation, controller) {
      if (!conversation || typeof conversation.sendSession !== 'function') return false
      if (conversation.__mimoVisionWrapped === true) return true

      const original = conversation.sendSession
      const wrapped = async function (session, text, imageIds, mode, signal) {
        const ids = Array.isArray(imageIds) ? imageIds : []
        if (ids.length === 0) return original.call(this, session, text, ids, mode, signal)
        try {
          const state = controller.state
          if (state.ready !== true || state.apiKeyConfigured !== true) return original.call(this, session, text, ids, mode, signal)
          if (state.value.autoConvertImages === false) return original.call(this, session, text, ids, mode, signal)
          if (typeof this.serializeDraftImages !== 'function') return original.call(this, session, text, ids, mode, signal)

          // 公开 API：把草稿图片序列化成宿主接受的上传形态。
          const images = await this.serializeDraftImages(ids)
          if (!Array.isArray(images) || images.length === 0) return original.call(this, session, text, ids, mode, signal)

          const sessionId = String((session && (session.id || session.sessionId)) || '')
          if (sessionId.length === 0) return original.call(this, session, text, ids, mode, signal)

          const sendText = typeof text === 'string' && text.trim().length > 0 ? text : '请识别这张图片并回复我。'
          const prepared = await post('prepare', { sessionId, images, prompt: sendText })
          if (prepared.ok !== true) return original.call(this, session, text, ids, mode, signal)

          // 图片已交给宿主识别：本次以「无图」发送，避免宿主按 inputModalities 拒收。
          const result = await original.call(this, session, sendText, [], mode, signal)
          try {
            if (typeof this.releaseDraftImages === 'function') {
              this.releaseDraftImages(ids.map((id) => ({ id })))
            } else if (typeof this.releaseDraftImage === 'function') {
              for (const id of ids) this.releaseDraftImage(id)
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

    /** 样式：只用主题 token，数值对齐内核设置页。 */
    const CSS = [
      '.mv-section{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}',
      '.mv-heading{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.mv-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
      '.mv-page{display:flex;flex-direction:column}',
      '.mv-status{display:inline-flex;align-items:center;gap:6px;margin:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.mv-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
      '.mv-dotOn{background:var(--dsw-alias-state-success-primary)}',
      '.mv-models{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0;padding:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.mv-modelsLabel{color:var(--dsw-alias-label-tertiary)}',
      '.mv-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;height:26px;padding:0 10px}',
      '.mv-chip:hover{border-color:var(--dsw-alias-label-secondary)}',
      '.mv-fieldWrap,.mv-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.mv-fieldWrap+.mv-fieldWrap,.mv-fieldWrap+.mv-row,.mv-row+.mv-fieldWrap,.mv-row+.mv-row{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mv-head{display:flex;align-items:center;gap:8px}',
      '.mv-label{flex:0 1 auto;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.mv-badge{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;flex:none}',
      '.mv-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.mv-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);padding:8px 12px}',
      '.mv-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.mv-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.mv-textarea{min-height:72px;resize:vertical;font-family:inherit}',
      '.mv-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0}',
      '.mv-rowText{min-width:0}',
      '.mv-rowTitle{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.mv-rowDesc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.mv-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background-color .2s ease}',
      '.mv-switchOn{background:var(--dsw-alias-state-business-primary)}',
      '.mv-switch:disabled{cursor:default;opacity:.5}',
      '.mv-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.mv-switchKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .2s ease}',
      '.mv-switchOn .mv-switchKnob{transform:translateX(16px)}',
      '.mv-actions{display:flex;align-items:center;gap:8px;padding-top:16px}',
      '.mv-button{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:20px;height:30px;padding:0 14px}',
      '.mv-button:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}',
      '.mv-button:disabled{opacity:.5;cursor:default}',
      '.mv-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
      '.mv-note,.mv-noteOk,.mv-noteError{font-size:12px;line-height:1.5}',
      '.mv-note{color:var(--dsw-alias-label-tertiary)}',
      '.mv-noteOk{color:var(--dsw-alias-state-success-primary)}',
      '.mv-noteError{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n')

    /**
     * 插件入口。
     * @param {object} ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mimo-vision: dictionaries')
      const t = ctx.locale.bind(NS)

      const controller = createController(t)
      ctx.effect(() => () => {}, 'mimo-vision: controller lifetime')

      // 启动即读一次：发送拦截要判断「密钥是否已配置」，而用户可能整场都不打开设置页。
      controller.load().catch(() => {})

      // 座位 1：设置侧栏一整页。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SLOT_ID,
        order: 25,
        label: () => t('title'),
        inject: () => ({ injected: { controller, t } }),
      }, MimoSettingsSection))

      // 座位 2：插件页里本 bundle 的配置区（key = 包名）。
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE_KEY,
        inject: () => ({ injected: { controller, t } }),
      }, MimoBundleConfig))

      // ─────────── 样式 ───────────
      //
      // 挂载即注入：ctx.effect 立即调用回调，取其返回值当清理函数。
      // 写成 `ctx.effect(() => () => {...})` 会把注入推迟到卸载时。
      const tagId = 'dsh-mimo-vision/settings.css'
      ctx.effect(() => {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-mimo-vision'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          try {
            tag.remove()
          } catch {
            // 已被别处移除
          }
        }
      }, 'mimo-vision: styles')

      // ─────────── 发送拦截 ───────────
      //
      // conversation 服务可能晚于本插件激活，用定时器兜底重试。
      const attempt = () => installSendInterception(ctx, ctx.get('conversation'), controller)
      if (!attempt()) {
        let stop = null
        const timer = ctx.get('timer')
        if (timer && typeof timer.interval === 'function') {
          stop = timer.interval(() => {
            if (attempt() && stop !== null) {
              stop()
              stop = null
            }
          }, 300)
        } else {
          const handle = setInterval(() => {
            if (attempt() && handle !== undefined) clearInterval(handle)
          }, 300)
          stop = () => clearInterval(handle)
        }
        ctx.effect(() => () => {
          if (stop !== null) stop()
        }, 'mimo-vision: send interception watcher')
      }
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
