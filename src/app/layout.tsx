import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "GridSight — See Every Defect",
  description: "Upload drone footage, track every grid asset, get a prioritized defect report.",
};

export const viewport: Viewport = {
  themeColor: "#05070C",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('has-js')" }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <Toaster
          position="bottom-right"
          theme="dark"
          toastOptions={{
            style: {
              background: "#0B111D",
              border: "1px solid rgba(148,163,184,0.16)",
              color: "#e8edf5",
              fontFamily: "var(--font-geist-mono)",
              fontSize: "12px",
            },
          }}
        />
      </body>
    </html>
  );
}
