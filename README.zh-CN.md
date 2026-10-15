# Mahjong Learn · 日麻学习与对战

[English](README.md) | 简体中文

基于 [Agony5757/mahjong](https://github.com/Agony5757/mahjong) 的 C++/Python 日麻环境，增强网页对战、Mortal AI 建议与 Windows 本地安装体验。

## 本分支增强

- 接入兼容 Mortal 检查点的推理与 mjai 事件桥接。
- 在人类回合显示推荐动作及候选概率，并高亮相关牌和按钮。
- 处理立直舍牌、杠候选、吃碰组合等需要进一步选择的动作。
- 切换 3D 风格/平面牌面，调整网页牌桌和操作区布局。
- 提供 Windows 安装、启动与日志脚本。
- AI 动作失败会显式报错并停止对局，不静默换成其他合法动作掩盖错误。

## 安装本分支

请先克隆或下载**本仓库源码**。仅安装 PyPI 上游 `pymahjong` 包，不会获得本 fork 新增的网页功能。

Windows 安装入口为仓库根目录的 `install.bat`，启动入口为 `start.bat`。安装脚本要求 64 位 Python 3.10+，项目包含需要构建的 C++ 组件；编译工具和排错要求见 [安装文档](docs/installation.md) 与 [英文 README 的网页部分](README.md#visualization-web-ui)。

```powershell
.\install.bat
.\start.bat
```

Mortal 建议还需要兼容的模型权重与运行环境，不能仅靠安装脚本或 Python 包推断已经具备。模型配置和手动源码安装以英文说明为准。

## 文档

- [英文 README](README.md)：Python 接口、网页启动、模型与上游研究用法。
- [安装说明](docs/installation.md)：依赖、构建和平台说明。
- [`读我.md`](读我.md)：保留的早期 C++ 引擎说明，可能包含旧路径与旧安装方式。
- [上游 API 文档](https://agony5757.github.io/mahjong/)：引擎接口参考。

## 许可

代码许可见 [LICENSE](LICENSE)。外部模型权重的使用条件请另行遵守其原发布方要求。
