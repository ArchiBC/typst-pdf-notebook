#!/usr/bin/env bash
set -euo pipefail

# Test prerequisites only; keep the Node runtime isolated from other WSL projects.
runtime_root="$HOME/.cache/typst-note/runtime"
node_version="v24.22.1"
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) printf 'Unsupported WSL architecture\n' >&2; exit 1 ;;
esac
node_name="node-${node_version}-linux-${node_arch}"
mkdir -p "$runtime_root"
if [[ ! -x "$runtime_root/$node_name/bin/node" ]]; then
  curl -fL --retry 3 "https://nodejs.org/dist/${node_version}/${node_name}.tar.xz" -o "$runtime_root/$node_name.tar.xz"
  curl -fL --retry 3 "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "$runtime_root/SHASUMS256-${node_version}.txt"
  (cd "$runtime_root"; awk -v file="$node_name.tar.xz" '$2 == file { print }' "SHASUMS256-${node_version}.txt" | sha256sum -c -)
  tar -xf "$runtime_root/$node_name.tar.xz" -C "$runtime_root"
fi
export PATH="$runtime_root/$node_name/bin:$PATH"
apt_args=(apt-get -o Acquire::Retries=3)
if [[ "$EUID" -ne 0 ]]; then apt_args=(sudo "${apt_args[@]}"); fi
"${apt_args[@]}" update -qq
DEBIAN_FRONTEND=noninteractive "${apt_args[@]}" install -y --no-install-recommends \
  xvfb xauth libnss3 libasound2t64 libatk-bridge2.0-0t64 libx11-xcb1 libxkbfile1 libxss1 libxshmfence1
node --version
printf 'Node runtime: %s\n' "$runtime_root/$node_name/bin"
