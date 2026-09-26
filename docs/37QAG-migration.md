# 37QAG 迁移说明

## 来源

| 来源 | 用途 |
| --- | --- |
| QQ-Agent-整合版-20260922 | 37QAG 的运行基线，复用完整目录与运行依赖 |
| QQ-Agent 0.4 preview | 参考外围模块与后续扩展方向 |
| GPT-6ASTRA URTAL给出的Jev与记忆系统-思维决策树完整方案-20260923.md | Jev 决策树、证据记忆和任务闭环设计依据 |

## 新增模块

- `src/decision-policy.js`
- `src/run-context.js`
- `src/memory-evidence.js`
- `src/task-ledger.js`

对应测试位于 `test/`。

## 行为迁移

- Jev 从“总闸门”调整为“可弃权的小建议”。
- 明确请求和必需回忆不再被 Jev 故障或 NO 否决。
- 记忆搜索从可越权全库搜索收窄为当前会话。
- 新增来源化证据账本，模型推断不能伪装为已确认事实。
- 待办从“模型说完成即完成”调整为提交、平台回执、实际结果分层确认。
- 发送动作增加本轮截止时间保护。

## 兼容性

- 旧的人物印象继续读取，`lastSeen` 仍保留。
- 旧的待办提醒文件继续可用，新任务同时写入任务账本。
- OneBot、OpenAI 兼容 API、Electron 控制台和现有启动脚本保持可用。
- 环境变量仍使用 `QQ_AGENT_*` 前缀，以兼容已有启动脚本。
- `package.json` 中的 repository、bugs、homepage 保留为 upstream（QQ Agent）来源信息，不代表 37QAG 的独立发布仓库。
- 社区插件统一使用 `plugin.json` + `index.js`，通过 `setup(api)`、能力、钩子和插件存储接入；不同二开版本的私有 UI 安装包不会覆盖 37QAG 控制台。
- 指令前置使用带标记块的 v6 兼容补丁，为插件补齐 `commands`、`intercept`、`settingsUi`、`exposes`、`api.storage` 和消息入口拦截链。补丁安装与摘除均保留原文件备份。

## 首版暂未合并

“QQ-Agent 0.4 preview”的以下外围能力暂未直接覆盖到核心：

- 社区与评论
- 市场/插件市场
- 下载中心
- ZIP 安装器
- 遥测
- 媒体链接扩展
- 更完整的测试夹具与自测入口

这些模块与 0.4 preview 的核心源码耦合较深，应在独立适配和回归测试后逐项吸收。
