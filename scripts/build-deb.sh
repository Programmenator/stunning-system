#!/usr/bin/env bash
set -euo pipefail

APP_NAME="stunning-system"
ARCH="amd64"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")}"
BUILD_DIR="$ROOT_DIR/.debian-build"
PKG_DIR="$BUILD_DIR/${APP_NAME}_${VERSION}_${ARCH}"
OUT_DIR="$ROOT_DIR/dist"

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN" "$PKG_DIR/opt/$APP_NAME" "$PKG_DIR/usr/bin" "$PKG_DIR/lib/systemd/system"
mkdir -p "$OUT_DIR"

cd "$ROOT_DIR"
npm ci --omit=dev >/dev/null

cp package.json package-lock.json server.js README.md "$PKG_DIR/opt/$APP_NAME/"
cp -R src "$PKG_DIR/opt/$APP_NAME/src"
cp -R public "$PKG_DIR/opt/$APP_NAME/public"
cp -R node_modules "$PKG_DIR/opt/$APP_NAME/node_modules"

cat > "$PKG_DIR/DEBIAN/control" <<EOF
Package: $APP_NAME
Version: $VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Maintainer: Local User <local@example.com>
Depends: nodejs (>= 18)
Description: Local Ollama chat frontend with GPU, file search and SearXNG tooling
EOF

cat > "$PKG_DIR/usr/bin/$APP_NAME" <<'EOF'
#!/usr/bin/env bash
cd /opt/stunning-system
exec node server.js
EOF
chmod 0755 "$PKG_DIR/usr/bin/$APP_NAME"

cat > "$PKG_DIR/lib/systemd/system/$APP_NAME.service" <<'EOF'
[Unit]
Description=stunning-system local Ollama chat app
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/stunning-system
ExecStart=/usr/bin/stunning-system
Restart=on-failure
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

cat > "$PKG_DIR/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -e
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  echo "stunning-system installed. To run as a service:"
  echo "  sudo systemctl enable --now stunning-system"
fi
echo "Run manually with: stunning-system"
EOF
chmod 0755 "$PKG_DIR/DEBIAN/postinst"

cat > "$PKG_DIR/DEBIAN/prerm" <<'EOF'
#!/usr/bin/env bash
set -e
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop stunning-system >/dev/null 2>&1 || true
  systemctl disable stunning-system >/dev/null 2>&1 || true
fi
EOF
chmod 0755 "$PKG_DIR/DEBIAN/prerm"

cat > "$PKG_DIR/DEBIAN/postrm" <<'EOF'
#!/usr/bin/env bash
set -e
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
EOF
chmod 0755 "$PKG_DIR/DEBIAN/postrm"

dpkg-deb --build "$PKG_DIR" "$OUT_DIR/${APP_NAME}_${VERSION}_${ARCH}.deb" >/dev/null

echo "Built: $OUT_DIR/${APP_NAME}_${VERSION}_${ARCH}.deb"
