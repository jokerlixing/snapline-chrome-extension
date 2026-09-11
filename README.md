# 拾页 Snapline

把本地 HTML、正在浏览的页面和网页链接，变成好看、清晰的图片或 PDF。

拾页是一款适用于 **Chrome 120 及以上版本**的浏览器扩展。点击工具栏图标，会打开中文工作台：左侧选择页面和导出设置，中间预览结果，再保存到电脑。适合保存长网页、分享设计稿、整理网页资料和导出本地 HTML 作品。

## 开始使用

从 [GitHub Releases](https://github.com/jokerlixing/snapline-chrome-extension/releases/latest) 下载已打包的插件 ZIP，完整解压后按下方步骤安装。此仓库为私有仓库，需要使用有访问权限的 GitHub 账号登录。

1. 在 Chrome 地址栏输入 `chrome://extensions` 并打开。
2. 打开右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本项目中的 `dist/snapline` 文件夹。选择的文件夹内应能直接看到 `manifest.json`。
4. 点击 Chrome 右上角的拼图图标，把 **拾页 Snapline** 固定到工具栏。
5. 打开想保存的网页，点击拾页图标，进入工作台开始导出。

如果拿到的是 `dist/拾页-Snapline-v1.1.1.zip`，先将压缩包完整解压，再加载解压后包含 `manifest.json` 的文件夹。不要把 ZIP 当作网页打开，也不要选择项目根目录。

Git 仓库保存源码、示例、测试和说明；已打包的安装文件在 Releases 中提供。下载仓库源码后，需要按「从源码构建」步骤生成 `dist/snapline`。

这是可本地安装的扩展包，尚未发布到 Chrome 应用商店。Chrome 的加载流程可参考 [官方入门说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。

## 能做什么

| 想保存的内容 | 使用方式 |
| --- | --- |
| 已经打开的网页 | 选择「浏览器标签页」，从标签页列表中选择页面 |
| 已经部署的网站 | 选择「网页链接」，输入完整的网页地址 |
| 单个本地 HTML | 选择「本地 HTML」，导入 `.html` 或 `.htm` 文件 |
| 带图片、样式等文件的本地页面 | 导入整个文件夹，再选择入口 HTML |

| 导出设置 | 可选内容 |
| --- | --- |
| 文件格式 | PNG、JPG、WebP、PDF |
| 截取范围 | 整个页面、当前可见区域 |
| 输出清晰度 | 1 倍、2 倍、3 倍 |
| 页面宽度 | 原始宽度、1440、768、390 像素，以及 200–7680 像素的自定义宽度 |
| PDF 排版 | A4 分页、Letter 分页、单张长页 |
| 更多设置 | JPG / WebP 质量、透明背景、懒加载处理、等待时间 |

PDF 由页面截图生成，保留视觉效果，文字无法直接选中或搜索。透明背景仅保留页面原有的透明区域，不会自动去掉网页已设置的底色。超长或超高清页面受浏览器内存和图像尺寸限制，可降低倍数、缩小范围后重试。

「整个页面」支持普通长网页，以及 ChatGPT 类页面内部的主滚动区域：逐段滚动并拼接完整内容，适用于 PNG、JPG、WebP 和 PDF。主滚动区域截图聚焦正文，不包含区域外的侧栏或输入工具栏。需要登录的内容，请先打开并登录，再选择「浏览器标签页」。

「重置网页来源」会清空已选文件、网址或标签页，同时清空当前预览；导出设置和历史记录保留。超长 WebP 会等比例缩小到格式支持的尺寸，保存完整内容，并在导出前提示实际尺寸。

处理在本机浏览器完成，无需账号，不会由拾页上传网页或导出文件。网页原本引用的在线图片、字体和脚本仍可能访问其原网站。工作台保留最近 12 次结果，支持再次下载、单条删除和清空。

完整步骤、常见问题见 [使用指南](docs/使用指南.md)；权限与本地数据说明见 [隐私说明](docs/隐私说明.md)。

## 从源码构建

在项目目录打开终端，使用 Node.js 和 npm：

```bash
npm ci
npm run build
```

构建结果：

- `dist/snapline/`：Chrome 可直接加载的扩展文件夹。
- `dist/拾页-Snapline-v1.1.1.zip`：可分享的安装压缩包，需要解压后加载。

开发验证：

```bash
npm test
npm run test:e2e
```

完整验证可运行 `npm run test:all`（单元与导入测试、截图引擎、工作台、自定义宽度与重置、主滚动区域、全格式内容完整性）。新功能专项也可运行 `npm run test:controls`、`npm run test:scroll` 和 `npm run test:full-export`。若电脑中没有测试用 Chromium，先运行 `npx playwright install chromium`，也可以通过 `CHROMIUM_PATH` 指定完整 Chromium 的路径。测试不读取你的日常浏览器用户数据。

`npm run preview` 用于本地查看工作台的视觉效果。真正的网页捕获需要在 Chrome 中加载扩展后使用。

修改源码后重新运行 `npm run build`，在 `chrome://extensions` 页面点击拾页卡片的刷新按钮，并刷新已打开的拾页工作台。
