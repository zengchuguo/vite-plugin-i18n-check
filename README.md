# vite-plugin-i18n-check

在 `pre-commit` 阶段自动检测 Vue / JS / JSX 文件中未翻译的中文词条，支持自动替换已有翻译、阻断提交并输出报告。

---

## 使用场景

- **Vue 2 / Vue 3 国际化项目**：使用 vue-i18n 或类似方案，中文文案需统一走 i18n 映射
- **团队协作规范**：防止开发者直接硬编码中文，保证所有文案都在语言文件中维护
- **CI/CD 前校验**：在提交前自动检查，有未翻译词条时阻断 commit，避免遗漏
- **增量翻译**：只扫描本次修改/暂存的文件，不影响历史代码，适合逐步迁移的老项目
- **自动补全**：若词条已存在于 `zh-cn.js` 中，自动将中文替换为 `$t('key')` / `t('key')`，减少手工操作

---

## 特性

- 🔍 **自动扫描**：在 `git commit` 前扫描暂存区文件，检测中文字符
- ♻️ **自动替换**：若词条已存在于语言文件中，自动将中文替换为 `$t('key')` / `t('key')`
- 🚫 **阻断提交**：有替换或未翻译词条时终止提交，确保代码不遗漏翻译
- 📄 **输出报告**：将未翻译词条写出为 JSON 文件，方便补充翻译
- ⚙️ **配置集中**：所有配置写入 `package.json[i18nCheck]`，npm 脚本 / 钩子 / CLI 共享同一份配置
- 🗂️ **白 / 黑名单**：支持 `includeDirs`（只扫描指定目录）和 `excludeDirs`（排除指定目录）

---

## 安装

### 1. 安装插件

```bash
# npm
npm install vite-plugin-i18n-check -D
```

### 2. 安装 Husky（pre-commit 钩子依赖）

```bash
npm install husky -D
```

### 3. 启用 Husky

在 `package.json` 中添加 `prepare` 脚本：

```json
{
  "scripts": {
    "prepare": "husky install"
  }
}
```

> 首次运行 `npm run dev` 时，插件会自动安装 pre-commit 钩子；若项目已有 `.husky/pre-commit`，脚本会追加 i18n 检测逻辑。

---

## 具体配置

### 1. 在 Vite 中注册插件

在 `vite.config.js` 中引入并配置：

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vitePluginI18nCheck from 'vite-plugin-i18n-check'

export default defineConfig({
  plugins: [
    vue(),
    vitePluginI18nCheck({
      languageDir: 'src/utils/language',   // 语言文件目录
      reportFile: 'untranslated-i18n.json', // 未翻译报告输出路径
      includeDirs: ['src/views', 'src/components'], // 白名单：只扫描这些目录
      excludeDirs: ['src/utils/language', 'node_modules'], // 黑名单：排除这些目录
      scriptI18nFn: 't', // Vue 3 用 't'，Vue 2 用 '$t'
    }),
  ],
})
```

### 2. 首次初始化（执行一次）

```bash
npm run dev
```

首次运行 `vite dev` 时，插件会自动：

- 若 `package.json[i18nCheck]` **不存在**：将 `vite.config.js` 中的插件选项写入，作为初始配置
- 若 `package.json[i18nCheck]` **已存在**：跳过写入，以现有配置为准
- 安装 `.husky/pre-commit` 钩子（已存在则跳过）

> ⚠️ **初始化完成后，所有配置变更请直接修改 `package.json[i18nCheck]`，`vite.config.js` 中的选项不再生效。**

### 3. 配置项说明（`package.json[i18nCheck]`）

初始化后，配置统一放在 `package.json` 的 `i18nCheck` 字段：


| 选项             | 类型         | 默认值                        | 说明                                    |
| -------------- | ---------- | -------------------------- | ------------------------------------- |
| `languageDir`  | `string`   | `'src/utils/language'`     | 语言文件目录（相对项目根），递归读取其中 `zh-cn.js` 构建映射表 |
| `reportFile`   | `string`   | `'untranslated-i18n.json'` | 未翻译词条输出的 JSON 报告路径                    |
| `includeDirs`  | `string[]` | `[]`                       | **白名单**：只扫描这些目录，空则扫描全部                |
| `excludeDirs`  | `string[]` | `[]`                       | **黑名单**：排除这些目录，优先级高于 `includeDirs`    |
| `scriptI18nFn` | `string`   | `'t'`                      | script / JS 中替换用的函数名，Vue 2 可设为 `'$t'` |


示例：

```json
{
  "i18nCheck": {
    "languageDir": "src/utils/language",
    "reportFile": "untranslated-i18n.json",
    "includeDirs": ["src/views", "src/components", "src/layouts"],
    "excludeDirs": ["src/utils/language", "node_modules", "dist"],
    "scriptI18nFn": "t"
  }
}
```

---

## 具体使用

### pre-commit 自动检测

日常开发中，执行 `git commit` 时会自动触发 i18n 检测：

1. 仅扫描 **暂存区**（`git add` 后的文件）
2. 有匹配翻译 → 自动替换为 `$t('key')` / `t('key')`，**中断提交**，需检查后重新 `git add` 再提交
3. 有未翻译词条 → 终端输出报告、写入 `untranslated-i18n.json`，**中断提交**
4. 无问题 → 提交通过

```bash
git add src/views/Home.vue
git commit -m "feat: 新增首页"
# → 自动执行 i18n 检测，有问题则终止提交
```

## 自动替换规则

检测到中文后，根据所在代码区块选择替换格式：


| 场景                        | 替换前               | 替换后                              |
| ------------------------- | ----------------- | -------------------------------- |
| Vue `<template>` 文本节点     | `<span>你好</span>` | `<span>{{ $t('hello') }}</span>` |
| Vue `<template>` 属性值      | `title="你好"`      | `:title="$t('hello')"`           |
| `<script>` / `.js` 字符串字面量 | `'你好'`            | `t('hello')`                     |
| `<script>` / `.js` 模板字符串  | `你好`              | `t('hello')`                     |


> ⚠️ 替换后文件**只写入磁盘，不自动执行 `git add`**，请检查修改内容后手动暂存再提交。

---

## 跳过检测的场景

以下位置的中文**不会**被检测或替换：

- HTML 注释 `<!-- 注释 -->`
- JS 单行注释 `// 注释`
- JS 多行注释 `/* 注释 */`
- `console.log / warn / error / info / debug` 等控制台输出
- `new Error(...)` / `Error(...)` / 独立 `error(...)` / `warn(...)` 调用

---

## 报告文件格式

未翻译词条输出为 JSON 对象，包含未翻译明细和去重后的待翻译中文词条数组：

```json
{
  "untranslated": [
    { "file": "src/views/Home.vue", "line": 42, "text": "新功能" },
    { "file": "src/utils/helper.js", "line": 15, "text": "操作失败" }
  ],
  "untranslatedTexts": [
    "新功能",
    "操作失败"
  ]
}
```

