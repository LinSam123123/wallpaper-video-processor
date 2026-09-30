# Contributing

感谢你愿意改进 AI 视频壁纸处理器。

## 开始之前

- 使用 Windows 10/11 x64、Node.js 22.18+ 和 npm。
- 不要提交视频、模型、运行时、缓存、Release 二进制、个人绝对路径或访问凭据。
- 行为改动应保持 JobSpec v1-v4 兼容；除非 Issue 已明确讨论，不要改变默认输出语义。
- 第三方工具必须固定版本、下载地址、许可证和 SHA-256。

## 本地验证

```powershell
npm ci
npm test
npm run typecheck --workspace @wallpaper-video/desktop
npm run build
npm run skill:prepare
git diff --check
```

运行 `npm run skill:prepare` 后，`skill/make-video-wallpaper/scripts/wallpaper-video-cli.mjs` 不应出现未提交差异。

## Pull Request

- 一个 PR 聚焦一个问题，并说明用户可见行为、风险和验证结果。
- Core、CLI 或 JobSpec 改动需要对应测试；桌面交互改动应补充组件测试。
- 不要把真实个人素材作为测试夹具。请使用最小、可公开、许可清晰的合成素材或纯逻辑测试。
- UI 改动请附实际截图，并确认常见桌面尺寸下没有遮挡或文本溢出。

## 报告问题

Bug Issue 中请提供版本、Windows/GPU 信息、复现步骤和已脱敏日志。安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开披露。
