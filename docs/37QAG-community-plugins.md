# 37QAG 社区插件

## 已安装

| 目录 | 插件 | 版本 | 用途 |
| --- | --- | --- | --- |
| `plugins/command-gateway` | 指令前置 | 1.5.0 | 指令入口、权限、禁言、暂停、骰子、猜拳和跨插件服务 |
| `plugins/sticker-admin` | 表情包管理 | 1.2.0 | 表情库管理、AI 识图提示词、标签和 QQ 收藏同步 |
| `plugins/sleep-mood` | 睡眠与心情系统 | 1.0.1 | 心情、疲劳、自然睡眠、命令睡眠和状态提示词注入 |

三个插件已在 `data/config.json` 中启用。

## 兼容方式

社区二开版本的插件差异主要集中在清单扩展字段和宿主私有接口。37QAG 采用统一适配，而不是复制各版本整套 UI：

- 清单统一识别 `commands`、`intercept`、`settingsUi` 和 `exposes`。
- 插件统一获得 `setup(api)` 生命周期、配置、日志、能力调用、工具注册和 `api.storage`。
- 消息入口统一运行 `intercept` 链，插件按 `order` 决定处理顺序。
- 睡眠插件使用 37QAG 已有的 `before-context`、`before-llm-messages`、`before-tool`、`after-tool` 与 `after-response` 钩子。
- 睡眠包附带的整套旧 UI 没有覆盖 37QAG 控制台；心情数据通过 `mood.dashboard` 能力提供。
- 指令前置的 v6 补丁只向核心增加带 `command-gateway:*` 标记的薄接入块。原件备份位于 `plugins/command-gateway/backup/`。

## 使用注意

- 指令前置已经完成核心补丁，但当前进程若在补丁安装前已启动，仍需重启一次 37QAG。
- 指令权限默认收紧。禁言、解禁、全体禁言、全体解禁、暂停和继续需要 100000 权限；抛骰子和猜拳默认所有人可用。
- 睡眠插件可从 `owner-identity` 获取主人 QQ，也可在插件配置中直接填写 `ownerQq`，否则主人起床口令无法鉴权。
- 表情数据保存在 `data/stickers.json` 和 `data/sticker-images/`。
- 社区插件来自不同维护者。升级前应保留插件数据目录，并重新运行 `npm test` 中的社区插件兼容检查。