// OWNER: R1 (Integration/UI). Minimal app shell placeholder so the R2 capture/vision
// work can run and be demoed. R1 coordinates the real layout and styling.

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reflect — Cruella Mirror",
  description: "Hands-free costume mirror (MVP).",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
