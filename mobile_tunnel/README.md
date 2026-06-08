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

插件默认不会自动启动公网访问入口。用户需要在面板中选择访问方案并点击启动按钮，扫描二维码并在手机确认页点击进入按钮后，才会打开手机访问页面。

目前面板提供三种方案：

- Cloudflare 临时隧道：内置 `cloudflared.exe`，不需要用户单独下载，适合快速一键使用。
- Tailscale Funnel：需要用户先安装并登录 Tailscale，适合已有 Tailscale 环境的用户。
- cpolar 国内隧道：需要用户先安装 cpolar 并配置认证 token，适合国内网络优先的用户。

使用结束后可以在面板中点击“停止分享”。如果需要让旧二维码失效，可以点击“刷新二维码”。

## cpolar 准备教程

cpolar 方案和内置的 Cloudflare 临时隧道不同，它需要用户先安装 cpolar 客户端并配置账号 token。准备完成后，插件会启动本地手机网关，并通过 cpolar 创建 HTTPS 访问入口；插件不会自动安装 cpolar，也不会读取或显示用户 token。

官方资料：

- cpolar 下载页：https://www.cpolar.com/download
- cpolar token 页面：https://dashboard.cpolar.com/auth
- cpolar 文档：https://www.cpolar.com/docs

### 步骤 1：安装 cpolar

打开 cpolar 官方下载页，下载并安装 Windows 客户端。安装完成后，回到插件面板的 cpolar 国内隧道页，点击“检测安装”，插件会自动检测本机是否已经安装 cpolar。

> 配图区域：cpolar 下载页和安装完成后的状态检查。

### 步骤 2：配置认证 token

打开 cpolar token 页面，复制自己的认证 token，粘贴到插件面板里的 token 输入框，然后点击“保存 token”。插件会自动把 token 写入默认配置文件。插件只会检查配置文件中是否存在 token，不会显示 token 内容。

> 配图区域：cpolar token 页面和插件内 token 保存区域。

### 步骤 3：回到插件重新检测

确保本插件处于启动状态，然后回到插件面板的 cpolar 国内隧道页，点击“重新检测”。检测通过后点击“启动 cpolar”。插件会启动本地手机网关，并显示二维码、隐藏链接、复制链接、刷新二维码和停止按钮。

免费版通常为随机地址和 1Mbps 带宽，且账号同时在线进程数有限；如果电脑上已经有其他 cpolar 进程在运行，插件启动可能失败。

> 配图区域：插件中检测成功后的状态卡片。

## Tailscale Funnel 准备教程

Tailscale Funnel 和内置的临时通道不同，它需要用户先完成 Tailscale 安装、登录、MagicDNS、HTTPS 与访问控制准备。准备完成后，插件可以启动本地手机网关，并通过 Tailscale Funnel 生成二维码和访问链接；插件不会自动安装 Tailscale，也不会替用户修改账号或访问控制策略。

官方资料：

- Tailscale 下载页：https://tailscale.com/download/windows
- Tailscale DNS 设置：https://login.tailscale.com/admin/dns
- Tailscale 访问控制 JSON 编辑器：https://login.tailscale.com/admin/acls/file
- Funnel 官方文档：https://tailscale.com/docs/features/tailscale-funnel

### 步骤 1：安装并登录 Tailscale

打开 Tailscale 官方下载页，安装 Windows 客户端。安装完成后，从系统托盘打开 Tailscale 并登录账号，确认这台电脑已经出现在 Tailscale 的设备列表中。

> 配图区域：官方下载页、安装完成后的系统托盘状态。

### 步骤 2：确认 MagicDNS，启用 HTTPS

进入 Tailscale 管理后台的 DNS 页面，确认 MagicDNS 已启用。MagicDNS 通常默认开启，如果页面显示已经开启，不需要额外操作；如果没有开启，请手动打开。

然后启用 HTTPS 证书。Funnel 需要 MagicDNS 和 HTTPS 证书来生成可公开访问的 HTTPS 设备域名。

> 配图区域：DNS 页面里的 MagicDNS 与 HTTPS 开关。

### 步骤 3：允许使用 Funnel

按照 Tailscale Funnel 官方文档启用 Funnel。首次启用时，Tailscale 可能会打开网页让用户确认授权；如果它自动写入访问控制策略，就不用手动改。

如果需要在网页上手动配置，不要在 `Add rule` 页面里填写 `Source`、`Destination` 或端口；那个页面是普通访问规则，不是 Funnel 权限。

更适合新手的方式是使用插件面板中的“复制完整模板”按钮，然后全选替换：

1. 在插件面板点击“复制完整模板”。
2. 打开 Tailscale 访问控制 JSON 编辑器：https://login.tailscale.com/admin/acls/file
3. 在 JSON 编辑器里全选原内容。
4. 粘贴替换。
5. 保存。

注意：这会覆盖已有自定义规则。它适合仍在使用默认模板，或没有改过访问控制的用户；如果已经写过自己的规则，请只把模板里的 `nodeAttrs` 部分合并进去。

> 配图区域：JSON 编辑器中全选原内容并替换为完整模板。

如果不想覆盖整个文件，也可以只合并下面的 `nodeAttrs` 部分：

```jsonc
// 允许 tailnet 成员使用 Tailscale Funnel。
"nodeAttrs": [
  {
    "target": ["autogroup:member"],
    "attr": ["funnel"]
  }
],
```

这种做法需要确认粘贴位置和逗号，适合已经改过访问控制的用户。

### 步骤 4：回到插件重新检测

确保本插件处于启动状态，然后回到插件面板的 Tailscale Funnel 页，点击“重新检测”。当安装状态、账号状态和设备域名都正常后，点击“启动 Funnel”。插件会启动本地手机网关，并像临时隧道方案一样显示二维码和可复制的访问链接。

> 配图区域：插件中检测成功后的状态卡片。

## 第三方组件

本插件内置 Windows amd64 版 `cloudflared.exe`。替换该文件时，必须同步更新：

- `vendor/cloudflared/VERSION.txt`
- `vendor/cloudflared/THIRD_PARTY_NOTICES.txt`
- `vendor/cloudflared/licenses/`

请在重新发布前校验 `VERSION.txt` 中记录的 SHA256。
