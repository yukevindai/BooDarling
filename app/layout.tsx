import type { Metadata } from "next";
import { Beth_Ellen, Pirata_One, Almendra } from "next/font/google";
import "./globals.css";

const title = Beth_Ellen({ weight: "400", subsets: ["latin"], variable: "--font-title" });
const display = Pirata_One({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const serif = Almendra({ weight: ["400", "700"], style: ["normal", "italic"], subsets: ["latin"], variable: "--font-serif" });

export const metadata: Metadata = { title: "Boo, Darling!", description: "Let the Baroness judge you." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${title.variable} ${display.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
