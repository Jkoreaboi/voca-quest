// Vercel CLI 실행 전용 사전 로드: 이 PC 이름이 한글이라 CLI 가 HTTP 헤더에 넣다가 실패하는 문제를 피한다.
// 사용: $env:NODE_OPTIONS = "--require <이 파일 절대경로>"; npx vercel ...
const os = require('node:os');
const original = os.hostname;
os.hostname = () => {
  const h = original.call(os);
  return /^[\x20-\x7e]*$/.test(h) ? h : 'voca-quest-pc';
};
