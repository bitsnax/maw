#!/bin/sh
# Writes opencode.json from the environment, makes the workspaces folder
# writable for maw-web (user node, uid 1000), then runs the server.
set -e
[ -n "$OPENCODE_SERVER_PASSWORD" ] || { echo "maw-opencode: OPENCODE_SERVER_PASSWORD is not set" >&2; exit 1; }
[ -n "$MAW_TOOLS_TOKEN" ] || { echo "maw-opencode: MAW_TOOLS_TOKEN is not set" >&2; exit 1; }
mkdir -p /workspaces /data
chown 1000:1000 /workspaces
node /opt/maw-opencode/write-config.mjs
echo "maw-opencode: OpenCode $(opencode --version), model ${LLAMACPP_MODEL} at ${LLAMACPP_BASE_URL}, tools via ${MAW_URL}"
exec opencode serve --hostname 0.0.0.0 --port 4096
