import { defineConfig } from 'vite';

// GitHub Pages 는 https://<계정>.github.io/<저장소>/ 아래에서 열리므로 상대 경로로 빌드한다
export default defineConfig({
  base: './',
});
