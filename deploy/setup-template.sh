#!/bin/bash
# Shlen Box server setup. Paste this whole file into "User data" (Advanced options) when creating the
# DigitalOcean Droplet. It runs once, as the server starts for the first time.
#
# >>> The only thing to change: paste your Tailscale auth key between the quotes on the next line. <<<
TAILSCALE_AUTH_KEY="PASTE-YOUR-TAILSCALE-KEY-HERE"
#
# What it does: installs security updates (and keeps installing them), Node.js, Tailscale and the app;
# blocks all other incoming traffic; publishes the app at its https://…ts.net link through Tailscale
# Funnel (a normal web link, no Tailscale needed on phones; approved 2026-09-30); and keeps a nightly
# copy of the database for 14 days.
set -euo pipefail
exec > /var/log/shlen-setup.log 2>&1
echo "Shlen Box setup started $(date -u)"
export DEBIAN_FRONTEND=noninteractive

# 1. Memory headroom for the small server
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

# 2. Updates, now and automatically from here on (restarting at 04:30 when an update needs it)
apt-get update
apt-get -y upgrade
apt-get -y install unattended-upgrades ufw curl xz-utils sqlite3 ca-certificates
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52shlen-box <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
CONF

# 3. Firewall: nothing gets in from the public internet. Tailscale is the only way in.
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 41641/udp
ufw --force enable

# 4. Node.js 22 (official build, checked against its published checksum)
cd /tmp
NODE_DIR=https://nodejs.org/dist/latest-v22.x
curl -fsSLO "$NODE_DIR/SHASUMS256.txt"
NODE_TAR=$(grep -o 'node-v22[0-9.]*-linux-x64.tar.xz' SHASUMS256.txt | head -1)
curl -fsSLO "$NODE_DIR/$NODE_TAR"
grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$NODE_TAR" -C /usr/local --strip-components=1
node --version

# 5. The app (bundled below), run by its own user with no login
id shlen >/dev/null 2>&1 || useradd --system --home /var/lib/shlen-box --shell /usr/sbin/nologin shlen
install -d -o shlen -g shlen -m 700 /var/lib/shlen-box /var/lib/shlen-box/backups
rm -rf /opt/shlen-box && mkdir -p /opt/shlen-box
sed -n '/^__APP_BUNDLE__$/,$p' "$0" | tail -n +2 | base64 -d | tar -xJ -C /opt/shlen-box
cd /opt/shlen-box && npm ci --omit=dev --no-audit --no-fund
chown -R root:root /opt/shlen-box

# 6. Tailscale, and HTTPS inside the Tailscale network
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey="$TAILSCALE_AUTH_KEY" --hostname=shlen-box
for i in $(seq 1 30); do
  HOSTNAME_TS=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).Self.DNSName||"").replace(/\.$/,"")))')
  [ -n "$HOSTNAME_TS" ] && break; sleep 2
done
echo "Address: https://$HOSTNAME_TS"

cat > /etc/shlen-box.env <<CONF
SHLEN_DB=/var/lib/shlen-box/shlen-box.db
HOST=127.0.0.1
PORT=8080
ORIGIN=https://$HOSTNAME_TS
CONTACT=https://$HOSTNAME_TS
SECURE=1
CONF
chmod 600 /etc/shlen-box.env

cat > /etc/systemd/system/shlen-box.service <<'CONF'
[Unit]
Description=Shlen Box
After=network-online.target
[Service]
User=shlen
EnvironmentFile=/etc/shlen-box.env
WorkingDirectory=/opt/shlen-box
ExecStart=/usr/local/bin/node --no-warnings=ExperimentalWarning /opt/shlen-box/server/index.js
Restart=always
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/shlen-box
[Install]
WantedBy=multi-user.target
CONF

# 7. Nightly database copy at 03:30, kept 14 days (DigitalOcean's weekly backups copy the whole server)
cat > /usr/local/bin/shlen-backup <<'CONF'
#!/bin/sh
set -e
sqlite3 /var/lib/shlen-box/shlen-box.db ".backup '/var/lib/shlen-box/backups/shlen-box-$(date +%F).db'"
find /var/lib/shlen-box/backups -name 'shlen-box-*.db' -mtime +14 -delete
CONF
chmod 755 /usr/local/bin/shlen-backup
cat > /etc/systemd/system/shlen-backup.service <<'CONF'
[Service]
Type=oneshot
User=shlen
ExecStart=/usr/local/bin/shlen-backup
CONF
cat > /etc/systemd/system/shlen-backup.timer <<'CONF'
[Timer]
OnCalendar=*-*-* 03:30
Persistent=true
[Install]
WantedBy=timers.target
CONF

systemctl daemon-reload
systemctl enable --now shlen-box.service shlen-backup.timer
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8080/api/setup >/dev/null && break; sleep 2; done
# Public link. If Tailscale hasn't allowed Funnel yet, the app starts private (Tailscale phones only)
# and the server keeps trying every 5 minutes, so allowing Funnel in the Tailscale admin is enough.
cat > /usr/local/bin/shlen-funnel <<'CONF'
#!/bin/sh
timeout 30 tailscale funnel --bg http://127.0.0.1:8080 </dev/null && systemctl disable --now shlen-funnel.timer
CONF
chmod 755 /usr/local/bin/shlen-funnel
cat > /etc/systemd/system/shlen-funnel.service <<'CONF'
[Service]
Type=oneshot
ExecStart=/usr/local/bin/shlen-funnel
CONF
cat > /etc/systemd/system/shlen-funnel.timer <<'CONF'
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
CONF
systemctl daemon-reload
if timeout 30 tailscale funnel --bg http://127.0.0.1:8080 </dev/null; then
  echo "Shlen Box setup finished $(date -u). Open https://$HOSTNAME_TS on any phone."
else
  tailscale serve --bg http://127.0.0.1:8080
  systemctl enable --now shlen-funnel.timer
  echo "Funnel not allowed yet: private for now at https://$HOSTNAME_TS, retrying every 5 minutes."
fi
exit 0
__APP_BUNDLE__
