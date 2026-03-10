/**
 * lib/git-files.js
 * Git 文件获取：根据扫描模式从 git 暂存区 / 工作区获取目标文件列表
 */

import { execSync } from 'child_process'
import { ROOT_DIR, INCLUDE_DIRS, EXCLUDE_DIRS } from './config.js'

/**
 * 根据 mode 获取目标文件列表（去重）
 * @param {'staged'|'modified'|'all'} mode
 * @returns {string[]} 相对路径文件列表
 */
export function getTargetFiles(mode) {
  const staged = (mode === 'staged' || mode === 'all') ? getStagedFiles() : []
  const modified = (mode === 'modified' || mode === 'all') ? getModifiedFiles() : []
  return [...new Set([...staged, ...modified])]
}

/** 获取 git 暂存区（已 add）的已修改/新增文件 */
function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    }).trim()
    if (!output) return []
    return filterFiles(output.split('\n').map(f => f.trim()))
  } catch {
    return []
  }
}

/** 获取工作区已修改但未暂存的文件 */
function getModifiedFiles() {
  try {
    const output = execSync('git diff --name-only --diff-filter=ACM', {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    }).trim()
    if (!output) return []
    return filterFiles(output.split('\n').map(f => f.trim()))
  } catch {
    return []
  }
}

/**
 * 过滤文件列表：
 *  1. 只保留 .vue / .js / .jsx
 *  2. 配置了 includeDirs 时只保留命中白名单的文件
 *  3. 排除命中 excludeDirs 黑名单的文件
 */
function filterFiles(files) {
  return files.filter(f => {
    if (!/\.(vue|js|jsx)$/.test(f)) return false
    const normalized = f.replace(/\\/g, '/')

    if (INCLUDE_DIRS.length > 0) {
      const included = INCLUDE_DIRS.some(
        dir => normalized.startsWith(dir + '/') || normalized === dir,
      )
      if (!included) return false
    }

    return !EXCLUDE_DIRS.some(
      dir => normalized.startsWith(dir + '/') || normalized === dir,
    )
  })
}
