/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      'pdf-parse',
      'pdf-to-png-converter',
      'pdfjs-dist',
      '@napi-rs/canvas',
      'sharp',
      'dxf-parser',
    ],
  },
};

module.exports = nextConfig;
