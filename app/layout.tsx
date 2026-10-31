import type { Metadata } from "next";
import { Pirata_One, Cormorant_Garamond } from "next/font/google";
import "./globals.css";

const display = Pirata_One({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const serif = Cormorant_Garamond({ weight: ["400", "600", "700"], style: ["normal", "italic"], subsets: ["latin"], variable: "--font-serif" });

export const metadata: Metadata = { title: "Boo, Darling!", description: "Let the Baroness judge you." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body className={`${display.variable} ${serif.variable}`}>{children}</body></html>
  );
}
