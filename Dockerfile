FROM node:18-alpine AS builder

WORKDIR /app

COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

COPY web ./web
RUN cd web && npm run build


FROM node:18-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_DIR=/app/public
ENV STATS_FILE=/data/stats.json
ENV ADMIN_PASSWORD=BeeIT@2026

RUN mkdir -p /data

COPY --from=builder /app/web/dist ./public
COPY server ./server

EXPOSE 8080

CMD ["node", "server/index.js"]
