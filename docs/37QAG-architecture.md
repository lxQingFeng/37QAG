# 37QAG 架构说明

## 项目基线

37QAG 以“QQ-Agent-整合版-20260922”为可运行基线。该版本的 OneBot 接入、控制台、会话调度、模型调用、工具系统、本地 Jev 与便携启动链路已经形成完整闭环，因此首版不直接覆盖核心源码。

“QQ-Agent 0.4 preview”在测试、社区、市场、下载和审计等外围能力上更完整，但其核心源码已经分叉。37QAG 首版保留差异，后续按独立模块逐步吸收，避免一次性替换导致运行链路回归。

## 一轮运行

1. `orchestrator.js` 创建统一的 `RunContext`，绑定本轮编号、前置预算、整轮截止时间和取消信号。
2. `decision-policy.js` 识别参与路线：明确请求、自然回复、主动插话。
3. 必需的记忆回忆由词表/明确请求直接触发；Jev 只能补充不明显的回忆需求。
4. `local-jev.js` 并发执行前置小决策。到预算后冻结结果，取消剩余推理，迟到结果不得覆盖有效结果。
5. 明确请求继续执行。只有模糊图片需求等可弃权事项可以被 Jev 的明确 NO 否决。
6. 发送动作执行前再次经过 `RunContext.guardAction()`，超过整轮截止时间的外部动作会被拒绝。

## 决策原则

- 明确请求不能被 Jev 否决。
- 必需记忆检索不能被 Jev 否决。
- Jev 关闭、超时、低置信或出错时，不应破坏明确请求和可靠记忆。
- 自动补发正文只补发已经判断为成品消息的内容，而且只补发明确请求路线；它仍要经过动作截止时间保护。
- Jev 的前置结果属于“建议”，不能越过权限、会话范围和事实证据等级。

## 记忆系统

### 会话记忆

`memory_search` 与 `memory_archive` 只使用当前 `chatKey`。模型不能通过参数扩大到其它群或私聊，粗词重试也保持在同一范围。

### 来源化证据

`memory-evidence.js` 提供四个工具：

- `memory_evidence_add`
- `memory_evidence_query`
- `memory_evidence_correct`
- `memory_evidence_remove`

读写均以当前会话 scope 为边界。明确陈述、人工录入和平台回执可直接确认；模型推断只能成为候选。纠正生成新版本，删除保留墓碑，同内容不能被自动写回。

### 时间语义

- `personLastActiveAt`：人物最近出现时间。
- `lastConfirmedAt`：事实最近确认时间。
- `lastRetrievedAt`：事实最近读取时间。
- `lastSeen`：保留作旧数据兼容字段，不再由“人物出现”逐条刷新。

## 任务闭环

`task-ledger.js` 严格区分：

1. `proposed / pending`：计划或待提交。
2. `in_progress`：收到平台回执。
3. `completed`：有实际结果证据。
4. `result_unknown / failed / cancelled / expired`：没有足够证据或任务结束。

`memory_todo_save` 创建任务；`send_message(taskId=...)` 记录提交并用 OneBot `message_id` 确认平台回执；`memory_todo_done` 只有 `confirmed=true` 且带结果证据时才允许完成。

## 取消与超时

- 前置决策预算默认取 `localJev.gateBudgetMs`，兜底 1500ms。
- 整轮预算默认取 `api.runDeadlineMs`，兜底 120000ms。
- 前置预算耗尽只冻结前置决策，不结束整轮。
- 整轮截止后冻结运行并拒绝新的外部动作。
