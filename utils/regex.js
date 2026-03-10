/**
 * utils/regex.js
 * 中文词条识别正则 & 正则转义工具
 */

/**
 * 常见中文标点，可合法出现在词条内部，不应将其视为词条的分割点：
 *   、。《》【】（）—…！，：；？""''
 */
export const CN_PUNCT =
  '\u3001\u3002\u300a\u300b\u3010\u3011\uff08\uff09\u2014\u2026\uff01\uff0c\uff1a\uff1b\uff1f\u201c\u201d\u2018\u2019'

/**
 * 中文词条正则：以汉字开头，后续跟汉字或中文标点，并支持括号包裹的中文内容。
 *
 * 结构：
 *   核心段：[\u4e00-\u9fa5][CN_PUNCT\u4e00-\u9fa5]*
 *   括号组：(?:[(\[][CN_PUNCT\u4e00-\u9fa5]+[)\]][CN_PUNCT\u4e00-\u9fa5]*)*
 *
 * 括号规则：
 *   - ASCII () 或 [] 内部含中文时 → 视为词条一部分，整体匹配
 *   - ASCII () 或 [] 内部无中文时（如 (123)）→ 不纳入匹配，自动截断
 *   - 全角（）已在 CN_PUNCT 中，始终视为词条内容
 *
 * 每次调用返回新实例，避免 matchAll 共享 lastIndex 状态。
 */
export const chineseRe = () =>
  new RegExp(
    `[\u4e00-\u9fa5][${CN_PUNCT}\u4e00-\u9fa5]*` +
      `(?:[\\u0028\\u005b][${CN_PUNCT}\u4e00-\u9fa5]+[\\u0029\\u005d][${CN_PUNCT}\u4e00-\u9fa5]*)*`,
    'g',
  )

/** 仅用于 test 的无状态版本（只需检测是否含汉字，无需处理标点） */
export const CHINESE_TEST_RE = /[\u4e00-\u9fa5]/

/** 转义正则特殊字符，用于将普通字符串安全地嵌入正则表达式 */
export function escapeReg(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
