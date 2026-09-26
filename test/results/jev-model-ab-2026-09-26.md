# Jev 模型比较（2026-09-26）

范围：本次自建题库、当前 Windows 环境下的比较；只代表当前“该不该插嘴”链路，不代表模型绝对强弱。

题库：50 题（应接话 25 / 不应接话 25），使用线上 replyChanceGate 同一提示词与标签约束。

| 模型 | 类型/可用性 | 有效标签率 | 总准确率 | 应接话准确率 | 不应接话准确率 | 平均延迟 | P50 | P95 | Prompt tokens | Completion tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| qwen3.5-0.8b-q6k | 生成模型，可直接跑当前链路 | 100.0% | 90.0% | 100.0% | 80.0% | 576ms | 575ms | 600ms | 8387 | 100 |
| jev-v2b-q6k | BERT 分类/排序模型；缺 SLOT 映射 | N/A | N/A | N/A | N/A | 56ms（仅向量） | N/A | N/A | N/A | N/A |

## Jev V2B 结构检查

- 文件：`jev-v2b-Q6_K.gguf`，446.3 MiB。
- 元数据：bert / Jev V2B Hf / 训练上下文 512。
- 分类头：76 个输出，名称仅为 SLOT_0..SLOT_75（模型元数据未保存业务含义）。
- 向量接口可用：是，输出 1024 维；生成接口可用：否。
- 生成接口错误：{"error":{"code":500,"message":"the current context does not logits computation. skipping","type":"server_error"}}

## 结论

- 当前插嘴判定链路里，可直接使用且完成实测的是 `qwen3.5-0.8b-q6k`。
- 在当前插嘴判定任务中 Qwen3.5-0.8B 可直接运行并给出 YES/NO；jev-v2b 是缺少槽位映射的 BERT 分类器，当前不能直接替代或公平计分。
- 若要严格比较 Jev V2B 的 76 类分类能力，还需要它训练时的 SLOT_0..SLOT_75 业务映射或原始标签表；仅凭当前 GGUF 无法把分类结果翻译成 YES/NO。
