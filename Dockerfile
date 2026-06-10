# syntax=docker/dockerfile:1

# ---- Build stage ----
# Pinned to the builder's native architecture ($BUILDPLATFORM) so it is never
# run under QEMU emulation. All dependencies are pure JavaScript, so the
# resulting node_modules and dist/ are architecture-independent and run on any
# platform's Node runtime — letting us produce a multi-arch image without
# emulating npm/node for the target arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:local
# Drop dev dependencies so only the runtime deps are carried into the image.
RUN npm prune --omit=dev

# ---- Runtime stage ----
# Multi-arch: this stage only COPYs prebuilt artifacts (no RUN), so nothing
# executes under emulation. The base image supplies the correct native Node
# binary per target platform.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/misialq/rachis-mcp"
LABEL org.opencontainers.image.description="MCP server for exploring the Rachis ecosystem"
LABEL org.opencontainers.image.licenses="MIT"

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
# stdio transport: the MCP client attaches stdin/stdout via `docker run -i`.
ENTRYPOINT ["node", "dist/src/stdio.js"]
