/**
 * utils/comments.js
 * 注释去除工具：将注释内容替换为等长空白，保留行列号对应关系
 */

/**
 * 去除 HTML 注释（<!-- ... -->），用等长空格填充，保持位置信息不变。
 */
export function removeHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '))
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
