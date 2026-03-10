/**
 * lib/language.js
 * 语言文件解析：递归扫描 zh-cn.js，构建「中文 → i18n key」反向映射表
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import path from 'path'
import { CHINESE_TEST_RE } from '../utils/regex.js'

/**
 * 递归扫描 dir 下所有 zh-cn.js，返回文件绝对路径及其命名空间。
 * 命名空间由相对 baseDir 的目录路径推导（点分隔），根目录为空字符串。
 *
 * @param {string} dir      当前扫描目录
 * @param {string} [baseDir] 递归基准目录（首次调用时与 dir 相同）
 * @returns {{ absPath: string, namespace: string }[]}
 */
export function findZhCnFiles(dir, baseDir = null) {
  baseDir = baseDir || dir
  const results = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      results.push(...findZhCnFiles(path.join(dir, dirent.name), baseDir))
    } else if (dirent.name === 'zh-cn.js') {
      const abs = path.join(dir, dirent.name)
      const rel = path.relative(baseDir, dir)
      const namespace = rel === '' ? '' : rel.replace(/\\/g, '.')
      results.push({ absPath: abs, namespace })
    }
  }
  return results
}

/**
 * 构建反向映射表：{ '中文文本': 'namespace.key' }
 * 遍历 dir 下所有 zh-cn.js，支持一层嵌套对象结构。
 *
 * @param {string} dir  语言文件根目录（已校验存在）
 * @returns {Record<string, string>}
 */
export function buildReverseMap(dir) {
  const map = {}
  if (!existsSync(dir)) return map

  for (const { absPath, namespace } of findZhCnFiles(dir)) {
    try {
      const entries = parseExportDefault(absPath)
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string' && CHINESE_TEST_RE.test(value)) {
          map[value] = namespace ? `${namespace}.${key}` : key
        } else if (value && typeof value === 'object') {
          for (const [subKey, subVal] of Object.entries(value)) {
            if (typeof subVal === 'string' && CHINESE_TEST_RE.test(subVal)) {
              map[subVal] = namespace ? `${namespace}.${key}.${subKey}` : `${key}.${subKey}`
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[i18n-check] 解析语言文件失败：${absPath}`, e.message)
    }
  }

  return map
}

/**
 * 解析语言文件中 `export default { ... }` 的对象值。
 *
 * 优先使用 new Function 动态执行，完整支持嵌套对象、模板字符串、转义字符等所有
 * 合法 JS 对象字面量写法；执行失败时自动降级到正则提取（仅支持简单单层结构）。
 *
 * 语言文件属于项目内受信源码，使用 new Function 执行是安全的。
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
export function parseExportDefault(filePath) {
  const content = readFileSync(filePath, 'utf-8')

  try {
    const fnBody = content
      .replace(/^\s*import\b[^\n]*/gm, '')
      .replace(/export\s+default\s+/, 'return ')
    // eslint-disable-next-line no-new-func
    const result = new Function(fnBody)()
    if (result && typeof result === 'object') return result
  } catch {
    // 执行失败时静默降级
  }

  const fallback = {}
  const blockMatch = content.match(/export\s+default\s+\{([\s\S]*)\}/)
  if (!blockMatch) return fallback
  const pairRe = /(\w+)\s*:\s*(['"`])([\s\S]*?)\2/g
  let m
  while ((m = pairRe.exec(blockMatch[1])) !== null) {
    fallback[m[1]] = m[3]
  }
  return fallback
}
