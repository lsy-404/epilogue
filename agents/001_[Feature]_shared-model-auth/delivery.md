# 交付验证

- 使用正式 model-auth v0.2.1，共享 Vue Custom Element、WorkBuddy 协议和 CredentialRouter。
- 修复独立包 Node 全局引用、models.dev 默认 SDK API 地址遗漏、OAuth/API 条目合并、断网授权入口、重连与错误恢复。
- 52 项测试通过；使用独立数据目录，原生 Electron 44 实测实际产品模块和主进程状态：三种可用 OAuth 入口与 TRAE 缺失提示、WorkBuddy 开关写入与恢复。
- 完整应用首次使用条款未替用户接受；模块测试独立于首次使用流程，不读取生产凭据。
- 新建根 test 模块 GUI 入口用于人工回归；未自动覆盖已安装客户端或真实账号。
- TRAE 只使用一个应用专属会话，账号默认模式不冒充 models.dev 模型；真实 CLI 登录被官方安装入口 HTTP 403 阻塞。
