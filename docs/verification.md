# 独立导出核验

核验时间：2026-09-11，Asia/Shanghai。

## PDF

使用 pypdf 读取导出文件、pypdfium2 渲染页面，再与同一次导出的 PNG 对照。

| 文件 | 页数 | 页面尺寸 | 结果 |
| --- | --- | --- | --- |
| `artifacts/export.pdf` | 2 | 每页 210 × 297 mm（A4） | 通过 |
| `artifacts/export-long.pdf` | 1 | 210 × 408.659 mm | 通过 |

原始 PNG 为 768 × 1571 px。A4 PDF 的两张嵌入图片分别覆盖原图第 `[0, 1119)` 行和 `[1119, 1571)` 行，长页 PDF 覆盖 `[0, 1571)` 行。所有像素行均恰好覆盖一次，没有漏页、空白页、重复片段或丢失内容。PDF 内嵌图片与对应原图的每通道平均绝对误差为 1.33–1.41/255，符合 JPEG 编码的轻微损失。

已实际渲染并检查三张 PDF 页面。A4 按图片高度切分，会跨页拆开网页中的卡片；需要完整连续布局时可选择长页 PDF。PDF 是截图型文档，文字不可直接选取。

可视核验：`artifacts/pdf-contact-sheet.png`。
机器可读数据：`artifacts/pdf-verification.json`。

## 已部署网页

在真实加载扩展的 Chromium 中，通过工作台填写 `https://example.com`，生成预览并下载 PNG。

- 页面标题：Example Domain。
- 导出尺寸：1440 × 1060 px。
- 页面转换完成，无警告，PNG 下载成功。
- 已查看实际导出的图片，内容是在线 Example Domain 页面。

证据：`artifacts/remote-example.png`、`artifacts/remote-workbench.png`、`artifacts/remote-verification.json`。

## 本地 HTML 导入

`node --test tests/import-html.test.js` 共 12 项测试通过，覆盖路径和编码、CSS 循环引用、字体和 SVG、srcset、错误提示、文件大小限制，以及完整文件夹在隔离数据页中的实际渲染。脚本仅在隔离预览页执行，打包器所在页面没有执行导入脚本。

## 完整验收

- `npm test`：23 项检查通过，覆盖截图参数与像素限制、资源打包、文件名及 PDF 切片。
- `npm run test:engine`：原有 10 个场景涵盖整页、2 倍像素、当前可见区域、透明背景、已登录页面、HTML 隔离、资源失败、取消与页面恢复；本次增加 6 个响应式重载回归场景，见下文。原有 10 个场景曾在正常 Chrome 调试提示条模式另测全部通过。
- `npm run test:e2e`：16 个工作台场景通过，包括四种导出格式的真实下载、长页/分页 PDF、文件夹导入、历史记录、来源失效、窄屏布局和两次重新加载后的设置保留。
- `npm audit`：0 个已知漏洞。
- 源码采用 Manifest V3，发布目录包含全部本地脚本、图标、示例及使用说明，无 CDN 运行依赖。

浏览器实测使用独立临时 Chromium 配置，没有读取日常 Chrome 的个人用户数据。安装包尚未发布到 Chrome 应用商店。源码通过 GitHub `origin` 同步，安装包通过同一私有仓库的 Releases 提供；构建依赖和本机测试产物不提交到 Git。

## 手机、平板尺寸预览修复

问题在工作台的「手机 · 390 px」「平板 · 768 px」宽度选项下复现：网页响应 `resize` 事件并重新加载后，截图程序继续使用旧文档的执行上下文，报 `Cannot find context with specified id`。旧版失败证据保存在 `artifacts/preview-regression-before.json`。

修复后会在调整尺寸后重新等待文档；若准备或截图期间发生重载，会重新读取页面，最多尝试 3 次。截图后再次确认文档并更新标题、网址。恢复原页面时也会等待短暂稳定后恢复滚动位置，取消和失败路径仍会解除截图连接。

新增的 6 个引擎回归场景：

- 390 / 768 px：网址页面延迟重载后截图成功，像素与尺寸正确，临时标签页关闭。
- 390 / 768 px：现有标签页即时重载后 2 倍截图成功，原始尺寸、像素比和滚动位置恢复。
- 恢复桌面宽度时延迟重载，仍能恢复原滚动位置。
- 持续重载时有限退出并给出中文提示，释放截图任务，下一次预览可以继续。

本次验证结果：23 项单元与导入测试、16 个引擎场景、16 个工作台场景全部通过。另测桌面 / 手机 / 平板工作台、网址 / 本地 HTML、390 / 768 px、1 / 2 / 3 倍共 36 组组合，图片非空、尺寸正确、预览可见且无横向溢出，未出现 UI 或脚本错误。这些是桌面 Chromium 中的宽度及工作台尺寸验证，不代表真实移动设备可安装 Chrome 扩展。

最新证据：`artifacts/engine-e2e.json`、`artifacts/ui-test-results.json`、`artifacts/preset-diagnostic.json`。安装目录及 ZIP 通过 `npm run build` 重新生成；已有用户需要在扩展管理页刷新拾页，再刷新工作台。
