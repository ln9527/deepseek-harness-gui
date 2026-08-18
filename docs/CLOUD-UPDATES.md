# 云端动态(dsh-agent-core 只读跟踪)

**性质**:本仓库会话对 `../dsh-agent-core`(分支 `phase1/out-of-tree-plugin-probe`)
的**只读**观察记录,按观察日期倒序。那边的开发由那边的工作会话负责;
本表用于合并规划——判断哪些云端能力值得/需要移植进 GUI(见 FEATURES.md 规划区)。
不追求穷尽,只记对 GUI 有含义的变化。

---

## 2026-08-18(观察)

- 无新提交(那边最新提交停在 2026-08-16 的 office 预览调研文档;
  可能仍在进行,后续复查)。

## 2026-08-16(观察)

- **office 文档预览调研完成**(FINDINGS-07):LibreOffice + 中文字体约 654MB 镜像、
  每文件约 1 秒转换、冷热启动相近无需常驻进程;office 内嵌缩略图是空白模板字节,
  不可用;方案为网关侧独立转换服务。→ 对 GUI 的含义:桌面版做 office 预览
  可复用同一结论,但按「工具自备」原则装在用户本机。
- **对话中引用文件**(14:09):上传的文件可在输入框引用给 agent
  (conversation.input.left 空槽,增量注册)。
- **删除改为可恢复**(14:11):回收站/恢复/彻底清空/改名。
  回收站放在工作区**内部**,路径守卫封堵保持绝对;rename 原子移动。

## 2026-08-15 ~ 08-16(整批上线,浏览器实测通过)

- **网页访问**:CONNECT 出口代理(容器内 curl/pip/git 可用)+
  web_fetch 中继与 WebFetchProvider 插件(模型可读网页);
  出口地址审查(拒 Docker DNS/内网/本机公网回环)。
- **控制台「文件」标签页**:工作区树 + 内联预览(md/图/SVG/PDF/代码,
  office 给下载卡片);经 UI 插件接缝增量注册(conversation.view 列表槽)。
- **聊天内下载产出文件**(deliverable-download 插件,遮蔽 turnTail 链槽)。
- **多用户切换**:登录网关、账号管理、git 部署(取代 rsync)。
- **UI 插件接缝结论**(FINDINGS-06):树外包即可给 dsh 控制台加 React 组件,
  无需重建;5 种失败模式(两种静默);空槽 shell.overlay /
  conversation.input.left / conversation.input.right 可安全增量使用。
  → 对 GUI 的含义:桌面版可直接沿用同一插件机制(装进 GUI 管理的运行时树),
  网关侧 API(如 /files)需本地等价物。
