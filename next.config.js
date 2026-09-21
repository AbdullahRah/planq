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
    // pdfjs-dist resolves its worker by constructing a path at runtime rather
    // than importing it, so Next's file tracing does not follow it and the
    // worker is left out of the serverless bundle. The function then fails with
    //
    //   Setting up fake worker failed: "Cannot find module
    //   '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'"
    //
    // which lib/parsers/pdf.ts catches, leaving a sheet with no page images.
    // Rendering works locally because the file is present in node_modules, so
    // this only ever shows up once deployed. Trace it in explicitly.
    outputFileTracingIncludes: {
      '/api/analyze': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
    },
  },
};

module.exports = nextConfig;
