# 拾页 Snapline

将网页内容保存为 PNG、JPG、WebP 或 PDF，同时提供网页版和 Chrome 插件版。项目采用 [MIT 许可证](LICENSE) 开源。

- **在线使用网页版：** [打开拾页](https://jokerlixing.github.io/snapline-chrome-extension/)
- **下载插件版：** [GitHub Releases](https://github.com/jokerlixing/snapline-chrome-extension/releases/latest)
- **先看使用方法：** 根目录 [使用说明.md](使用说明.md)

## 选哪一种

| 功能 | 网页版 | 插件版 |
| --- | --- | --- |
| 无需安装，打开链接使用 | 支持 | 需加载扩展 |
| 导入单个 HTML、带资源的文件夹 | 支持 | 支持 |
| 粘贴 HTML 代码 | 支持 | 可先保存为 HTML 后导入 |
| 自定义宽度、手机/平板预设、1–3 倍清晰度 | 支持 | 支持 |
| PNG、JPG、WebP、分页/长页 PDF | 支持 | 支持 |
| 来源重置、本机历史、再次下载 | 支持 | 支持 |
| 在线网站、已登录的标签页 | 请使用插件 | 支持 |
| JavaScript 动态网页及虚拟滚动内容 | 不运行导入脚本 | 支持浏览器实际渲染 |

网页版在本机渲染静态 HTML；受浏览器同源限制，不能直接读取其他网站或登录会话。复杂 CSS、外部媒体和跨域资源可能无法完整呈现，需要这些内容时请使用插件。PDF 是截图型文档，文字不可直接选取。超长 WebP 会等比例缩小，保留完整内容。

## 网页版

打开 [公共网站](https://jokerlixing.github.io/snapline-chrome-extension/)，选择「本地 HTML」导入文件/文件夹，或选择「粘贴 HTML」输入代码。点击浅红色「生成预览」，然后选择格式导出。也可以点击「试试示例网页」立即体验。

无需登录。网站不会上传导入内容；记录和偏好保存在当前浏览器内。网页本身引用的在线图片、字体等仍可能访问原网站。网页版与插件版的历史分别保存。

## 插件版

1. 从 [Releases](https://github.com/jokerlixing/snapline-chrome-extension/releases/latest) 下载 `Snapline-v1.2.0.zip` 并完整解压。
2. 在 Chrome 打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择解压后的 `snapline` 文件夹，里面应直接包含 `manifest.json`。
4. 打开要保存的网页，完成登录或展开内容，点击拾页工具栏图标。
5. 选择网页来源、宽度和范围，生成预览后导出。

更新时覆盖 **Chrome 当前加载的文件夹**，在扩展管理页刷新拾页，再打开工作台。插件适用于 Chrome 120 及以上版本，尚未发布到 Chrome 应用商店。

更多操作见 [使用指南](docs/使用指南.md)；本地数据和权限见 [隐私说明](docs/隐私说明.md)；验证记录见 [测试说明](docs/verification.md)。

## 从源码运行

```bash
npm ci
npm run build
npm run preview
```

- `dist/site/`：可部署的静态网页版；本地地址为 `http://127.0.0.1:4173`。
- `dist/snapline/`：Chrome 可加载的插件目录。
- Windows 构建另生成 `dist/拾页-Snapline-v1.2.0.zip` 安装包。
- 只构建网页版：`npm run build:web`；只构建插件：`npm run build:extension`。

请通过 HTTP 服务打开本地网页版，直接双击 `index.html` 会受到模块与资源加载限制。

## 验证与部署

```bash
npx playwright install chromium
npm test
npm run build
npm run test:web-engine
npm run test:web
npm run test:e2e
```

完整回归使用 `npm run test:all`。其中 `test:upgrade` 需要完整 Git 历史，会提取真实 1.0.0 进行覆盖升级测试；仅下载源码 ZIP 不含该历史。浏览器测试使用独立配置，不读取日常浏览器数据。

推送 `main` 后，`.github/workflows/pages.yml` 自动检查、构建并发布 `dist/site` 到 GitHub Pages。工作流使用只读源码权限，部署任务仅请求 Pages 和 OIDC 所需权限，无需额外密钥。站点不包含构建依赖、测试产物或本机记录。

## 开源与第三方组件

源码采用 MIT 许可证，允许使用、修改和再分发。构建目录中的 `THIRD-PARTY-NOTICES.txt` 收录运行依赖的许可证文本，分发时请一并保留。
