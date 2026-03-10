/**
 * lib/config.js
 * 配置加载与运行时常量
 *
 * 优先级：CLI 参数 > package.json[i18nCheck] > 内置默认值
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'

export const ROOT_DIR = process.cwd()

const args = process.argv.slice(2)

/**
 * 读取 package.json 中 i18nCheck 字段作为基础配置。
 * package.json 始终随仓库提交，无需 vite dev 即可读取。
 */
function loadPkgConfig() {
  const pkgPath = path.join(ROOT_DIR, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.i18nCheck || {}
  } catch {
    return {}
  }
}

const PKG_CONFIG = loadPkgConfig()

/**
 * 获取参数值，优先级：CLI 参数 > package.json i18nCheck > 内置默认值
 * @param {string} name       CLI 参数名（不含 --），同时作为配置字段 key
 * @param {*}      defaultVal 内置默认值
 */
export function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1) return args[idx + 1]
  if (PKG_CONFIG[name] !== undefined) return PKG_CONFIG[name]
  return defaultVal
}

/** 是否启用检测，false 时 check-i18n 直接退出、不做任何更改 */
export const ENABLED = (() => {
  const val = getArg('enabled', true)
  if (val === false || val === 'false' || val === '0') return false
  return val !== undefined && val !== null && val !== '' && val !== 'false' && val !== '0'
})()

export const LANGUAGE_DIR = path.resolve(ROOT_DIR, getArg('languageDir', 'src/utils/language'))
export const REPORT_FILE = path.resolve(ROOT_DIR, getArg('reportFile', 'untranslated-i18n.json'))

/** 扫描模式：staged（默认）| modified | all */
export const MODE = getArg('mode', 'staged')

/** script 块 / JS 文件中替换时使用的函数名，默认 't'，Vue 2 可设为 '$t' */
export const SCRIPT_I18N_FN = getArg('scriptI18nFn', 't')

/** 排除目录列表（黑名单） */
export const EXCLUDE_DIRS = (() => {
  const val = getArg('excludeDirs', [])
  if (Array.isArray(val)) return val.map(d => d.trim()).filter(Boolean)
  return val ? String(val).split(',').map(d => d.trim()).filter(Boolean) : []
})()

/** 仅扫描目录列表（白名单） */
export const INCLUDE_DIRS = (() => {
  const val = getArg('includeDirs', [])
  if (Array.isArray(val)) return val.map(d => d.trim()).filter(Boolean)
  return val ? String(val).split(',').map(d => d.trim()).filter(Boolean) : []
})()
