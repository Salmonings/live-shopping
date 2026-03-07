import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'BESTWAY Supermarket - Live Shopping',
  description: 'Connect with order takers via video to pick your groceries',
  icons: {
    icon: '/favicon.jpg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
