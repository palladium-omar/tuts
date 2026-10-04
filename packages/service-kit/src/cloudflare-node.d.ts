declare module 'cloudflare:node' {
  import type { Server } from 'node:http';
  export function httpServerHandler(server: Server | { port: number }): {
    fetch(request: Request, env?: unknown, context?: unknown): Promise<Response>;
  };
}
