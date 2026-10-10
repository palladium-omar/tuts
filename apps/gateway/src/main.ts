import { createServer } from 'node:http';
import { serviceNames } from '@palladium/contracts';
import type { GatewayEnv } from './worker.js';
import { createNodeGateway } from './node-adapter.js';
const urls = Object.fromEntries(serviceNames.map((name, i) => [name, process.env[`${name.toUpperCase()}_URL`] ?? `http://localhost:${4001 + i}`]));
const binding = (origin: string) => ({ fetch(request: Request) {
  const source = new URL(request.url);
  const target = new URL(origin); target.pathname = source.pathname; target.search = source.search;
  return fetch(new Request(target, request));
} });
const env: GatewayEnv = {
  PLATFORM: binding(urls.platform!),
  CLIENTS: binding(urls.clients!),
  SCHEDULING: binding(urls.scheduling!),
  LEARNING: binding(urls.learning!),
  BILLING: binding(urls.billing!),
  PAYMENTS: binding(urls.payments!),
  NOTIFICATIONS: binding(urls.notifications!),
  INTEGRATIONS: binding(urls.integrations!),
  PLANNING: binding(urls.planning!),
  REPORTING: binding(urls.reporting!),

  ASSETS: binding(process.env.PUBLIC_APP_URL ?? 'http://localhost:3000'),
  CONTEXT_PRIVATE_KEY: process.env.CONTEXT_PRIVATE_KEY ?? '',
  PLATFORM_INTERNAL_SECRET: process.env.PLATFORM_INTERNAL_SECRET ?? '',
  INTERNAL_RUNTIME_SECRET: process.env.INTERNAL_RUNTIME_SECRET ?? '',
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL ?? 'http://localhost:3000',
  PUBLIC_GATEWAY_URL: process.env.PUBLIC_GATEWAY_URL ?? 'http://localhost:8080',
};
if (!env.CONTEXT_PRIVATE_KEY || !env.PLATFORM_INTERNAL_SECRET) throw new Error('Gateway signing credentials required');
createServer(createNodeGateway(env)).listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('Tuts gateway listening'));
