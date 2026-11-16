import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { DataProvider } from "@/components/data-provider";
import { ThemeProvider } from "@/components/theme-switch";

const archivo = localFont({
  src: "./fonts/archivo.ttf",
  variable: "--font-archivo",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Relay CRM",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const p=localStorage.getItem('relay-theme')||'system';document.documentElement.dataset.theme=p==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p}catch{}`,
          }}
        />
      </head>
      <body className={archivo.variable}>
        <DataProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </DataProvider>
      </body>
    </html>
  );
}
