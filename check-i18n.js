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

import { writeFileSync } from 'fs'
import { readFile as readFileAsync, writeFile as writeFileAsync } from 'fs/promises'
import path from 'path'

import { ROOT_DIR, MODE, ENABLED, LANGUAGE_DIR, REPORT_FILE, SCRIPT_I18N_FN } from './lib/config.js'
import { getTargetFiles } from './lib/git-files.js'
import { validateLanguageDir } from './lib/validate.js'
import { buildReverseMap } from './lib/language.js'
import { processFile } from './lib/processor.js'

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  if (!ENABLED) {
    process.exit(0)
  }

  // 1. 根据 mode 获取目标文件列表
  const modeLabel = { staged: '暂存区', modified: '修改区', all: '暂存区 + 修改区' }[MODE] || '暂存区'
  const targetFiles = getTargetFiles(MODE)

  if (targetFiles.length === 0) {
    console.log(`[i18n-check] ${modeLabel}无需检测的文件，跳过。`)
    process.exit(0)
  }

  console.log(`[i18n-check] 扫描范围：${modeLabel}，共 ${targetFiles.length} 个文件：`)
  targetFiles.forEach(f => console.log(`  - ${f}`))

  // 2. 校验 languageDir 配置
  validateLanguageDir()

  // 3. 构建反向映射表：{ '中文': 'namespace.key' }
  const reverseMap = buildReverseMap(LANGUAGE_DIR)

  // 4-A. 并发读取所有目标文件（I/O 并行，消除串行等待叠加）
  const readResults = await Promise.all(
    targetFiles.map(async relFile => {
      const absFile = path.resolve(ROOT_DIR, relFile)
      try {
        const content = await readFileAsync(absFile, 'utf-8')
        return { relFile, absFile, content }
      } catch {
        return null
      }
    }),
  )

  // 4-B. 串行处理每个文件（processFile 是 CPU 密集操作，JS 单线程下并发无收益）
  const processResults = []
  for (const item of readResults) {
    if (!item) continue
    const { relFile, absFile, content } = item
    const result = processFile(absFile, relFile, content, reverseMap, SCRIPT_I18N_FN)
    processResults.push({ relFile, absFile, result })
  }

  // 4-C. 并发写回所有有修改的文件（I/O 并行）
  const toWrite = processResults.filter(({ result }) => result.replacedCount > 0)
  await Promise.all(
    toWrite.map(({ absFile, result }) => writeFileAsync(absFile, result.content, 'utf-8')),
  )

  const replaced = toWrite.map(({ relFile, result }) => ({ file: relFile, count: result.replacedCount }))
  const untranslated = processResults.flatMap(({ result }) => result.untranslated)

  // 5. 输出替换摘要
  if (replaced.length > 0) {
    console.log('\n[i18n-check] 以下文件已自动替换中文词条：')
    replaced.forEach(r => console.log(`  ${r.file}  （替换 ${r.count} 处）`))
    console.log('\n  请检查修改内容，执行 git add 后重新提交。')
  }

  // 6. 报告未翻译词条
  if (untranslated.length > 0) {
    console.error('\n[i18n-check] ❌ 发现未翻译词条，提交已阻断：')
    untranslated.forEach(item => {
      console.error(`  ${item.file}:${item.line}  "${item.text}"`)
    })
    const untranslatedTexts = [...new Set(untranslated.map(item => item.text))]
    const report = {
      untranslated,
      untranslatedTexts,
    }
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf-8')
    console.error(`\n  报告已输出至 ${path.relative(ROOT_DIR, REPORT_FILE)}，请补充翻译后重新提交。\n`)
  }

  // 有替换或有未翻译词条，统一在此终止提交
  if (replaced.length > 0 || untranslated.length > 0) {
    process.exit(1)
  }

  const successMsg = MODE === 'staged'
    ? '\n[i18n-check] ✅ 所有词条已翻译，提交通过。'
    : '\n[i18n-check] ✅ 扫描完成，未发现未翻译词条。'
  console.log(successMsg)
  process.exit(0)
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('[i18n-check] 脚本执行异常：', err)
  process.exit(1)
})
