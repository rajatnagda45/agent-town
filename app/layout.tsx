import type { Metadata } from "next";
import { Press_Start_2P, Space_Mono } from "next/font/google";
import "./globals.css";

const pressStart2P = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-pixel",
  adjustFontFallback: false,
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-space-mono",
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: "Agent Town",
  description: "A pixel office where AI agents work",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${pressStart2P.variable} ${spaceMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
