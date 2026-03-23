import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "ioredis", "@anthropic-ai/sdk"],
};

export default nextConfig;
