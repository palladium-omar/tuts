import type { NextConfig } from 'next';
const staticExport = process.env.TUTS_STATIC_EXPORT === 'true';
const nextConfig: NextConfig = {
  output: staticExport ? 'export' : 'standalone',
  transpilePackages: ['@palladium/contracts'],
  // Match production's same-origin gateway composition during local work.
  ...(process.env.NODE_ENV === 'development' && !staticExport ? {
    env: { NEXT_PUBLIC_GATEWAY_URL: '' },
    rewrites: async () => [{ source: '/api/:path*', destination: `${process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8080'}/api/:path*` }],
  } : {}),
  ...(staticExport ? {
    images: { unoptimized: true },
    // Public values are compiled into the static client. An empty URL uses the
    // gateway Worker serving these assets, including its browser session cookies.
    env: { NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? '' },
  } : {}),
};
export default nextConfig;
