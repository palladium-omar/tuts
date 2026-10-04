// Pages accepts a custom subdomain with external DNS. Keep all application
// routing, authorization, assets and cookies in the existing gateway Worker.
export default {
  async fetch(request, env) {
    try {
      return await env.GATEWAY.fetch(request);
    } catch {
      return Response.json({ error: { code: 'service_unavailable', message: 'Gateway is unavailable' } }, {
        status: 503,
        headers: {
          'Strict-Transport-Security': 'max-age=31536000',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      });
    }
  },
};
