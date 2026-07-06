/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow images from Islamic CDNs (audio thumbnails etc.)
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.islamic.network",
      },
    ],
  },
  experimental: {
    serverComponentsExternalPackages: ['@remotion/bundler', '@remotion/renderer', '@remotion/media-utils', 'remotion'],
  },
  async rewrites() {
    return [
      {
        source: '/backend/:path*',
        destination: 'http://backend:8000/api/:path*',
      },
    ];
  },
};

export default nextConfig;
