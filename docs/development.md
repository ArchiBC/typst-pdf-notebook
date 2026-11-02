# 开发与维护

## 构建与测试

构建使用 Node.js 22.13+，CI 使用 Node.js 24。这个要求适用于开发工具；扩展宿主的代码按 Node.js 20 构建，用户运行插件时使用 VS Code 自带的运行时。

```powershell
npm ci
npm run package
npm run test:prepare
npm test
npm run test:host
```

`npm run package` 先构建扩展，再生成 `output/typst-pdf-notebook-<version>.vsix`。按 F5 可启动扩展开发宿主。

`test:prepare` 下载 VS Code，将 VSIX 安装到隔离的扩展目录，检查 Tinymist 依赖自动安装，并准备固定版本的测试字体。`npm test` 包含原生排版、包安装、PDF 导出和发布校验，需要先完成打包及环境准备。

测试最低支持版本：

```powershell
$env:NOTEBOOK_VSCODE_VERSION = 'minimum'
npm run test:prepare
npm run test:host
Remove-Item Env:NOTEBOOK_VSCODE_VERSION
```

`minimum` 从 `package.json` 的 `engines.vscode` 读取版本，默认的 `stable` 使用当前稳定版。也可指定具体版本，如 `1.100.0`。其他测试选项：

| 环境变量                  | 用途                                 |
| ------------------------- | ------------------------------------ |
| `NOTEBOOK_CODE_BIN`       | 使用已有 VS Code 可执行文件          |
| `NOTEBOOK_VSIX`           | 指定测试安装包                       |
| `NOTEBOOK_TEST_CACHE`     | 指定下载和安装缓存目录               |
| `NOTEBOOK_FONT_PATHS`     | 使用本机字体目录，值为 JSON 路径数组 |
| `NOTEBOOK_EXTENSION_PATH` | 指定宿主加载的扩展目录               |

宿主测试生成 341 页测试 PDF 及独立笔记工作区，覆盖 PDF 命令激活、单文件笔记、未保存编辑、模板升级、分页、源码双向定位、右侧便签、导出和错误恢复。另起一个宿主检查相对包目录和启动参数在编辑器与笔记编译器中一致。证据分别写入 `output/extension-host-evidence.json` 和 `output/tinymist-host-evidence.json`。

CI 将同一份 VSIX 安装到 Windows、macOS、Linux，每个平台分别测试最低版本和当前稳定版 VS Code。Linux 宿主通过 Xvfb 运行；日志和证据保存在工作流附件中。

## 兼容性边界

最低 VS Code 版本为 1.97.0，与必需的 Tinymist 0.15.10 的扩展清单一致。笔记引擎在初始化时检查 Tinymist 的版本及导出、定位接口。

PDF.js 使用官方 `legacy` 构建，主模块、worker 和样式取自同一依赖版本。该构建包含旧浏览器需要的语法转换和补全，适合随 VS Code 分发的较旧 Chromium；参见 [PDF.js 官方兼容性说明](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)。`scripts/build.cjs` 将这些文件复制到统一的 `vendor/pdfjs/` 路径，供预览、开发服务器和压力测试共同使用。

降低 `engines.vscode` 时，以实际 VSIX 在最低版本宿主中的安装、预览和定位测试为依据。构建工具的 Node.js 版本与扩展宿主、webview 的运行时分别验证。

## 代码与模板

| 路径                | 职责                                  |
| ------------------- | ------------------------------------- |
| `src/document.cjs`  | 页码计划、PDF 书签与导出              |
| `src/compiler.cjs`  | 编译、内存文件及定位协议              |
| `src/extension.cjs` | VS Code 命令和会话                    |
| `src/tinymist.cjs`  | 引擎选择、Tinymist 配置及模板安装衔接 |
| `src/template.cjs`  | 内置包安装和笔记入口生成              |
| `templates/`        | 当前模板与固定版本的旧模板            |
| `media/`            | 按需绘制的预览界面                    |

`templates/chengsi/` 保存未修改的 Chengsi 0.1.2（MIT-0），来源及哈希记录在 `UPSTREAM.json`；`templates/math.typ` 适配页框和数学环境。`node scripts/render-template-preview.cjs` 可用 Typst CLI 生成模板示例 PNG。

插件使用自己的 Tinymist LSP 会话编译笔记，编辑器语言功能由 Tinymist 扩展提供。引擎依次取自 `tinymist.serverPath`、Tinymist 扩展内置程序和 PATH，继承字体、输入变量及包目录设置。相对路径按第一个工作区文件夹解析。Tinymist 0.15.10 的编辑器服务重启后仍保留启动时的 `typstExtraArgs`，修改此设置后需重新加载窗口以更新编辑器服务；笔记预览会自行重建会话。

模板安装到实际使用的本地包目录。Windows 默认目录为 `%APPDATA%/typst/packages/local/typst-pdf-notebook/<模板版本>`，也支持 `TYPST_PACKAGE_PATH`。首次写入模板后会重启编辑器 Tinymist，刷新缺失包缓存。包内已有不同内容时报告冲突，由维护者检查。

## 性能与其他入口

```powershell
npx playwright-core install chromium
npm run test:stress -- current
$env:NOTEBOOK_STRESS_HOST = '1'
npm run test:host
Remove-Item Env:NOTEBOOK_STRESS_HOST
```

压力测试覆盖 341 页与 2,000 页生成式 PDF、100 页笔记、跨页滚动、连续缩放和文档更新，检查文字选择、导出与右侧便签。浏览器可通过 `NOTEBOOK_BROWSER` 指定，报告写入 `output/performance-<label>.json`。宿主压力模式连续编辑 40 次，并检查原书页面内容流的逐字节一致性。

预览界面的画布缓存预算为 96 MiB，单画布上限为 16M 像素；缩放停止 160 ms 后重画。比较性能报告时，同时记录运行环境、源码哈希和浏览器版本。

```powershell
node test/serve-preview.cjs 'C:\path\to\book-folder'
node scripts/export.cjs 'C:\path\to\book-folder\main.typ' 'C:\path\to\notebook.pdf'
node test/run-wsl.cjs Ubuntu
```

命令行导出读取已保存源码，预览导出包含当前未保存编辑。WSL 测试将源码和同一 VSIX 复制到发行版自身文件系统中的隔离目录，结果回传至 `output/wsl/`；环境准备脚本为 `scripts/setup-wsl-test.sh`，需要 Node.js 24、Xvfb 和 VS Code 系统库。

## 发布

`.github/workflows/release.yml` 在推送 `vX.Y.Z` 标签后运行：核对版本、复用兼容性 CI、校验安装包身份和 SHA-256，将同一份 VSIX 及校验文件发布为 GitHub Release。标签应指向 `main` 历史中的提交，且与 `package.json`、`package-lock.json` 版本一致。

日常发布先更新 CHANGELOG，再执行：

```powershell
npm version patch --no-git-tag-version
$releaseVersion = node -p 'require("./package.json").version'
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release $releaseVersion"
git tag "v$releaseVersion"
git push origin main
git push origin "v$releaseVersion"
```

Marketplace 发布由仓库变量 `MARKETPLACE_TRUSTED_PUBLISHING` 控制。`false` 时只发布 GitHub 安装包；`true` 时先完成市场发布，再公开 GitHub Release。发布工具为固定版本的 `@vscode/vsce`，认证使用 GitHub OIDC Trusted Publishing。

启用前，在发布者 `ArcBC` 的 Marketplace 后台创建 Trusted Publishing 策略，绑定以下值：

| 字段             | 值                           |
| ---------------- | ---------------------------- |
| Policy name      | `typst-pdf-notebook-release` |
| Repository owner | `ArchiBC`                    |
| Repository       | `typst-pdf-notebook`         |
| Workflow         | `release.yml`                |
| Environment      | `marketplace`                |

GitHub 的 `marketplace` 环境允许 `v*` 标签部署。Actions → **Release** → **Run workflow** 默认执行 `dry_run=true`，完成打包、三平台测试和安装包校验；正式手动发布需选择版本匹配的标签并取消 dry run。

发布失败可在 Actions 中重跑失败任务，复用已验证的安装包。工作流会核对已有附件哈希，并保留较新版本的 Latest 标记；已发布的版本号和标签保持固定。
