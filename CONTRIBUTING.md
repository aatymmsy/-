# Contributing to Perch

欢迎用中文或英文反馈。优先提交一个具体问题、复现步骤、预期行为和实际行为。提供系统、Node.js 版本与模型协议；请移除 API Key、私人对话、个人路径和配置。

开发环境：Node.js 24+，`npm ci`。提交前运行 `npm run check` 和 `npm test`。界面变化同时运行 `npx playwright install chromium`、`npm run test:ui`，并附上使用虚构数据的截图。

保持零运行时 npm 依赖的轻量结构。修改权限、请求前缀、数据持久化或恢复流程时，增加验证实际行为的回归测试。不要让测试使用真实模型密钥或现有 `data/`。不要通过伪造用量、硬编码成功率或增加无用模型请求来改善指标。

Pull requests should explain the user-visible problem, resulting behavior, and validation. Keep unrelated changes separate. Contributions are distributed under the repository's MPL-2.0 license.
