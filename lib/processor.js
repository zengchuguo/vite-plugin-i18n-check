/**
 * lib/processor.js
 * 文件内容处理：扫描中文词条、自动替换或收集未翻译项
 *
 * 导出：
 *   processFile          — 处理单个文件（根据扩展名分发到 Vue / JS 流程）
 *   processTemplateBlock — 处理 Vue <template> 块
 *   processScriptBlock   — 处理 Vue <script> 块
 *   processJsContent     — 处理纯 JS/JSX 内容
 */

import { chineseRe, escapeReg } from '../utils/regex.js'
import { removeHtmlComments, removeJsComments } from '../utils/comments.js'
import {
  isInsideStringLiteral,
  isInsideIgnoredCall,
  isInsideI18nCall,
  isInsideTemplateExprString,
} from '../utils/string-ctx.js'
import { buildTemplateReplacement, replaceI18nCallArg, replaceStringLiteral } from '../utils/replacer.js'

// ─── 对外接口 ─────────────────────────────────────────────────────────────────

/**
 * 处理单个源文件，返回替换后的内容、替换次数和未翻译词条列表。
 *
 * @param {string} absFile        文件绝对路径
 * @param {string} relFile        文件相对路径（用于报告输出）
 * @param {string} originalContent 文件原始内容
 * @param {Record<string,string>} reverseMap  中文 → i18n key 反向映射表
 * @param {string} scriptI18nFn   JS/script 块中 i18n 调用函数名（如 't' 或 '$t'）
 * @returns {{ content: string, replacedCount: number, untranslated: Array }}
 */
export function processFile(absFile, relFile, originalContent, reverseMap, scriptI18nFn) {
  const isVue = absFile.endsWith('.vue')
  let content = originalContent
  let replacedCount = 0
  const untranslated = []

  if (isVue) {
    const tr = processTemplateBlock(content, relFile, reverseMap)
    content = tr.content; replacedCount += tr.replacedCount; untranslated.push(...tr.untranslated)
    const sr = processScriptBlock(content, relFile, reverseMap, scriptI18nFn)
    content = sr.content; replacedCount += sr.replacedCount; untranslated.push(...sr.untranslated)
  } else {
    const sr = processJsContent(content, relFile, reverseMap, 0, scriptI18nFn)
    content = sr.content; replacedCount += sr.replacedCount; untranslated.push(...sr.untranslated)
  }

  return { content, replacedCount, untranslated }
}

// ─── Template 块处理 ──────────────────────────────────────────────────────────

/**
 * 扫描 <template> 块，批量替换或收集未翻译词条。
 *
 * 整个模板只做一次 split('\n') / join('\n')，消除每词条都 split/join 的 O(N²) 开销；
 * 同一行存在多个词条时，通过 colOffset 累积偏移量修正列位置，避免索引错位。
 *
 * @param {string} fileContent  完整文件内容
 * @param {string} relFile      相对路径（报告用）
 * @param {Record<string,string>} reverseMap
 * @returns {{ content: string, replacedCount: number, untranslated: Array }}
 */
export function processTemplateBlock(fileContent, relFile, reverseMap) {
  let content = fileContent
  let replacedCount = 0
  const untranslated = []

  const templateStart = content.indexOf('<template>')
  const templateEnd = content.lastIndexOf('</template>')
  if (templateStart === -1 || templateEnd === -1) return { content, replacedCount, untranslated }

  const templateRaw = content.slice(templateStart, templateEnd + '</template>'.length)
  const cleanedTemplate = removeHtmlComments(templateRaw)
  const lineOffset = content.slice(0, templateStart).split('\n').length - 1

  // 步骤 1：扫描清理后的模板，按行收集匹配
  const cleanedLines = cleanedTemplate.split('\n')
  /** @type {Map<number, Array<{text:string, col:number, context:string}>>} */
  const matchesByLine = new Map()
  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i]
    for (const m of line.matchAll(chineseRe())) {
      const before = line.slice(0, m.index)
      // 中文直接位于属性值内：:attr="中文" 或 attr="中文"
      const isAttrValue = /=["']?\s*$/.test(before) || /=["'][^"']*$/.test(before)
      // 中文位于绑定属性表达式中的字符串字面量内：:attr="... ? '中文' : ..."
      // 判断依据：before 中存在属性绑定开口（=["']），且当前列处于字符串字面量内
      const isBindingExprStr =
        !isAttrValue && /=["']/.test(before) && isInsideStringLiteral(line, m.index)
      const context = isAttrValue ? 'attrValue' : isBindingExprStr ? 'bindingExprString' : 'textNode'
      const bucket = matchesByLine.get(i) ?? []
      bucket.push({ text: m[0], col: m.index, context })
      matchesByLine.set(i, bucket)
    }
  }

  // 步骤 2：在原始行数组上批量替换（整个模板只做一次 split / join）
  const lines = templateRaw.split('\n')

  for (const [lineIdx, matches] of matchesByLine) {
    let line = lines[lineIdx]
    let colOffset = 0
    const absoluteLine = lineOffset + lineIdx + 1

    for (const match of matches) {
      const key = reverseMap[match.text]

      if (!key) {
        untranslated.push({ file: relFile, line: absoluteLine, text: match.text })
        continue
      }

      const adjustedCol = match.col + colOffset
      const before = line.slice(0, adjustedCol)

      // 中文已在字符串参数内：只替换字符串值，不再外包 $t() 或 {{ }}
      if (isInsideI18nCall(before) || isInsideTemplateExprString(before)) {
        const newLine = line.slice(0, adjustedCol) + key + line.slice(adjustedCol + match.text.length)
        colOffset += newLine.length - line.length
        line = newLine
        replacedCount++
        continue
      }

      // 中文在绑定属性表达式内的字符串字面量中（如 :attr="cond ? '中文' : other"）
      // 将整个 '中文'（含引号）替换为 $t('key')
      if (match.context === 'bindingExprString') {
        const newLine = replaceStringLiteral(line, match.text, key, '$t')
        if (newLine !== line) {
          colOffset += newLine.length - line.length
          line = newLine
          replacedCount++
        } else {
          untranslated.push({ file: relFile, line: absoluteLine, text: match.text })
        }
        continue
      }

      const replacement = buildTemplateReplacement(match, key)
      if (!replacement) {
        untranslated.push({ file: relFile, line: absoluteLine, text: match.text })
        continue
      }

      if (match.context === 'textNode') {
        const newLine =
          line.slice(0, adjustedCol) + replacement + line.slice(adjustedCol + match.text.length)
        colOffset += newLine.length - line.length
        line = newLine
        replacedCount++
      } else {
        // attrValue：反向定位属性名，再整行替换
        const attrNameMatch = before.match(/\s([\w-:@.]+)=["']?[^"']*$/)
        if (attrNameMatch) {
          const attrName = attrNameMatch[1]
          const bindAttrName = attrName.startsWith(':') ? attrName : `:${attrName}`
          const fullAttrRe = new RegExp(
            `([\\s])${escapeReg(attrName)}=["']([^"']*)${escapeReg(match.text)}([^"']*)["']`,
          )
          const newLine = line.replace(
            fullAttrRe,
            (_, space, b, a) => `${space}${bindAttrName}="${b}${replacement}${a}"`,
          )
          if (newLine !== line) {
            colOffset += newLine.length - line.length
            line = newLine
            replacedCount++
          } else {
            untranslated.push({ file: relFile, line: absoluteLine, text: match.text })
          }
        } else {
          // 降级：按位置直接替换
          const newLine =
            line.slice(0, adjustedCol) + replacement + line.slice(adjustedCol + match.text.length)
          colOffset += newLine.length - line.length
          line = newLine
          replacedCount++
        }
      }
    }

    lines[lineIdx] = line
  }

  const newTemplateContent = lines.join('\n')
  content =
    content.slice(0, templateStart) +
    newTemplateContent +
    content.slice(templateEnd + '</template>'.length)
  return { content, replacedCount, untranslated }
}

// ─── Script 块处理 ────────────────────────────────────────────────────────────

/**
 * 提取 Vue 文件的 <script> 块内容，交由 processJsContent 处理后拼回完整文件。
 *
 * @param {string} fileContent
 * @param {string} relFile
 * @param {Record<string,string>} reverseMap
 * @param {string} scriptI18nFn
 * @returns {{ content: string, replacedCount: number, untranslated: Array }}
 */
export function processScriptBlock(fileContent, relFile, reverseMap, scriptI18nFn) {
  const scriptStartMatch = fileContent.match(/<script(\s[^>]*)?>/)
  if (!scriptStartMatch) return { content: fileContent, replacedCount: 0, untranslated: [] }

  const scriptStart = fileContent.indexOf(scriptStartMatch[0])
  const scriptContentStart = scriptStart + scriptStartMatch[0].length
  const scriptEnd = fileContent.indexOf('</script>', scriptContentStart)
  if (scriptEnd === -1) return { content: fileContent, replacedCount: 0, untranslated: [] }

  const lineOffset = fileContent.slice(0, scriptContentStart).split('\n').length - 1
  const result = processJsContent(
    fileContent.slice(scriptContentStart, scriptEnd),
    relFile,
    reverseMap,
    lineOffset,
    scriptI18nFn,
  )

  return {
    content: fileContent.slice(0, scriptContentStart) + result.content + fileContent.slice(scriptEnd),
    replacedCount: result.replacedCount,
    untranslated: result.untranslated,
  }
}

// ─── JS/JSX 内容处理 ──────────────────────────────────────────────────────────

/**
 * 扫描 JS/JSX 内容（或 Vue <script> 块的内部文本），逐行查找中文词条并替换。
 *
 * @param {string} content       待扫描的 JS 代码文本
 * @param {string} relFile       相对路径（报告用）
 * @param {Record<string,string>} reverseMap
 * @param {number} lineOffset    行号基准偏移（Vue script 块时非零）
 * @param {string} scriptI18nFn  替换时使用的函数名
 * @returns {{ content: string, replacedCount: number, untranslated: Array }}
 */
export function processJsContent(content, relFile, reverseMap, lineOffset, scriptI18nFn) {
  let replacedCount = 0
  const untranslated = []
  const cleaned = removeJsComments(content)
  const lines = content.split('\n')
  const cleanedLines = cleaned.split('\n')

  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i]
    const absoluteLine = lineOffset + i + 1

    for (const m of line.matchAll(chineseRe())) {
      const text = m[0]
      const col = m.index

      if (!isInsideStringLiteral(line, col)) continue
      if (isInsideIgnoredCall(line, col)) continue

      if (reverseMap[text]) {
        const newLine = isInsideI18nCall(line.slice(0, col))
          ? replaceI18nCallArg(lines[i], text, reverseMap[text])
          : replaceStringLiteral(lines[i], text, reverseMap[text], scriptI18nFn)
        if (newLine !== lines[i]) { lines[i] = newLine; replacedCount++ }
      } else {
        untranslated.push({ file: relFile, line: absoluteLine, text })
      }
    }
  }

  return { content: lines.join('\n'), replacedCount, untranslated }
}
