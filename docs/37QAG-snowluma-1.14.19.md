# SnowLuma 1.14.19 适配说明

37QAG 已完成 SnowLuma v1.14.19 的 OneBot 接口适配，同时保留对旧版接口的受控回退。

## 本次适配

- `get_forward_msg` 的 `id`、`message_id` 统一按 v1.14.19 要求传字符串。
- `get_msg.message_id` 严格使用非零整数，保留合法负数消息 ID。
- 合并转发发送优先使用统一接口 `send_forward_msg`。
- 只有协议端明确表示接口不存在时，才回退到 `send_group_forward_msg` / `send_private_forward_msg`，避免重复发送。
- 合并转发读取保留 forward 段 ID、正消息 ID 与负消息 ID 的自动找回顺序。
- OneBot 错误会同时展示 `message`、`msg`、`wording` 等字段，便于在后台日志定位严格参数校验问题。
- 多账号令牌同步同时参考 WebSocket 与 HTTP 端口，降低两个实例互相读取令牌的概率。
- 后台“QQ 连接”页显示 SnowLuma 版本与适配状态。

## 版本状态

- v1.14.19 及以上：显示“37QAG 最新兼容模式”。
- v1.14.13 至 v1.14.18：仍可运行，显示“兼容模式（保留旧接口回退）”。
- 更早版本：建议升级到 v1.14.19。

## 升级保护

升级 SnowLuma 时应保留：

- `snowluma/config/`
- `snowluma/data/`
- `snowluma/node.exe`
- `snowluma/native/`

替换程序构建文件前建议保留完整备份。37QAG 不会覆盖上述账号配置、登录数据和本地数据。
