---
description: Always Load
applyTo: '**'
---
# 项目指令

- 优先优化性能和运行开销，使用现有依赖和最简单的可靠实现。
- 代码变更前遵循 agent-mode，测试放根 /test，决策与详细操作记录只放 /agents。
- 多模块任务用隔离 worktree 和子 agent 协作，在本地 main 合并；每15分钟检查协作进展，完成后暂停检查。
- 子 agent 禁用 sol；常规调查实现优先 terra/luna medium。
- 工作树默认位于当前系统用户目录 .codex/worktrees/epilogue，创建前检查 git worktree list，不移动或删除既有工作树。
- 完成并验证后检查远程 main 保护状态；未保护则合并推送 main，否则走受保护分支交付规则；不混入无关本地修改。
- 不引入兼容层、迁移或预防性抽象；代码和提交中不放个人信息、任务编号、模型署名和审计性说明。
