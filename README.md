# vite-plugin-i18n-check

在 `pre-commit` 阶段自动检测 Vue / JS / JSX 文件中未翻译的中文词条，支持自动替换已有翻译、阻断提交并输出报告。

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

```bash
# npm
npm install vite-plugin-i18n-check -D

# pnpm
pnpm add vite-plugin-i18n-check -D
```

同时需要安装 [husky](https://typicode.github.io/husky)（用于 pre-commit 钩子）：

```bash
npm install husky -D
```

在 `package.json` 中添加 `prepare` 脚本：

```json
{
  "scripts": {
    "prepare": "husky install"
  }
}
```

---

## 快速上手

### 1. 在 `vite.config.js` 中注册插件

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vitePluginI18nCheck from 'vite-plugin-i18n-check'

export default defineConfig({
  plugins: [
    vue(),
    vitePluginI18nCheck({
      languageDir: 'src/utils/language',
      reportFile: 'untranslated-i18n.json',
      includeDirs: ['src/views', 'src/components'],
      excludeDirs: ['src/utils/language', 'node_modules'],
    }),
  ],
})
```

### 2. 启动开发服务（自动完成初始化）

```bash
npm run dev
```

插件会在 `vite dev` 启动时自动完成：
- 将插件配置同步写入 `package.json[i18nCheck]`
- 安装 `.husky/pre-commit` 钩子（已存在则跳过）

### 3. 手动运行检测（可选）

在 `package.json` 中添加快捷脚本：

```json
{
  "scripts": {
    "i18n:check":          "node node_modules/vite-plugin-i18n-check/check-i18n.js --mode all",
    "i18n:check:staged":   "node node_modules/vite-plugin-i18n-check/check-i18n.js --mode staged",
    "i18n:check:modified": "node node_modules/vite-plugin-i18n-check/check-i18n.js --mode modified"
  }
}
```

```bash
npm run i18n:check           # 扫描暂存区 + 修改区
npm run i18n:check:staged    # 仅扫描暂存区
npm run i18n:check:modified  # 仅扫描修改区
```

---

## 插件配置项

在 `vite.config.js` 的插件选项中配置，每次 `vite dev` 启动时自动同步到 `package.json[i18nCheck]`。

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `languageDir` | `string` | `'src/utils/language'` | 语言文件目录（相对项目根），插件从该目录递归读取 `zh-cn.js` 构建翻译映射表 |
| `reportFile` | `string` | `'untranslated-i18n.json'` | 未翻译词条输出的 JSON 报告文件名（相对项目根） |
| `includeDirs` | `string[]` | `[]` | **白名单**：只扫描这些目录下的文件，不配置则扫描全部文件 |
| `excludeDirs` | `string[]` | `[]` | **黑名单**：排除这些目录，优先级高于 `includeDirs` |

### 配置示例

```js
vitePluginI18nCheck({
  languageDir: 'src/utils/language',
  reportFile:  'untranslated-i18n.json',
  includeDirs: ['src/views', 'src/components', 'src/layouts'],
  excludeDirs: ['src/utils/language', 'node_modules', 'dist'],
})
```

---

## `package.json[i18nCheck]` 字段

插件每次启动时会将配置写入该字段，也可以**直接手动修改**，无需重启 vite。

```json
{
  "i18nCheck": {
    "languageDir": "src/utils/language",
    "reportFile":  "untranslated-i18n.json",
    "includeDirs": ["src/views", "src/components"],
    "excludeDirs": ["src/utils/language", "node_modules"]
  }
}
```

> `check-i18n.js` 读取配置的优先级：**CLI 参数 > `package.json[i18nCheck]` > 内置默认值**

---

## CLI 参数

`check-i18n.js` 支持以下命令行参数，可覆盖 `package.json[i18nCheck]` 中的配置。

| 参数 | 类型 | 说明 |
|---|---|---|
| `--mode` | `staged \| modified \| all` | 扫描范围（默认 `staged`） |
| `--languageDir` | `string` | 语言文件目录 |
| `--reportFile` | `string` | 报告文件路径 |
| `--includeDirs` | `string` | 白名单目录，多个用逗号分隔 |
| `--excludeDirs` | `string` | 黑名单目录，多个用逗号分隔 |

```bash
node vite-plugin-i18n-check/check-i18n.js \
  --mode all \
  --includeDirs "src/views,src/components" \
  --excludeDirs "src/utils/language,node_modules"
```

---

## 语言文件结构

插件递归扫描 `languageDir` 下所有 `zh-cn.js`，支持**扁平**和**命名空间**两种结构：

### 扁平结构

```js
// src/utils/language/zh-cn.js
export default {
  hello: '你好',
  welcome: '欢迎',
}
```

映射结果：`'你好' → 'hello'`，`'欢迎' → 'welcome'`

### 命名空间结构（子目录）

```js
// src/utils/language/common/zh-cn.js
export default {
  confirm: '确认',
  cancel: '取消',
}
```

映射结果：`'确认' → 'common.confirm'`，`'取消' → 'common.cancel'`

---

## 自动替换规则

检测到中文后，根据所在代码区块选择替换格式：

| 场景 | 替换前 | 替换后 |
|---|---|---|
| Vue `<template>` 文本节点 | `<span>你好</span>` | `<span>{{ $t('hello') }}</span>` |
| Vue `<template>` 属性值 | `title="你好"` | `:title="$t('hello')"` |
| `<script>` / `.js` 字符串字面量 | `'你好'` | `t('hello')` |
| `<script>` / `.js` 模板字符串 | `` `你好` `` | `t('hello')` |

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

## 完整工作流

```
git commit
    │
    ▼
.husky/pre-commit
    │
    ▼
check-i18n.js（扫描暂存区文件）
    │
    ├─ 读取 package.json[i18nCheck] 获取配置
    ├─ 过滤文件（includeDirs / excludeDirs）
    ├─ 去除注释，扫描中文字符
    ├─ 构建反向映射表（zh-cn.js → { '中文': 'key' }）
    │
    ├─ 有匹配的词条 → 自动替换，写回文件 → exit(1) 终止提交
    │                  （提示开发者 git add 后重新提交）
    │
    ├─ 无匹配的词条 → 收集 untranslated
    │
    └─ untranslated 不为空
           → 终端输出 文件:行号 "词条"
           → 写出 untranslated-i18n.json
           → exit(1) 终止提交
       untranslated 为空 → exit(0) 允许提交
```

---

## 报告文件格式

未翻译词条输出为 JSON 数组，每项包含文件路径、行号、中文文本：

```json
[
  { "file": "src/views/Home.vue",   "line": 42, "text": "新功能" },
  { "file": "src/utils/helper.js",  "line": 15, "text": "操作失败" }
]
```

---

## License

MIT
