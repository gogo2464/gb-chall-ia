FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tools ./tools

# The ROM and save are NOT baked in: mount them at /app/roms (see docker-compose.yml).
RUN mkdir -p /app/roms && addgroup -S ctf && adduser -S ctf -G ctf
USER ctf

ENV PORT=8765 \
    ROM_PATH=roms/pokered.gb \
    SAVE_PATH=roms/pokered.sav \
    MAX_SESSIONS=16 \
    MAX_PER_IP=2 \
    SESSION_TIMEOUT=900

EXPOSE 8765
CMD ["node", "src/server.js"]
