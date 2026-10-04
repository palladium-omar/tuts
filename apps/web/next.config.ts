import type { NextConfig } from 'next';
const staticExport = process.env.TUTS_STATIC_EXPORT === 'true';
const nextConfig: NextConfig = {
  output: staticExport ? 'export' : 'standalone',
  transpilePackages: ['@palladium/contracts'],
  ...(staticExport ? {
    images: { unoptimized: true },
    // Public values are compiled into the static client. An empty URL uses the
    // gateway Worker serving these assets, including its browser session cookies.
    env: { NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? '' },
  } : {}),
};
export default nextConfig;
