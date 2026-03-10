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
 *  1. 首次初始化：将插件选项作为种子写入 package.json[i18nCheck]
 *     （该字段已存在时跳过，不覆盖，以避免团队协作冲突）
 *  2. 安装 Husky pre-commit 钩子（已存在则跳过）
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │                                                         │
 * │  vite.config.js 的插件选项仅在首次初始化时作为「种子」     │
 * │  写入 package.json。此后所有配置变更请直接修改             │
 * │  package.json[i18nCheck]，插件不会再覆盖该字段。          │ 
 * │                                                         │
 * │  check-i18n.js 配置优先级：                              │
 * │    CLI 参数 > package.json[i18nCheck] > 内置默认值       │
 * └─────────────────────────────────────────────────────────┘
 *
 * @param {object}          [options]
 * @param {boolean}         [options.enabled=true]
 *   是否启用插件。设为 false 时插件完全静默，不初始化配置、不安装钩子。
 *   常用于按环境控制：如仅在本地开发时启用，CI 环境关闭。
 *   注意：该选项为运行时控制项，不会写入 package.json[i18nCheck]。
 * @param {string}          [options.languageDir='src/utils/language']
 *   语言文件目录（相对项目根）。仅在 package.json[i18nCheck] 不存在时生效。
 * @param {string}          [options.reportFile='untranslated-i18n.json']
 *   未翻译词条 JSON 报告文件名。仅在 package.json[i18nCheck] 不存在时生效。
 * @param {string|string[]} [options.includeDirs=[]]
 *   只扫描的目录白名单，不配置则扫描全部。仅在首次初始化时生效。
 * @param {string|string[]} [options.excludeDirs=[]]
 *   排除的目录黑名单，优先级高于 includeDirs。仅在首次初始化时生效。
 * @param {string}          [options.scriptI18nFn='t']
 *   script 块 / JS 文件中自动替换时使用的函数名。仅在首次初始化时生效。
 *   Vue 3 Composition API 通常为 't'（useI18n 解构）；
 *   Vue 2 或手动导入独立函数的项目可设为 '$t'。
 */
export default function vitePluginI18nCheck(options = {}) {
  const {
    enabled = true,
    languageDir = 'src/utils/language',
    reportFile = 'untranslated-i18n.json',
    includeDirs = [],
    excludeDirs = [],
    scriptI18nFn = 't',
  } = options

  let rootDir = process.cwd()
  let initialized = false

  return {
    name: 'vite-plugin-i18n-check',
    apply: 'serve',

    configResolved(config) {
      rootDir = config.root
    },

    buildStart() {
      if (!enabled) return
      // 每次进程内只执行一次（防止 HMR 触发的重复调用）
      if (initialized) return
      initialized = true

      // 仅在 package.json[i18nCheck] 不存在时写入种子配置
      const seedCfg = {
        languageDir,
        reportFile,
        includeDirs: [].concat(includeDirs),
        excludeDirs: [].concat(excludeDirs),
        scriptI18nFn,
      }
      initPkgConfig(rootDir, seedCfg)

      try {
        setupHuskyHook(rootDir)
      } catch (err) {
        console.warn('[vite-plugin-i18n-check] Husky 钩子安装失败：', err.message)
      }
    },
  }
}


/**
 * 首次初始化：仅当 package.json[i18nCheck] 字段不存在时，将种子配置写入。
 *
 * 设计原则：package.json[i18nCheck] 是配置的唯一来源。
 *   - 该字段不存在 → 以 vite.config.js 插件选项为种子写入，完成一次性初始化。
 *   - 该字段已存在 → 跳过，不做任何修改，避免覆盖团队共享配置。
 *
 * 初始化完成后，所有配置变更请直接修改 package.json[i18nCheck]。
 */
function initPkgConfig(rootDir, seedCfg) {
  const pkgPath = path.join(rootDir, 'package.json')
  if (!existsSync(pkgPath)) return

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch {
    return
  }

  // 已有配置：package.json[i18nCheck] 是唯一配置来源，跳过不覆盖
  if (pkg.i18nCheck) {
    console.log('[vite-plugin-i18n-check] 读取 package.json[i18nCheck] 配置，vite.config.js 中的选项已忽略。')
    return
  }

  // 首次初始化：将插件选项作为种子写入
  pkg.i18nCheck = seedCfg
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  console.log('[vite-plugin-i18n-check] 已初始化 package.json[i18nCheck]，后续请直接修改该字段进行配置。')
}


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
