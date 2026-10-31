# 迁入评审：Coopanion 的真实软件观察与输入能力

2026-10-26，评审人 Codex；[总评](plugin-migration-selection-20261026.md)，[规格](../plugin-migration-spec.md)。本轮重新读取上游，commit 为 `ed8bdf179d55c69c081a5488035ac86bd71d63e5`，不同于前轮 `544302aa`；旧结论不当作新版本运行证据。

**Coopanion 确实提供能够作用于外部真实软件的接口。** 本轮定位到的是 desktop-pet World 内的通用电脑操作层：截图、局部放大、窗口枚举 / 聚焦、鼠标 / 键盘输入。是否属于 DSH bundle 只决定安装入口，不能否定这层能力的迁入价值；但这组低层接口也不能直接承诺特定软件任务已完成。

## 1. 结论卡与实际能力

| 字段 | 结论 |
| --- | --- |
| 对象 | `Pal-AI-Lab/Coopanion` 上述 commit；`cortico-world-desktop-pet@0.2.0`，Cortico World api 6 |
| 第一阶段 | 用户明确选择一个外部软件窗口，授权本次观察，让角色解释该窗口当前的错误、选项或界面内容；不输入 |
| 第二阶段，独立决策 | 对选定软件的有限输入控制；必须有目标身份、观察新鲜度、用户抢占、执行回执和风险动作约束 |
| 不迁入 | 桌宠壳、persona、记忆、语音、系统对话审批、30 分钟通用 grant、任意终端输入与整机自由操作 |
| 路线 / 影响 | 窄观察优先比较 M4 原生窗口捕获；M3 抽驱动须先解决许可与边界。观察为 F2；新的系统输入授权 / 整机控制为 F3 |
| 决策 | 观察能力值得后续验证，优先级 4；完整控制暂缓，不能以配置默认值替 LCA 决定新权限 |
| 基线与验收 | 总评的 dirty LCA / Windows；E0 完成所列源码审查，E1–E6 未测，无制品 hash，未执行 OS 操作 |
| 许可 | World package 与自身 LICENSE 为 AGPL-3.0-or-later；代码抽取 / 组合分发方案未明确，不能沿用底层 Cortico 的许可结论 |

来源：[工具声明](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/tools.ts)、[Cua 控制器](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/cua.ts)、[引擎子进程](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/engine-child.ts)、[Win32 驱动](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/engine/win32.ts)。

| 实际接口 | 源码证明的能力 | 不能推导出的能力 |
| --- | --- | --- |
| `pet_cua_screenshot / zoom / wait` | 抓一个显示器、缩放 / 放大区域、等待后看屏幕 | 只读取了用户指定应用；普通截图默认仍可包含其他软件 |
| `pet_cua_windows / focus` | 枚举可见顶层窗口，按句柄或标题片段聚焦 | 已有持久的单应用权限、不会误选同名窗口 |
| `pet_cua_click / move / drag / scroll` | 把截图坐标映射为显示器物理输入 | 控件身份仍有效，或点击产生了预期业务效果 |
| `pet_cua_type / key` | 向当前焦点输入 Unicode 文本 / 快捷键，分块输入可停 | 文件已经保存、消息没有发送，或当前焦点仍是原应用 |

## 2. 价值与 LCA 流程

| 项 | 判断 |
| --- | --- |
| V1 | 观察用途成立于“帮我看这个软件报错 / 当前页面怎么选”；用户也明确关心真实软件接口。频率和首个目标软件待确定 |
| V2 | 预期成立：覆盖没有 API / MCP 的软件；低频截图已有手动附图替代，因此不能只因新鲜就优先 |
| V3 | 窄观察可与 LCA 一起使用；完整输入控制需要新增权限对象与安全反馈，尚未完成产品设计 |
| V4 | 驱动有跨平台、坐标、输入和故障恢复实现，潜在复用价值大；缩到单窗口观察后收益变小，许可 / 维护未定 |

目前可由用户主动附图，再让角色解释。目标窄流程是：用户选择窗口并预览本次可见范围 → main 绑定窗口身份与一次观察授权 → 截取允许范围 → 经获授权的图片模型路径进入本回合 → 书页解释并标记观察时刻 / 截断限制。没有支持图片的连接则明确不可用，不隐藏调用另一个视觉 provider。独立隐私路径不能处理图片时不能自动回退主模型。

第一阶段不主动 focus、不后台轮询、不输入。窗口关闭、切换、遮挡、身份不明或范围变化时要求重新选择 / 观察，不能退回整屏截图。专注、熄灯、取消、换项目撤销待执行观察；图片和派生内容下一轮退役，不入日记或经历记忆。

第二阶段必须另定“允许哪个窗口、哪类动作、持续多久、如何确认外发 / 删除 / 付款 / 终端命令”。低层点击不能可靠区分这些业务含义；本轮不承诺一份按钮黑名单就解决。优先考虑目标软件专用 API；没有 API 时才讨论 CUA。

## 3. 门槛与成本比较

| 门槛 | 判断 / 缺口 |
| --- | --- |
| G1 | 分离驱动与角色 / 工作编排可行；不能把 Cortico WorldHost、WorldLamp、回合 grant 直接替换为 LCA 状态 |
| G2 | 缺口明确：目标主要是 display/layout / 当前焦点；有限窗口权限、部分执行核对和用户抢占仍需设计 |
| G3 | 需要窗口选择 / 授权、图像来源出口及安全投影。LCA 现有 `imageRefs` 字段或 Minecraft 专用截图出口不等于具备该通用能力 |
| G4 | 代码复制 / 组合方案待明确；AGPL 不等于不能用，单独进程也不自动解决组合义务 |
| G5 | 有上游测试供参考，未运行；真实窗口隔离、Windows 打包和长期维护均未验收 |

对同一“指定窗口观察”范围，M4 估 4–7 人日，M3 抽 Coopanion 驱动并替换宿主估 6–10 人日，且许可工作不在区间内。原因是它的成熟部分包括显示器坐标输入、Cortico 反馈与权限，而首阶段需要的是严格的窗口捕获与 LCA 图像链；复用未必减少主要工作。

对完整电脑控制，重新实现原生输入、多屏缩放、用户抢占与故障恢复显然增加工作，复用驱动可能合算；但本轮无法合理估整个权限产品和分发方案的成本，不给虚假的全量工期。替代路线是受支持的外部执行后端 + LCA 窄适配，或专用软件 API；暂不做则维持手动截图。浏览器场景优先专用浏览器协议；同日后续 [Agent Browser 完整评审](plugin-review-agent-browser-20261026.md)将其列为任务内文字 / 截图的优先候选，BrowserSkill 保留给借页流程。

## 4. 迁入改造账本

| 项 | 处理 / 已发现的差异 |
| --- | --- |
| D1 | World api 6 不可按 DSH bundle 导入。若获准抽取，隔离纯驱动 / 图像 / 键码组件，不带整套 desktop-pet、ASR、语音、UI、模型 provider 和 Electron 壳 |
| D2 | main 持有窗口身份、允许操作、scope / epoch；每次操作核对。原 `ask-once / never-ask` 不直接映射为 LCA 批准 |
| D3 | 第一阶段无新 LLM；图像经既有模型能力 / 路由 / 预算核对；不能因截图成功而默认有授权视觉服务 |
| D4 | 截图是带来源、观察版本和有效期的第三方内容；截图里的提示或后续转述不能升权。需要新图像投影契约，不能把 base64 塞普通日志 |
| D5 | 首阶段实现真正的窗口范围捕获并验证遮挡 / 其他窗口不泄露；整屏捕获后裁切仍要评估原始整屏在何处流转，不默认满足隔离 |
| D6 | 业务授权有效期与任务触发归 LCA；驱动技术 deadline / 输入节拍可独立有界，不把它们误判为新 agent 调度器 |
| D7 | 沿用书页审批 / 失败 / 结果；选择窗口与捕获预览是新有限 UI。采用素材、人设或桌宠互动完全在本范围外 |
| D8 | 中止后报告尚未执行、部分执行或结果未知；不能复述“cancelled”就承诺撤回。子进程迟到退出 / IPC send 失败按现有 LCA 经验处理 |
| D9 | 窗口句柄不跨重启恢复；不把当前焦点、截图或 grant 保存成可自动恢复权限。恢复后重新选目标，不补做旧输入 |
| D10 | 单独审 World 代码许可、koffi / jpeg-js 等实际选用依赖和制品；不用上游图像、声音、角色与商标做 LCA 素材 |

三处直接影响适配的证据：

1. [config.ts 44–52](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/config.ts#L44)：CUA 默认关闭，启用后的配置默认 `control=true`、`ask-once`、30 分钟 grant。不能误写为默认一直控制电脑，也不能沿用 grant 为 LCA 产品决定。
2. [engine-child.ts 96–121](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/engine-child.ts#L96)：`target` 检查显示器布局，再等用户空闲执行。它不等于窗口 / 控件新鲜度证明；等待期间状态也可能变化。
3. [engine-child.ts 151–205](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/src/cua/engine-child.ts#L151)：点击 / 拖拽等保持输入完整；打字每 16 个 grapheme 分块，可报告部分输入。迁入要保留这种部分执行事实，不笼统承诺所有动作可即时撤销。

这些是源码性质和待测风险，不是已复现攻击或线上事故。原驱动确有用户空闲等待、输入抢占、取消、超时重建等设计，评审不能只看缺口而忽略可复用经验。

## 5. 许可路径

本轮读取的是 [World 自身 package](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/package.json) 和 [World LICENSE](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/LICENSE)，不是只看应用根或 Cortico 框架。复制 / 修改 / 分发选中代码须按该许可与具体组合作进一步判断；本轮未获得另一种授权，也未作出 LCA 组合一定适用哪种许可的结论。

M4 指按 LCA 需求及公开 OS 接口独立实现，不是把上游代码换名后删除许可。若后续仍复制实现片段，应恢复到明确的复用清单与许可评审。单独进程、IPC、用户自行安装都不能作为自动免责判断；应用素材本轮全部不采用。

## 6. 验收计划

| 维度 | 计划与状态 |
| --- | --- |
| E0 | 已读工具、控制器、Windows 驱动、子进程协议 / 行为及部分恢复 / E2E 测试；仅源码证据 |
| E1 / E2 | 未测；未来适配入口先只提供选定窗口观察，缺驱动或图片能力时不回退整屏 / 其他 provider |
| E3 | 未测；模拟窗口关闭 / 同名窗口 / handle 重用、切焦点、遮挡、多屏布局和 DPI 改变、超大图片、过期授权、取消 / 迟到 IPC、隐私失败 / 额度耗尽 |
| E4 | 未测；后续授权后只用专用测试窗口与合成内容做捕获；断言截图不含邻近测试窗口标记。输入阶段另做测试与授权，不能混在观察验收里 |
| E5 | 未测；熄灯 / 停用 / 换项目 / 重启撤销授权，技术故障不重放旧动作；将来输入验收还须检查鼠标 / 按键释放和部分输入回执 |
| E6 | 未测；目标 Windows 安装态的原生依赖、权限、缩放、打包许可和失败反馈 |

上游已有 [引擎恢复测试](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/tests/cua/recovery.test.ts) 与 [通过 Cortico 驱动测试表单的 E2E](https://github.com/Pal-AI-Lab/Coopanion/blob/ed8bdf179d55c69c081a5488035ac86bd71d63e5/packages/cortico-world-desktop-pet/tests/cua/e2e/core.test.ts)。这些测试可帮助设计验收，但本轮没有运行，也不证明真实 Office / 浏览器任务或 LCA 安装态通过。

停损条件：没有高频观察需求，或必须整屏长期授权才能实现首阶段，则保留手动截图。若窄捕获成功，再单独决定输入控制的用户流程与许可路线。

## 7. 维护和目录表述

维护人未认领。窗口身份策略、原生依赖、Electron / Windows 版本、DPI 与图像路由变更均触发复核。清理临时截图不能删除用户附件；卸载不关用户其他软件、不删其数据。私人存档不迁移软件授权或活窗口句柄。

拟用文案：“按你的选择观察一个软件窗口，帮助解释当前界面；电脑操作机制参考 Coopanion。尚未实现或验收，不提供任意整机操作。”若未来采用其代码，改为准确的组件来源与许可说明，不能继续只写“参考”。
