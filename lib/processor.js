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

import { chineseRe, CHINESE_TEST_RE, escapeReg } from '../utils/regex.js'
import { removeHtmlComments, removeJsComments, isIgnoredLine, isNextLineIgnored, buildDisabledLineSet } from '../utils/comments.js'
import {
  isInsideStringLiteral,
  isInsideIgnoredCall,
  isInsideI18nCall,
  isInsideTemplateExprString,
} from '../utils/string-ctx.js'
import { buildTemplateReplacement, replaceI18nCallArg, replaceStringLiteral } from '../utils/replacer.js'
import { scanJsStrings, extractTemplateParts, posToLine } from '../utils/string-scanner.js'

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
 * 采用两遍扫描 + 统一从后向前应用替换：
 *   Pass 1（属性整块）：在去注释后的完整模板上用状态机提取每个属性的完整值
 *                       （支持跨行、含 <br>/<span> 等 HTML 标签），整体匹配 reverseMap。
 *   Pass 2（文本节点）：逐行用 chineseRe 扫描，跳过 Pass 1 已处理的属性范围，
 *                       只处理 HTML 文本内容（textNode）。
 *   所有替换收集为绝对位置指令，最后统一从后向前应用，确保位置不错乱。
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

  const cleanedLines = cleanedTemplate.split('\n')
  const rawLines = templateRaw.split('\n')
  const disabledLines = buildDisabledLineSet(rawLines)

  // 预计算每行在 templateRaw 中的起始绝对位置（用于 lineIdx + col → 绝对 pos）
  const lineStarts = [0]
  for (let i = 0; i < rawLines.length - 1; i++) {
    lineStarts.push(lineStarts[i] + rawLines[i].length + 1) // +1 for \n
  }

  // 所有替换指令（绝对位置相对于 templateRaw），统一从后向前应用
  /** @type {Array<{start:number, end:number, replacement:string}>} */
  const allReplacements = []
  // Pass 1 已处理的属性值范围，Pass 2 文本节点扫描时跳过
  const processedRanges = [] // [absStart, absEnd]

  // ── Pass 1：属性值整块预扫描 ─────────────────────────────────────────────
  for (const attr of _scanTemplateAttrCandidates(cleanedTemplate)) {
    const lineIdx = posToLine(cleanedTemplate, attr.attrStart)
    if (
      isIgnoredLine(rawLines[lineIdx]) ||
      isNextLineIgnored(rawLines[lineIdx - 1]) ||
      disabledLines.has(lineIdx)
    ) continue

    processedRanges.push([attr.valueStart, attr.valueEnd])
    const absoluteLine = lineOffset + lineIdx + 1

    if (!attr.isDynamic) {
      // ── 静态属性：整体属性值 = 一个词条候选 ──────────────────────────────
      if (!CHINESE_TEST_RE.test(attr.value)) continue

      // 规范化：多行属性值中 \n + 缩进空白是模板格式化产物，不属于语义内容，
      // 将其折叠后再查 reverseMap，使多行写法与单行写法等价。
      // 例：content="中文<br>\n          更多" 规范化为 "中文<br>更多"
      const normalizedValue = attr.value.replace(/\n\s*/g, '')
      const wholeKey = reverseMap[normalizedValue] ?? reverseMap[attr.value]
      if (wholeKey) {
        // attr="中文" → :attr="$t('key')"
        allReplacements.push({
          start: attr.attrStart,
          end: attr.valueEnd + 1,
          replacement: `:${attr.attrName}="$t('${wholeKey}')"`,
        })
      } else {
        // 静态属性值作为整体上报未翻译：
        //   含 <br>/<span> 等 HTML 标签或跨行内容时，整个规范化值是一个完整词条，
        //   不应按 chineseRe() 拆分（<br> 的 < 会截断）。
        //   开发者根据上报内容将整个字符串作为 key 写入语言文件即可。
        if (CHINESE_TEST_RE.test(normalizedValue)) {
          untranslated.push({ file: relFile, line: absoluteLine, text: normalizedValue })
        }
      }
    } else {
      // ── 动态属性（绑定表达式）：对内部 JS 字符串字面量整块扫描 ─────────────
      for (const str of scanJsStrings(attr.value)) {
        if (!CHINESE_TEST_RE.test(str.content)) continue

        const absStart = attr.valueStart + str.start
        const absEnd = attr.valueStart + str.end
        const strLineIdx = posToLine(cleanedTemplate, absStart)
        const strLine = lineOffset + strLineIdx + 1

        if (
          isIgnoredLine(rawLines[strLineIdx]) ||
          isNextLineIgnored(rawLines[strLineIdx - 1]) ||
          disabledLines.has(strLineIdx)
        ) continue

        const beforeQuote = attr.value.slice(0, str.start + 1)
        const isI18n = isInsideI18nCall(beforeQuote)

        // ── 模板字面量含插值：构建带占位符 key，支持识别和替换 ────────────
        if (str.hasInterpolation) {
          const parts = extractTemplateParts(str.content)
          if (!parts.some(p => p.type === 'text' && CHINESE_TEST_RE.test(p.text))) continue

          let keyTemplate = ''
          const exprParts = []
          let paramIdx = 0
          for (const part of parts) {
            if (part.type === 'text') {
              keyTemplate += part.text
            } else {
              keyTemplate += `{p${paramIdx++}}`
              exprParts.push(part)
            }
          }

          const wholeKey = reverseMap[keyTemplate]
          if (wholeKey) {
            // 从原始模板中提取表达式文本（位置对齐）
            const rawLiteral = templateRaw.slice(absStart + 1, absEnd - 1)
            const paramsStr = exprParts
              .map((p, idx) => `p${idx}: ${rawLiteral.slice(p.start, p.end)}`)
              .join(', ')
            allReplacements.push({
              start: absStart,
              end: absEnd,
              replacement: paramsStr
                ? `$t('${wholeKey}', { ${paramsStr} })`
                : `$t('${wholeKey}')`,
            })
          } else {
            untranslated.push({ file: relFile, line: strLine, text: keyTemplate })
          }
          continue
        }

        if (isI18n) {
          const key = reverseMap[str.content]
          if (key) allReplacements.push({ start: absStart + 1, end: absEnd - 1, replacement: key })
          else untranslated.push({ file: relFile, line: strLine, text: str.content })
          continue
        }

        // 优先：整个字符串内容作为词条
        const wholeKey = reverseMap[str.content]
        if (wholeKey) {
          allReplacements.push({ start: absStart, end: absEnd, replacement: `$t('${wholeKey}')` })
          continue
        }

        // 兜底：整体上报（含 HTML 标签时不拆分）
        untranslated.push({ file: relFile, line: strLine, text: str.content })
      }
    }
  }

  // ── Pass 2：文本节点扫描（逐行，跳过已处理属性范围）────────────────────────
  for (let i = 0; i < cleanedLines.length; i++) {
    if (isIgnoredLine(rawLines[i]) || isNextLineIgnored(rawLines[i - 1]) || disabledLines.has(i)) continue
    const line = cleanedLines[i]
    const absoluteLine = lineOffset + i + 1

    for (const m of line.matchAll(chineseRe())) {
      const absPos = lineStarts[i] + m.index

      // 跳过 Pass 1 已处理的属性值范围
      if (processedRanges.some(([s, e]) => absPos >= s && absPos < e)) continue

      const before = line.slice(0, m.index)

      // 属性类上下文由 Pass 1 负责，这里只处理文本节点
      const isAttrValue = /=["']?\s*$/.test(before) || /=["'][^"']*$/.test(before)
      const isBindingExprStr =
        !isAttrValue && /=["']/.test(before) && isInsideStringLiteral(line, m.index)
      if (isAttrValue || isBindingExprStr) continue

      const text = m[0]
      const key = reverseMap[text]

      if (!key) {
        untranslated.push({ file: relFile, line: absoluteLine, text })
        continue
      }

      // 检查是否已在 i18n 调用或 {{ }} 表达式内
      const rawBefore = templateRaw.slice(0, absPos)
      if (isInsideI18nCall(rawBefore) || isInsideTemplateExprString(rawBefore)) {
        allReplacements.push({ start: absPos, end: absPos + text.length, replacement: key })
        continue
      }

      // 文本节点：包裹 {{ $t('key') }}
      allReplacements.push({ start: absPos, end: absPos + text.length, replacement: `{{ $t('${key}') }}` })
    }
  }

  // ── 从后向前应用所有替换 ─────────────────────────────────────────────────
  let newTemplateContent = templateRaw
  for (const rep of allReplacements.sort((a, b) => b.start - a.start)) {
    newTemplateContent =
      newTemplateContent.slice(0, rep.start) + rep.replacement + newTemplateContent.slice(rep.end)
    replacedCount++
  }

  content =
    content.slice(0, templateStart) +
    newTemplateContent +
    content.slice(templateEnd + '</template>'.length)
  return { content, replacedCount, untranslated }
}

// ─── Template 属性扫描器 ──────────────────────────────────────────────────────

/**
 * 状态机：扫描已去注释的模板 HTML，逐个 yield 所有属性（含完整属性值，支持跨行）。
 *
 * 关键特性：
 *   - 属性值读取直到闭合引号，天然支持跨行和内含 <br>/<span> 等标签
 *   - isDynamic 区分静态属性（attr="..."）和绑定属性（:attr="..."、@attr="..."、v-*）
 *   - 在 cleanedTemplate 上操作，注释已变为空格，不产生误匹配
 *
 * @param {string} template cleanedTemplate（与 templateRaw 等长，位置可互换）
 * @yields {{
 *   isDynamic: boolean,
 *   attrName: string,
 *   value: string,
 *   attrStart: number,
 *   openQuotePos: number,
 *   valueStart: number,
 *   valueEnd: number,
 *   quote: string,
 * }}
 */
function* _scanTemplateAttrCandidates(template) {
  let i = 0

  while (i < template.length) {
    // 找下一个 < 号
    while (i < template.length && template[i] !== '<') i++
    if (i >= template.length) break

    // 跳过闭合标签 </tag>
    if (template[i + 1] === '/') {
      while (i < template.length && template[i] !== '>') i++
      i++
      continue
    }

    // 跳过标签名
    i++ // skip <
    while (i < template.length && !/[\s>\/]/.test(template[i])) i++

    // 解析属性列表（直到标签结束 > 或 />）
    while (i < template.length) {
      // 跳过空白
      while (i < template.length && /\s/.test(template[i])) i++

      if (i >= template.length) break
      if (template[i] === '>' || (template[i] === '/' && template[i + 1] === '>')) break

      // 读属性名（允许 :, @, -, . 等 Vue 特殊字符）
      const attrStart = i
      while (i < template.length && !/[\s=>/]/.test(template[i])) i++
      const attrName = template.slice(attrStart, i)
      if (!attrName) { i++; continue }

      // 跳过空白
      while (i < template.length && /\s/.test(template[i])) i++

      // 无 = 号：布尔属性，跳过值读取
      if (template[i] !== '=') continue

      i++ // skip =
      while (i < template.length && /\s/.test(template[i])) i++

      const quote = template[i]
      if (quote !== '"' && quote !== "'") { i++; continue }

      const openQuotePos = i
      const valueStart = i + 1
      i++ // skip opening quote

      // 读属性值（遇到同类引号为止，支持跨行）
      while (i < template.length && template[i] !== quote) i++
      const valueEnd = i
      const value = template.slice(valueStart, valueEnd)
      if (i < template.length) i++ // skip closing quote

      const isDynamic = /^[:@]/.test(attrName) || attrName.startsWith('v-')
      yield { isDynamic, attrName, value, attrStart, openQuotePos, valueStart, valueEnd, quote }
    }

    // 跳到标签结束
    while (i < template.length && template[i] !== '>') i++
    if (i < template.length) i++ // skip >
  }
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
 * 扫描 JS/JSX 内容（或 Vue <script> 块的内部文本），找到完整字符串后检测并替换中文词条。
 *
 * 与旧版逐行+chineseRe 的区别：
 *   先通过 scanJsStrings 确定字符串边界（支持跨行、含 HTML 标签），
 *   再在整个字符串内容上检测中文，避免 <br>、<span> 等把词条割裂成多段。
 *
 * 处理优先级：
 *   1. 整个字符串内容 → reverseMap 查找（最精确）
 *   2. 字符串内中文子串 → reverseMap 查找（兜底，保持向后兼容）
 *   模板字面量含 ${} → 仅收集非插值段中文，报告为待人工处理，不自动替换
 *
 * @param {string} content       待扫描的 JS 代码文本
 * @param {string} relFile       相对路径（报告用）
 * @param {Record<string,string>} reverseMap
 * @param {number} lineOffset    行号基准偏移（Vue script 块时非零）
 * @param {string} scriptI18nFn  替换时使用的函数名
 * @returns {{ content: string, replacedCount: number, untranslated: Array }}
 */
export function processJsContent(content, relFile, reverseMap, lineOffset, scriptI18nFn) {
  const untranslated = []
  const cleaned = removeJsComments(content)
  const rawLines = content.split('\n')
  const disabledLines = buildDisabledLineSet(rawLines)

  // 扫描整块代码中所有字符串字面量（支持跨行、模板字面量）
  const strings = scanJsStrings(cleaned)
  // 收集替换指令，最后统一从后向前应用，确保绝对位置不错乱
  const replacements = [] // { start, end, replacement }

  for (const str of strings) {
    const lineIdx = posToLine(cleaned, str.start)
    const absoluteLine = lineOffset + lineIdx + 1

    // 忽略标记检查
    if (
      isIgnoredLine(rawLines[lineIdx]) ||
      isNextLineIgnored(rawLines[lineIdx - 1]) ||
      disabledLines.has(lineIdx)
    ) continue

    // 取当前行文本，用于 isInsideIgnoredCall（只看本行上下文）
    const lineStart = cleaned.lastIndexOf('\n', str.start - 1) + 1
    const lineEnd = cleaned.indexOf('\n', str.start)
    const lineText = cleaned.slice(lineStart, lineEnd === -1 ? cleaned.length : lineEnd)
    const colInLine = str.start - lineStart
    if (isInsideIgnoredCall(lineText, colInLine)) continue

    // 是否已在 $t('...') 内
    const beforeQuote = cleaned.slice(0, str.start + 1)
    const isI18n = isInsideI18nCall(beforeQuote)

    // ── 模板字面量含插值：构建带占位符的 key 模板，支持整体识别和自动替换 ────
    // 策略：将 ${expr} 替换为 {p0}、{p1}... 占位符，构成 key 模板；
    //   - key 模板在 reverseMap 中存在 → 自动替换为 t('key', { p0: expr, ... })
    //   - 不存在 → 上报完整 key 模板，开发者复制到语言文件后下次可整体替换
    if (str.hasInterpolation) {
      const parts = extractTemplateParts(str.content)

      // 只处理含中文的文本段
      if (!parts.some(p => p.type === 'text' && CHINESE_TEST_RE.test(p.text))) continue

      // 构建带占位符的 key 模板并收集表达式名称
      let keyTemplate = ''
      const exprParts = []
      let paramIdx = 0
      for (const part of parts) {
        if (part.type === 'text') {
          keyTemplate += part.text
        } else {
          keyTemplate += `{p${paramIdx++}}`
          exprParts.push(part)
        }
      }

      const wholeKey = reverseMap[keyTemplate]
      if (wholeKey) {
        // 从原始内容提取表达式文本（removeJsComments 等长替换，位置对齐）
        const rawContent = content.slice(str.start + 1, str.end - 1)
        const paramsStr = exprParts
          .map((p, idx) => `p${idx}: ${rawContent.slice(p.start, p.end)}`)
          .join(', ')
        replacements.push({
          start: str.start,
          end: str.end,
          replacement: paramsStr
            ? `${scriptI18nFn}('${wholeKey}', { ${paramsStr} })`
            : `${scriptI18nFn}('${wholeKey}')`,
        })
      } else {
        // 上报带占位符的完整文案，开发者可直接复制到语言文件作为 key
        untranslated.push({ file: relFile, line: absoluteLine, text: keyTemplate })
      }
      continue
    }

    if (!CHINESE_TEST_RE.test(str.content)) continue

    // ── 已在 $t() 内：只更新 key，不再外包调用 ────────────────────────────
    if (isI18n) {
      const key = reverseMap[str.content]
      if (key) {
        replacements.push({ start: str.start + 1, end: str.end - 1, replacement: key })
      } else {
        untranslated.push({ file: relFile, line: absoluteLine, text: str.content })
      }
      continue
    }

    // ── 优先级 1：整个字符串内容作为一个完整词条 ──────────────────────────
    const wholeKey = reverseMap[str.content]
    if (wholeKey) {
      replacements.push({
        start: str.start,
        end: str.end,
        replacement: `${scriptI18nFn}('${wholeKey}')`,
      })
      continue
    }

    // ── 优先级 2：整体内容作为一条未翻译词条上报 ─────────────────────────
    // 字符串边界已由 scanJsStrings 精确确定，整个 content 就是一个完整的文案单元。
    // 不再用 chineseRe() 拆分子串（<br>/<span> 等 HTML 标签会被 < 截断成多段），
    // 直接上报完整内容，开发者将其整体写入语言文件后，优先级 1 下次可整体命中替换。
    untranslated.push({ file: relFile, line: absoluteLine, text: str.content })
  }

  // 从后向前应用替换，保证绝对位置不因前面内容长度变化而错位
  let result = content
  let replacedCount = 0
  for (const rep of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, rep.start) + rep.replacement + result.slice(rep.end)
    replacedCount++
  }

  return { content: result, replacedCount, untranslated }
}
