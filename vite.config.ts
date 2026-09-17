import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'vite-plugin-electron/simple';
import electronRenderer from 'vite-plugin-electron-renderer';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

// ESM 中不存在 __dirname，需要用 import.meta.url 来模拟
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 从 package.json 读取版本号，构建时注入到前端
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// https://vitejs.dev/config/
export default defineConfig({
  // BrowserWindow.loadFile() serves the renderer through file://.  Keep public
  // and bundled asset URLs relative to dist/ rather than the filesystem root.
  base: './',
  plugins: [tailwindcss(), react(), electron({
    main: {
      // Shortcut of `build.lib.entry`.
      entry: 'electron/main.ts',
      vite: {
        build: {
          // 注意：vite-plugin-electron 实际按 ESM 输出（package.json 为
          // "type": "module"，Electron 以 ESM 加载 main）。原生模块与 AI SDK
          // 必须外部化：内联 CJS 依赖（如 @vercel/oidc）会被 rolldown 包上
          // 运行时必炸的 __require shim；外部化后由 Node 原生模块解析加载。
          rollupOptions: {
            external: [
              'better-sqlite3',
              '@lancedb/lancedb',
              'yauzl',
              'ai',
              '@ai-sdk/google',
              '@ai-sdk/openai-compatible'
            ]
          }
        }
      }
    },
    preload: {
      // Shortcut of `build.rollupOptions.input`.
      // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
      input: path.join(__dirname, 'electron/preload.ts')
    }
  }), process.env.NODE_ENV !== 'test' && electronRenderer()],
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    watch: {
      ignored: ['**/docs/**']
    }
  },
  define: {
    // 构建时将 package.json 版本注入为全局常量，避免 StatusBar 硬编码版本号
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  optimizeDeps: {
    entries: ['index.html', 'src/**/*.{ts,tsx}']
  },
  test: {
    // Test copy must not follow the operating-system locale of a CI runner.
    setupFiles: ['test/setup-locale.ts'],
    // 本地历史 worktree 和 pnpm 缓存可能包含旧版本测试；它们不是当前项目源码。
    exclude: [
      ...configDefaults.exclude,
      '**/.worktrees/**',
      '**/.pnpm-store/**',
      '**/.workbuddy/**',
      '**/.runtime/**',
      '**/plugins/**',
      '**/.release/scripts/release-artifact-retention.test.mjs',
    ],
  },
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        // 过滤掉已知的无害警告
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return;
        if (warning.message?.includes('Invalid key')) return;
        defaultHandler(warning);
      }
    }
  }
});
