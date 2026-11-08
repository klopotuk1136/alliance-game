# ---- build: typecheck, run the tests, build the browser client ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run typecheck && npm test && npm run build

# ---- runtime ----
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    ALLIANCE_DB=/data/alliance.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist
# `alliance <command>` is the admin CLI (talks to the running server over a local socket).
RUN printf '#!/bin/sh\nexec node /app/server/cli.ts "$@"\n' > /usr/local/bin/alliance \
    && chmod +x /usr/local/bin/alliance \
    && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8080/api/flags').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.ts"]
