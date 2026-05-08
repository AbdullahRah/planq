/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', 'pdf2pic', 'sharp', 'dxf-parser'],
  },
};

module.exports = nextConfig;
