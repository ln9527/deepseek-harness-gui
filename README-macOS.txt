════════════════════════════════════════════════
  DSH GUI for Mac · 安装说明
════════════════════════════════════════════════

【这是什么】
DeepSeek Harness(DSH)的 Mac 桌面应用。
安装包已内置全部运行时:不需要安装 Node.js,不需要联网下载,
唯一要做的只有填写 DeepSeek API Key。

【系统要求】
- macOS 12 或更新
- Apple Silicon 芯片(M1 / M2 / M3 / M4)
  (Intel 芯片的 Mac 不适用此包)

【安装步骤】
1. 双击 DSH-GUI-0.1.0-arm64.dmg
2. 把 DSH GUI 图标拖入旁边的 Applications 文件夹
   (必须拖入 /Applications,否则不会出现在启动台)
3. 打开启动台(Launchpad),点击 DSH GUI
4. 若提示"无法打开,因为无法验证开发者":
   在启动台/访达里 **右键点 DSH GUI → 打开 → 再点"打开"**
   (应用未购买苹果签名证书,属正常现象,只需首次操作一次)
5. 稍等几秒自动启动 → 弹窗提示配置 API Key → 点「去设置」
6. 在「DeepSeek」一栏粘贴你的 API Key → 保存 → 重启后端
7. 开始使用(窗口里就是 DSH 完整界面,可建会话/跑任务)

【常见问题】
- 提示"文件已损坏,建议移到废纸篓":
  打开"终端"(Terminal),粘贴下面这行并回车,再重新打开应用:
  xattr -dr com.apple.quarantine /Applications/DSH\ GUI.app
- 启动台里找不到:确认已拖入 /Applications,然后终端运行 killall Dock
- 关闭窗口 = 后台继续跑任务;彻底退出用屏幕右上角托盘图标
  右键 →「退出 DSH GUI」
- 任务完成/需要审批时会弹 Mac 原生通知(可在 管理→设置 里开关)
- 日志位置:管理窗口 →「日志」页

【API Key 说明】
Key 只保存在你自己电脑的应用设置里,用于本机调用
DeepSeek 接口,不会上传给任何其他方。
