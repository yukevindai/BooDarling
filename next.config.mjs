/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: false,
  experimental: {
    // On Vercel each API route is a separate function bundle. /api/critique reads the
    // reference manifest and images from disk at runtime (paths come from the manifest,
    // so file tracing can't discover them) — include them explicitly.
    outputFileTracingIncludes: {
      "/api/critique": ["./references/**/*", "./public/references/**/*"],
    },
  },
};
