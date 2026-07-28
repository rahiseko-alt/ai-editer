import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "cc-v2",
  description: "pnpm monorepo (apps/web + packages/ui)",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="antialiased">{children}</body>
    </html>
  );
}
