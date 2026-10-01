#!/bin/bash
# Installs the latest Shlen Box from GitHub on the server, keeping all data.
# First time, typed in the DigitalOcean console as root:
#   curl -fsSL https://raw.githubusercontent.com/colleenemaccallum/shlen-box/main/deploy/update.sh | bash
# After that, just:  shlen-update
# If the new version doesn't start, the previous one is put back automatically.
set -euo pipefail
REPO=colleenemaccallum/shlen-box
APP=/opt/shlen-box
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "Downloading the latest Shlen Box..."
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$WORK" --strip-components=1
VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/commits/main" | grep -m1 '"sha"' | cut -d'"' -f4 | cut -c1-7 || true)

echo "Installing..."
rm -rf "$WORK/test"
cd "$WORK" && npm ci --omit=dev --no-audit --no-fund >/dev/null
echo "${VERSION:-unknown} $(date -u +%F)" > "$WORK/VERSION"
chown -R root:root "$WORK"
# mktemp makes a private folder; the app runs as the shlen user, so it must be readable.
chmod 755 "$WORK"

rm -rf "$APP.previous"
mv "$APP" "$APP.previous"
cp -a "$WORK" "$APP"
systemctl restart shlen-box

for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:8080/api/setup >/dev/null; then
    install -m 755 "$APP/deploy/update.sh" /usr/local/bin/shlen-update
    echo "Shlen Box is updated (version ${VERSION:-unknown}). Your messages are untouched."
    exit 0
  fi
  sleep 2
done

echo "The new version didn't start, so the previous version is being put back."
rm -rf "$APP" && mv "$APP.previous" "$APP"
systemctl restart shlen-box
exit 1
