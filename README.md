# Obsidian → Google Drive 单向上传

Windows 桌面版 Obsidian 插件。打开仓库时检查并补传本地文件；之后保存笔记或附件时自动上传到 Google Drive 的 `MyDrive/Obsidian`。关闭 Obsidian 后不运行后台服务。

## 工作方式

- 首次启用、每次打开仓库或手动执行“立即检查并上传整个仓库”时，检查整个仓库；相同内容会跳过。
- 平时通过 Obsidian 文件事件只上传新增或修改的文件。连续保存默认等待 5 秒后合并处理；上传期间的新修改会排队。
- 状态栏显示进度条和已处理文件数。只有出现“Drive：已完成，可以关闭”时，本轮上传及排队的修改才已结束。
- 使用 `rclone copy --checksum`，只从本地上传到云端。本地删除或重命名文件不会删除云端旧文件，云端改动也不会下载回本地。
- 默认排除 `.obsidian`（或自定义配置目录）、`.git`、`.trash`。网络失败后最多重试 3 次，命令面板可查看最近错误。

## 准备

需要 Windows 桌面版 Obsidian（至少 1.5.0）、[rclone for Windows](https://rclone.org/downloads/) 和一个 Google 账号。插件运行本身无需安装 Node.js 或 Python。

1. 在 Google Cloud 创建项目，启用 Google Drive API，配置 OAuth 同意界面，并创建**桌面应用** OAuth 客户端。按 [rclone 官方说明](https://rclone.org/drive/#making-your-own-client-id)获取 Client ID 和 Client Secret。若应用保持“External / Testing”，把自己的账号加入测试用户；Google 的此类刷新令牌通常在 7 天后过期，届时可能需要重新授权。参见 [Google OAuth 说明](https://developers.google.com/identity/protocols/oauth2/#expiration)。
2. 解压 `rclone.exe` 到自选目录。在 PowerShell 运行 `& 'C:\Tools\rclone\rclone.exe' config`，将示例路径替换为实际路径。
3. 创建名为 `gdrive` 的 Remote，类型选 `drive`，填写自己的 Client ID/Secret，权限选 `drive`，按浏览器提示授权。Shared Drive 选 No，`root_folder_id` 留空，Remote 根目录保持 MyDrive。`drive` 是整个 Drive 的读写授权；插件代码只把文件复制到该 Remote 下的 `Obsidian` 目录。
4. 检查授权：`& 'C:\Tools\rclone\rclone.exe' about gdrive:`。如果使用自定义 rclone 配置文件，命令加上 `--config '你的配置文件绝对路径'`。

不要将 OAuth 客户端 JSON、`rclone.conf`、令牌或 Obsidian 插件的 `data.json` 提交到 GitHub。它们只保存在本机。

## 安装

下载此仓库，把 `manifest.json`、`main.js`、`sync-core.js` 放到同一个目录：

```text
<你的 Obsidian 仓库>\.obsidian\plugins\obsidian-gdrive-on-open\
```

重新启动 Obsidian，进入“设置 → 第三方插件”，启用“Google Drive 单向上传”。然后在插件设置中填写：

- `rclone.exe` 的绝对路径；
- Remote 名称，默认 `gdrive`；
- 可选的 rclone 配置文件绝对路径；留空使用 rclone 默认配置。

本地仓库路径会自动识别。确认设置后打开“启用自动上传”；需要修改路径时，点击“应用并检查”。新建或修改一篇测试笔记，等右下角显示“Drive：已完成，可以关闭”，再到 `MyDrive/Obsidian` 查看。

## 常见问题

- **一直显示“扫描中/上传中”**：首次或重新打开仓库时要检查所有文件。底部进度条会更新；上传期间不要关闭 Obsidian。
- **“上传失败”**：在命令面板运行“查看最近同步错误”，检查网络、rclone 路径、Remote 和授权。也可以手动运行“立即检查并上传整个仓库”。
- **Google 授权过期**：运行 `& 'C:\Tools\rclone\rclone.exe' config reconnect gdrive:`，然后在插件中重新检查。
- **云端仍有本地已删除的文件**：这是单向 `copy` 的预期行为，插件不会执行云端删除。

开发测试可在仓库根目录运行 `npm test`（需要 Node.js；插件用户无需运行）。

参考：[rclone Google Drive 配置](https://rclone.org/drive/)、[rclone copy](https://rclone.org/commands/rclone_copy/)、[Obsidian 插件 API](https://github.com/obsidianmd/obsidian-api)。
