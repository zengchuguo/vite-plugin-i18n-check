/**
 * utils/replacer.js
 * 词条替换函数：根据上下文生成正确的替换内容并写回行字符串
 */

import { escapeReg } from './regex.js'

/**
 * 根据匹配词条所在的模板上下文，生成对应的替换字符串。
 *   textNode  → {{ $t('key') }}
 *   attrValue → $t('key')
 */
export function buildTemplateReplacement(match, key) {
  if (match.context === 'textNode') return `{{ $t('${key}') }}`
  if (match.context === 'attrValue') return `$t('${key}')`
  return null
}

/**
 * 中文已在 i18n 调用内（如 $t('关于') 或 {{ $t('关于') }}），
 * 只将字符串中的中文替换为 key，不再外包 $t()。
 *
 * 例：
 *   $t('关于')      → $t('about')
 *   $t('错误：关于') → $t('错误：about')
 */
export function replaceI18nCallArg(line, text, key) {
  const escaped = escapeReg(text)

  const simpleRe = new RegExp(`(['"])([^'"\\n]*?)${escaped}([^'"\\n]*?)\\1`)
  if (simpleRe.test(line)) {
    return line.replace(simpleRe, (_, q, pre, post) => `${q}${pre}${key}${post}${q}`)
  }

  const tplRe = new RegExp('`([^`\\n]*?)' + escaped + '([^`\\n]*?)`')
  if (tplRe.test(line)) {
    return line.replace(tplRe, (_, pre, post) => `\`${pre}${key}${post}\``)
  }

  return line
}

/**
 * 将字符串字面量中的中文替换为 scriptI18nFn('key') 调用。
 * 若字符串内还有其他内容（前缀/后缀），使用字符串拼接保留。
 *
 * 例：
 *   '关于'       → t('about')
 *   '前缀关于后缀' → '前缀' + t('about') + '后缀'
 */
export function replaceStringLiteral(line, text, key, scriptI18nFn = 't') {
  const escaped = escapeReg(text)
  const callExpr = `${scriptI18nFn}('${key}')`

  const simpleRe = new RegExp(`(['"])([^'"]*?)${escaped}([^'"]*?)\\1`)
  if (simpleRe.test(line)) {
    return line.replace(simpleRe, (_, quote, before, after) => {
      if (before || after) return `${quote}${before}${quote} + ${callExpr} + ${quote}${after}${quote}`
      return callExpr
    })
  }

  const tplRe = new RegExp('(`)([^`]*?)' + escaped + '([^`]*?)`')
  if (tplRe.test(line)) {
    return line.replace(tplRe, (_, _q, before, after) => {
      if (before || after) return '`' + before + '`' + ` + ${callExpr} + ` + '`' + after + '`'
      return callExpr
    })
  }

  return line
}
