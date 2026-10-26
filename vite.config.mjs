import { defineConfig } from 'vite';
import path from 'node:path';
import notices from './scripts/frontend-notices.cjs';

function frontendNotices() {
  let config;
  let packages;
  return {
    name: 'personal-workboard-frontend-notices',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    generateBundle(_options, bundle) { packages = notices.collectRenderedPackages(bundle, config.root); },
    closeBundle() {
      if (!packages) return;
      const generated = notices.createNotices(config.root, packages);
      notices.writeNotices(path.resolve(config.root, 'public'), generated);
      // Vite copies public before finalizing output. Write again after closing
      // the bundle so both source and deployment carry this build's originals.
      const result = notices.writeNotices(path.resolve(config.root, config.build.outDir), generated);
      config.logger.info(`前端第三方声明：${result.packages} 个依赖，${result.originals} 份完整原件`);
    }
  };
}

export default defineConfig({ base: './', plugins: [frontendNotices()], server: { host: '127.0.0.1', port: 5178, strictPort: true } });
