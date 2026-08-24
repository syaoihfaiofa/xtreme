# 自定义 NuScenes 七类数据的 BEVFusion 训练说明

本文记录 Xtreme1 导出的 NuScenes 格式数据在本仓库中训练 BEVFusion 的完整前置条件、数据准备方式和两阶段训练命令。适用配置为：

`projects/BEVFusion/configs/bevfusion_lidar_voxel0075_custom-nus-7class.py`

以及：

`projects/BEVFusion/configs/bevfusion_lidar-cam_voxel0075_custom-nus-7class.py`

## 背景与范围

数据集具有以下非官方 NuScenes 的特征：

- 4 路鱼眼相机：`CAM_FRONT`、`CAM_RIGHT`、`CAM_BACK`、`CAM_LEFT`；
- LiDAR 文件为 ASCII PCD，字段为 `x y z intensity`；
- 保留 Xtreme1 的 7 个原始标注类别；
- 仅使用 `visibility_token == '4'` 的完全可见目标训练；
- 标注导出为 NuScenes 规定的全局坐标，训练时由转换器变换回 LiDAR 坐标。

该配置不使用官方 NuScenes 十类评估器，因此训练阶段只记录 loss 并保存 checkpoint；不能直接得到官方 NDS 或 mAP。

## 类别

类别顺序必须与 `CustomNuScenesDataset`、转换后的 infos 和训练配置一致：

1. `Car`
2. `Cone`
3. `No Parking Board`
4. `Parking Lock (Locked)`
5. `Person`
6. `Pillar`
7. `Pole`

不要把类别名称改为官方 NuScenes 类别名，也不要重新排序，否则标签索引会失配。

## 前置条件

假设工作目录为 MMDetection3D 根目录：

```bash
cd /PnP/lxzhu/mmdetection3d
```

数据根目录应为 `data/nuscenes`，至少包含：

```text
data/nuscenes/
├── v1.0-trainval/
├── v1.0-test/
├── samples/
│   ├── LIDAR_TOP/
│   ├── CAM_FRONT/
│   ├── CAM_RIGHT/
│   ├── CAM_BACK/
│   └── CAM_LEFT/
└── sweeps/LIDAR_TOP/
```

`v1.0-trainval` 和 `v1.0-test` 中需要包含 NuScenes JSON 元数据表。PCD 文件必须使用 `DATA ascii`，且至少具有 `x y z intensity` 四个字段。加载器会补齐第 5 个时间维：当前帧为 `0`，历史 sweep 使用时间差。

BEVFusion 还需要编译其 CUDA 算子：

```bash
cd /PnP/lxzhu/mmdetection3d
python projects/BEVFusion/setup.py develop
```

若该步骤未成功，训练时通常会报 `bev_pool_ext` 无法导入。

## 推荐训练流程

从 Xtreme1 原始导出到启动训练必须按以下顺序执行：

1. 将标注导出为 `v1.0-mini` 元数据；
2. 将原始 LiDAR 与四路相机文件放入该导出目录；
3. 按时间将每个场景拆分为前 90% 训练、后 10% 测试；
4. 重新生成仅含完全可见目标的 infos 和 GT 数据库；
5. 检查坐标、相机与点云维度；
6. 编译 BEVFusion CUDA 算子并启动训练。

不要跳过第 4 步。`nuscenes_infos_train.pkl` 是当前训练配置实际读取的文件；
重新导出 JSON 或原始传感器文件后仍继续使用旧 pkl 会得到过期数据。
`nuscenes_dbinfos_train.pkl` 与 GT 数据库也应同时更新，以便后续启用对象采样。

## 步骤 1：导出 Xtreme1 标注

Xtreme1 标注导出器会将框中心从 LiDAR/自车局部坐标转换为 NuScenes 所需的全局坐标。示例：

```bash
cd /PnP/lxzhu/lidar_annos/xtreme1/backend

python scripts/nuscenes_export/export_nuscenes.py \
  --src /path/to/xtreme1-export \
  --dst /PnP/lxzhu/mmdetection3d/data/nuscenes \
  --rps /tmp/nuscenes-export-result.json \
  --labels-only true \
  --use-ego-z true
```

该导出器生成 `v1.0-mini/` 元数据。采用 `--labels-only true` 时，
下一步通过原始传感器文件补齐 `samples/`，避免复制标注导出包中不一致的传感器文件。

## 步骤 2：放置原始 LiDAR 与相机文件

原始场景目录需要包含 `lidar_point_cloud/` 和 `camera_image/`。相机后缀
`_0`、`_1`、`_2`、`_3` 依次映射为 `CAM_FRONT`、`CAM_LEFT`、
`CAM_BACK`、`CAM_RIGHT`。

```bash
cd /PnP/lxzhu/mmdetection3d

python tools/misc/place_raw_samples.py \
  --input-root /path/to/raw-scenes \
  --dataroot data/nuscenes \
  --version v1.0-mini \
  --link
```

`--link` 会创建硬链接，要求源数据和 `data/nuscenes` 位于同一文件系统。
如果不满足该条件，移除 `--link` 以复制文件。命令输出的 `missing` 必须为 `0`；
否则不得继续转换。

## 步骤 3：拆分训练集与测试集

导出器本身只生成 `v1.0-mini`。以下命令按每个场景的时间顺序保留前
90% 样本作为训练集，并将后 10% 作为测试集：

```bash
cd /PnP/lxzhu/mmdetection3d

python tools/misc/split_nuscenes_tail_test.py \
  --dataroot data/nuscenes \
  --source-version v1.0-mini \
  --test-ratio 0.1
```

该命令生成 `v1.0-trainval/` 与 `v1.0-test/`，并将原始
`v1.0-mini/` 重命名为 `v1.0-mini.unsplit-backup/`。脚本不会覆盖已有
`v1.0-test/`；若要重新拆分，应先确认旧目录不再需要后再手动清理。

## 步骤 4：生成训练 infos 与 GT 数据库

每次重新导出标注、修改类别或修改可见性规则后，都必须重新生成 infos 和 GT 数据库：

```bash
cd /PnP/lxzhu/mmdetection3d

python tools/create_data.py nuscenes \
  --root-path data/nuscenes \
  --version v1.0 \
  --out-dir data/nuscenes \
  --extra-tag nuscenes \
  --max-sweeps 10
```

该命令会生成：

```text
data/nuscenes/
├── nuscenes_infos_train.pkl
├── nuscenes_infos_val.pkl
├── nuscenes_infos_test.pkl
├── nuscenes_dbinfos_train.pkl
└── nuscenes_gt_database/
```

转换器在生成 `nuscenes_infos_train.pkl` 前只保留 `visibility_token == '4'` 的标注。因此，`ObjectNameFilter` 只负责类别过滤，不能替代可见性过滤。若继续使用旧的 pkl，遮挡目标仍可能被训练。

LiDAR-only 配置启用了 `ObjectSample`，会使用 `nuscenes_gt_database/` 进行
对象采样；LiDAR-camera 融合配置未启用该增强，直接读取
`nuscenes_infos_train.pkl`。

## 步骤 5：检查数据

确认转换结果中的相机和点云维度：

```bash
cd /PnP/lxzhu/mmdetection3d

python -c "import pickle; from pathlib import Path; data = pickle.loads(Path('data/nuscenes/nuscenes_infos_train.pkl').read_bytes()); info = data['data_list'][0]; print(sorted(info['images'])); print(info['lidar_points']['num_pts_feats'])"
```

预期输出中的相机列表为：

```text
['CAM_BACK', 'CAM_FRONT', 'CAM_LEFT', 'CAM_RIGHT']
```

点云特征数应为 `5`。

导出前也建议随机检查标注可视化：

```bash
cd /PnP/lxzhu/mmdetection3d

python tools/misc/visualize_nuscense.py \
  --data-root data/nuscenes \
  --version v1.0-trainval \
  --mode all \
  --sample-index 0 \
  --bev-range -21 21 -21 21 \
  --output-dir outputs/vis
```

生成图片保存在 `outputs/vis/`。应检查框与点云是否对齐，以及四张相机图是否都有投影结果。

## 步骤 6：先训练 LiDAR-only 模型

先训练 LiDAR-only 配置，让体素编码器、LiDAR BEV backbone 和 7 类检测头
在本数据集上收敛：

```bash
cd /PnP/lxzhu/mmdetection3d

GPU_IDS=0,1,2,3,4,5,6,7 \
  bash tools/train_bevfusion_lidar_custom_nus_7class.sh
```

训练脚本会把 `GPU_IDS` 设置为 `CUDA_VISIBLE_DEVICES`，并按其中 GPU 数量
自动启动对应数量的进程。例如，使用物理 GPU 2 和 5：

```bash
cd /PnP/lxzhu/mmdetection3d

GPU_IDS=2,5 bash tools/train_bevfusion_lidar_custom_nus_7class.sh
```

未指定 `GPU_IDS` 时默认使用 GPU 0。训练完成后选择
`work_dirs/bevfusion_lidar_custom_nus_7class/epoch_20.pth` 作为下一步的
`LIDAR_PRETRAINED_CHECKPOINT`。该配置默认训练 20 个 epoch。

## 步骤 7：训练 LiDAR-camera 融合模型

融合训练加载上一步的 LiDAR checkpoint，并为 Swin 图像 backbone 提供预训练
权重：

```bash
cd /PnP/lxzhu/mmdetection3d

LIDAR_PRETRAINED_CHECKPOINT=work_dirs/bevfusion_lidar_custom_nus_7class/epoch_20.pth
IMAGE_PRETRAINED_BACKBONE=/path/to/swin-tiny-pretrained.pth

bash tools/dist_train.sh \
  projects/BEVFusion/configs/bevfusion_lidar-cam_voxel0075_custom-nus-7class.py \
  8 \
  --work-dir work_dirs/bevfusion_lidar-cam_custom_nus_7class \
  --amp \
  --cfg-options \
    load_from=${LIDAR_PRETRAINED_CHECKPOINT} \
    model.img_backbone.init_cfg.checkpoint=${IMAGE_PRETRAINED_BACKBONE}
```

`load_from` 会恢复 LiDAR 分支和检测头中名称、形状相同的参数；Swin 预训练
权重初始化图像分支。`LIDAR_PRETRAINED_CHECKPOINT` 必须来自步骤 6，且类别顺序、
检测范围和体素尺寸必须保持一致。不要使用官方 NuScenes 十类 LiDAR checkpoint。

融合训练日志与 checkpoint 保存到
`work_dirs/bevfusion_lidar-cam_custom_nus_7class/`。该配置默认训练 6 个 epoch，
并禁用了验证 dataloader 和官方 `NuScenesMetric`。

## 配置关键参数

| 参数 | 当前值 | 含义 |
| --- | --- | --- |
| `num_views` | `4` | 每帧相机数量，必须与 infos 中的四路相机一致。 |
| `point_cloud_range` | `[-21, -21, -5, 21, 21, 4]` | 训练、体素化和检测后处理共用的 LiDAR 坐标范围，单位为米。 |
| `voxel_size` | `[0.075, 0.075, 0.2]` | XY 平面和高度方向的体素大小，单位为米。 |
| `sweeps_num` | `9` | 除当前帧外加载的历史 sweep 数量。 |
| `num_classes` | `7` | 自定义类别数量。 |
| `use_valid_flag` | `False` | 自定义数据的 `num_lidar_pts` 不是官方统计值，不能据此过滤标注。 |

如需扩大检测范围，必须同步修改以下配置项：`point_cloud_range`、`voxelize_cfg.point_cloud_range`、`sparse_shape`、`view_transform.xbound/ybound/zbound`、`bbox_head.train_cfg`、`bbox_head.test_cfg` 与 `bbox_coder.post_center_range`。仅改一个范围会造成 LiDAR BEV 与图像 BEV 特征尺寸不一致。

## 常见问题

### `ImportError: cannot import name 'bev_pool_ext'`

原因：BEVFusion CUDA 算子未编译或当前 Python 环境未加载编译结果。

处理：

```bash
cd /PnP/lxzhu/mmdetection3d
python projects/BEVFusion/setup.py develop
```

完成后重新启动终端，再运行训练命令。

### 训练中出现相机数量或矩阵维度错误

原因：数据中不是四路相机，或相机通道名与配置不一致。

处理：运行“检查数据”中的命令确认相机列表。若数据通道变化，需要同时更新 `data_prefix` 和两个 pipeline 中的 `num_views`。

### pkl 中仍有遮挡目标

原因：使用了可见性过滤修改前生成的旧 infos 或 GT 数据库。

处理：确认 `sample_annotation.json` 中存在 `visibility_token`，然后重新执行“生成训练 infos 与 GT 数据库”命令；不要只重新创建 GT 数据库。

### 框在 BEV 中偏离点云

原因：导出器将局部 LiDAR 坐标错误写入了 NuScenes 的全局标注字段，或 infos 来自修复前的导出。

处理：重新导出数据并重新生成 infos。NuScenes 的 `sample_annotation.translation` 必须是全局坐标，转换器会基于 `ego_pose` 和 `calibrated_sensor` 转回 LiDAR 坐标。

## 限制与后续工作

- 当前不支持官方 NuScenes 十类指标；需要实现与这 7 类 taxonomy 匹配的评估器后才能报告可靠的 mAP。
- 相机为鱼眼时，BEVFusion 默认投影模型是否与实际相机内参完全匹配需要以训练样本可视化和 loss 曲线进一步验证。
- 若数据采集范围或标注范围显著超过 21 米，应先统计框中心和尺寸分布，再按“配置关键参数”所列项目整体扩大范围。
