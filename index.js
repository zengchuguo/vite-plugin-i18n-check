import { execSync } from 'child_process'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// 插件自身所在目录（用于定位同包内的 check-i18n.js）
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * vite-plugin-i18n-check
 *
 * Vite 插件：在 vite dev 启动时自动完成两件事：
 *  1. 将插件配置同步写入项目 package.json 的 i18nCheck 字段
 *  2. 安装 Husky pre-commit 钩子（已存在则跳过）
 *
 * check-i18n.js 读取 package.json[i18nCheck] 作为默认配置，
 * npm 脚本 / pre-commit 钩子 / CLI 三种调用方式均共享同一份配置。
 *
 * @param {object}          [options]
 * @param {string}          [options.languageDir='src/utils/language']
 *   语言文件目录（相对项目根）
 * @param {string}          [options.reportFile='untranslated-i18n.json']
 *   未翻译词条 JSON 报告文件名
 * @param {string|string[]} [options.includeDirs=[]]
 *   只扫描的目录白名单，不配置则扫描全部
 * @param {string|string[]} [options.excludeDirs=[]]
 *   排除的目录黑名单，优先级高于 includeDirs
 */
export default function vitePluginI18nCheck(options = {}) {
  const {
    languageDir = 'src/utils/language',
    reportFile = 'untranslated-i18n.json',
    includeDirs = [],
    excludeDirs = [],
  } = options

  let rootDir = process.cwd()
  let hookInstalled = false

  return {
    name: 'vite-plugin-i18n-check',
    apply: 'serve',

    configResolved(config) {
      rootDir = config.root
    },

    buildStart() {
      const cfg = {
        languageDir,
        reportFile,
        includeDirs: [].concat(includeDirs),
        excludeDirs: [].concat(excludeDirs),
      }

      // 每次 vite dev 启动都将配置同步到 package.json[i18nCheck]
      syncPkgConfig(rootDir, cfg)

      // 钩子只安装一次
      if (hookInstalled) return
      hookInstalled = true
      try {
        setupHuskyHook(rootDir)
      } catch (err) {
        console.warn('[vite-plugin-i18n-check] Husky 钩子安装失败：', err.message)
      }
    },
  }
}

// ─── 配置同步 ─────────────────────────────────────────────────────────────────

/**
 * 将插件配置写入项目 package.json[i18nCheck]。
 * package.json 随仓库提交，团队成员无需运行 vite dev 即可读到最新配置。
 */
function syncPkgConfig(rootDir, cfg) {
  const pkgPath = path.join(rootDir, 'package.json')
  if (!existsSync(pkgPath)) return

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch {
    return
  }

  // 内容未变化时跳过，避免触发不必要的文件变更
  if (JSON.stringify(pkg.i18nCheck) === JSON.stringify(cfg)) return

  pkg.i18nCheck = cfg
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  console.log('[vite-plugin-i18n-check] package.json[i18nCheck] 已同步。')
}

// ─── Husky 钩子安装 ───────────────────────────────────────────────────────────

/**
 * 安装 Husky 并写入 pre-commit 钩子脚本。
 * 脚本路径通过 import.meta.url 动态计算，本地开发和 npm 发布后均可正确定位。
 */
function setupHuskyHook(rootDir) {
  const huskyDir = path.join(rootDir, '.husky')
  const preCommitFile = path.join(huskyDir, 'pre-commit')

  if (existsSync(preCommitFile)) {
    const content = readFileSync(preCommitFile, 'utf-8')
    if (content.includes('check-i18n.js')) {
      console.log('[vite-plugin-i18n-check] Husky pre-commit 钩子已就绪，跳过安装。')
      return
    }
  }

  const gitDir = path.join(rootDir, '.git')
  if (!existsSync(gitDir)) {
    throw new Error('当前目录不是 Git 仓库，无法安装 pre-commit 钩子。')
  }

  const hookContent = buildHookScript(rootDir)

  try {
    execSync('npx husky install', { cwd: rootDir, stdio: 'pipe' })
  } catch {
    // 回退：直接写 .git/hooks/pre-commit
    const gitHooksDir = path.join(rootDir, '.git', 'hooks')
    if (!existsSync(gitHooksDir)) mkdirSync(gitHooksDir, { recursive: true })
    writeFileSync(path.join(gitHooksDir, 'pre-commit'), hookContent, { mode: 0o755, encoding: 'utf-8' })
    console.log('[vite-plugin-i18n-check] pre-commit 钩子已写入（回退模式）。')
    return
  }

  if (!existsSync(huskyDir)) mkdirSync(huskyDir, { recursive: true })
  writeFileSync(preCommitFile, hookContent, { mode: 0o755, encoding: 'utf-8' })
  console.log('[vite-plugin-i18n-check] Husky pre-commit 钩子安装成功。')
}

/**
 * 生成 pre-commit shell 脚本内容。
 * 使用相对于项目根的路径，兼容本地引用和 node_modules 安装两种场景。
 */
function buildHookScript(rootDir) {
  // check-i18n.js 与 index.js 同目录
  const checkScriptAbs = path.join(__dirname, 'check-i18n.js')
  // 生成相对于项目根的路径，使 pre-commit 脚本可移植
  const checkScriptRel = path.relative(rootDir, checkScriptAbs).replace(/\\/g, '/')
  return `node ${checkScriptRel}\n`
}
