# MiMo 视觉识别（DSH 插件）

[![npm](https://img.shields.io/npm/v/dsh-mimo-vision.svg)](https://www.npmjs.com/package/dsh-mimo-vision)
[![license](https://img.shields.io/npm/l/dsh-mimo-vision.svg)](https://github.com/liuNNW/dsh-mimo-vision/blob/main/LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-blue.svg)](https://github.com/topics/dsh-plugin)

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）具备**图片识别能力**：对接小米 [MiMo](https://platform.xiaomimimo.com) 模型，发送带图片的消息时自动调用 MiMo 识别，结果作为上下文注入对话 —— 主模型即使不支持图片输入，也能围绕图片内容正常回复。

> **一条命令安装**：`dsh plugin --profile desktop add dsh-mimo-vision`
>
> **profile 级永久插件**：装一次进入 `dsh.profile.bundles`，之后每次启动自动加载；升级 DSH 不会把它冲掉。
> 配置在**设置页**里直接改：**模型名称 / 模型密钥 / 默认提示词**（外加接口地址、最大输出、温度、系统提示词、自动识别开关）。

## ✨ 功能

- 🖼️ **发送即识别**：粘贴/上传图片后发送，自动调用 MiMo 识别，结果注入上下文
- ⚙️ **原生设置页**：`设置 → MiMo 视觉`，也可从 `插件 → MiMo 视觉` 进入；表单复用 DSH 官方组件，样式与内置「网页搜索」一致
- 🔑 **密钥不落配置**：模型密钥写进部署凭据（`<DSH_HOME>/.credentials.yaml`），配置文件里只留凭据引用名
- 🔧 **全局工具** `mimo_analyze_image`：所有会话可见，支持本地路径 / http(s) URL / data URL
- 🛡️ **原生回退**：未配置密钥 / 关闭开关 / 插件未加载 / 调用失败 → 一律走原生流程，保留「当前模型不支持图片」提示，绝不静默吞图
- 🧪 **自带测试**：契约自检、冒烟、行为集成、profile 装配四套脚本，全部离线可跑

## 📥 安装

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile desktop add dsh-mimo-vision
```

`dsh` 会走 pnpm 与兼容性检查，把包装进 profile 的 `node_modules` 并写进 `dsh.profile.bundles`。**装完重启 DSH**。

> 尚未发布到 npm 时，用下面的 GitHub 或本地安装方式。

### 方式二：直接从 GitHub 安装

```bash
dsh plugin --profile desktop add github:liuNNW/dsh-mimo-vision
```

适合想跟 `main` 最新提交、或 npm 上还没发版的情况。

### 方式三：克隆后本地安装

```bash
git clone https://github.com/liuNNW/dsh-mimo-vision.git
cd dsh-mimo-vision
node install.mjs                      # 自动挑 profile（默认 desktop）
node install.mjs --profile web        # 指定 profile
```

脚本会：校验包体 → 选 profile → 安装 → 检查旧版残留。**装完重启 DSH**，然后到 `设置 → MiMo 视觉` 填写三项并保存。

### 手动安装

1. 把本目录整体拷到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-mimo-vision/`
2. 把 `"dsh-mimo-vision"` 加进 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dsh.profile.bundles`
3. 重启 DSH

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`（Windows）/ `~/.dsh`（macOS、Linux）。
**不需要**改 profile 的 `cordis.patch.yml` —— 组合层由本包自带的 `cordis.patch.yml` 提供。

> 从 0.1.x / 旧 scope 名（`@deepseek-ai/dsh-mimo-vision`）升级上来的用户：包名已改为
> 无 scope 的 `dsh-mimo-vision`。`dsh.profile.bundles` 里若还留着旧名，改成新名；
> 设置命名空间（row id `mimo-vision`）没变，所以配置值和密钥都不会丢。

### 为什么不再「拷进内核目录」

0.1.x 把包拷到 `<dsh安装目录>/node_modules/@deepseek-ai/` 并在 profile 补丁里插一行。那条路有三个问题：

1. 升级 dsh（`npm i -g` 或桌面版自动更新）会整棵树替换，插件随之消失；
2. 它借用内核自己的依赖解析，任何一次内核依赖变动都可能连带打挂启动；
3. 需要额外跑 `fix-mimo-vision.mjs` 之类的补丁脚本去修源码 bug。

`install.mjs` 现在会主动检测这类残留并给出清理命令。**已装过 0.1.x 的请先把旧拷贝删掉再装新版**，否则两个版本会同时加载。

## ⚙️ 配置

在 `设置 → MiMo 视觉`（或 `插件 → MiMo 视觉`）里配置，保存即生效、重启仍在。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| **模型名称** | `mimo-v2.5-pro` | 自由文本，不锁白名单；「测试连接」成功后可从候选里点选实际可用 id |
| **模型密钥** | 空 | 只写进凭据，不落配置文件；留空保存＝保持当前密钥 |
| 接口地址 | `https://api.xiaomimimo.com/v1` | 按量付费与 Token 套餐使用不同地址 |
| 最大输出 tokens | `2048` | 64–65536 |
| 温度 | `0.3` | 0–2 |
| **默认提示词** | 中文描述提示 | 发送时未写提示词时用它描述图片 |
| 系统提示词 | 内置 | 留空使用内置的 MiMo 图片分析人格 |
| 发送时自动识别 | 开 | 关闭后按原生方式发送图片，保留原生提示 |

密钥存放位置与复用：默认写进凭据 **`MIMO_VISION_API_KEY`**。若已有别的引用（例如 `XIAOMI_API_KEY`），把配置里的 `apiKeyEnv` 改成它即可复用，无需重新粘贴密钥。

配置值落在 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 的 `- id: mimo-vision` 条目下；删掉某个键即回落到默认值。

## 🧰 使用

**方式一：自动识别（推荐）**

保持「发送时自动用 MiMo 识别图片」开启，聊天框直接粘贴图片发送即可，正文可以不写文字。

**方式二：工具调用**

```json
{ "image": "C:\\Users\\me\\Pictures\\screenshot.png", "prompt": "这张图里有哪些文字？" }
```

`image` 支持本地绝对路径、`http(s)` URL、`data:image/...;base64,...`。

## 🔬 工作原理

```
[浏览器] 发送带图消息
   └─ 拦截 conversation.sendSession（仅当 插件存活 + 开关开 + 已配密钥）
        ├─ resolveDraftAttachments + encodeImage → 图片字节
        ├─ POST ./mimo-vision/api/prepare  → 宿主暂存
        └─ 以「剔除图片后的附件 id」调用原始 sendSession（纯文本，不触发图片闸门）
[宿主] agent/pre-step waterfall
        ├─ 逐张调 MiMo（进程内 fetch）
        └─ 把结果作为 source.kind==='plugin' 的用户消息插到已认领消息之后
[设置页] 插件 Config(.volatile) → dsh-settings 投影 → SettingsForm；密钥走 credentials 域
```

**为什么必须在客户端剔除图片？** 宿主 `api-session-controller` 在受理 prompt 时就会按当前模型的 `inputModalities` 拒绝带图请求（`session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`），这一步发生在**任何插件事件之前**，宿主侧无法事后补救。

**为什么不用 typert Remote？** rc.6+ 的客户端只挂载编译期生成的 Remote 清单，运行时注册的 `TypertRemoteService` 在浏览器侧拿不到命名空间。所以客户端 ↔ 宿主走同源 HTTP（`/mimo-vision/api/*`，与 `dsh-better-sidebar` 的 `/sidebar/api` 同机制），配置读写走官方 `configForms` 与 `credentials` 服务。

## 🧪 测试

四套脚本都不需要启动 DSH、不联网（HTTP 用打桩 fetch）。**cwd 必须在这个 profile 目录里**，才能解析到内核依赖：

```bash
cd "$DSH_HOME/profiles/desktop"

node <仓库>/scripts/schema-check.mjs     # Config 与工具参数契约
node <仓库>/scripts/smoke.mjs            # 宿主 HTTP 面 / 错误映射 / 密钥解析 / 旧配置迁移
node <仓库>/scripts/integration.mjs      # pre-step 注入 与 客户端发送拦截（含全部回退分支）
node <仓库>/scripts/verify-profile.mjs   # profile 装配（bundles / 包体解析 / 补丁层 / 兼容性）
```

也可在本仓库根目录跑 `npm test`（`schema-check` + `smoke`）。

开发期若要在包目录下直接跑，先建内核依赖链接：

```bash
mkdir -p node_modules/@deepseek-ai
for p in schemastery dsh-tools dsh-credentials; do
  # Windows: mklink /J ；POSIX: ln -s
  ln -s "<dsh安装目录>/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
```

## 📦 目录结构

```
mimo-vision-plugin/
├── package.json           # 包声明：dsh.bundle.patch + dsh.client
├── cordis.patch.yml       # 组合补丁层（insert row id: mimo-vision）
├── install.mjs            # 安装脚本（CLI 优先，文件系统兜底，幂等）
├── lib/
│   ├── index.js           # 宿主半：HTTP 面 + 全局工具 + pre-step 注入 + 旧配置迁移
│   ├── client.js          # 浏览器半：设置页双座位 + 发送拦截
│   ├── config.js          # Config schema 与共享常量
│   └── mimo.js            # MiMo HTTP 客户端（含错误映射与密钥脱敏）
└── scripts/               # 四套自检脚本
```

## 📌 版本历史

- **0.2.0** — 重构为 **profile 级永久插件**（不再拷进内核目录）。设置页改用官方 `Config(.volatile)` + `dsh-settings` + `configForms` 体系，座位从已不存在的 `settings.plugin.item` 迁到 `settings.section` + `plugins.item`。通信层从 typert Remote / SRC 回退改为同源 HTTP 面。模型名称解锁白名单；密钥改走独立凭据引用（`MIMO_VISION_API_KEY`）。图片改由宿主进程内 `fetch` 直连 MiMo（去掉子进程与 `subprocess`/`sandboxPolicy` 依赖）。新增四套自检脚本与旧配置自动迁移。
- **0.1.1** — 修复客户端挂载失败（改用 SRC 回退链路）
- **0.1.0** — 由动态插件迁移为全局静态插件

## 📄 许可证

MIT
