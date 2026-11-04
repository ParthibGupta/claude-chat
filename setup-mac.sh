#!/bin/bash
# One-time setup to run parthib-claude on an always-on Mac.
# On Windows use setup-windows.ps1 instead.
# Usage: copy this folder (with .env) to the Mac, then: cd claude-chat && ./setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")"
BOT_DIR="$PWD"
LABEL="com.parthib.claude-chat"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "==> Homebrew, Node, git, gh"
if ! command -v brew >/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
brew install node git gh

echo "==> Claude Code"
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

echo "==> Bot dependencies"
npm install
mkdir -p "$HOME/projects"
[ -f .env ] || { echo "Missing .env (copy it from your laptop)"; exit 1; }

echo "==> GitHub login (pick your personal account, HTTPS, login with browser)"
gh auth status >/dev/null 2>&1 || gh auth login
gh auth setup-git

echo "==> Claude login"
if ! claude -p "reply ok" >/dev/null 2>&1; then
  echo "Claude isn't logged in yet. Run 'claude', type /login, finish in the browser, then /exit and re-run this script."
  exit 1
fi

echo "==> Keep the Mac awake, even with the lid closed (needs your password)"
sudo pmset -a sleep 0 disksleep 0 displaysleep 5 powernap 0
sudo pmset -a disablesleep 1

echo "==> Start the bot at login and restart it if it crashes"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>export PATH="\$HOME/.local/bin:\$PATH"; exec npm start</string></array>
  <key>WorkingDirectory</key><string>$BOT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BOT_DIR/bot.log</string>
  <key>StandardErrorPath</key><string>$BOT_DIR/bot.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 5
tail -5 bot.log
echo
echo "Done. Logs: tail -f $BOT_DIR/bot.log"
echo "Restart:    launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "Stop:       launchctl bootout gui/$(id -u)/$LABEL"
