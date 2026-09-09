# 应用内自动更新:可行性研究与实施方案

> 记录于 2026-08-22。性质:**技术调研 + 方案建议**,不是已实现功能。
> 目标:用户装过一次之后,后续版本在应用内点一下就能升级,
> 而不是每次重新下载 179MB/212MB 安装包再覆盖安装。

---

## 0. 结论速览

| 平台 | 能否做到「点一下自动升级」 | 卡点 |
|---|---|---|
| Windows | **能**,成本低,可立即落地 | 无硬卡点 |
| macOS | **当前不能** | 被 `identity: "-"`(ad-hoc 签名)硬性阻断,见 §3 |

另有一个反直觉但重要的发现:**DSH 内核升级根本不需要更新整个应用**——
这条通道仓库里已经实现了(§1),很多「想升级」的场景其实不必动安装包。

---

## 1. 先分清两条更新轴(最容易搞混的地方)

| 轴 | 更新什么 | 体积 | 现状 |
|---|---|---|---|
| **内核更新** | DSH 运行时 | 343MB(darwin) / 690MB(win32) | **已实现** |
| **壳更新** | Electron 应用本体 | `out/` 仅 256KB | 无,只能重装 |

内核更新已有完整通道:`versions:install` IPC → `installer.ts` → `npm-runner` →
`registry.ts` 的 `installVersion`(tmp → manifest → rename 原子安装到 userData)。
DSH 发新版时,用户在「管理 → 版本」页点一下就能装,**不需要重下安装包**。

也就是说:安装包里那 343MB/690MB 是「出厂自带的兜底内核」,不是升级的必经之路。
真正必须靠新安装包分发的,只有壳自身的改动——而壳的产物只有 256KB。

**推论**:自动更新要解决的是壳这 256KB 的分发问题,而现在为了这 256KB
让用户重下 179MB。这个不对称正是本方案的价值所在。

---

## 2. 现状盘点:已经具备的条件

调研发现当前构建**已经在产出自动更新所需的元数据**,只是没人消费:

| 已有 | 位置 | 说明 |
|---|---|---|
| `latest-mac.yml` | `dist/` | electron-updater 的 mac 更新清单 |
| `latest.yml` | `dist-win/` | Windows 更新清单 |
| `*.blockmap` | 两处 | 差量更新所需的块映射 |
| 公开仓库 | `ln9527/deepseek-harness-gui` (PUBLIC) | GitHub Releases 可直接当更新源,**免 token** |
| electron-builder | 26.15.3 | 版本足够新,原生支持 publish 配置 |

缺的只有四样:`electron-updater` 依赖、`publish` 配置、macOS 的 `zip` 靶子、以及 UI。

---

## 3. macOS 的硬卡点(必须先做决策)

### 事实

Squirrel.Mac 在安装更新前会用 `SecCodeCopyDesignatedRequirement` +
`SecStaticCodeCheckValidityWithErrors` 校验新包签名是否满足**旧包的 designated
requirement**。ad-hoc 签名没有稳定的 designated requirement——它不含 Team ID,
且 cdhash 每次构建都变——因此该校验必然失败。

这不是配置问题,是机制问题:Sparkle 等其他 mac 更新器有同样的限制。

### 与既有决策的冲突

`CLAUDE.md` 明确记载 `identity: "-"` 是刻意选择:设成 `identity: null` 会让
electron-builder 跳过签名、留下 Electron 的陈旧封印,导致下载副本报「文件已损坏」。
所以 ad-hoc 签名当前是**正确的**——它只是恰好与自动更新互斥。

### 三个选项

| 方案 | 成本 | 结果 |
|---|---|---|
| **A. 加入 Apple Developer Program** | 99 美元/年 + 公证流程 | 真·自动更新;**并顺带消灭「无法验证开发者」弹窗** |
| **B. 保持 ad-hoc,做半自动** | 0 | 应用内提示新版 + 自动下载 dmg + 自动打开,用户仍需手动拖拽到「应用程序」 |
| **C. 自研替换 .app 目录** | 高 | **不推荐**:绕过 Gatekeeper 校验,隔离属性(quarantine)与权限坑多,且失去防篡改保证 |

方案 A 的具体加入步骤见 [APPLE-DEVELOPER-ENROLLMENT.md](./APPLE-DEVELOPER-ENROLLMENT.md)。

**建议选 A**。理由不只是自动更新:Developer ID 签名 + 公证同时消灭了
README.md 与 README-macOS.txt 里那套「右键打开 / 系统设置 → 隐私与安全性 →
仍要打开」的首次启动摩擦。一笔钱买断两个问题,而这两个问题都直接作用于新用户
的第一印象。

若暂不投入,方案 B 也是体面的过渡:用户体验从「自己去 GitHub 找新版」
提升到「应用告诉我有新版并把 dmg 递到手上」,已经是很大改善。

---

## 4. Windows:无卡点

NSIS + electron-updater 开箱可用,未签名也能自动更新,但有一处必须显式配置:

electron-updater 默认会做 Authenticode 校验——把构建期解析出的 publisherName
写进 `app-update.yml`,更新时比对下载到的安装包证书 subject,**不匹配就拒绝安装**。
当前安装包未签名,因此必须设 `verifyUpdateCodeSignature: false`,否则更新会被自己拒掉。

代价是 SmartScreen 警告依旧存在(与是否自动更新无关,那是签名问题)。

---

## 5. 体积与差量更新

当前整包体积:mac dmg 179MB、win exe 212MB。若每次补丁都全量下载,自动更新的
体验优势会被网络耗时抵消大半。

差量更新支持矩阵:

| 目标格式 | 差量支持 |
|---|---|
| Windows NSIS | 支持(基于 blockmap) |
| macOS **zip** | 支持 |
| macOS **dmg** | **不支持** |

因此 **macOS 端无论如何都要增加 `zip` 靶子**——Squirrel.Mac 需要它才能生成
可用的 `latest-mac.yml`,差量更新也需要它。dmg 保留给首次下载安装用,
zip 供更新通道用,两者并存。

预期收益很可观:343MB/690MB 的运行时树在壳的补丁版本之间几乎不变,
理论上 v0.1.2 → v0.1.3 这种纯壳改动的差量应该极小。

**但需实测**:差量下载耗时与「变化的块数」成正比,块变化分散时可能反而慢于整包。
不要假设差量一定更快,上线前用真实的两个版本量一次。

---

## 6. 更新源:中国网络的现实约束

GitHub Releases 在国内直连不稳定。若把它作为唯一更新源,自动更新会在
相当比例的用户那里静默失败——而更新失败比没有更新更伤体验。

electron-updater 支持 `generic` provider(任意 HTTP 静态源)。既然已有
`ds.ainativeorg.net`(阿里云 HK),建议:

- **主源**:generic → 自有域名(国内可达)
- **备源**:GitHub Releases(海外用户 / 自有源故障时)

这也与 `PRODUCT-VISION.md` 的云端收敛方向一致:更新分发是云端天然该承担的职责之一。

注意:自有源只需托管静态文件(`latest*.yml` + 安装包 + blockmap),无需任何服务端逻辑。

---

## 7. 关键集成风险:优雅退出会吃掉更新重启

这是本仓库特有的坑,**不处理必然踩**。

`main.ts:306` 注册了 `before-quit` 处理器,第一件事就是 `event.preventDefault()`,
然后走 `requestQuit()`:摘桥 → `supervisor.stop()` → **`app.exit(0)`**
(另有 8 秒兜底定时器同样调 `app.exit(0)`)。

`autoUpdater.quitAndInstall()` 的工作方式是触发退出流程、在退出时执行安装。
但这里的序列会走到 `app.exit(0)`——**硬退出,跳过 electron-updater 的安装钩子**。
结果:应用退出了,更新没装上,重启后还是旧版本,且没有任何错误提示。

**要求**:更新安装必须汇入既有的优雅退出序列,而不是另起一条路。
具体做法是在 `requestQuit()` 中引入「本次退出是为了安装更新」的标志,
在 `supervisor.stop()` 完成之后、`app.exit(0)` 之前调用安装动作。

这与仓库既有的纪律是同一条:外部 SIGTERM/SIGINT/SIGHUP 也是被路由进
`requestQuit()` 的,原因相同——任何绕过这条序列的退出都会泄漏 DSH 子进程。

---

## 8. 实施步骤(建议分阶段)

### Phase 0 — 零成本,可立即做

1. 在「管理」窗口增加「检查更新」入口:拉取 `latest*.yml`,比对版本,
   有新版则提示并给出 Releases 链接。
2. 同时把 §1 的事实讲给用户:**DSH 内核升级在「版本」页就能做,不必重装应用**。
   这一条很可能直接消解掉相当一部分「我要升级」的诉求。

### Phase 1 — Windows 全自动

3. 加 `electron-updater` 依赖;`electron-builder.win.yml` 增加 `publish` 配置。
4. 设 `verifyUpdateCodeSignature: false`(§4)。
5. 打通 §7 的退出序列集成。
6. UI:检查 → 下载(带进度)→ 重启安装。

### Phase 2 — macOS

7. 取决于 §3 的决策。选 A 则购买证书、配置公证、mac 靶子加 `zip`;
   选 B 则实现「下载 dmg 并打开」的半自动路径。

### Phase 3 — 分发优化

8. 自建更新源(§6)+ 差量更新实测(§5)。

---

## 9. 代码落点(遵循既有纪律)

- **新增目录** `src/main/updater/`,与 `dsh-runtime/`、`notify-bridge/` 同级。
  更新状态建议同样做成纯函数状态机 + 执行器的形态,与 `dsh-runtime/state-machine.ts`
  一致,便于表驱动测试。
- **新增 IPC**:`update:check` / `update:download` / `update:install`(invoke),
  `update:status`(push)。按现有纪律,schema 进 `src/shared/ipc-schemas.ts`,
  在 `ipc/register.ts` 的单一表里注册,handler 自动获得校验与 `Result<T>` 包装。
- **日志**走 `getLogger('updater')`,不得出现 `console.*`。
- **失败必须 fail-soft**:更新检查/下载失败绝不能影响 DSH 运行——
  与 notify-bridge 同样的设计取向。

---

## 10. 待确认事项

以下几点建议在立项时实测,不要基于本文档假设:

1. 差量更新在本项目真实版本对上的实际收益(§5)。
2. macOS 加 `zip` 靶子后,dmg 与 zip 并存的构建时长与产物体积增量。
3. 若选方案 A,公证(notarization)流程对 CI 的改造量——
   需要 Apple ID 凭据进 GitHub Secrets,且公证是联网步骤,会拉长 CI 时间。
4. `verifyUpdateCodeSignature: false` 在 Windows 上的安全含义:
   关闭后更新包不再校验签名者,更新源的完整性就完全依赖 HTTPS 与
   `latest.yml` 中的 sha512。自建源(§6)必须强制 HTTPS。
