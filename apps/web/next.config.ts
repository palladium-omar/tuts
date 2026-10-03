import type { NextConfig } from 'next';
const nextConfig: NextConfig = { output: 'standalone', transpilePackages: ['@palladium/contracts'] };
export default nextConfig;
