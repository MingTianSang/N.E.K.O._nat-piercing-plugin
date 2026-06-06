# 扫码手机访问插件

这是 `mobile_tunnel` 插件的承载骨架，用于后续实现基于 Cloudflare TryCloudflare / Quick Tunnels 的临时公网访问入口。

当前状态：

- 已内置 Windows amd64 版 `cloudflared.exe`。
- 已附带 Apache-2.0 许可证文本、第三方组件说明和版本哈希记录。
- 插件默认不会自动启动公网隧道，需要在面板中手动点击“启动分享”。
- 已实现基础 MVP：启动/停止 TryCloudflare 隧道、生成二维码、刷新 token、手机只读状态页。

后续实现时请优先遵守：

- 默认不要自动启动公网隧道。
- 不要直接代理 N.E.K.O 主服务或插件管理器。
- 只暴露受 token 保护的手机端网关和白名单 API。
- 启动隧道后必须在 UI 中明确显示状态，并提供一键停止。
- 修改内置 `cloudflared.exe` 时必须同步更新 `vendor/cloudflared/VERSION.txt` 中的版本、来源和 SHA256。

更多设计记录见：

`docs/zh-CN/plugins/mobile-tunnel-notes.txt`
