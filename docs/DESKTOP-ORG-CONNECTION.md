# 桌面版组织连接：首个可实施切片

状态：`codex/desktop-org-login-20260925` 开发分支，未合入 `main`，未发布安装包。仓库 `package.json` 当前写 `0.2.1`；截至 2026-09-25，公开 Windows Releases 的最新安装包仍为 v0.1.2。代码、CI 构建和可下载安装包是三种不同证据。

## 用户流程

1. Windows/macOS 安装包启动后，原本的本地 DSH 工作台仍可独立运行。打开「管理 → 组织连接」，点「连接组织账号」。
2. 桌面主进程生成一次性随机 verifier，只把 SHA-256 challenge 和设备名发到 `https://ds.ainativeorg.net/auth/desktop/start`。界面显示短码和有效期，系统浏览器打开服务端返回、且经同域校验的验证页。
3. 用户在网页完成现有登录、首次改密（若需要）、手输短码、核对设备名并确认。桌面按服务端给定间隔轮询；批准后拿到仅限设备身份查询和撤销的 token。
4. 凭据仅在 Electron 主进程；Windows 上通过 `safeStorage` 使用当前系统用户的系统加密能力后写入独立文件。加密不可用时只在进程内持有，关闭应用需重连。重启先显示「待验证」，`/auth/desktop/me` 成功后才显示「已连接」。
5. 「断开组织连接」清除本机凭据并调用服务端撤销。网络断开时明确提示远端撤销未经确认。换账号先断开。

## 协议边界

Gateway 契约（与 Gateway 实现分支对齐）：

| 请求 | 响应 | 桌面处理 |
| --- | --- | --- |
| `POST /auth/desktop/start` `{challenge,deviceName}` | `{requestId,userCode,verificationUrl,expiresInSeconds,pollIntervalSeconds}` | 相对 `verificationUrl` 按固定 Gateway origin 解析，只接受同源 `/auth/desktop/verify` 地址 |
| `POST /auth/desktop/poll` `{requestId,verifier}` | `{status:'pending',pollIntervalSeconds}` 或 `{status:'approved',token,user}` | token 不进入 renderer、日志、设置和 DSH 环境 |
| `GET /auth/desktop/me` | `{user:{username,role}}` | 每次启动验证当前身份；401 清除本机凭据 |
| `POST /auth/desktop/logout` | `{ok:true}` | 请求后清除本机凭据 |

Native POST 加 `x-dsh-desktop-client: 1`、JSON Content-Type、同域 Origin，不带浏览器 cookie。Gateway 的 Bearer 只允许 `/auth/desktop/me` 和 `/auth/desktop/logout`，不可访问 `/org`、文件或 DSH 代理。这一切片证明「同一组织身份连接」，**尚未开放 Context 或成果同步**。后续共享应设计独立受限权限、明确选择和审计，不能把身份 token 当作全站 session。

## Windows 与验收

- `safeStorage` 的 Windows 加密依赖当前用户的 DPAPI；同一 Windows 用户上下文内的其他恶意程序并非隔离对象。桌面保持用户会话安全与操作系统账号安全的边界，不声称防御已控制本机用户的进程。
- 安装包首次运行、重启、离线、服务端撤销、账号禁用、首次改密、拒绝/过期码、断开及换账号，应在真实 Windows x64 安装包上走一遍。跨平台类型检查与 macOS 上的单元测试不能代替 Windows 安装验收。
- 本地 DSH 的启动命令、数据目录和凭据不受组织连接影响；连接不自动上传本地文件或对话。未来飞书/手机只应接收低敏通知和深链，不能借设备凭据代替用户确认共享。

## 当前验证

- `pnpm typecheck`
- `pnpm test`：协议、凭据不落明文、状态不泄露 token，以及既有测试
- `pnpm build`
- 待完成：Gateway 分支合并后的真实 HTTP 联测、Windows CI 安装包、真实 Windows GUI 检查与公开发布决策。
