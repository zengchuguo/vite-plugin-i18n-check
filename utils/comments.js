/**
 * utils/comments.js
 * 注释去除工具：将注释内容替换为等长空白，保留行列号对应关系
 */

/**
 * 行内忽略标记：在行末（或行内任意位置）添加此注释，该行中文将被跳过。
 *   - JS / script：  任意中文  // i18n-ignore
 *   - Template：     任意中文  <!-- i18n-ignore -->
 *
 * 下一行忽略标记：添加在目标行的上一行，下一行中文将被跳过。
 *   - JS / script：  // i18n-ignore-next-line
 *   - Template：     <!-- i18n-ignore-next-line -->
 *
 * 块级 / 文件级禁用标记：
 *   - 开启：// i18n-disable  （或 /* i18n-disable *\/、<!-- i18n-disable -->）
 *   - 关闭：// i18n-enable   （或 /* i18n-enable *\/、<!-- i18n-enable -->）
 *   - 若文件内只有 i18n-disable 而无 i18n-enable，则整个文件（或块）均被禁用。
 */
const IGNORE_MARKER = 'i18n-ignore'
const IGNORE_NEXT_LINE_MARKER = 'i18n-ignore-next-line'
const IGNORE_DISABLE_MARKER = 'i18n-disable'
const IGNORE_ENABLE_MARKER = 'i18n-enable'

/**
 * 判断某行是否包含 i18n-ignore 同行标记，若有则整行跳过不做替换。
 * 注意：i18n-ignore-next-line 不视为同行标记。
 * @param {string} rawLine 原始行内容（未经注释清理）
 */
export function isIgnoredLine(rawLine) {
  return rawLine.includes(IGNORE_MARKER) && !rawLine.includes(IGNORE_NEXT_LINE_MARKER)
}

/**
 * 判断上一行是否包含 i18n-ignore-next-line 标记，若有则当前行跳过不做替换。
 * @param {string | undefined} prevRawLine 上一行原始内容
 */
export function isNextLineIgnored(prevRawLine) {
  return prevRawLine !== undefined && prevRawLine.includes(IGNORE_NEXT_LINE_MARKER)
}

/**
 * 预计算哪些行处于 i18n-disable / i18n-enable 块内，返回被禁用的行索引集合。
 *
 * 规则：
 *   - 遇到含 i18n-disable 的行：从下一行起进入禁用区（该标记行本身不计入）
 *   - 遇到含 i18n-enable  的行：禁用区结束（该标记行本身不计入）
 *   - 若 i18n-disable 后没有对应的 i18n-enable，则直到文件末尾均被禁用（文件级禁用）
 *
 * @param {string[]} rawLines 原始行数组（未经注释清理）
 * @returns {Set<number>} 应跳过的行索引集合
 */
export function buildDisabledLineSet(rawLines) {
  const disabled = new Set()
  let inDisabled = false

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (!inDisabled && line.includes(IGNORE_DISABLE_MARKER)) {
      inDisabled = true
      continue
    }
    if (inDisabled && line.includes(IGNORE_ENABLE_MARKER)) {
      inDisabled = false
      continue
    }
    if (inDisabled) disabled.add(i)
  }

  return disabled
}

/**
 * 去除模板中的注释，用等长空格填充，保持位置信息不变：
 *   - HTML 注释：<!-- ... -->
 *   - JS 块注释：/* ... *\/（可出现在绑定表达式和 {{ }} 内）
 *   - JS 行注释：// ...（可出现在绑定表达式和 {{ }} 内）
 */
export function removeHtmlComments(content) {
  let result = content.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '))
  result = result.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
  result = result.replace(/(?<!['":`])\/\/[^\n]*/g, match => ' '.repeat(match.length))
  return result
}

/**
 * 去除 JS 注释：
 *  - 块注释（/* ... *\/）：替换为等长空格，保留换行符以维持行号
 *  - 单行注释（// ...）：替换为等长空格，不影响行号
 *
 * 注意：// 前置的 '":`  字符表示可能在字符串内，不视为注释起始。
 */
export function removeJsComments(content) {
  let result = content.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
  result = result.replace(/(?<!['":`])\/\/[^\n]*/g, match => ' '.repeat(match.length))
  return result
}
