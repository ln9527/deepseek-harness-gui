# Windows 组织连接：隔离测试安装包验收

本流程只用于本机合成账号验收。标准安装包的 Gateway 固定为
`https://ds.ainativeorg.net`；测试安装包在构建时固定到 Windows 本机的
`http://127.0.0.1:47621`，运行时不能修改地址。测试安装包的显示名、
`appId`、Windows AppUserModelId、用户数据与日志目录均和标准版分开。
测试安装包产物是 `dist-win-test/DSH-GUI-Test-Setup-0.2.1-x64.exe`，
不得作为公开 Release 发布。

## 在测试 Windows x64 机器准备

需要 Node.js 24、pnpm 10、此 GUI 仓库和含桌面设备认证的 Gateway 仓库。
Gateway 仓库先按自身说明安装 `gateway/` 依赖。本机端口 47621 应空闲。
在 GUI 仓库的 PowerShell 7 终端运行：

```powershell
$env:DSH_GATEWAY_SOURCE = 'C:\path\to\dsh-agent-core'
$env:DSH_GUI_TEST_GATEWAY_ORIGIN = 'http://127.0.0.1:47621'
$env:DSH_GUI_TEST_PASSWORD = Read-Host -MaskInput 'Choose a throwaway synthetic password'
pnpm install --frozen-lockfile
pnpm dist:win:test
```

构建脚本只接受精确的 loopback HTTP origin，且编译后的主进程必须含有
`DSH GUI Test` 和指定地址，否则拒绝打包。标准 `pnpm dist:win` 不需要
上述测试变量；发布时须从干净环境构建标准安装包。

构建完成后，在同一个 PowerShell 终端启动临时服务；另用文件管理器打开安装包：

```powershell
node scripts/serve-test-gateway.mjs
```

脚本在临时 SQLite 中创建 `synthetic-windows-member`，仅绑定
`127.0.0.1:47621`，不打印密码。按 Ctrl+C 后关闭服务并删除临时数据库。
浏览器登录时使用刚才输入的合成密码。不要在此流程使用真实成员账号或生产库。

## 安装包实际检查

1. 安装 `DSH-GUI-Test-Setup-0.2.1-x64.exe`，核对安装器、任务栏和管理窗显示 `DSH GUI Test`。确认本地 DSH 可以独立启动，未连接组织时也可工作。
2. 管理 → 组织连接 → 开始连接。系统浏览器应打开本机 Gateway 验证页；网页用 `synthetic-windows-member` 登录、输入桌面短码、核对设备名并批准。桌面应显示已连接及合成用户名。
3. 退出并重启测试版；管理页重验 `/me` 后应保持连接。到 Gateway 设备管理页撤销该设备，回到管理页或重获焦点后应显示断开。重新连接后，在桌面点击断开并确认网页端设备撤销。
4. 另起一次流程，在网页拒绝授权；桌面应显示拒绝。让一次短码过期并检查提示。停止临时 Gateway 后重试，桌面应显示离线而本地 DSH 仍能运行。
5. 检查 `%APPDATA%\DSH GUI Test` 与标准版用户数据目录分离；测试版不应读取标准版的组织连接状态。重启标准版也不应向本机测试 Gateway 发请求。

记下安装包 SHA-256、Windows 版本、每项实际结果和截图/日志路径。
CI 生成 EXE、协议自动测试和 macOS 预览都不代替这次 Windows GUI 验收。

## 地址与凭据边界

设备凭据的加密载荷包含构建时 Gateway origin。读取时若 origin 不匹配，
不会返回 token 给启动重验；旧版不含 origin 的载荷也不会被当成已连接。
测试版和标准版各用独立用户数据目录。管理页会显示验证页地址；设备
token 不进入 renderer、日志或 DSH 环境，桌面仍只向 `/auth/desktop/*`
发最小身份请求。
