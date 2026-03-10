/**
 * utils/string-ctx.js
 * 字符串上下文分析：判断某列字符是否处于字符串字面量、i18n 调用、忽略调用等特定上下文内
 */

// ─── 预编译正则（模块级，避免重复创建）────────────────────────────────────────

const IGNORED_CONSOLE_RE =
  /console\s*\.\s*(log|warn|error|info|debug|trace|assert|dir|table|group|groupEnd|time|timeEnd)\s*\(/
const IGNORED_NEW_ERROR_RE = /\bnew\s+Error\s*\(/
const IGNORED_ERROR_CLASS_RE = /(?<![.\w])Error\s*\(/
const IGNORED_ERROR_FN_RE = /(?<![.\w])error\s*\(/
const IGNORED_WARN_FN_RE = /(?<![.\w])warn\s*\(/

/**
 * 匹配 $t(' / t(' / i18n.t(' / $i18n.t(' 等常见 i18n 调用的字符串参数开头，
 * 用于识别「中文已在 $t() 内」的场景。
 */
const I18N_CALL_RE = /(?:\$i18n\.t|i18n\.t|\$t|\bt)\s*\(\s*['"`]\s*$/

// ─── 导出函数 ─────────────────────────────────────────────────────────────────

/**
 * 判断 line 中 col 位置的字符是否处于字符串字面量内（单引号、双引号、模板字符串）。
 * 支持模板字符串嵌套表达式（${...}）内的字符串。
 */
export function isInsideStringLiteral(line, col) {
  let state = 'code'
  let exprDepth = 0

  for (let i = 0; i < col; i++) {
    const ch = line[i]
    if (ch === '\\') { i++; continue }

    switch (state) {
      case 'code':
        if (ch === "'") state = 'single'
        else if (ch === '"') state = 'double'
        else if (ch === '`') state = 'template'
        break
      case 'single': if (ch === "'") state = 'code'; break
      case 'double': if (ch === '"') state = 'code'; break
      case 'template':
        if (ch === '`') state = 'code'
        else if (ch === '$' && line[i + 1] === '{') { state = 'templateExpr'; exprDepth = 1; i++ }
        break
      case 'templateExpr':
        if (ch === '{') exprDepth++
        else if (ch === '}') { exprDepth--; if (exprDepth === 0) state = 'template' }
        else if (ch === "'") state = 'tplExprSingle'
        else if (ch === '"') state = 'tplExprDouble'
        else if (ch === '`') state = 'template'
        break
      case 'tplExprSingle': if (ch === "'") state = 'templateExpr'; break
      case 'tplExprDouble': if (ch === '"') state = 'templateExpr'; break
    }
  }

  return state === 'single' || state === 'double' || state === 'template'
}

/**
 * 判断 line 中 col 位置是否处于应忽略的调用内：
 *   console.log/warn/error/... | new Error() | Error() | error() | warn()
 */
export function isInsideIgnoredCall(line, col) {
  const before = line.slice(0, col)
  return (
    IGNORED_CONSOLE_RE.test(before) ||
    IGNORED_NEW_ERROR_RE.test(before) ||
    IGNORED_ERROR_CLASS_RE.test(before) ||
    IGNORED_ERROR_FN_RE.test(before) ||
    IGNORED_WARN_FN_RE.test(before)
  )
}

/**
 * 判断 before（中文左侧的内容）末尾是否处于 i18n 函数调用的字符串参数内。
 * 匹配 $t('、t('、i18n.t('、$i18n.t(' 等常见调用形式（含双引号和反引号变体）。
 */
export function isInsideI18nCall(before) {
  return I18N_CALL_RE.test(before)
}

/**
 * 判断模板中，中文前的 before 字符串是否处于 {{ ... }} 表达式内的字符串字面量中。
 *
 * 原理：统计 {{ 与 }} 的层数，若未关闭（depth > 0）说明在表达式内，
 * 再判断紧靠中文左侧（去除空格后）的字符是否为字符串定界符 ' " `。
 *
 * 用于处理 {{ gengertiont('关于') }} 这类非标准 i18n 函数名的情况：
 * 替换时只更新字符串内容，不再外包 {{ $t() }}。
 */
export function isInsideTemplateExprString(before) {
  let depth = 0
  for (let i = 0; i < before.length - 1; i++) {
    if (before[i] === '{' && before[i + 1] === '{') { depth++; i++ }
    else if (before[i] === '}' && before[i + 1] === '}') { if (depth > 0) depth--; i++ }
  }
  if (depth <= 0) return false
  const trimmed = before.trimEnd()
  const lastChar = trimmed[trimmed.length - 1]
  return lastChar === "'" || lastChar === '"' || lastChar === '`'
}
