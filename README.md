# N.E.K.O. NAT Piercing Plugin

N.E.K.O 扫码手机访问插件。它可以通过 Cloudflare 临时隧道、Tailscale Funnel 或 cpolar 创建二维码访问入口，让用户扫码后在手机浏览器打开本机 N.E.K.O，并提供确认页、链接隐藏、复制、刷新和空闲自动停止机制。

## 功能

- 生成 HTTPS 访问链接和二维码。
- 支持 Cloudflare 临时隧道、Tailscale Funnel 和 cpolar 国内隧道三种方案。
- 手机访问前显示确认页，避免误扫后直接进入。
- 链接默认隐藏，可手动显示或复制。
- 支持刷新二维码，使旧链接立即失效。
- 手机进入前长时间空闲会自动停止分享入口。
- 内置 Windows amd64 版 `cloudflared.exe`，Cloudflare 临时隧道方案无需用户额外下载。
- 插件面板和手机确认页支持多语言本地化。

## 安装

推荐从 Releases 下载正式的 `mobile_tunnel.neko-plugin` 包，然后在 N.E.K.O 的插件管理器中导入。

不建议直接把 GitHub 自动生成的源码 zip 当作插件包导入；源码仓库结构和 N.E.K.O 的 `.neko-plugin` 导入包结构不同。

如果要从源码安装，可以将 `mobile_tunnel` 文件夹复制到 N.E.K.O 的插件目录中，然后重启或刷新插件列表。

## 使用

1. 在 N.E.K.O 插件面板中打开“扫码手机访问”。
2. 点击“启动分享”。
3. 用手机扫描二维码。
4. 在手机确认页点击进入按钮。
5. 使用完成后在插件面板点击“停止分享”。

## 安全说明

- 插件默认不会自动启动公网访问入口。
- 每次启动都会生成临时访问链接。
- 请只把二维码或链接分享给可信设备。
- 使用结束后建议手动停止分享。
- 如果二维码泄露，可以刷新二维码使旧链接失效。

## 第三方组件

本插件内置 Cloudflare 的 `cloudflared`，用于创建 Cloudflare Quick Tunnels。Tailscale Funnel 和 cpolar 方案需要用户自行安装并登录对应客户端，插件不会内置或代替用户安装这些客户端。

- 项目地址：https://github.com/cloudflare/cloudflared
- 内置版本：见 `mobile_tunnel/vendor/cloudflared/VERSION.txt`
- 第三方声明：见 `mobile_tunnel/vendor/cloudflared/THIRD_PARTY_NOTICES.txt`
- cloudflared 许可证：见 `mobile_tunnel/vendor/cloudflared/licenses/`

## 免责声明

本插件不是 Cloudflare、Tailscale 或 cpolar 官方产品，也不代表这些服务对本插件提供认可、赞助或背书。相关名称归其各自权利人所有。

使用 Cloudflare Quick Tunnels、Tailscale Funnel 或 cpolar 时，请遵守对应服务适用的服务条款和使用政策。

## 许可证

本插件使用 Apache License 2.0。

内置的 `cloudflared` 由 Cloudflare 以 Apache License 2.0 授权。本插件不声明拥有 `cloudflared` 的所有权。
