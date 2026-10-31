import type { Metadata } from "next";
import { Beth_Ellen, Caudex } from "next/font/google";
import "./globals.css";

const display = Beth_Ellen({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const serif = Caudex({ weight: ["400", "700"], style: ["normal", "italic"], subsets: ["latin"], variable: "--font-serif" });

export const metadata: Metadata = { title: "Boo, Darling!", description: "Let the Baroness judge you." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body className={`${display.variable} ${serif.variable}`}>{children}</body></html>
  );
}
