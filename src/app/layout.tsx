import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PHR OS — Mission Control',
  description: 'AI Agent Command Center for PHX Home Remodeling',
  icons: {
    icon: '/phr-logo.png',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  )
}
