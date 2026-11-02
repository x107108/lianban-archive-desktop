#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != Darwin ]; then echo '此入口仅用于 macOS。'; exit 1; fi
arch="$(uname -m)"
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
case "$arch" in arm64|x86_64) ;; *) echo '不支持此芯片。'; exit 1 ;; esac
base="${LIANBAN_INSTALL_DIR:-$HOME/Library/Application Support/LianbanArchive}"
if [ -e "$base" ] && [ ! -f "$base/managed-project.txt" ]; then
  if [ -n "$(ls -A "$base")" ]; then echo '指定目录未被本安装器管理，请另选空目录。'; exit 1; fi
fi
mkdir -p "$base/downloads" "$base/versions"
if [ -f "$base/managed-project.txt" ] && [ "$(cat "$base/managed-project.txt")" != lianban-archive-desktop-macos ]; then
  echo '目录属于其他项目，未进行安装。'; exit 1
fi
printf '%s\n' lianban-archive-desktop-macos > "$base/managed-project.txt"
work="$(mktemp -d "$base/downloads/install.XXXXXX")"
repo=https://github.com/x107108/lianban-archive-desktop
curl --fail --location --retry 2 --proto '=https' --tlsv1.2 "$repo/releases/latest/download/SHA256SUMS.txt" -o "$work/SHA256SUMS.txt"
line="$(grep -E "^[a-fA-F0-9]{64}  lianban-archive-desktop-v20[0-9]{2}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?-macos-${arch}\.tar\.gz$" "$work/SHA256SUMS.txt" || true)"
if [ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" != 1 ]; then echo '当前正式版本没有对应 Mac 安装包。'; exit 1; fi
hash="${line%%  *}"
name="${line#*  }"
version="${name#lianban-archive-desktop-v}"
version="${version%-macos-*}"
curl --fail --location --retry 2 --proto '=https' --tlsv1.2 "$repo/releases/download/v$version/$name" -o "$work/$name"
(cd "$work"; printf '%s  %s\n' "$hash" "$name" | /usr/bin/shasum -a 256 -c -)
stage="$(mktemp -d "$base/versions/${version}-${arch}.XXXXXX")"
/usr/bin/tar -xzf "$work/$name" -C "$stage"
root="$stage/lianban-archive-desktop"
"$root/launcher-macos.command" verify
"$root/.runtime/macos/python/bin/python3" "$root/macos_upgrade.py" "$base" "$@"
