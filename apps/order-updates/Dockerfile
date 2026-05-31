# Multi-stage build for Order Updates (email + SMS + WhatsApp).
FROM node:20-alpine AS builder
WORKDIR /work
# Use the OS Chromium for whatsapp-web.js/puppeteer; never download one.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/order-updates ./apps/order-updates
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/order-updates
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Chromium + the libs whatsapp-web.js/puppeteer need at runtime.
RUN apk add --no-cache git chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    WWEBJS_DATA_PATH=/data/wwebjs
RUN mkdir -p /data/wwebjs
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/order-updates/package.json ./apps/order-updates/package.json
COPY --from=builder /work/apps/order-updates/node_modules ./apps/order-updates/node_modules
COPY --from=builder /work/apps/order-updates/dist ./apps/order-updates/dist
COPY apps/order-updates/server.js ./apps/order-updates/server.js
COPY apps/order-updates/whatsapp.js ./apps/order-updates/whatsapp.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/order-updates
CMD ["node", "server.js"]
