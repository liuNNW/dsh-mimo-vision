# MiMo 视觉识别（DSH 插件）

[![npm](https://img.shields.io/npm/v/dsh-mimo-vision.svg)](https://www.npmjs.com/package/dsh-mimo-vision)
[![license](https://img.shields.io/badge/license-MulanPSL--2.0-blue.svg)](https://github.com/liuNNW/dsh-mimo-vision/blob/main/LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-blue.svg)](https://github.com/topics/dsh-plugin)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）具备**图片识别能力**：对接小米 [MiMo](https://platform.xiaomimimo.com) 模型，发送带图片的消息时自动调用 MiMo 识别，结果作为上下文注入对话 —— 主模型即使不支持图片输入，也能围绕图片内容正常回复。

> **一条命令安装**
>
> ```bash
> dsh plugin --profile desktop add dsh-mimo-vision
> ```
>
> **可安装的 bundle 插件**：装一次进入 `dsh.profile.bundles`，之后每次启动自动加载，
> 升级 DSH 不会把它冲掉。配置在**设置 → MiMo 视觉**里改。

## ✨ 功能

- 🖼️ **发送即识别**：粘贴/上传图片后发送，自动调用 MiMo 识别，结果注入上下文
- ⚙️ **原生设置页**：`设置 → MiMo 视觉`；同一张表单也出现在
  `设置 → 插件 → dsh-mimo-vision` 的 bundle 配置区
- 🔑 **密钥不落配置**：模型密钥写进部署凭据（`<DSH_HOME>/.credentials.yaml`），
  配置文件里只留凭据引用名
- 🔧 **全局工具** `mimo_analyze_image`：所有会话可见，支持本地路径 / http(s) URL / data URL
- 🛡️ **原生回退**：未配置密钥 / 关闭开关 / 插件未加载 / 调用失败 → 一律走原生流程，
  保留「当前模型不支持图片」提示，绝不静默吞图
- 🧩 **不依赖内核内部 API**：宿主半零 `@deepseek-ai/*` import，内核升级不会把插件打挂

## 📥 安装

本插件是**可安装的 bundle 插件**（与 `dsh-better-sidebar` 同一种形态）：包里自带
`cordis.patch.yml`，装进 profile 后自动进 `dsh.profile.bundles`，**不需要手工改
profile 的任何文件**。

### 方式一：从 npm 安装

```bash
dsh plugin --profile desktop add dsh-mimo-vision
```

### 方式二：直接从 GitHub 安装

```bash
dsh plugin --profile desktop add github:liuNNW/dsh-mimo-vision
```

### 方式三：本地目录安装

```bash
git clone https://github.com/liuNNW/dsh-mimo-vision.git
dsh plugin --profile desktop add /绝对路径/dsh-mimo-vision
```

`dsh` 会走 pnpm 与兼容性检查，把包装进 profile 的 `node_modules` 并写进
`dsh.profile.bundles`。**装完重启 DSH**，然后到 `设置 → MiMo 视觉` 填密钥。

### ⚠️ 从 0.2.x 升级

0.3.0 改成 bundle 形态，配置载体也换了，**按这三步走**：

1. **删掉 profile `cordis.patch.yml` 里旧的手工挂载行**：

   ```yaml
   - id: mimo-vision
     name: "dsh-mimo-vision"
     config: { ... }
   ```

   不删的话同一个插件会被挂载两次 —— 重复的 HTTP 前缀路由会让整棵插件树启动失败。

2. 用本版重新安装：`dsh plugin --profile desktop add ...`

3. 首次启动会自动把旧配置迁移到 `<DSH_HOME>/.dsh-mimo-vision.json`；
   密钥仍在 `.credentials.yaml` 的 `MIMO_VISION_API_KEY` 下，不用重填。

> **从 0.1.x 升级**还要额外清掉内核目录里的旧拷贝
> （`<dsh安装目录>/node_modules/@deepseek-ai/dsh-mimo-vision`）——
> 那是**另一份副本**，会和本插件同时加载。

## ⚙️ 配置

在 `设置 → MiMo 视觉` 里改，保存即生效、重启仍在。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| **模型名称** | `mimo-v2.5-pro` | 自由文本，不锁白名单；「测试连接」成功后可从候选里点选实际可用 id |
| **模型密钥** | 空 | 只写进凭据，不落配置文件；留空保存＝保持当前密钥 |
| 密钥引用名 | `MIMO_VISION_API_KEY` | 已有别的引用（如 `XIAOMI_API_KEY`）时改这里即可复用，无需重贴密钥 |
| 接口地址 | `https://api.xiaomimimo.com/v1` | 按量付费与 Token 套餐使用不同地址 |
| 最大输出 tokens | `2048` | 64–65536 |
| 温度 | `0.3` | 0–2 |
| **默认提示词** | 中文描述提示 | 发送时未写提示词时用它描述图片 |
| 系统提示词 | 内置 | 留空使用内置的 MiMo 图片分析人格 |
| 发送时自动识别 | 开 | 关闭后按原生方式发送图片，保留原生提示 |

### 配置文件在哪

| 内容 | 位置 |
|---|---|
| 非密钥配置（模型、接口地址、提示词等） | `<DSH_HOME>/.dsh-mimo-vision.json` |
| 模型密钥 | `<DSH_HOME>/.credentials.yaml` → `refs.MIMO_VISION_API_KEY` |

配置放在插件自己的文件里、而不是 profile 的 `cordis.patch.yml`，所以内核升级不会
牵动插件状态。删掉 JSON 里某个键即回落到默认值。

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`（Windows）/ `~/.dsh`（macOS、Linux）。

## 🧰 使用

**方式一：自动识别（推荐）**

保持「发送时自动用 MiMo 识别图片」开启，聊天框直接粘贴图片发送即可，正文可以不写文字。

**方式二：工具调用**

```json
{ "image": "C:\\Users\\me\\Pictures\\screenshot.png", "prompt": "这张图里有哪些文字？" }
```

`image` 支持本地绝对路径、`http(s)` URL、`data:image/...;base64,...`。
也可由模型自行调用：任意会话里让它「分析这张图」即可。

## 🔬 工作原理

```
[浏览器] 发送带图消息
   └─ 拦截 conversation.sendSession（仅当 插件存活 + 开关开 + 已配密钥）
        ├─ conversation.serializeDraftImages(ids) → 图片字节（公开 API）
        ├─ POST ./mimo-vision/api/prepare  → 宿主暂存
        └─ 以「空图片列表」调用原始 sendSession（纯文本，不触发图片闸门）
[宿主] agent/pre-step waterfall
        ├─ 逐张调 MiMo（进程内 fetch）
        └─ 把结果作为 source.kind==='plugin:<包名>' 的用户消息插到已认领消息之后
[设置页] 自建表单 → POST ./mimo-vision/api/{fields,status,save,test} → 宿主
```

### 三个设计决定

**为什么必须在客户端剔除图片？**
宿主 `api-session-controller` 在受理 prompt 时就会按当前模型的 `inputModalities`
拒绝带图请求（`session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`），
这一步发生在**任何插件事件之前**，宿主侧无法事后补救。

**为什么客户端 ↔ 宿主走同源 HTTP，而不是 Remote / `configForms`？**
0.2.x 的客户端只挂载编译期生成的 Remote 清单，运行时注册的 `TypertRemoteService`
在浏览器侧拿不到命名空间；而 `ctx.configForms` 在 0.2.1-rc.2 内核里已经
**整个不存在**（全量搜索零命中）——旧版设置页依赖它，正是升级后整页空白的原因。
所以统一走 `/mimo-vision/api/*`，与 `dsh-better-sidebar` 的 `/sidebar/api` 同机制。

**为什么宿主半不 import 任何 `@deepseek-ai/*`？**
profile 里安装的插件按 Node 的目录查找解析这些包名，命中的是
`~/.dsh/profiles/node_modules` 那批 junction —— 它们指向 **npm 全局 dsh**，
和桌面版内核（`app.asar` 里）可能差一个 minor。旧版
`import { defineTool }` / `import { credentialRef }` 就踩在这条裂缝上。
现在宿主半零内核 import：工具定义直接提交 `ctx.tools.register()` 接受的 JSON 形态。

## 🧪 自检

```bash
# 宿主半可独立加载（证明零内核依赖）
node -e "import('<包目录>/lib/index.js').then(m=>console.log(m.name,m.inject))"

# 浏览器半语法
node --check <包目录>/lib/client.js

# 装好之后：宿主 HTTP 面
curl -X POST http://127.0.0.1:19387/mimo-vision/api/status \
     -H 'content-type: application/json' -d '{}'
```

`status` 返回 `configured`、当前配置值与字段表；`test` 会真的拉一次模型列表。

## 📦 目录结构

```
mimo-vision-plugin/
├── package.json           # 包声明：dsh.bundle.patch + dsh.client + icon
├── cordis.patch.yml       # 组合补丁层（insert row id: mimo-vision，含双挂载保护）
├── icon.svg               # 插件行图标
├── locale/
│   ├── zh.json            # 插件页显示的中文标题/描述
│   └── en.json            # 英文标题/描述
└── lib/
    ├── index.js           # 宿主半：HTTP 面 + 全局工具 + pre-step 注入 + 旧配置迁移
    ├── client.js          # 浏览器半：设置页双座位 + 发送拦截
    ├── config.js          # 字段表/默认值与共享常量（宿主与浏览器共用）
    └── mimo.js            # MiMo HTTP 客户端（含错误映射与密钥脱敏）
```

## 📌 版本历史

- **0.3.0** — 改成**可安装的 bundle 插件**（与 `dsh-better-sidebar` 同形态），删除
  `install.mjs` 与四套旧自检脚本；修掉内核 0.2.x 升级后的全部不兼容点
  （`configForms` 消失、`plugins.item` → `plugins.bundle.config`、发送拦截私有方法被删、
  内核包解析到旧副本、`output.schema` 写法、注入消息 source 格式）。
  配置改存 `<DSH_HOME>/.dsh-mimo-vision.json`，与 profile 解耦。新增 locale 与图标。
- **0.2.0** — 重构为 profile 级永久插件（不再拷进内核目录）；客户端 ↔ 宿主改走同源 HTTP；
  密钥改走独立凭据引用；图片改由宿主进程内 `fetch` 直连 MiMo（去掉子进程依赖）。
- **0.1.1** — 修复客户端挂载失败
- **0.1.0** — 由动态插件迁移为全局静态插件

## 📄 许可证

[MulanPSL-2.0](LICENSE)（木兰宽松许可证，第 2 版）—— 与仓库内 `LICENSE` 文件一致。
