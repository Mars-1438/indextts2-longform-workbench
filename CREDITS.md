# 致谢与三方素材清单

本项目的「声音能力」来自别人，「工作台」这一层才是本仓库的内容。下面按重要程度列清楚。

---

## 1. 十一君Jun · IndexTTS2.0 超级优化整合包 V3

- 作者：**十一君Jun**（哔哩哔哩）
- 作品：**「IndexTTS2.0 超级优化整合包 V3」**
- 关系：本工作台是**装在这个整合包里的扩展**。整合包提供 Python 运行时、IndexTTS2 模型、推理接口、
  音色示例与主界面；本仓库提供台本编辑器、时间轴、混音/工程导出与教程。
  **本仓库不包含整合包本体、模型权重、运行时环境。**
- 下载（按作者提供的信息整理，请以作者发布页为准）：

  | 网盘 | 链接 | 备注 |
  |---|---|---|
  | 夸克网盘 | <https://pan.quark.cn/s/9cd4d7d5dfa9> | |
  | 百度网盘 | <https://pan.baidu.com/s/1dTd34exfqdGWtVPTD566fQ?pwd=2333> | 提取码 `2333` |
  | 123 网盘 | <https://1833900014.share.123pan.cn/123pan/nkiATd-LtDpH> | |

> 如果整合包更新了版本或换了链接，以作者的最新发布为准；本仓库只做指路，不转存、不二次分发整合包。

---

## 2. IndexTTS2（语音合成模型）

- 项目：**IndexTTS2**，由哔哩哔哩（Bilibili）开源。
- 用途：本工作台调用整合包里已经部署好的 IndexTTS2 推理接口来生成语音，**不修改、不重分发**模型代码与权重。
- 许可：请以原项目仓库的 LICENSE 为准。若原项目限制商用，本工作台同样不能用于商用场景。

---

## 3. Demucs（人声分离，可选）

- 项目：**Demucs**（Meta AI Research），`htdemucs` 模型。
- 用途：素材导入台里的「去伴奏 / 只留人声」。
- 许可：代码为 MIT；**预训练权重的许可请以官方仓库说明为准**（不同版本可能不同）。
- 分发策略：本仓库**不包含**权重文件。补丁包里带了一份离线权重方便使用；
  从源码安装时，第一次运行会自动下载，或自行放置到 `vendor2/torch/hub/checkpoints/`。

---

## 4. HRIR 数据（空间音频）

`assets/hrir/` 下不同文件来源与授权不同，**逐个列出**：

| 文件 | 来源 | 授权 | 说明 |
|---|---|---|---|
| `MIT_KEMAR_normal_pinna.sofa` | MIT Media Lab，KEMAR 人工头（Gardner & Martin, 1995），经 SOFA 数据库分发 | 文件内声明「**无使用限制**」，仅要求引用 | 710 方向 / 44.1kHz / 512 抽头 / 单距离 1.4m |
| `KU100_near.npz` | TH Köln，「Spherical Near-Field HRIR Compilation of the Neumann KU100」，由本项目用 `hrir.pack()` 合并重采样 | 原数据 **CC BY-SA**（以下载包内的 License 属性为准） | 4 层距离（0.5/0.75/1.0/1.5m），Lebedev 2702 点 |
| `KU100_near_circ.npz` | 同上（水平 1° 圈，5 层 0.25~1.5m） | 同上 | 贴耳 / ASMR 用，真测了 25cm |

引用建议（放在产品的关于/致谢里）：

> HRTF data: MIT KEMAR (Gardner & Martin, 1995), via the SOFA database.
> Near-field HRIR: Neumann KU100 spherical near-field HRIR compilation, TH Köln (CC BY-SA).

⚠️ 因为 KU100 那两份是 **CC BY-SA（署名 + 相同方式共享）**，它们**不属于**本仓库的 MIT 许可范围：
- 只是随软件一起使用（不修改）→ 署名即可；
- 如果你**修改/再分发**了这些 IR 文件本身 → 需要按 CC BY-SA 共享；
- 商用前建议先过一遍法务。若不想处理这些约束，删掉这两个 `.npz` 即可，空间音频会自动回退到 KEMAR 或球头模型。

---

## 5. FFmpeg（视频抽音频）

- 用途：导入台里把视频抽成 wav。
- 分发策略：**不放进本仓库**（体积大、且构建版本许可不同）。补丁包里带的是 `essentials_build`；
  从源码安装时，把任意可用的 `ffmpeg.exe` 放进 `bin\`，或在导入台里手动指定路径。
- 许可：FFmpeg 主体为 LGPL/GPL（取决于编译选项），分发二进制时请一并提供其许可文本与源码获取方式。
  本仓库的 `tools/fetch_ffmpeg.ps1` 只是下载脚本，不包含二进制。

---

## 6. 字体与图标

前端只使用系统字体（`Segoe UI` / `Microsoft YaHei` / `PingFang SC` 等）与 emoji，不内嵌任何商业字体或图标库。
