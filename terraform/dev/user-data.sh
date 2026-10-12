#!/bin/bash
# Dormeto demo web server: a static page showing the instance ID and boot time.
set -euo pipefail

mkdir -p /srv/www

cat > /usr/local/bin/dormeto-demo-index <<'SCRIPT'
#!/bin/bash
set -euo pipefail
TOKEN=$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
ID=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
cat > /srv/www/index.html <<HTML
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dormeto demo</title></head>
<body><h1>Dormeto demo</h1><p>Instance <code>$ID</code> booted at <time>$(date -u +%Y-%m-%dT%H:%M:%SZ)</time>.</p></body></html>
HTML
SCRIPT
chmod 755 /usr/local/bin/dormeto-demo-index

cat > /etc/systemd/system/dormeto-demo.service <<'UNIT'
[Unit]
Description=Dormeto demo web server
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=/usr/local/bin/dormeto-demo-index
ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now dormeto-demo.service
