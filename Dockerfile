# The whole app in one container (docs/ARCHITECTURE.md §8), Node 22.
#
# Stage 1 installs production dependencies only, so Playwright and the tests stay out. better-sqlite3 has
# no ready-made binaries and always compiles from source, so this stage needs Python, make and a compiler.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2 is what runs: the compiled dependencies and the app, without the build tools.
# It runs as the unprivileged "node" user (uid 1000), so data/ on the host must belong to uid 1000.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
