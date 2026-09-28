import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Atoms Demo · 智能体驱动的应用生成',
  description:
    '通过多智能体协作，把一句话需求生成为可运行、可交互、可迭代的网页应用，并实时预览。',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
