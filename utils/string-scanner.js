/**
 * utils/string-scanner.js
 * 字符串字面量提取器：从代码中提取完整字符串（支持跨行、含 HTML 标签、模板字面量）
 *
 * 核心思路：先确定字符串边界（开/闭引号），再在边界内检测中文，
 * 避免 <br>、<span>、多行换行等把词条割裂成多段。
 *
 * 导出：
 *   scanJsStrings(code)              — 提取 JS/TS 代码中所有字符串字面量
 *   extractTemplateParts(content)    — 提取模板字面量中所有段（文本段 + 表达式段）
 *   extractTemplateSegments(content) — 仅提取模板字面量中各非插值文本段（旧接口保留）
 *   posToLine(code, pos)             — 绝对字符位置 → 0-indexed 行号
 */

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 从 JS/TS 代码（已去除注释）中提取所有字符串字面量。
 *
 * 支持：单引号 '...'、双引号 "..."、模板字面量 `...`（含跨行）。
 * 对模板字面量内的 ${...} 插值块，递归跳过并标记 hasInterpolation = true。
 *
 * @param {string} code 已去除 JS 注释的代码文本
 * @returns {Array<{
 *   start: number,           // 开引号的绝对位置
 *   end: number,             // 闭引号之后的位置
 *   quote: "'" | '"' | '`',
 *   content: string,         // 字符串原始内容（不含外层引号，含 ${...} 原文）
 *   hasInterpolation: boolean,
 * }>}
 */
export function scanJsStrings(code) {
  const tokens = []
  let i = 0

  while (i < code.length) {
    const ch = code[i]

    if (ch === "'" || ch === '"') {
      const start = i
      const quote = ch
      i++
      while (i < code.length && code[i] !== quote && code[i] !== '\n') {
        if (code[i] === '\\') i++ // skip escaped char
        i++
      }
      const closed = i < code.length && code[i] === quote
      if (closed) i++
      tokens.push({
        start,
        end: i,
        quote,
        content: code.slice(start + 1, closed ? i - 1 : i),
        hasInterpolation: false,
      })
    } else if (ch === '`') {
      const start = i++
      let hasInterpolation = false
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '`') { i++; break }
        if (code[i] === '$' && code[i + 1] === '{') {
          hasInterpolation = true
          i = _skipExprBlock(code, i + 2)
          continue
        }
        i++
      }
      tokens.push({
        start,
        end: i,
        quote: '`',
        content: code.slice(start + 1, i - 1),
        hasInterpolation,
      })
    } else {
      i++
    }
  }

  return tokens
}

/**
 * 提取模板字面量中所有段（文本段和表达式段），复用 _skipExprBlock 正确处理嵌套。
 *
 * 例：`前缀${expr}后缀` →
 *   [
 *     { type: 'text', text: '前缀',  start: 0, end: 2 },
 *     { type: 'expr', text: 'expr',  start: 4, end: 8 },
 *     { type: 'text', text: '后缀',  start: 9, end: 11 },
 *   ]
 *
 * start/end 均相对于 content（不含外层反引号）：
 *   - text 段：content.slice(start, end) = 文本内容
 *   - expr 段：content.slice(start, end) = ${} 内的表达式（不含 ${ 和 }）
 *
 * @param {string} content 模板字面量内容（不含外层反引号）
 * @returns {Array<{ type: 'text'|'expr', text: string, start: number, end: number }>}
 */
export function extractTemplateParts(content) {
  const parts = []
  let i = 0
  let textStart = 0

  while (i < content.length) {
    if (content[i] === '$' && content[i + 1] === '{') {
      if (i > textStart) {
        parts.push({ type: 'text', text: content.slice(textStart, i), start: textStart, end: i })
      }
      const exprStart = i + 2  // 跳过 ${，指向表达式第一个字符
      i = _skipExprBlock(content, exprStart)
      const exprEnd = i - 1    // i 已越过 }，exprEnd 是 } 的位置（即表达式末尾）
      parts.push({
        type: 'expr',
        text: content.slice(exprStart, exprEnd),
        start: exprStart,
        end: exprEnd,
      })
      textStart = i
    } else {
      i++
    }
  }
  if (i > textStart) {
    parts.push({ type: 'text', text: content.slice(textStart, i), start: textStart, end: i })
  }
  return parts
}

/**
 * 提取模板字面量中各非插值文本段（旧接口，保留向后兼容）。
 *
 * 例：`前缀${var}后缀` → [{ text: '前缀', offset: 0 }, { text: '后缀', offset: 9 }]
 *
 * @param {string} content 模板字面量内容（不含外层反引号）
 * @returns {Array<{ text: string, offset: number }>}
 */
export function extractTemplateSegments(content) {
  return extractTemplateParts(content)
    .filter(p => p.type === 'text')
    .map(p => ({ text: p.text, offset: p.start }))
}

/**
 * 将代码的绝对字符位置转换为 0-indexed 行号。
 *
 * @param {string} code
 * @param {number} pos
 * @returns {number}
 */
export function posToLine(code, pos) {
  let line = 0
  const end = Math.min(pos, code.length)
  for (let i = 0; i < end; i++) {
    if (code[i] === '\n') line++
  }
  return line
}

// ─── 内部辅助 ─────────────────────────────────────────────────────────────────

/**
 * 跳过 ${...} 表达式块（支持嵌套大括号及内部字符串字面量）。
 * 进入时 i 指向 "{" 之后的第一个字符（depth 已为 1）。
 */
function _skipExprBlock(code, i) {
  let depth = 1
  while (i < code.length && depth > 0) {
    const ch = code[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '{') { depth++; i++; continue }
    if (ch === '}') { depth--; i++; continue }
    // 跳过嵌套简单字符串
    if (ch === "'" || ch === '"') {
      const q = ch; i++
      while (i < code.length && code[i] !== q && code[i] !== '\n') {
        if (code[i] === '\\') i++
        i++
      }
      if (i < code.length && code[i] === q) i++
      continue
    }
    // 跳过嵌套模板字面量
    if (ch === '`') {
      i++
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === '`') { i++; break }
        if (code[i] === '$' && code[i + 1] === '{') { i = _skipExprBlock(code, i + 2); continue }
        i++
      }
      continue
    }
    i++
  }
  return i
}
