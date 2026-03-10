/**
 * lib/validate.js
 * languageDir 三层校验：路径为空 → 目录不存在 → 无 zh-cn.js 文件
 * 任意一层不通过均打印错误并 exit(1) 中断程序。
 */

import { existsSync } from 'fs'
import { LANGUAGE_DIR, getArg } from './config.js'
import { findZhCnFiles } from './language.js'

/**
 * 校验 languageDir 配置的合法性，不通过则立即终止进程。
 *
 * 校验顺序：
 *  1. 显式传入空字符串（path.resolve 会将空串解析为 ROOT_DIR，需提前拦截）
 *  2. 解析后的目录路径不存在于文件系统
 *  3. 目录存在但其中没有任何 zh-cn.js 文件
 */
export function validateLanguageDir() {
  const rawVal = getArg('languageDir', null)
  if (rawVal !== null && !String(rawVal).trim()) {
    console.error(
      '[i18n-check] ❌ languageDir 路径不能为空，请检查 CLI 参数或 package.json[i18nCheck].languageDir 配置。',
    )
    process.exit(1)
  }

  if (!existsSync(LANGUAGE_DIR)) {
    console.error(`[i18n-check] ❌ 语言文件目录不存在：${LANGUAGE_DIR}`)
    console.error('  请通过 --languageDir 或 package.json[i18nCheck].languageDir 指定正确路径。')
    process.exit(1)
  }

  const zhCnFiles = findZhCnFiles(LANGUAGE_DIR)
  if (zhCnFiles.length === 0) {
    console.error(`[i18n-check] ❌ 在语言文件目录下未找到任何 zh-cn.js 文件：${LANGUAGE_DIR}`)
    console.error('  请确认目录结构正确，语言文件应命名为 zh-cn.js。')
    process.exit(1)
  }
}
