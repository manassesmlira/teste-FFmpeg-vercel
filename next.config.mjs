/** @type {import('next').NextConfig} */
const nextConfig = {
  // ffmpeg-static returns a path to a native executable. Keep the package external
  // so Next.js does not rewrite that path while bundling the route handler.
  serverExternalPackages: ['ffmpeg-static'],

  // Native binaries referenced indirectly are not always detected by Node File Trace.
  // Force the package (including its ffmpeg executable) into the /api/render Function.
  outputFileTracingIncludes: {
    '/api/render': ['./node_modules/ffmpeg-static/**/*'],
  },
};

export default nextConfig;
