/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone build for the Docker image (serverless can't run ffmpeg/sqlite/scratch).
  output: "standalone",
};

export default nextConfig;
