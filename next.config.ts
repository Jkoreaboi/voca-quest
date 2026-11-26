import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 서버 전용 패키지는 번들하지 않고 Node 런타임에서 그대로 불러온다.
  serverExternalPackages: ['pg', '@electric-sql/pglite', '@electric-sql/pglite-socket', 'exceljs'],
  poweredByHeader: false,
  // 같은 폴더에서 실행 중인 서버의 .next 를 덮어쓰지 않고 별도 빌드를 만들 때만 사용 (기본 .next)
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
