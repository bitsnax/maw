import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  reactCompiler: true,
  // Certificate code (lib/pki.ts) runs on the server only; load these from
  // node_modules at run time instead of bundling them.
  serverExternalPackages: ['@peculiar/x509', 'reflect-metadata', 'tsyringe'],
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
}

export default nextConfig
