# 工作岛（可选集成）

把 cccodroid 里 Claude 的实时工作状态，显示在 **ColorOS 16 的流体云 / 灵动岛**上。

- 干活时：「正在干活」+ 当前动作（用执行命令 / 正在想 / 等你确认…）
- 收工：「任务完成」+ 用时
- 8 秒后：岛上收起，通知栏保留一条安静的「在后台等下一轮」

这是**可选集成**：不安装「工作岛」应用时，网关完全不会启动它，不占进程、不写日志噪音。

---

## 测试状态

> **Pre-release / Alpha**
> 目前只在 **OnePlus PJA110 · ColorOS 16.0.3 · Android 16（SDK 36）** 上测试成功。
> 其他 ColorOS 版本、其他品牌机型均未验证；接口、文案和文件布局可能继续变动。
> 不建议用于生产或关键任务。

详细边界见工作岛仓库的 [`STATUS.md`](https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/STATUS.md)。

---

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| 网关模块 | `gateway/gw/work-island.mjs` | 检测应用是否安装；拉起 driver；每 30 秒看一次存活 |
| driver | `gateway/gw/work-island-driver.mjs` | 订阅 `/api/events`，把状态经 `am` 送给应用 |
| 渲染应用 | 仓库 [WorkIsland-Android](https://github.com/STUTTEFRFIX/WorkIsland-Android) | Android 16 Live Update + 前台服务，负责画通知 |

网关侧只使用 Node 内置模块，没有新增 npm 依赖或构建步骤。

---

## 为什么这么设计

1. **ColorOS 16 直接接 Android 16 Live Updates**
   应用侧用 `Notification.ProgressStyle` + `POST_PROMOTED_NOTIFICATIONS` +
   `android.requestPromotedOngoing`，不需要 OPPO 私有白名单。

2. **定时器不能放在应用里**
   实测 ColorOS 会在后台冻结应用（`do_freezer_trap`，前台服务也冻），
   应用内的 8 秒收起定时器不会走。所以定时器与事件流放在网关 driver 里。

3. **driver 不能挂在单轮 claude 里**
   单轮结束会连同进程树一起收走；driver 由网关模块拉起，挂在网关进程树里。

4. **收工判定要看 `runs`，不看 `run`**
   `run` 是“最近一轮”，换轮的空隙可能短暂为空；`runs` 才是所有活跃轮次。
   收到 `run_end` 后等 2.5 秒回 `/api/state` 复查，完成前再等 3 秒宽限，
   期间有新的一轮就直接接着干。

---

## 启用

1. 安装「工作岛」应用（[Release](https://github.com/STUTTEFRFIX/WorkIsland-Android/releases)），
   打开一次，确认：通知开 / 实时更新允许 / 电池不优化。
2. 重启 cccodroid（让网关重新加载模块）。
3. 网关日志出现：

   ```
   [work-island] driver 已启动 pid=...
   ```

4. 发一条消息，看灵动岛。

## 关闭

- 临时：启动网关时设环境变量 `CCAPP_WORK_ISLAND=0`。
- 强制开启（跳过安装检测）：`CCAPP_WORK_ISLAND=1`。
- 卸载「工作岛」应用后，下次网关启动会自己跳过。

换一个包名：`WORK_ISLAND_PKG=your.package`。

---

## 已知限制

- cccodroid 被强行停止后，网关与 driver 都会消失；重开 cccodroid 恢复。
- ColorOS 升级或其他厂商的“灵动岛”实现未验证。
- 工作岛应用的通知服务是 exported 的，同机应用可以伪造显示状态（仅影响显示）。
- 胶囊外观由系统绘制，未使用 OPPO UPK 自定义卡片。
- 工作岛仓库里的 APK 是测试签名，和正式版签名不同。

---

## 相关链接

- 工作岛仓库：https://github.com/STUTTEFRFIX/WorkIsland-Android
- 方案与设计：https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/01-方案与设计.md
- 测试报告：https://github.com/STUTTEFRFIX/WorkIsland-Android/blob/main/docs/03-测试报告.md
