#!/usr/bin/env bash
set -euo pipefail

# Awesome Pi Agent - Linux & macOS Installer (prebuilt binary first, source fallback)
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

# Graphite ANSI palette
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_DIM="\033[38;5;242m"
C_TEXT="\033[38;5;252m"
C_ACCENT="\033[38;5;250m"
C_OK="\033[38;5;108m"
C_WARN="\033[38;5;180m"
C_ERR="\033[38;5;174m"

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

PREBUILT_OK=0
if [ "$FORCE_SOURCE" != "1" ]; then
  step "2/3" "Downloading prebuilt binary (${ASSET_NAME})"
  ARCHIVE_PATH="$TMP_DIR/$ASSET_NAME"
  CURL_AUTH=()
  if [ -n "$TOKEN" ]; then
    CURL_AUTH=(-H "Authorization: token ${TOKEN}")
  fi

  if curl -fSL --http1.1 --retry 4 --retry-delay 2 --connect-timeout 20 \
    "${CURL_AUTH[@]}" \
    "${RELEASE_BASE}/${ASSET_NAME}" -o "$ARCHIVE_PATH"; then
    STAGE_DIR="$TMP_DIR/stage"
    mkdir -p "$STAGE_DIR"
    tar -xzf "$ARCHIVE_PATH" -C "$STAGE_DIR"
    if [ -x "$STAGE_DIR/pi/pi" ]; then
      rm -rf "$APP_DIR"
      mv "$STAGE_DIR/pi" "$APP_DIR"
      chmod +x "$APP_DIR/pi"
      PREBUILT_OK=1
      ok "Installed prebuilt binary into $APP_DIR"
    else
      warn "Prebuilt archive layout unexpected, falling back to source build..."
    fi
  else
    warn "Prebuilt release not available yet, falling back to source build..."
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

  if ! curl -fsSL --http1.1 --connect-timeout 10 "${RELEASE_BASE}/version.json" -o "$INSTALL_ROOT/version.json" 2>/dev/null; then
    printf '{"version":"1.5.2","tag":"latest","updatedAt":%s}\n' "$(date +%s000)" > "$INSTALL_ROOT/version.json"
  fi
else
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

printf "\n${C_OK}${C_BOLD}  Done.${C_RESET} ${C_TEXT}Run '${C_BOLD}${CMD_NAME}${C_RESET}${C_TEXT}' to launch.${C_RESET}\n\n"
