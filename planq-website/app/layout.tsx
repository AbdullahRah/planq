import React from "react"
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

const inter = Inter({ subsets: ["latin"], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'planq — building code violation checker | by staqtech',
  description:
    'Upload building plans and get a structured violation report. planq checks your drawings against the National Building Code and flags compliance gaps, dimension conflicts, and cross-sheet contradictions.',
  generator: 'v0.app',
  openGraph: {
    title: 'planq — catch code violations before the city does.',
    description:
      'Automated building plan review against the 2020 NBC Alberta Edition. Upload PDF, DXF, or scanned drawings. Get a severity-ranked violation report with section citations.',
  },
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
