# HRIR 数据（assets/hrir）

这个目录就是「多套 HRIR 共存」的入口：**放几个 `.sofa` 就有几个可选数据集**，
每段片段都能在「片段属性 → 空间（双耳）→ HRIR」里单独选，也可以跟随默认。
切换的差别只在那份数据，混音/播放/关键帧全走同一条链路。

## 目录里现在有哪几套

| 文件 | 内容 | 用途 |
|---|---|---|
| `MIT_KEMAR_normal_pinna.sofa` | KEMAR，710 方向，**单距离 1.4m** | 默认（一般叙述、远场） |
| `KU100_near.npz` | Neumann KU100，**4 层 0.5/0.75/1.0/1.5m**，Lebedev 2702 点全向 | 需要距离变化 + 仰角 |
| `KU100_near_circ.npz` | Neumann KU100，**5 层 0.25~1.5m**，水平圈 1° | **贴耳 / ASMR**（真测了 25cm） |
| （内置）`sphere` | 球头解析模型 | 永远可用的兜底 |

三套可以逐片段切换，也可以 A/B 对比。

## 现在用的是哪一份

`MIT_KEMAR_normal_pinna.sofa`
— MIT Media Lab（Gardner & Martin, 1995）KEMAR 人工头，**710 个方向 / 44.1 kHz / 512 抽头 / 单距离 1.4m**。

文件里的授权声明（`License` 属性原文）：

> This HRTF data is provided without any usage restrictions. It is requested that you
> cite Gardner and Martin (1995) when using this data for research or commercial applications.

即：**没有使用限制**，学术或商业用途都只要求引用。建议在产品的「关于/致谢」里带一句：

> HRTF data: MIT KEMAR (Gardner & Martin, 1995), via the SOFA database.

## KU100 近场那两套是怎么来的

原始下载是 TH Köln 的「Spherical Near-Field HRIR Compilation of the Neumann KU100」，
包含 `NFHRIR_CIRC360_SOFA.zip`（每 25/50/75/100/150cm 一个 .sofa，水平 1°）和
`NFHRIR_L2702_SOFA.zip`（50/75/100/150cm，Lebedev 2702 点全向）。
**每个距离是单独一个文件**，而我们的查表需要「一套数据里带距离维」，所以用
`hrir.pack()` 合并打包成 `.npz`：

```python
import hrir
hrir.pack([(路径, 距离_米), ...], "assets/hrir/KU100_near.npz", name="KU100 near-field")
```

打包时做两件事：
1. 重采样到 44.1k（原始 48k / 128 抽头 → 118 抽头）；
2. **每层按「正前」归一到相同电平** —— 近场数据本身方向性极强（正前弱、侧向强），
   只按全向中位数归一的话「正前方越近越轻」，方向是反的。归一后距离响度交给
   `dist_gain`，「近处侧向更强」这个真实方向性保留。

授权：文件里的 `License` 属性写的是 **CC 3.0 BY-SA**（早前文档里写的 4.0 是论文口径，
以下载包里的为准）。署名 + 相同方式共享；商用前建议过一遍法务。

## 距离维（贴耳效果的关键）

`hrir.py` 读 SOFA 的 `SourcePosition` 第三列（半径，米）：

- **单层**（KEMAR 这种 1.4m）：`dist` 只影响增益和近似补偿（`NearField`：低频抬升 + 远耳遮挡增强）；
- **多层**（近场数据集，0.25/0.5/0.75/1.0/1.5 这种）：查表时按 log 距离取上下两层再插值，
  0.2~1m 的贴耳是**实测**的，不再靠近似。

UI 上会直说：多层集显示「近场 0.25~1.5m」，单层集显示「1.4m 远场」并提示「≤1m 是近似补偿」。

## 想加近场数据集（做 ASMR / 贴耳）

找一套带多距离层的 SOFA（常见来源）：

| 数据集 | 距离 | 说明 |
|---|---|---|
| ~~TH Köln KU100 near-field~~ | — | **已经接进来了**（见上），不用再下 |
| KEMAR near-field（Li et al., Zenodo 7626148） | 0.2~1.1m，1cm 分辨率 | **暂时不需要**：KU100 已经覆盖 0.25~1.5m；除非要 1cm 级距离精度或想跟默认那套 KEMAR 同头型 |
| BEM 近场（Salvador et al.） | 0.1~1.0m | 仿真数据，公开样本较小 |

做法：**把 `.sofa` 丢进这个目录**，重启服务即可。`profiles()` 会自动扫出来，
前端下拉里多一项，不需要改代码。

体积建议：原始近场集动辄几百 MB，建议先抽稀（方位 5°、仰角 5°、距离取 0.2/0.3/0.5/0.75/1.0/1.4、
抽头降到 256）再放进来，通常 10~30MB 就够；`hrir.py` 的 `_CACHE` 按文件缓存，不会反复读盘。

⚠️ 授权：KU100 那套是 CC BY-SA 4.0 —— 只随应用使用一般需要署名，**分发改过的 IR 文件**要同协议；
商用前建议先过法务。KEMAR 原始那套没有限制。

## 换成 SONICOM / 别家

同样只要丢文件，或用环境变量 `INDEXTTS_HRIR=路径` 指定默认那一份。
加载器支持任意 `SOFAConventions = SimpleFreeFieldHRIR`，球坐标/笛卡尔坐标、非规则网格都能读
（方向用球面最近 3 邻反距离加权，不能用规则网格双线性）。

## 目录里的文件

- `*.sofa`：实测 HRIR，排序后第一个是默认（也可用 `INDEXTTS_HRIR` 覆盖）；
- 解析需要 `h5py`（SOFA 就是 HDF5），已放在仓库根的 `_vendor/` 里；
- 没有数据或没有 h5py 时，`get_set()` 返回 `None`，混音自动回退到
  `timeline_api._Binaural` 的球头近似 —— 功能不会坏，只是音色和前后/近场感差一档。
  前端下拉里的 `sphere` 就是手动指定这个回退。
