import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Relay",
  description: "Kimi development and Codex verification handoff control center.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
