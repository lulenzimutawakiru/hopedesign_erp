# Hope Design ERP — multi-target image for AccuWeb Linux VPS (and any Docker host).
#   docker compose -f docker-compose.prod.yml build
# Targets: api, web

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci

FROM deps AS build
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/web apps/web
COPY vitest.workspace.ts vitest.workspace.ts
ENV NODE_ENV=production SOURCEMAP=false
RUN npm run build -w apps/api && npm run build -w apps/web
RUN npm prune --omit=dev

FROM node:20-alpine AS api
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
RUN apk add --no-cache tini
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY deploy/docker-entrypoint.mjs ./deploy/docker-entrypoint.mjs
EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=5s --start-period=180s --retries=8 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "deploy/docker-entrypoint.mjs"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
