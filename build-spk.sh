#!/usr/bin/env bash
set -euo pipefail

VERSION=$(cat VERSION)
PACKAGE="deduplicator"
ARCH="x86_64"
SPK_NAME="${PACKAGE}-${VERSION}.spk"
WORK_DIR=$(mktemp -d)

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "Building ${SPK_NAME}..."

# Compile static binary for linux/amd64
echo "Compiling Go binary..."
mkdir -p "${WORK_DIR}/pkg/bin"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
    go build -ldflags "-X main.version=${VERSION}" \
    -o "${WORK_DIR}/pkg/bin/deduplicator" .

# Create package.tgz — extracted by DSM to /var/packages/deduplicator/target/
tar -czf "${WORK_DIR}/package.tgz" -C "${WORK_DIR}/pkg" bin/

# INFO file — package metadata read by DSM Package Center
cat > "${WORK_DIR}/INFO" <<EOF
package="${PACKAGE}"
version="${VERSION}-0001"
maintainer="Dominik"
description="Find and remove duplicate photos"
displayname="Deduplicator"
os_min_ver="7.0-40000"
arch="${ARCH}"
adminport="5090"
adminprotocol="http"
adminurl="/"
EOF

# conf/privilege — tells DSM the package does not run as root
mkdir -p "${WORK_DIR}/conf"
cat > "${WORK_DIR}/conf/privilege" <<'PRIVILEGE'
{
  "defaults": {
    "run-as": "package"
  }
}
PRIVILEGE

# Install wizard — shown by Package Center during installation
mkdir -p "${WORK_DIR}/WIZARD_UIFILES"
cat > "${WORK_DIR}/WIZARD_UIFILES/install_uifile" <<'WIZARD'
[
  {
    "step_title": "Deduplicator Setup",
    "items": [
      {
        "type": "textfield",
        "desc": "Root path of your photo library on the NAS",
        "subitems": [
          {
            "key": "wizard_mount_root",
            "desc": "Photo library path",
            "defaultValue": "/volume1",
            "validator": { "allowBlank": false }
          }
        ]
      },
      {
        "type": "textfield",
        "desc": "Recycle bin path for deleted duplicates (leave empty to disable)",
        "subitems": [
          {
            "key": "wizard_recycle_bin",
            "desc": "Recycle bin path",
            "defaultValue": ""
          }
        ]
      }
    ]
  }
]
WIZARD

# scripts — lifecycle scripts called by DSM
mkdir -p "${WORK_DIR}/scripts"

# postinst — saves wizard values to a config file after installation
cat > "${WORK_DIR}/scripts/postinst" <<'SCRIPT'
#!/bin/sh
DATA_DIR="/var/packages/deduplicator/var"
mkdir -p "${DATA_DIR}"
cat > "${DATA_DIR}/config" <<EOF
MOUNT_ROOT="${wizard_mount_root}"
RECYCLE_BIN="${wizard_recycle_bin}"
EOF
chmod a+rwx "${DATA_DIR}"
SCRIPT
chmod +x "${WORK_DIR}/scripts/postinst"

# start-stop-status — sources config written by postinst
cat > "${WORK_DIR}/scripts/start-stop-status" <<'SCRIPT'
#!/bin/sh
PACKAGE_DIR="/var/packages/deduplicator"
DATA_DIR="${PACKAGE_DIR}/var"
PID_FILE="${DATA_DIR}/deduplicator.pid"
LOG_FILE="${DATA_DIR}/deduplicator.log"
BINARY="${PACKAGE_DIR}/target/bin/deduplicator"
CONFIG="${DATA_DIR}/config"

[ -f "${CONFIG}" ] && . "${CONFIG}"

start() {
    mkdir -p "${DATA_DIR}"
    rm -f "${LOG_FILE}" "${PID_FILE}" 2>/dev/null || true
    MOUNT_ROOT="${MOUNT_ROOT:-/volume1}" \
    DATA_DIR="${DATA_DIR}" \
    PORT=5090 \
    RECYCLE_BIN="${RECYCLE_BIN}" \
    "${BINARY}" >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"
}

stop() {
    if [ -f "${PID_FILE}" ]; then
        kill "$(cat "${PID_FILE}")" 2>/dev/null || true
        rm -f "${PID_FILE}"
    fi
}

status() {
    if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
        exit 0
    else
        exit 1
    fi
}

case "$1" in
    start)  start  ;;
    stop)   stop   ;;
    status) status ;;
esac
SCRIPT
chmod +x "${WORK_DIR}/scripts/start-stop-status"

# Copy pre-generated package icons from resources/
cp resources/PACKAGE_ICON.PNG     "${WORK_DIR}/PACKAGE_ICON.PNG"
cp resources/PACKAGE_ICON_256.PNG "${WORK_DIR}/PACKAGE_ICON_256.PNG"

# Pack everything into the .spk (plain tar, not gzipped)
tar -cf "${SPK_NAME}" -C "${WORK_DIR}" INFO conf/ package.tgz WIZARD_UIFILES/ scripts/ PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG

echo "Done: ${SPK_NAME}"
