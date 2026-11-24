# CharacterLife API server: OpenAI-compatible chat API (SillyTavern), optional Telegram bot.
# Zero runtime dependencies, so the image is just Node plus the source tree.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    CHARACTERLIFE_HOST=0.0.0.0 \
    CHARACTERLIFE_ALLOW_PUBLIC=true \
    CHARACTERLIFE_PORT=8787 \
    CHARACTERLIFE_DB=/data/characterlife.db

COPY package.json LICENSE NOTICE ./
COPY src ./src
COPY examples ./examples
# Example characters; every pack in /app/characters shows up as a model.
# Mount your own folder there (or set CHARACTERLIFE_CHARACTERS_DIR) to run your characters.
COPY characters ./characters

# Character state lives in /data; mount a volume there to keep it across containers.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8787

# The server saves and closes the database on SIGINT.
STOPSIGNAL SIGINT

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${CHARACTERLIFE_PORT}/healthz" >/dev/null || exit 1

CMD ["node", "examples/sillytavern/start-server.ts"]
