import { defineConfig } from 'rollup'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import { writeFileSync, readFileSync } from 'fs'

const NODE_BUILTINS = [
  'child_process',
  'fs',
  'fs/promises',
  'path',
  'url',
]

/** shebang 在 terser 之后追加，避免 terser 将 # 误解析为私有字段 */
function shebangAfterTerser(matchFileName) {
  return {
    name: 'shebang-after-terser',
    writeBundle(_, bundle) {
      const chunk = Object.values(bundle).find((c) => c.type === 'chunk' && c.fileName?.endsWith(matchFileName))
      if (chunk) {
        const code = readFileSync(chunk.fileName, 'utf-8')
        if (!code.startsWith('#!')) {
          writeFileSync(chunk.fileName, '#!/usr/bin/env node\n' + code, 'utf-8')
        }
      }
    },
  }
}

export default defineConfig([
  // 主插件入口
  {
    input: 'index.js',
    output: {
      file: 'dist/index.js',
      format: 'es',
      sourcemap: false,
    },
    external: NODE_BUILTINS,
    plugins: [nodeResolve(), terser({ format: { comments: false } })],
  },
  // CLI 脚本入口（terser 后再追加 shebang，避免解析错误）
  {
    input: 'check-i18n.js',
    output: {
      file: 'dist/check-i18n.js',
      format: 'es',
      sourcemap: false,
    },
    external: NODE_BUILTINS,
    plugins: [
      nodeResolve(),
      terser({ format: { comments: false } }),
      shebangAfterTerser('check-i18n.js'),
    ],
  },
])
