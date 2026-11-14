#!/usr/bin/env bash
set -euo pipefail

# Awesome Pi Agent - Linux & macOS Installer
# Usage:
#   PI_GH_TOKEN=ghp_xxx curl -fsSL -H "Authorization: token ghp_xxx" \
#     https://raw.githubusercontent.com/Gl1ch5555/awesome-pi-agent/main/install.sh | bash

REPO_OWNER="Gl1ch5555"
REPO_NAME="awesome-pi-agent"
INSTALL_ROOT="${PI_INSTALL_DIR:-$HOME/.awesome-pi-agent}"
SRC_DIR="$INSTALL_ROOT/src"
BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"
TOKEN="${PI_GH_TOKEN:-${GITHUB_TOKEN:-${1:-}}}"

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

step "1/4" "Checking runtime requirements"

command -v git >/dev/null 2>&1 || fail "git is not installed. Please install git first."
ok "git $(git --version | awk '{print $3}')"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js >= 22.19 is required. Install Node.js 22+ and re-run."
fi

NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  fail "Node.js >= 22.19.0 is required (found v${NODE_VER})."
fi
ok "node v${NODE_VER}"

step "2/4" "Fetching ${REPO_OWNER}/${REPO_NAME}"

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
if [ -n "$TOKEN" ]; then
  AUTH_URL="https://x-access-token:${TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git"
else
  AUTH_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
fi
CLEAN_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"

if [ -d "$SRC_DIR/.git" ]; then
  info "Updating existing checkout in $SRC_DIR"
  git -C "$SRC_DIR" remote set-url origin "$AUTH_URL"
  git -C "$SRC_DIR" fetch --depth 1 origin main
  git -C "$SRC_DIR" reset --hard origin/main
  git -C "$SRC_DIR" remote set-url origin "$CLEAN_URL"
else
  rm -rf "$SRC_DIR"
  info "Cloning repository into $SRC_DIR"
  git clone --depth 1 "$AUTH_URL" "$SRC_DIR"
  git -C "$SRC_DIR" remote set-url origin "$CLEAN_URL"
fi
ok "Source ready"

step "3/4" "Installing dependencies & building pi"

cd "$SRC_DIR"
info "npm install --ignore-scripts"
npm install --ignore-scripts --no-audit --no-fund
info "Building workspace packages"
npm run build:offline
ok "Build complete"

step "4/4" "Installing pi binary"

CLI_ENTRY="$SRC_DIR/packages/coding-agent/dist/bundle/cli.js"
[ -f "$CLI_ENTRY" ] || fail "Build artifact missing: $CLI_ENTRY"
chmod +x "$CLI_ENTRY"

TARGET_BIN="$BIN_DIR/pi"
cat > "$TARGET_BIN" <<EOF
#!/usr/bin/env bash
exec node "$CLI_ENTRY" "\$@"
EOF
chmod +x "$TARGET_BIN"
ok "Installed $TARGET_BIN"

if [ -w /usr/local/bin ] && [ "$BIN_DIR" != "/usr/local/bin" ]; then
  ln -sf "$TARGET_BIN" /usr/local/bin/pi
  ok "Linked /usr/local/bin/pi"
fi

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  warn "$BIN_DIR is not in your PATH. Add this to ~/.bashrc or ~/.zshrc:"
  printf "     ${C_ACCENT}export PATH=\"%s:\$PATH\"${C_RESET}\n" "$BIN_DIR"
fi

if [ "$(uname -s)" = "Linux" ]; then
  if ! command -v parecord >/dev/null 2>&1 && ! command -v arecord >/dev/null 2>&1 && ! command -v ffmpeg >/dev/null 2>&1 && ! command -v sox >/dev/null 2>&1; then
    warn "No audio recorder found for Hold-Space voice input. Install one of: pulseaudio-utils (parecord), alsa-utils (arecord), ffmpeg, or sox."
  fi
fi

printf "\n${C_OK}${C_BOLD}  Done.${C_RESET} ${C_TEXT}Run '${C_BOLD}pi${C_RESET}${C_TEXT}' to launch.${C_RESET}\n\n"
