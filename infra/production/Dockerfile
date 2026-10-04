FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ARG SERVICE
ARG NEXT_PUBLIC_GATEWAY_URL
ENV NEXT_PUBLIC_GATEWAY_URL=${NEXT_PUBLIC_GATEWAY_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @palladium/${SERVICE}... build
RUN if [ "$SERVICE" = "web" ]; then \
      mkdir -p apps/web/.next/standalone/apps/web/.next/static && \
      cp -R apps/web/.next/static/. apps/web/.next/standalone/apps/web/.next/static/; \
    fi

FROM node:24-alpine AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG SERVICE
ENV SERVICE=${SERVICE}
USER node
ENTRYPOINT ["sh", "/app/infra/production/start-container.sh"]
