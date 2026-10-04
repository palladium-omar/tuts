-- BetterAuth's atomic PostgreSQL rate limiter. Global identity state remains
-- private to the platform; every Worker invocation shares these limits.
CREATE TABLE "rateLimit" (
  "id" text PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
CREATE INDEX auth_rate_limit_expiry_idx ON "rateLimit" ("lastRequest");
