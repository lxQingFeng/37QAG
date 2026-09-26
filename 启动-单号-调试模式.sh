#!/usr/bin/env bash
# 调试模式（Linux/macOS 版）—— 前台可见控制台跑单号，用于排错。
# 等价于 Windows 的「启动-单号-调试模式.bat」。
cd "$(dirname "$0")"
exec node scripts/start.mjs --debug --headless "$@"
