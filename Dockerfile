FROM node:24-alpine
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ARG SERVICE
RUN pnpm --filter @palladium/${SERVICE}... build
ENV SERVICE=${SERVICE}
CMD ["sh", "-c", "pnpm --filter @palladium/${SERVICE} start"]
