# MC 背包、场景与转向

2026-10-17。接口 `37cb419` 已先合 main，新增可核对能力与未来截图／挖掘的逐轮同意字段。此批完成 inventory／scene／look，游戏模型由四个工具增为七个；截图、挖掘仍是未完成项，省略／显式 false 兼容，尚未实现的 true 同意会拒绝，不假装已开启。

背包只放物品 registry ID、槽位、数量和可用耐久，校验槽位唯一、占用数量、维度和已知凭据碰撞；名称、lore、NBT 不进入游戏日志／模型。场景固定附近 3×3 原生射线，检查维度、采样格、距离及玩家位置，明确标成 ray grid，不当作像素视觉，不以未击中证明空地。来源 tick 不能倒退，观察期间玩家显著移动则拒绝。

转向范围 yaw [-180,180]／pitch [-90,90]，走同一 controlSessionId／sequence／expectedWorldSessionId；导航进行中拒绝，动作后核对输入 owner 和新玩家角度，回声式 ack 不能当成功。转向计入既有 24 次动作，错误、换世界、专注、断开和关闭仍走释放核验。

`src/main/minecraft/play-with-user.md` 是独立编写并实际注入的“陪你玩”技术 skill，明确轮次范围、观察／图像区别、动作证据、公开聊天和停止边界，不代写角色台词。数据字段只参考本机 `D:/mcpfabric` 的 MCP schema 和 Java handler，本轮只读固定点 HEAD `f2c1296ab011f1c89f254db136dfd90be15059bb` 及当时工作区；未复制实现，未改参考仓库、启动服务或接管实例。字段来源为 mcp-server/src/tools.ts、src/client/java/dev/mcpfabric/client/handlers/{LocalPlayerHandlers,VisionHandlers,ControlHandlers,ItemJson}.java。

资源：实测七步对话需约 67k 预留单位，原单轮 60k 在六次工具后会拒绝收尾；因此单轮调至 80k，8 步／输出 800 token／共享日自主 100k／总 500k 保持。预留单位不是实际计费 token。原生后段独立失败／断开矩阵使用第二个合成日，不扩大生产日预算；真正展位预算配置／监测仍需补齐。

验证：类型／lint、59 文件 356 项 Vitest 通过。`pnpm test:minecraft` 的源码 Electron＋真实本机合成 MCP HTTP 跑七步链路，真实 schema 核对、Markdown 注入、物品 lore 丢弃、原生 owner 与新角度、事件／专注／换世界／私有状态拒绝／断开／重启核验均通过；普通记录与 ZIP 不含新背包／射线正文。它不是 MC 实机或真实模型质量验收。安装包基线仍是 6571c05，本次源码增补待后续打包收录。
