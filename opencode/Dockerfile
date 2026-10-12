# maw-opencode: the only OpenCode, serving every MAW project (Phase 3).
# Its file and command tools are replaced by MAW's (config/tools): they act on
# the project's machine through MAW's tool API. Sessions are kept in /data.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.19.0
RUN npm i -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} && opencode --version

# Config (read-only part from the repo; opencode.json is written at start),
# and everything OpenCode stores, on the data volume.
ENV XDG_CONFIG_HOME=/opt/maw-opencode/config-home \
    XDG_DATA_HOME=/data/share \
    XDG_STATE_HOME=/data/state \
    XDG_CACHE_HOME=/data/cache
COPY config/ /opt/maw-opencode/config-home/opencode/
# The tools' helper package, installed now so startup needs no download.
RUN cd /opt/maw-opencode/config-home/opencode \
 && printf '{"dependencies":{"@opencode-ai/plugin":"%s"}}\n' "${OPENCODE_VERSION}" > package.json \
 && npm i --no-audit --no-fund >/dev/null
COPY write-config.mjs entrypoint.sh /opt/maw-opencode/
RUN mkdir -p /workspaces /data
EXPOSE 4096
CMD ["sh", "/opt/maw-opencode/entrypoint.sh"]
