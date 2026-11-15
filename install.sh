#!/usr/bin/env bash
set -euo pipefail

# Awesome Pi Agent - Linux & macOS Installer (parallel prebuilt download, source fallback)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.sh | bash
#   PI_FORCE_SOURCE=1 curl -fsSL ... | bash

REPO_OWNER="Gl1ch5555"
REPO_NAME="awesome-pi-agent"
CMD_NAME="pi-awesome"
INSTALL_ROOT="${PI_INSTALL_DIR:-$HOME/.pi-awesome}"
APP_DIR="$INSTALL_ROOT/app"
SRC_DIR="$INSTALL_ROOT/src"
BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"
TOKEN="${PI_GH_TOKEN:-${GITHUB_TOKEN:-${1:-}}}"
FORCE_SOURCE="${PI_FORCE_SOURCE:-0}"
DL_PARTS="${PI_DL_PARTS:-4}"

# Graphite ANSI palette
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_DIM="\033[38;5;242m"
C_TEXT="\033[38;5;252m"
C_ACCENT="\033[38;5;250m"
C_OK="\033[38;5;108m"
C_WARN="\033[38;5;180m"
C_ERR="\033[38;5;174m"

STARTED_AT="$(date +%s)"

step() {
  printf "\n${C_ACCENT}${C_BOLD}[%s]${C_RESET} ${C_TEXT}%s${C_RESET}\n" "$1" "$2"
}

info() {
  printf "  ${C_DIM}--${C_RESET} ${C_TEXT}%s${C_RESET}\n" "$1"
}

ok() {
  printf "  ${C_OK}ok${C_RESET} %s\n" "$1"
}

warn() {
  printf "  ${C_WARN}warn${C_RESET} %s\n" "$1"
}

fail() {
  printf "\n  ${C_ERR}error${C_RESET} %s\n\n" "$1" >&2
  exit 1
}

file_size() {
  if [ -f "$1" ]; then
    wc -c < "$1" | tr -d '[:space:]'
  else
    printf "0"
  fi
}

fmt_mb1() {
  local bytes="${1:-0}"
  local tenths=$(( (bytes * 10 + 524288) / 1048576 ))
  printf "%d.%d" $((tenths / 10)) $((tenths % 10))
}

now_ms() {
  if date +%s%3N 2>/dev/null | grep -qE '^[0-9]+$'; then
    date +%s%3N
  else
    printf "%s000" "$(date +%s)"
  fi
}

render_progress_bar() {
  local done_bytes="$1"
  local total_bytes="$2"
  local elapsed_ms="$3"
  local cols="${COLUMNS:-0}"
  if [ "$cols" -le 0 ] 2>/dev/null; then
    cols="$(tput cols 2>/dev/null || echo 64)"
  fi

  local pct=0
  if [ "$total_bytes" -gt 0 ]; then
    pct=$(( done_bytes * 100 / total_bytes ))
    [ "$pct" -gt 100 ] && pct=100
  fi

  local bar_w=22
  if [ "$cols" -lt 52 ]; then
    bar_w=10
  elif [ "$cols" -lt 66 ]; then
    bar_w=16
  fi

  local filled=$(( pct * bar_w / 100 ))
  local empty=$(( bar_w - filled ))
  local fill_str=""
  local empty_str=""
  local i=0
  while [ "$i" -lt "$filled" ]; do fill_str="${fill_str}█"; i=$((i + 1)); done
  i=0
  while [ "$i" -lt "$empty" ]; do empty_str="${empty_str}░"; i=$((i + 1)); done

  local done_mb total_mb speed_str=""
  done_mb="$(fmt_mb1 "$done_bytes")"
  total_mb="$(fmt_mb1 "$total_bytes")"
  if [ "$elapsed_ms" -gt 200 ] && [ "$done_bytes" -gt 0 ]; then
    local bps=$(( done_bytes * 1000 / elapsed_ms ))
    local spd_tenths=$(( (bps * 10 + 524288) / 1048576 ))
    speed_str=" $((spd_tenths / 10)).$((spd_tenths % 10)) MB/s"
  fi

  if [ "$cols" -lt 50 ]; then
    printf "\r\033[2K  ${C_ACCENT}[%s%s]${C_RESET} ${C_TEXT}%3d%%${C_RESET} ${C_DIM}%s/%sM%s${C_RESET}" \
      "$fill_str" "$empty_str" "$pct" "$done_mb" "$total_mb" "$speed_str"
  else
    printf "\r\033[2K  ${C_ACCENT}[%s%s]${C_RESET} ${C_TEXT}%3d%%${C_RESET} ${C_DIM}%s / %s MB%s${C_RESET}" \
      "$fill_str" "$empty_str" "$pct" "$done_mb" "$total_mb" "$speed_str"
  fi
}

printf "\n${C_TEXT}${C_BOLD}  awesome-pi-agent${C_RESET} ${C_DIM}:: installer (linux/macos)${C_RESET}\n"
printf "${C_DIM}  ------------------------------------------------${C_RESET}\n"

step "1/3" "Detecting platform & requirements"

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Linux)  PLATFORM_OS="linux" ;;
  Darwin) PLATFORM_OS="darwin" ;;
  *) fail "Unsupported OS: $OS_RAW" ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64) PLATFORM_ARCH="x64" ;;
  arm64|aarch64) PLATFORM_ARCH="arm64" ;;
  *) fail "Unsupported CPU architecture: $ARCH_RAW" ;;
esac

ASSET_NAME="pi-${PLATFORM_OS}-${PLATFORM_ARCH}.tar.gz"
RELEASE_BASE="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/latest"

ok "platform ${PLATFORM_OS}-${PLATFORM_ARCH}"
info "install dir: $INSTALL_ROOT"
info "command:     $CMD_NAME"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CURL_AUTH=()
if [ -n "$TOKEN" ]; then
  CURL_AUTH=(-H "Authorization: token ${TOKEN}")
fi

VERSION_TMP="$TMP_DIR/version.json"
curl -fsSL --http1.1 --connect-timeout 10 "${CURL_AUTH[@]}" "${RELEASE_BASE}/version.json" -o "$VERSION_TMP" 2>/dev/null &
VERSION_PID=$!

download_range_chunk() {
  local url="$1"
  local start="$2"
  local end="$3"
  local dest="$4"
  local expected=$(( end - start + 1 ))
  local max_attempts=8
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    local have
    have="$(file_size "$dest")"
    if [ "$have" -ge "$expected" ]; then
      if [ "$have" -gt "$expected" ]; then
        rm -f "$dest"
        have=0
      else
        return 0
      fi
    fi

    local req_start=$(( start + have ))
    if curl -fsSL --http1.1 --connect-timeout 15 --speed-limit 1024 --speed-time 20 \
      "${CURL_AUTH[@]}" \
      -r "${req_start}-${end}" "$url" >> "$dest" 2>/dev/null; then
      have="$(file_size "$dest")"
      if [ "$have" -eq "$expected" ]; then
        return 0
      fi
    fi

    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

download_single_with_resume() {
  local url="$1"
  local dest="$2"
  local total_hint="${3:-0}"
  local max_attempts=8
  local attempt=1
  local t0
  t0="$(now_ms)"

  while [ "$attempt" -le "$max_attempts" ]; do
    curl -fsSL --http1.1 -C - --connect-timeout 20 --speed-limit 1024 --speed-time 25 \
      "${CURL_AUTH[@]}" \
      "$url" -o "$dest" >/dev/null 2>&1 &
    local pid=$!

    while kill -0 "$pid" 2>/dev/null; do
      if [ "$total_hint" -gt 0 ]; then
        local cur elapsed
        cur="$(file_size "$dest")"
        elapsed=$(( $(now_ms) - t0 ))
        render_progress_bar "$cur" "$total_hint" "$elapsed"
      fi
      sleep 0.2
    done

    local rc=0
    wait "$pid" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ "$total_hint" -gt 0 ]; then
        local final_sz elapsed
        final_sz="$(file_size "$dest")"
        elapsed=$(( $(now_ms) - t0 ))
        render_progress_bar "$final_sz" "$total_hint" "$elapsed"
        printf "\n"
      fi
      return 0
    fi
    if [ "$rc" -eq 33 ]; then
      rm -f "$dest"
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      printf "\r\033[2K"
      warn "Download interrupted (curl exit ${rc}), resuming (${attempt}/${max_attempts})..."
      sleep 2
    fi
    attempt=$((attempt + 1))
  done
  printf "\n"
  return 1
}

download_parallel_prebuilt() {
  local url="$1"
  local dest="$2"
  local parts="$DL_PARTS"

  local probe_headers
  probe_headers="$(curl -fsSLI --http1.1 --connect-timeout 15 "${CURL_AUTH[@]}" "$url" 2>/dev/null || true)"
  local effective_url total_size accept_ranges
  effective_url="$(curl -fsSLI --http1.1 --connect-timeout 15 -o /dev/null -w '%{url_effective}' "${CURL_AUTH[@]}" "$url" 2>/dev/null || printf "%s" "$url")"
  total_size="$(printf "%s\n" "$probe_headers" | tr -d '\r' | awk 'tolower($1)=="content-length:"{val=$2} END{print val+0}')"
  accept_ranges="$(printf "%s\n" "$probe_headers" | tr -d '\r' | awk 'tolower($1)=="accept-ranges:"{val=tolower($2)} END{print val}')"

  if [ -z "$total_size" ] || [ "$total_size" -lt 4194304 ] || [ "$accept_ranges" != "bytes" ] || [ "$parts" -le 1 ]; then
    download_single_with_resume "$effective_url" "$dest" "${total_size:-0}"
    return $?
  fi

  info "Parallel download (${parts} streams · $(fmt_mb1 "$total_size") MB)"

  local part_dir="$TMP_DIR/parts"
  mkdir -p "$part_dir"
  local chunk_size=$(( total_size / parts ))
  local pids=()
  local idx=0
  local t0
  t0="$(now_ms)"

  while [ "$idx" -lt "$parts" ]; do
    local p_start=$(( idx * chunk_size ))
    local p_end
    if [ "$idx" -eq $(( parts - 1 )) ]; then
      p_end=$(( total_size - 1 ))
    else
      p_end=$(( p_start + chunk_size - 1 ))
    fi
    local p_file="$part_dir/part.${idx}"
    : > "$p_file"
    download_range_chunk "$effective_url" "$p_start" "$p_end" "$p_file" &
    pids+=("$!")
    idx=$((idx + 1))
  done

  while :; do
    local alive=0
    local sum=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive=1
      fi
    done
    idx=0
    while [ "$idx" -lt "$parts" ]; do
      sum=$(( sum + $(file_size "$part_dir/part.${idx}") ))
      idx=$((idx + 1))
    done
    local elapsed=$(( $(now_ms) - t0 ))
    render_progress_bar "$sum" "$total_size" "$elapsed"
    if [ "$alive" -eq 0 ]; then
      break
    fi
    sleep 0.2
  done

  local all_ok=1
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      all_ok=0
    fi
  done

  local final_sum=0
  idx=0
  while [ "$idx" -lt "$parts" ]; do
    final_sum=$(( final_sum + $(file_size "$part_dir/part.${idx}") ))
    idx=$((idx + 1))
  done

  if [ "$all_ok" -eq 1 ] && [ "$final_sum" -eq "$total_size" ]; then
    local elapsed=$(( $(now_ms) - t0 ))
    render_progress_bar "$total_size" "$total_size" "$elapsed"
    printf "\n"
    cat "$part_dir"/part.* > "$dest"
    return 0
  fi

  printf "\n"
  warn "Parallel stream hit a drop, falling back to single resumable stream..."
  rm -rf "$part_dir"
  download_single_with_resume "$url" "$dest" "$total_size"
}

PREBUILT_OK=0
if [ "$FORCE_SOURCE" != "1" ]; then
  step "2/3" "Downloading prebuilt binary (${ASSET_NAME})"
  ARCHIVE_PATH="$TMP_DIR/$ASSET_NAME"

  if download_parallel_prebuilt "${RELEASE_BASE}/${ASSET_NAME}" "$ARCHIVE_PATH"; then
    STAGE_DIR="$TMP_DIR/stage"
    mkdir -p "$STAGE_DIR"
    info "Extracting archive..."
    if tar -xzf "$ARCHIVE_PATH" -C "$STAGE_DIR" && [ -x "$STAGE_DIR/pi/pi" ]; then
      rm -rf "$APP_DIR"
      mv "$STAGE_DIR/pi" "$APP_DIR"
      chmod +x "$APP_DIR/pi"
      PREBUILT_OK=1
      ok "Installed prebuilt binary into $APP_DIR"
    else
      warn "Prebuilt archive extraction failed, falling back to source build..."
    fi
  else
    if [ "${PI_PREBUILT_ONLY:-0}" = "1" ]; then
      fail "Failed to download prebuilt release (${ASSET_NAME}) after multiple attempts."
    fi
    warn "Prebuilt release download failed after retries, falling back to source build..."
  fi
fi

TARGET_BIN="$BIN_DIR/$CMD_NAME"

if [ "$PREBUILT_OK" -eq 1 ]; then
  step "3/3" "Linking ${CMD_NAME} & saving version metadata"
  cat > "$TARGET_BIN" <<EOF
#!/usr/bin/env bash
exec "$APP_DIR/pi" "\$@"
EOF
  chmod +x "$TARGET_BIN"
  ok "Installed $TARGET_BIN"

  if [ -w /usr/local/bin ] && [ "$BIN_DIR" != "/usr/local/bin" ]; then
    ln -sf "$TARGET_BIN" "/usr/local/bin/$CMD_NAME"
    ok "Linked /usr/local/bin/$CMD_NAME"
  fi

  wait "$VERSION_PID" 2>/dev/null || true
  if [ -s "$VERSION_TMP" ]; then
    mv "$VERSION_TMP" "$INSTALL_ROOT/version.json"
  else
    printf '{"version":"1.5.2","tag":"latest","updatedAt":%s}\n' "$(date +%s000)" > "$INSTALL_ROOT/version.json"
  fi
else
  wait "$VERSION_PID" 2>/dev/null || true
  step "2/3" "Building from source (Node.js >= 22.19 required)"
  command -v node >/dev/null 2>&1 || fail "Node.js >= 22.19 is required for source fallback."
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    fail "Node.js >= 22.19.0 is required (found v${NODE_VER})."
  fi

  TARBALL_FILE="$TMP_DIR/repo.tar.gz"
  if [ -n "$TOKEN" ]; then
    curl -fSL --http1.1 --retry 5 --retry-delay 2 --connect-timeout 20 \
      -H "Authorization: token ${TOKEN}" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tarball/main" -o "$TARBALL_FILE"
  else
    curl -fSL --http1.1 --retry 5 --retry-delay 2 --connect-timeout 20 \
      "https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/main.tar.gz" -o "$TARBALL_FILE"
  fi

  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  tar -xzf "$TARBALL_FILE" --strip-components=1 -C "$SRC_DIR"

  cd "$SRC_DIR"
  npm install --ignore-scripts --no-audit --no-fund
  npm run hydrate:model-data || warn "Online model catalog refresh skipped (using bundled models)"
  npm run build:offline

  step "3/3" "Installing ${CMD_NAME} command"
  CLI_ENTRY="$SRC_DIR/packages/coding-agent/dist/bundle/cli.js"
  [ -f "$CLI_ENTRY" ] || fail "Build artifact missing: $CLI_ENTRY"
  chmod +x "$CLI_ENTRY"

  cat > "$TARGET_BIN" <<EOF
#!/usr/bin/env bash
exec node "$CLI_ENTRY" "\$@"
EOF
  chmod +x "$TARGET_BIN"
  ok "Installed $TARGET_BIN"

  if [ -w /usr/local/bin ] && [ "$BIN_DIR" != "/usr/local/bin" ]; then
    ln -sf "$TARGET_BIN" "/usr/local/bin/$CMD_NAME"
    ok "Linked /usr/local/bin/$CMD_NAME"
  fi

  node -e '
  const fs = require("fs");
  const path = require("path");
  const pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], "packages/coding-agent/package.json"), "utf8"));
  fetch("https://api.github.com/repos/Gl1ch5555/awesome-pi-agent/commits/main", {
    headers: { "User-Agent": "awesome-pi-agent-installer", "Accept": "application/vnd.github+json" },
    signal: AbortSignal.timeout(5000)
  }).then(r => r.ok ? r.json() : null).then(d => {
    if (d && d.sha) {
      fs.writeFileSync(path.join(process.argv[2], "version.json"), JSON.stringify({ sha: d.sha, version: pkg.version, updatedAt: Date.now() }, null, 2) + "\n");
    }
  }).catch(() => {});
  ' "$SRC_DIR" "$INSTALL_ROOT" >/dev/null 2>&1 || true
fi

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:" && [ ! -w /usr/local/bin ]; then
  warn "$BIN_DIR is not in your PATH. Add this to ~/.bashrc or ~/.zshrc:"
  printf "     ${C_ACCENT}export PATH=\"%s:\$PATH\"${C_RESET}\n" "$BIN_DIR"
fi

if [ "$PLATFORM_OS" = "linux" ]; then
  if ! command -v parecord >/dev/null 2>&1 && ! command -v arecord >/dev/null 2>&1 && ! command -v ffmpeg >/dev/null 2>&1 && ! command -v sox >/dev/null 2>&1; then
    warn "No audio recorder found for Hold-Space voice input. Install one of: pulseaudio-utils (parecord), alsa-utils (arecord), ffmpeg, or sox."
  fi
fi

ELAPSED_SEC=$(( $(date +%s) - STARTED_AT ))
printf "\n${C_OK}${C_BOLD}  Done${C_RESET} ${C_DIM}(${ELAPSED_SEC}s).${C_RESET} ${C_TEXT}Run '${C_BOLD}${CMD_NAME}${C_RESET}${C_TEXT}' to launch.${C_RESET}\n\n"
