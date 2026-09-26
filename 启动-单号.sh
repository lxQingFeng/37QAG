#!/usr/bin/env bash
# QQ Agent 启动器（Linux/macOS 版）—— 启动账号 A（数据目录 data/）。
# 等价于 Windows 的「启动-单号.bat」，真实逻辑在 scripts/start.mjs。
# 日志：data/logs/launch.log（stdout/stderr 追加进去）
cd "$(dirname "$0")"
mkdir -p data/logs
exec node scripts/start.mjs "$@"
