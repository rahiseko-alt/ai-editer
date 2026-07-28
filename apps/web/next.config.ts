import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @repo/ui exports raw .tsx source; let Next transpile it.
  transpilePackages: ["@repo/ui"],

  // 最小セキュリティヘッダ（G-3-3 c2）。本番は Vercel が HTTPS を終端するので、
  // ここで HSTS を含む最小ヘッダを全ルートに付与する。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
