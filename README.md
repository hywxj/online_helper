# online_helper · 网课助手

DeepSeek Harness 本地插件，通过独立 Chrome / Edge 窗口读取课程视频的真实进度，播放结束后自动进入下一节视频。面板支持启动、停止、播放进度、最近动态和站点规则管理。

仓库：[hywxj/online_helper](https://github.com/hywxj/online_helper)。由 [Lojove/dsh-autoplay](https://github.com/Lojove/dsh-autoplay) 重构而来，保留原始提交历史和 MIT 许可。

## 环境要求

- DeepSeek Harness 桌面版，宿主 Node.js 22 或更新版本。
- Windows，已安装 Chrome 或 Edge。浏览器自动发现当前仅适配 Windows。
- 插件无第三方运行时依赖，无需执行 `npm install`。无需构建即可作为本地 bundle 安装。
- 开发自测可以在 Linux、macOS 或 Windows 上运行。

## 安装

```bash
git clone https://github.com/hywxj/online_helper.git ~/online_helper
cd ~/online_helper
npm test
```

在 DSH 中让 agent 安装指向该目录绝对路径的 bundle：

```text
plugin_manager  action: install_bundle
                target: <online_helper 目录的绝对路径>
```

该操作由 DSH 审批。更新本地代码后，禁用并重新启用 bundle，使宿主加载最新模块。旧版 `dsh-autoplay` 用户应先禁用旧 bundle，再安装本插件。

## 使用

1. 点击 Harness 左侧栏的「网课助手」。
2. 填写课程视频页地址，点击「启动并监控」。
3. 首次使用时，在打开的独立浏览器窗口中登录课程平台。
4. 面板实时展示进度、已连播节数及最近动态；点击「停止」结束监控。

内置站点规则：

| 站点 | 规则 ID |
|---|---|
| 北航雨课堂 `buaa.yuketang.cn` | `buaa-yuketang` |
| 学堂在线研究生院 `graduate.xuetangx.com` | `graduate-xuetangx` |

自定义规则可以在面板中导入、删除，并通过「探测当前页面」查看 DOM。相同 ID 的用户规则覆盖内置规则；规则在下次启动监控时生效。新站点的适配方法见 [RULES.md](RULES.md)。

## 数据与兼容

- 包标识：`@local/online_helper`；宿主插件及侧栏 ID：`online_helper`。
- 前后端通过宿主的 `/online_helper` 本地 HTTP 路由通信。
- 设置、日志、状态及用户规则存放于 `~/.dsh/online_helper/`；设置 `DSH_HOME` 后改为 `$DSH_HOME/online_helper/`。
- 当新数据目录尚不存在时，自动从同级 `dsh-autoplay/` 或 `course-watch/` 迁移，优先选择前者；已有新目录时保留现有数据。
- 独立浏览器配置目录继续使用 `%LOCALAPPDATA%\dsh-course-watch-chrome`，以保留旧版登录态，与日常 Chrome 的配置独立。

## 项目结构

```text
index.js           DSH 宿主适配、HTTP 路由、运行生命周期
client.js          侧栏面板和控制界面
lib/config.mjs     监控默认值、规则合并及站点匹配
lib/rules.mjs      JSON 规则加载、校验、保存和删除
lib/paths.mjs      数据目录解析及旧版数据迁移
lib/watch.mjs      播放进度监控、续播与自动翻页
lib/cdp.mjs        零依赖 Chrome DevTools Protocol 客户端
lib/chrome.mjs     浏览器发现、独立配置目录及启动
rules/*.json       内置规则的唯一数据来源
locale/*.json      语言资源
selftest.mjs       原有功能回归自测
tests/*.test.mjs   规则仓库、数据迁移及宿主接口测试
```

## 开发验证

```bash
npm run check   # 宿主与客户端语法检查
npm test        # 回归自测与模块/接口测试；无需浏览器或网络
```

监控模块仍兼容原有 `loadConfig`、`advanceFor`、`matchesHost`、`mergeSites` 导出。内置规则统一从 `rules/*.json` 读取，避免宿主和监控引擎使用不同版本的选择器。

## 已知限制

- 需要在实际的 Windows + DSH + 浏览器环境中验证真实播放和界面渲染。
- 面板文字当前以中文为主，尚未接入客户端 locale 服务。
- 同时打开多门课程时，按地址前缀选择目标课程。
- 跳过非视频条目依赖课程目录；站点结构变化可能需要更新规则。没有目录的平台可能停在习题页并报告 `blocked`。

## License

[MIT](LICENSE)。保留原作者 Lloyd 的版权声明，重构与后续维护：hywxj。
