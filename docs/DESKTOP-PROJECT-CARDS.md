# 桌面管理窗的组织项目卡原型

2026-09-25。状态：主会话在用户授权的持续开发方向内选定 P1a 原型，尚非用户裁定的长期资料政策。此 GUI 分支从已推送通知与桌面登录堆叠分支 `c6fb646` 建立；对应 Gateway 原型为 `dd149b7`，准确服务端 wire 见 `dsh-agent-core/contracts/desktop-project-cards.md`。均未因本分支自动启用生产或发布安装包。

## 行为与边界

浏览器设备确认页的“项目卡”复选框默认未勾选。选择时，`POST /auth/desktop/poll` 的批准响应在原有身份 `token` 旁额外返回 `projectCardsGrant`。它是与身份 token 不同的凭据，只可用于 `GET /auth/desktop/project-cards`；旧配对响应没有该字段，旧设备只能看到“重新连接并授权”的说明。桌面无法自行扩大权限，重新授权须断开并重新进行浏览器确认。

主进程校验可选 grant 的 43 字符 base64url 形状，和身份 token 一起通过 Electron `safeStorage` 加密保存于 origin 绑定的凭据文件。系统加密不可用时只保留进程内连接。grant 不进入 renderer 状态、preload 返回值、URL、日志、设置、本地 DSH 环境或模型。preload 只暴露 `getDesktopProjectCards()` 方法，其 IPC 对管理窗口 WebContents ID 做与身份 API 相同的拒绝检查；DSH 主页面调用会得到 `AUTH_IPC_FORBIDDEN`。返回管理窗的每张卡只有 `projectId,title,owner,role,updatedAt`，zod 严格拒绝服务端额外字段（包括协作者数组）。卡片仅是文本展示，没有链接、下载或其他组织动作。

组织连接页进入、符合既有一分钟节流的重新聚焦，以及页面每五分钟身份重验时，会向 Gateway 重新请求项目卡。主进程不缓存项目列表，页面开始每次请求就清除前一列表；请求发现断网、身份离线、Gateway 拒绝、授权过期或设备撤销后只显示状态和重新授权/重试入口，不显示上次的卡。`DESKTOP_PROJECT_GRANT_INVALID` 会立即从主进程移除可选 grant，并尝试覆盖加密凭据；覆盖失败则尝试删掉旧凭据文件，身份在当前进程中仍可继续使用。后续需在浏览器重新配对。实时撤权没有推送通道：已打开而未重新请求的页面，最迟下一次焦点/五分钟重验时才会发现 ACL 变化。这一边界需在产品验收中明示。

## 当前验证与发布门

- Node 24：`pnpm typecheck`、定向 desktop-auth Vitest，以及以 Gateway `dd149b7` 的源码、临时 SQLite 和合成账号运行的跨仓 HTTP 联测。覆盖可选 grant、严格五字段、老加密凭据、主进程状态不泄漏、管理窗 IPC 与 DSH 窗口拒绝、当前 ACL 撤人、服务端撤销、离线与 in-flight 断开。
- 本机 headless Google Chrome 预览构建后的管理页（760×600、390×700）：已见项目、空列表、身份离线隐藏、未授权和授权失效时的重连提示；恶意形状的项目名按文本渲染。[390px 截图](verification/2026-09-25-project-cards/chrome-narrow-synthetic.png)。这是浏览器注入合成 IPC 状态的 UI 验证。
- Electron 43.4.0 本机实跑：临时 profile、真实构建后的 preload 和管理页，通过**独立临时主进程 harness 注册的合成 IPC**收到并显示项目卡；[Electron 截图](verification/2026-09-25-project-cards/electron-manage-synthetic.png)。此项验证了 Electron 窗口、preload 与渲染连接，**未运行产品 `main.ts`、完整 DSH、真实 Gateway 或 Windows 安装包**。
- 发布前仍须运行 GUI 的 Windows CI 与真实 Windows x64 Test 安装包，连接启用该 Gateway 分支的合成 HTTPS 服务，走完整浏览器同意、关闭重启恢复、断网、撤权和改密。Gateway 的 Linux CI、精确生产 overlay 和小范围成员使用也需分别验收；本分支不修改生产配置。

## 交接回执

独立 worktree `/Users/ningli/.codex/worktrees/gui-project-cards-20260925`，分支 `codex/gui-project-cards-20260925`，基底 `c6fb646`。未合并桌面登录 #1 后续的 Windows CI 提交；由主会话按依赖顺序整合。

本机 Node 24 `pnpm typecheck`、`pnpm build` 通过；`pnpm test` 为 122 通过、3 跳过（2 项可选跨仓、1 项内置运行时冒烟），原生 catalog 补丁测试另有 8/8 通过。指定 `DSH_GATEWAY_SOURCE=/Users/ningli/.codex/worktrees/desktop-project-cards-gateway/dsh-agent-core` 后，`pnpm exec vitest run tests/desktop-auth` 为 21/21 通过、0 跳过；其中项目卡跨仓用的是 Gateway `dd149b7`，并非生产服务。入库截图仅含合成账号、合成项目和虚构内容；不含真实成员资料或凭据。
