════════════════════════════════════════════════
  DSH GUI for Mac · 安装说明
════════════════════════════════════════════════

【这是什么】
DeepSeek Harness(DSH)的 Mac 桌面应用。
安装包已内置全部运行时:不需要安装 Node.js,不需要联网下载,
唯一要做的只有填写 API Key(DeepSeek;也可选配智谱 GLM Coding Plan,见下文)。

【系统要求】
- macOS 12 或更新
- Apple Silicon 芯片(M1 / M2 / M3 / M4)
  (Intel 芯片的 Mac 不适用此包)

【安装步骤】
1. 双击 DSH-GUI-0.1.2-arm64.dmg
2. 把 DSH GUI 图标拖入旁边的 Applications 文件夹
   (必须拖入 /Applications,否则不会出现在启动台)
3. 打开启动台(Launchpad),点击 DSH GUI
4. 若提示"无法验证开发者 / 是否包含恶意软件"(未购买苹果签名证书的正常现象,
   只需首次操作一次),三种方式任选其一:
   ▸ 方式 A(推荐,适合 macOS 13/14/15):先双击 DSH GUI 让系统拦一次,
     然后打开 系统设置 → 隐私与安全性,往下滚动找到
     「已阻止使用 DSH GUI」提示条 → 点「仍要打开」→ 输入密码确认
   ▸ 方式 B:在启动台/访达里 右键点 DSH GUI → 打开 → 再点"打开"
   ▸ 方式 C(终端):xattr -dr com.apple.quarantine /Applications/DSH\ GUI.app
5. 稍等几秒自动启动 → 弹窗提示配置 API Key → 点「去设置」
6. 在「DeepSeek」一栏粘贴你的 API Key → 保存 → 重启后端
7. 开始使用(窗口里就是 DSH 完整界面,可建会话/跑任务)

【可选:配置智谱 GLM Coding Plan(使用 GLM-5.3)】
除 DeepSeek 外,应用也支持智谱 GLM Coding Plan 订阅:
1. 在 bigmodel.cn 订阅「GLM Coding Plan」,获取智谱 API Key
2. 打开应用主窗口的「设置」→「模型」分区
3. 找到 zai-coding-cn(智谱 Coding Plan 国内版)一栏,
   粘贴 API Key → 保存 → 重启后端
4. 之后对话窗口底部的模型菜单里就能选到 GLM-5.3(智谱当前旗舰)
说明:
- GLM-5.3 思考功能常开,支持多档思考强度(默认最高档),
  可在模型菜单旁的档位按钮切换
- 支持 1M 长上下文;底部状态栏照常显示缓存命中率、token 用量等统计
- 也可以继续用 DeepSeek,两家可同时配置、随时切换

【常见问题】
- 启动报错含 node:zlib / createZstdDecompress(v0.1.0 已知问题):
  电脑上装有较旧的 Node.js(22.14 及以下)被旧版误用。
  请下载 v0.1.1 或更新版本即可,无需卸载 Node
- 提示"文件已损坏,建议移到废纸篓":
  打开"终端"(Terminal),粘贴下面这行并回车,再重新打开应用:
  xattr -dr com.apple.quarantine /Applications/DSH\ GUI.app
- 启动台里找不到:确认已拖入 /Applications,然后终端运行 killall Dock
- 关闭窗口 = 后台继续跑任务;彻底退出用屏幕右上角托盘图标
  右键 →「退出 DSH GUI」
- 任务完成/需要审批时会弹 Mac 原生通知(可在 管理→设置 里开关)
- 日志位置:管理窗口 →「日志」页

【API Key 说明】
Key(DeepSeek / 智谱)只保存在你自己电脑的应用设置里,
用于本机调用对应接口,不会上传给任何其他方。
