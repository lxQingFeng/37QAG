#!/usr/bin/env bash
# 双号启动（Linux/macOS 版）—— 账号 A 桌面/本机，账号 B 第二实例（data-2/）。
# 等价于 Windows 的「启动-双号.bat」。
cd "$(dirname "$0")"
mkdir -p data/logs data-2/logs
QQ_AGENT_PROFILE=2 nohup node scripts/start.mjs --headless >> data-2/logs/launch.log 2>&1 &
echo "[双号] 账号 B 已后台启动（数据目录 data-2/，日志 data-2/logs/launch.log）"
exec node scripts/start.mjs "$@"
