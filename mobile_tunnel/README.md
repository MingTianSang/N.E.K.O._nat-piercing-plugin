# 扫码手机访问插件

这是 N.E.K.O 的 `mobile_tunnel` 插件目录，可作为源码复制到 N.E.K.O 插件目录，或通过打包后的 `.neko-plugin` 文件导入。

## 内容

- `plugin.toml`：插件元数据、入口和面板声明。
- `__init__.py`：插件后端逻辑，负责启动临时访问入口、本地网关、确认页和空闲停止。
- `ui/panel.tsx`：插件面板。
- `i18n/`：多语言文案。
- `vendor/cloudflared/`：内置 `cloudflared.exe` 及第三方许可记录。
- `LICENSE`：插件本体的 Apache License 2.0 许可证。

## 运行说明

插件默认不会自动启动公网访问入口。用户需要在面板中点击“启动分享”，扫描二维码并在手机确认页点击进入按钮后，才会打开手机访问页面。

使用结束后可以在面板中点击“停止分享”。如果需要让旧二维码失效，可以点击“刷新二维码”。

## 第三方组件

本插件内置 Windows amd64 版 `cloudflared.exe`。替换该文件时，必须同步更新：

- `vendor/cloudflared/VERSION.txt`
- `vendor/cloudflared/THIRD_PARTY_NOTICES.txt`
- `vendor/cloudflared/licenses/`

请在重新发布前校验 `VERSION.txt` 中记录的 SHA256。
