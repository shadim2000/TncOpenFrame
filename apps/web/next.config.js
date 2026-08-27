/** @type {import('next').NextConfig} */
// INTERNAL_API_URL points this app's web service at the backend API service.
// In production (Traefik) the /api prefix is stripped before the request reaches
// the API, so the rewrite mirrors that: /api/<path> -> <api>/<path>.
// Default to the local dev API so running `next dev`/the dev Dockerfile still works.
const internalApiUrl = process.env.INTERNAL_API_URL || 'http://localhost:8000'

const nextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${internalApiUrl}/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
