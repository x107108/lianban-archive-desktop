#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [ "$(uname -s)" != Darwin ]; then echo '此入口用于 macOS。'; exit 1; fi
action="${1:-start}"
arch="$(uname -m)"
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
if [ ! -f MACOS_RUNTIME.sha256 ] || [ ! -f "vendor/python-macos-${arch}.tar.gz" ]; then
  echo '安装包与本机芯片不匹配。Apple 芯片请选择 arm64，Intel 请选择 x86_64。'; exit 1
fi
if [ ! -x .runtime/macos/python/bin/python3 ]; then
  /usr/bin/shasum -a 256 -c MACOS_RUNTIME.sha256
  mkdir -p .runtime/macos
  /usr/bin/tar -xzf "vendor/python-macos-${arch}.tar.gz" -C .runtime/macos
fi
exec .runtime/macos/python/bin/python3 launcher_macos.py "$action" "${@:2}"
