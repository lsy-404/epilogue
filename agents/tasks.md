# Epilogue 任务追踪
> 准则版本: v0.2.2

## 任务列表

| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :------: | :------: | :------: | :--: |
| 001 | [Feature]_shared-model-auth | 以共享 model-auth 接口替换旧 provider onboarding，并使账户池与推理设置真实联动 | 统一 provider 授权和模型选择体验 | 🔄 进行中 |
| 002 | [Feature]_trae-enterprise-cli | 接入已验证的企业版 Trae CLI adapter，并隔离每个应用和凭据的 CLI home | 只展示可真实验证的企业 CLI 能力 | ⏳ 待处理 |
| 003 | [Maintenance]_model-auth-v0.2.2-dialog | 更新共享 model-auth v0.2.2，并验证 native dialog 动画在 Epilogue 宿主关闭时不被销毁 | 接入已核实发布的弹窗补丁并保持关闭动画可见 | ✅ 已完成 |
