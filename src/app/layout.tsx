import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Voca Quest | 나의 단어 모험', description: '단어를 익히고, 네 번의 미션을 완성해요.', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="ko"><body>{children}</body></html>; }
