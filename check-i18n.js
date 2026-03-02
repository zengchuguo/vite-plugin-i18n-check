#!/usr/bin/env node
/**
 * check-i18n.js
 * i18n 中文词条检测脚本（支持 pre-commit 钩子 & 手动执行）
 *
 * 用法：
 *   node vite-plugin-i18n-check/check-i18n.js [选项]
 *
 * 选项：
 *   --mode <staged|modified|all>   扫描范围（默认 staged）
 *       staged   — 仅扫描 git 暂存区（add 后的文件），pre-commit 默认值
 *       modified — 仅扫描工作区已修改但未暂存的文件
 *       all      — 暂存区 + 修改区，合并去重
 *   --languageDir <dir>            语言文件目录（默认 src/utils/language）
 *   --reportFile  <file>           未翻译词条报告路径（默认 untranslated-i18n.json）
 *
 * 配置优先级：CLI 参数 > package.json[i18nCheck] > 内置默认值
 *
 * 流程：
 *  1. 根据 mode 获取目标 .vue / .js / .jsx 文件列表
 *  2. 去除注释后，用正则扫描中文字符
 *  3. 加载 languageDir 下所有 zh-cn.js，构建「中文 → i18n key」反向映射表
 *  4. 有映射的词条：根据所在区块自动替换并写回源文件（不执行 git add），终止提交
 *  5. 无映射的词条：收集后终端报告 + 输出 JSON 报告文件，exit(1) 阻断提交
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import path from 'path'

// ─── 读取配置 + 解析命令行参数 ────────────────────────────────────────────────
// 优先级：CLI 参数 > package.json[i18nCheck] > 内置默认值
const ROOT_DIR = process.cwd()

/**
 * 读取 package.json 中 i18nCheck 字段作为基础配置。
 * package.json 始终随仓库提交，无需 vite dev 即可读取。
 */
function loadPkgConfig() {
  const pkgPath = path.join(ROOT_DIR, 'package.json')
  if (!existsSync(pkgPath)) return {}
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.i18nCheck || {}
  } catch {
    return {}
  }
}

const PKG_CONFIG = loadPkgConfig()
const args = process.argv.slice(2)

/**
 * 获取参数值，优先级：CLI 参数 > package.json i18nCheck > 内置默认值
 * @param {string} name       CLI 参数名（不含 --），同时作为配置字段 key
 * @param {*}      defaultVal 内置默认值
 */
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1) return args[idx + 1]
  if (PKG_CONFIG[name] !== undefined) return PKG_CONFIG[name]
  return defaultVal
}

const LANGUAGE_DIR = path.resolve(ROOT_DIR, getArg('languageDir', 'src/utils/language'))
const REPORT_FILE = path.resolve(ROOT_DIR, getArg('reportFile', 'untranslated-i18n.json'))
// mode: staged（默认，pre-commit）| modified（工作区）| all（全部）
const MODE = getArg('mode', 'staged')

// 排除目录列表（黑名单）
const EXCLUDE_DIRS = (() => {
  const val = getArg('excludeDirs', [])
  if (Array.isArray(val)) return val.map(d => d.trim()).filter(Boolean)
  return val ? String(val).split(',').map(d => d.trim()).filter(Boolean) : []
})()

// 仅扫描目录列表（白名单）
const INCLUDE_DIRS = (() => {
  const val = getArg('includeDirs', [])
  if (Array.isArray(val)) return val.map(d => d.trim()).filter(Boolean)
  return val ? String(val).split(',').map(d => d.trim()).filter(Boolean) : []
})()

// 中文字符正则（每次调用返回新实例，避免共享 lastIndex 状态）
const chineseRe = () => /[\u4e00-\u9fa5]+/g
// 仅用于 test 的无状态版本
const CHINESE_TEST_RE = /[\u4e00-\u9fa5]/

// ─── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  // 1. 根据 mode 获取目标文件列表
  const modeLabel = { staged: '暂存区', modified: '修改区', all: '暂存区 + 修改区' }[MODE] || '暂存区'
  const targetFiles = getTargetFiles(MODE)

  if (targetFiles.length === 0) {
    console.log(`[i18n-check] ${modeLabel}无需检测的文件，跳过。`)
    process.exit(0)
  }

  console.log(`[i18n-check] 扫描范围：${modeLabel}，共 ${targetFiles.length} 个文件：`)
  targetFiles.forEach(f => console.log(`  - ${f}`))

  // 2. 构建反向映射表：{ '中文': 'namespace.key' }
  const reverseMap = buildReverseMap(LANGUAGE_DIR)

  // 3. 扫描每个文件
  const untranslated = []  // { file, line, text }
  const replaced = []      // { file, count }

  for (const relFile of targetFiles) {
    const absFile = path.resolve(ROOT_DIR, relFile)
    if (!existsSync(absFile)) continue

    const originalContent = readFileSync(absFile, 'utf-8')
    const result = processFile(absFile, relFile, originalContent, reverseMap)

    if (result.replacedCount > 0) {
      writeFileSync(absFile, result.content, 'utf-8')
      replaced.push({ file: relFile, count: result.replacedCount })
    }

    untranslated.push(...result.untranslated)
  }

  // 4. 输出替换摘要，有替换则终止提交
  if (replaced.length > 0) {
    console.log('\n[i18n-check] 以下文件已自动替换中文词条（仅写入磁盘，未暂存）：')
    replaced.forEach(r => console.log(`  ${r.file}  （替换 ${r.count} 处）`))
    console.log('\n  请检查修改内容，执行 git add 后重新提交。\n')
    process.exit(1)
  }

  // 5. 报告未翻译词条
  if (untranslated.length > 0) {
    console.error('\n[i18n-check] ❌ 发现未翻译词条，提交已阻断：')
    untranslated.forEach(item => {
      console.error(`  ${item.file}:${item.line}  "${item.text}"`)
    })
    writeFileSync(REPORT_FILE, JSON.stringify(untranslated, null, 2), 'utf-8')
    console.error(`\n  报告已输出至 ${path.relative(ROOT_DIR, REPORT_FILE)}，请补充翻译后重新提交。\n`)
    process.exit(1)
  }

  const successMsg = MODE === 'staged'
    ? '\n[i18n-check] ✅ 所有词条已翻译，提交通过。'
    : '\n[i18n-check] ✅ 扫描完成，未发现未翻译词条。'
  console.log(successMsg)
  process.exit(0)
}

// ─── 获取目标文件 ─────────────────────────────────────────────────────────────
function getTargetFiles(mode) {
  const staged = (mode === 'staged' || mode === 'all') ? getStagedFiles() : []
  const modified = (mode === 'modified' || mode === 'all') ? getModifiedFiles() : []
  return [...new Set([...staged, ...modified])]
}

function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACM', {
      cwd: ROOT_DIR, encoding: 'utf-8',
    }).trim()
    if (!output) return []
    return filterFiles(output.split('\n').map(f => f.trim()))
  } catch { return [] }
}

function getModifiedFiles() {
  try {
    const output = execSync('git diff --name-only --diff-filter=ACM', {
      cwd: ROOT_DIR, encoding: 'utf-8',
    }).trim()
    if (!output) return []
    return filterFiles(output.split('\n').map(f => f.trim()))
  } catch { return [] }
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
        dir => normalized.startsWith(dir + '/') || normalized === dir
      )
      if (!included) return false
    }

    return !EXCLUDE_DIRS.some(
      dir => normalized.startsWith(dir + '/') || normalized === dir
    )
  })
}

// ─── 构建反向映射表 ───────────────────────────────────────────────────────────
function buildReverseMap(dir) {
  const map = {}
  if (!existsSync(dir)) return map

  for (const { absPath, namespace } of findZhCnFiles(dir)) {
    try {
      const entries = parseExportDefault(absPath)
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === 'string' && CHINESE_TEST_RE.test(value)) {
          map[value] = namespace ? `${namespace}.${key}` : key
        } else if (value && typeof value === 'object') {
          for (const [subKey, subVal] of Object.entries(value)) {
            if (typeof subVal === 'string' && CHINESE_TEST_RE.test(subVal)) {
              map[subVal] = namespace ? `${namespace}.${key}.${subKey}` : `${key}.${subKey}`
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[i18n-check] 解析语言文件失败：${absPath}`, e.message)
    }
  }

  return map
}

function findZhCnFiles(dir, baseDir = null) {
  baseDir = baseDir || dir
  const results = []
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) {
      results.push(...findZhCnFiles(abs, baseDir))
    } else if (entry === 'zh-cn.js') {
      const rel = path.relative(baseDir, path.dirname(abs))
      const namespace = rel === '' ? '' : rel.replace(/\\/g, '.')
      results.push({ absPath: abs, namespace })
    }
  }
  return results
}

function parseExportDefault(filePath) {
  const content = readFileSync(filePath, 'utf-8')
  const result = {}
  const blockMatch = content.match(/export\s+default\s+\{([\s\S]*)\}/)
  if (!blockMatch) return result
  const pairRe = /(\w+)\s*:\s*(['"`])([\s\S]*?)\2/g
  let m
  while ((m = pairRe.exec(blockMatch[1])) !== null) {
    result[m[1]] = m[3]
  }
  return result
}

// ─── 处理单个文件 ─────────────────────────────────────────────────────────────
function processFile(absFile, relFile, originalContent, reverseMap) {
  const isVue = absFile.endsWith('.vue')
  let content = originalContent
  let replacedCount = 0
  const untranslated = []

  if (isVue) {
    const tr = processTemplateBlock(content, relFile, reverseMap)
    content = tr.content; replacedCount += tr.replacedCount; untranslated.push(...tr.untranslated)
    const sr = processScriptBlock(content, relFile, reverseMap)
    content = sr.content; replacedCount += sr.replacedCount; untranslated.push(...sr.untranslated)
  } else {
    const sr = processJsContent(content, relFile, reverseMap, 0)
    content = sr.content; replacedCount += sr.replacedCount; untranslated.push(...sr.untranslated)
  }

  return { content, replacedCount, untranslated }
}

// ─── Template 块处理 ─────────────────────────────────────────────────────────
function processTemplateBlock(fileContent, relFile, reverseMap) {
  let content = fileContent
  let replacedCount = 0
  const untranslated = []

  const templateStart = content.indexOf('<template>')
  const templateEnd = content.lastIndexOf('</template>')
  if (templateStart === -1 || templateEnd === -1) return { content, replacedCount, untranslated }

  let templateContent = content.slice(templateStart, templateEnd + '</template>'.length)
  const cleanedTemplate = removeHtmlComments(templateContent)
  const chineseMatches = findChineseInTemplate(cleanedTemplate)
  const lineOffset = content.slice(0, templateStart).split('\n').length - 1

  for (const match of chineseMatches) {
    const absoluteLine = lineOffset + match.line
    if (reverseMap[match.text]) {
      const replacement = buildTemplateReplacement(match, reverseMap[match.text])
      if (replacement) {
        templateContent = replaceInTemplate(templateContent, match, replacement)
        replacedCount++
      } else {
        untranslated.push({ file: relFile, line: absoluteLine, text: match.text })
      }
    } else {
      untranslated.push({ file: relFile, line: absoluteLine, text: match.text })
    }
  }

  content = content.slice(0, templateStart) + templateContent + content.slice(templateEnd + '</template>'.length)
  return { content, replacedCount, untranslated }
}

function findChineseInTemplate(templateContent) {
  const matches = []
  const lines = templateContent.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const m of line.matchAll(chineseRe())) {
      const before = line.slice(0, m.index)
      const isAttrValue = /=["']?\s*$/.test(before) || /=["'][^"']*$/.test(before)
      matches.push({
        text: m[0], line: i + 1, col: m.index,
        context: isAttrValue ? 'attrValue' : 'textNode',
        rawLine: line,
      })
    }
  }
  return matches
}

function buildTemplateReplacement(match, key) {
  if (match.context === 'textNode') return `{{ $t('${key}') }}`
  if (match.context === 'attrValue') return `$t('${key}')`
  return null
}

function replaceInTemplate(templateContent, match, replacement) {
  const lines = templateContent.split('\n')
  let line = lines[match.line - 1]

  if (match.context === 'textNode') {
    line = line.slice(0, match.col) + replacement + line.slice(match.col + match.text.length)
  } else if (match.context === 'attrValue') {
    const before = line.slice(0, match.col)
    const attrNameMatch = before.match(/\s([\w-:@.]+)=["']?[^"']*$/)
    if (attrNameMatch) {
      const attrName = attrNameMatch[1]
      const bindAttrName = attrName.startsWith(':') ? attrName : `:${attrName}`
      const fullAttrRe = new RegExp(`([\\s])${escapeReg(attrName)}=["']([^"']*)${escapeReg(match.text)}([^"']*)["']`)
      line = line.replace(fullAttrRe, (_, space, b, a) => `${space}${bindAttrName}="${b}${replacement}${a}"`)
    } else {
      line = line.slice(0, match.col) + replacement + line.slice(match.col + match.text.length)
    }
  }

  lines[match.line - 1] = line
  return lines.join('\n')
}

// ─── Script 块处理 ────────────────────────────────────────────────────────────
function processScriptBlock(fileContent, relFile, reverseMap) {
  const scriptStartMatch = fileContent.match(/<script(\s[^>]*)?>/)
  if (!scriptStartMatch) return { content: fileContent, replacedCount: 0, untranslated: [] }

  const scriptStart = fileContent.indexOf(scriptStartMatch[0])
  const scriptContentStart = scriptStart + scriptStartMatch[0].length
  const scriptEnd = fileContent.indexOf('</script>', scriptContentStart)
  if (scriptEnd === -1) return { content: fileContent, replacedCount: 0, untranslated: [] }

  const lineOffset = fileContent.slice(0, scriptContentStart).split('\n').length - 1
  const result = processJsContent(fileContent.slice(scriptContentStart, scriptEnd), relFile, reverseMap, lineOffset)

  return {
    content: fileContent.slice(0, scriptContentStart) + result.content + fileContent.slice(scriptEnd),
    replacedCount: result.replacedCount,
    untranslated: result.untranslated,
  }
}

// ─── JS/JSX 内容处理 ─────────────────────────────────────────────────────────
function processJsContent(content, relFile, reverseMap, lineOffset) {
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
        const newLine = replaceStringLiteral(lines[i], text, reverseMap[text])
        if (newLine !== lines[i]) { lines[i] = newLine; replacedCount++ }
      } else {
        untranslated.push({ file: relFile, line: absoluteLine, text })
      }
    }
  }

  return { content: lines.join('\n'), replacedCount, untranslated }
}

// ─── 字符串上下文分析 ─────────────────────────────────────────────────────────
function isInsideStringLiteral(line, col) {
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

function isInsideIgnoredCall(line, col) {
  const before = line.slice(0, col)
  return (
    /console\s*\.\s*(log|warn|error|info|debug|trace|assert|dir|table|group|groupEnd|time|timeEnd)\s*\(/.test(before) ||
    /\bnew\s+Error\s*\(/.test(before) ||
    /(?<![.\w])Error\s*\(/.test(before) ||
    /(?<![.\w])error\s*\(/.test(before) ||
    /(?<![.\w])warn\s*\(/.test(before)
  )
}

function replaceStringLiteral(line, text, key) {
  const escaped = escapeReg(text)

  const simpleRe = new RegExp(`(['"])([^'"]*?)${escaped}([^'"]*?)\\1`)
  if (simpleRe.test(line)) {
    return line.replace(simpleRe, (_, quote, before, after) => {
      if (before || after) return `${quote}${before}${quote} + t('${key}') + ${quote}${after}${quote}`
      return `t('${key}')`
    })
  }

  const tplRe = new RegExp('(`)([^`]*?)' + escaped + '([^`]*?)`')
  if (tplRe.test(line)) {
    return line.replace(tplRe, (_, _q, before, after) => {
      if (before || after) return '`' + before + '`' + ` + t('${key}') + ` + '`' + after + '`'
      return `t('${key}')`
    })
  }

  return line
}

// ─── 注释去除 ─────────────────────────────────────────────────────────────────
function removeHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, match => ' '.repeat(match.length))
}

function removeJsComments(content) {
  let result = content.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
  result = result.replace(/(?<!['":`])\/\/[^\n]*/g, match => ' '.repeat(match.length))
  return result
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function escapeReg(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('[i18n-check] 脚本执行异常：', err)
  process.exit(1)
})
