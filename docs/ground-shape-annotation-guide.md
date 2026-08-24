# 地面形状标注规范（停车位 / Curb-Wall 等）

## 背景与目的

Xtreme1 在 LiDAR Fusion 数据集中扩展了两类专用地面标注工具，用于表达停车场场景中的**停车位 footprint** 和**路沿 / 墙体 / 围栏等线性边界**。它们与常规 3D 框（`CUBOID`）不同，几何类型分别为 `GROUND_POLYGON`（四边形）和 `GROUND_POLYLINE`（折线），并在开启同步模式（`syncMode`）后支持跨帧静态传播。

本文档基于当前代码实现整理标注方式、几何规范、数据格式与同步行为，供标注员、审核员和开发人员统一参考。

## 范围与假设

### 适用范围

- 数据集类型：`LIDAR_FUSION`
- 标注工具：`pc-tool` 点云编辑器
- 目标类别：
  - 工具类型 `PARKING_SLOT` → 几何 `GROUND_POLYGON`（典型：停车位）
  - 工具类型 `CURB_WALL` → 几何 `GROUND_POLYLINE`（典型：curb、wall、fence 及车辆/护栏边缘线）

### 前提条件

- 场景帧具备完整位姿（pose），否则跨帧同步会跳过该帧
- 跨帧同步需数据集开启 **同步标注模式**（`syncMode = true`）
- LiDAR 局部坐标系地面平面为 `z = ground.plane.constant`（创建时新点落在此平面上）
- 同步半径默认 **12 m**（`syncDistance`，可在属性面板调整）

### 不在本文范围

- 普通 3D 框（`CUBOID`）标注规范
- 图像 2D 矩形 / 2D 框的独立标注流程（仅说明 3D 地面形状的 2D 投影）
- 业务层面对「curb 与 wall 如何区分」的语义细则（由 Ontology / 数据集类别配置决定，代码层不硬编码）

---

## 相关目录与文件结构

| 路径 | 作用 |
| --- | --- |
| `frontend/pc-tool/src/packages/pc-editor/common/ActionManager/action/create.ts` | 停车位（`P`）、地面折线（`L`）创建逻辑 |
| `frontend/pc-tool/src/packages/pc-render/objects/GroundPolygon.ts` | 停车位四边形对象、开口方向 |
| `frontend/pc-tool/src/packages/pc-render/objects/GroundPolyline.ts` | 地面折线对象 |
| `frontend/pc-tool/src/packages/pc-render/renderView/SideRenderView.ts` | 三视图顶点拖动手柄 |
| `frontend/pc-tool/src/packages/pc-editor/hack.ts` | 主视图 / 侧视图 / 图像视图编辑回调 |
| `frontend/pc-tool/src/common/Editor.ts` | 手动同步（`Ctrl+Y` / `Sync Now`） |
| `backend/.../TrackSyncUseCase.java` | 停车位与折线的跨帧同步算法 |
| `backend/.../entity/enums/ToolTypeEnum.java` | `PARKING_SLOT`、`CURB_WALL` 工具类型定义 |
| `deploy/image-keypoint-lifted-detection/config/polyline-labels.json` | 模型支持的折线类别列表 |

---

## 类别与工具类型

在 Ontology 或数据集类别管理中，3D LiDAR 类别可选以下工具类型（见 `formSchemas.tsx`）：

| 工具类型 | 显示名 | 几何类型 | 典型类别 |
| --- | --- | --- | --- |
| `PARKING_SLOT` | Parking Slot | `GROUND_POLYGON` | 停车位 |
| `CURB_WALL` | Curb / Wall | `GROUND_POLYLINE` | curb、wall、fence 等 |

### 模型预置折线类别

`Image Keypoint-Lifted Detection` 模型支持以下 6 个折线类别（`polyline-labels.json`），推理结果为 `GROUND_POLYLINE` 候选，需人工确认后保存：

- `curb`
- `wall`
- `fence`
- `vehicle_long_side_edge`
- `vehicle_short_side_edge`
- `barrier_side_edge`

> **说明**：上述名称是模型与 Ontology 的类别 code/name，具体业务含义（例如 curb 与 wall 的边界判定）需在项目 Ontology 文档或标注手册中另行约定；系统只约束几何与工具类型。

---

## 一、停车位标注（`GROUND_POLYGON`）

### 1.1 几何定义

停车位是一个**四顶点**地面 footprint，顶点顺序固定：

| 索引 | 含义 | 说明 |
| --- | --- | --- |
| P0 | 左前（left-front） | 开口侧左端 |
| P1 | 左后（left-rear） | 车位内侧左端 |
| P2 | 右后（right-rear） | 车位内侧右端 |
| P3 | 右前（right-front） | 开口侧右端 |

- **开口边（parking entrance）**：P3 → P0（闭合边）
- **方向箭头**：从后侧中心 `(P1+P2)/2` 指向前侧开口中心 `(P0+P3)/2`，表示车辆进入方向
- 开口边以青色高亮显示（`#00e5ff`）

### 1.2 标注操作

**快捷键**：`P`

**步骤**：

1. 在类别列表中选择 `PARKING_SLOT` 类型类别（或先画再改类）
2. 在主视图依次点击：**左前 → 左后 → 右后 → 右前**
3. 系统提示：`停车位：依次点击左前、左后、右后、右前`
4. 四点点击完成后自动创建对象；创建时各点 `z` 投影到地面平面
5. 在属性面板选择最终类别；确认几何与类别后，按 **`Ctrl+Y`**（Mac：`Cmd+Y`）或点击 **Sync Now** 触发跨帧同步

### 1.3 有效性校验

创建时若校验失败，会提示：`停车位四点无效：请按左前、左后、右后、右前点击，且不能自交`

| 规则 | 阈值 / 条件 |
| --- | --- |
| 顶点数量 | 必须恰好 4 个 |
| 边长 | 任意相邻边长度 ≥ **0.1 m** |
| 面积 | 有符号面积绝对值 ≥ **0.1**（非退化） |
| 自交 | 边 (P0-P1) 与 (P2-P3)、(P1-P2) 与 (P3-P0) 不得相交 |

### 1.4 编辑方式

| 视图 | 能力 |
| --- | --- |
| 三视图（SideRenderView） | 选中后可拖顶点手柄；拖动在侧视相机平面内进行；四边形需保持 `isValidPoints` |
| 主视图 | 当前**不支持**创建阶段以外的专用顶点手柄（与 curb/wall 不同） |
| 图像 2D 投影 | 自动投影为 `2D_GROUND_POLYGON`；可在图像上拖动投影点，回写对应 3D 顶点（保持原 `z`） |

### 1.5 对象属性

- `motionMode`：`STATIC`（静态）
- `type`：`GROUND_POLYGON`
- `parkingOpeningEdge`：`P3_P0`（后端同步时写入）
- 需具备 `trackId` 才能跨帧同步

---

## 二、Curb / Wall 等折线标注（`GROUND_POLYLINE`）

### 2.1 几何定义

地面折线由 **≥ 2 个**三维顶点顺序连接而成，用于表达路沿、矮墙、围栏、车辆侧边、护栏侧边等线性结构。

- 对象类型：`GROUND_POLYLINE`
- 工具类型：`CURB_WALL`
- 折线**不闭合**（与停车位四边形不同）
- 每个顶点存储完整 `(x, y, z)`

### 2.2 标注操作

**快捷键**：`L`

**步骤**：

1. 选择 `CURB_WALL` 类型类别
2. 在主视图进入画线模式；提示：`地面折线：左键连续添加点，双击结束`
3. **左键**：依次添加顶点（创建时 `z` 落在地面平面）
4. **双击**：结束画线（至少 2 点）
5. 画线过程中可缩放 / 平移 / 旋转主视图（见 2.3）
6. 创建完成后，拖动手柄将顶点吸附到点云，修正高度与位置
7. 确认后 **`Ctrl+Y`** 同步到其他帧

**结束条件（curb/wall 增强交互）**：

| 操作 | 行为 |
| --- | --- |
| 左键单击 | 添加顶点 |
| 双击 | 结束（≥ 2 点） |
| 滚轮 | 缩放点云 |
| 中键拖动 | 旋转相机 |
| 右键拖动（移动 > 4 px） | 平移相机，不结束 |
| 右键单击（几乎不动） | 结束画线 |

### 2.3 创建后编辑

| 视图 | 行为 |
| --- | --- |
| 主视图 | 选中折线后显示圆形顶点手柄；拖动时射线吸附最近激光点（阈值 **0.5 m**），更新该点 **X/Y/Z**；无点可吸则保持不动 |
| 三视图 | 拖顶点在侧视平面内移动；调用 `update-ground-polyline-points`，支持撤销 |
| 图像 2D 投影 | 投影为 `2D_GROUND_POLYLINE`；图像上编辑回写 3D 点 |

> 创建阶段点在地面上；**斜坡、高路沿**等需在创建完成后通过主视图手柄贴点云修正 Z。

### 2.4 有效性校验

| 规则 | 条件 |
| --- | --- |
| 最少顶点 | ≥ **2** |
| 失败提示 | `地面折线至少需要两个点` |

### 2.5 对象属性

- `motionMode`：`STATIC`
- `type`：`GROUND_POLYLINE`
- 静态指**位置不变**，不指长度冻结；后续帧可接长或改短

---

## 三、跨帧同步规范

同步仅在数据集 `syncMode = true` 时生效。触发方式：

- 选中带 `trackId` 的停车位或折线
- **`Ctrl+Y`**（Mac：`Cmd+Y`）或属性面板 **Sync Now**
- 会先保存相关帧，再调用后端同步接口，最后从服务端刷新各帧结果

默认参数（可在属性面板修改）：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `syncDistance` | 12 m | 同步有效半径（BEV 平面，以点云原点 `(0,0)` 为圆心） |
| `motionMode` | `STATIC` | 地面形状固定为静态 |

### 3.1 停车位同步（`syncGroundPolygon`）

```
源帧四顶点 → 世界坐标 → 各目标帧局部坐标 → 写入
```

- 四角 footprint 作为**整体刚体**传播到每位姿完整的目标帧
- 若该帧中 footprint 到原点最近距离 **> syncDistance**，则该帧**删除**同 track 对象
- 最近距离计算：顶点到原点距离 + 各边到原点距离的最小值（BEV，不含 Z）
- 始终写入 `parkingOpeningEdge = P3_P0`

**标注含义**：一个停车位 track 在所有可见帧中保持同一世界位置；车驶离后超出半径的帧不再显示该停车位。

### 3.2 Curb / Wall 折线同步（`syncGroundPolyline`）

折线同步比停车位复杂，支持**分段标注 + 跨帧接长**：

```
源折线 → 世界坐标
       → 与目标帧已有同 track 折线合并（源覆盖重叠段，保留翼段）
       → 转到目标帧局部坐标
       → 以 (0,0) 为圆心、syncDistance 为半径裁剪
       → 写入或删除
```

**关键规则**：

| 场景 | 行为 |
| --- | --- |
| 线段在圆内 | 保留 |
| 线段在圆外 | 裁掉；若穿过圆，在交点处插入裁剪点 |
| 圆内出现多段不相连折线 | 只保留距原点最近的一段 |
| 有效点 < 2 | 该帧删除同 track 折线 |
| 后续帧接长 | 新顶点进入世界并集，落入某帧圆内的部分会出现在该帧 |
| 已出范围的旧段 | 不会从其他帧删除；合并时作为翼段保留 |

**标注建议**：

1. 在当前帧只标点云范围内可见的一段
2. `Ctrl+Y` 同步
3. 切到下一帧，在可见范围内**接长**折线后再保存并同步
4. 不要期望同步「发明」从未标注过的新几何

---

## 四、数据格式

保存到后端的标注对象（`classAttributes`）核心字段如下。

### 4.1 通用字段

```json
{
  "type": "GROUND_POLYGON | GROUND_POLYLINE",
  "trackId": "<uuid>",
  "motionMode": "STATIC",
  "syncDistance": 12.0,
  "classId": "<dataset class id>",
  "contour": {
    "points": [
      { "x": 1.0, "y": 2.0, "z": 0.0 }
    ]
  }
}
```

### 4.2 停车位附加字段

```json
{
  "type": "GROUND_POLYGON",
  "parkingOpeningEdge": "P3_P0",
  "contour": {
    "points": [
      { "x": ..., "y": ..., "z": ... },
      { "x": ..., "y": ..., "z": ... },
      { "x": ..., "y": ..., "z": ... },
      { "x": ..., "y": ..., "z": ... }
    ]
  }
}
```

顶点顺序：`[P0 左前, P1 左后, P2 右后, P3 右前]`

### 4.3 折线

```json
{
  "type": "GROUND_POLYLINE",
  "contour": {
    "points": [
      { "x": ..., "y": ..., "z": ... },
      { "x": ..., "y": ..., "z": ... }
    ]
  }
}
```

点数 ≥ 2，顺序即折线走向。

### 4.4 2D 投影

3D 地面形状可投影到 Fusion 相机图像：

| 3D 类型 | 2D 投影类型 |
| --- | --- |
| `GROUND_POLYGON` | `2D_GROUND_POLYGON` |
| `GROUND_POLYLINE` | `2D_GROUND_POLYLINE` |

投影对象 `userData.isProjection = true`，并记录 `projectedFromId` 指向源 3D 对象。

---

## 五、模型辅助标注

### 5.1 Image Keypoint-Lifted Detection

- 从 Fusion 相机图像检测目标，将像素点反投影到 LiDAR 地面（`z = 0`）
- **Quad 类别**（15 类）→ 生成 `3D_BOX` 候选
- **Polyline 类别**（6 类，见上文）→ 生成 `GROUND_POLYLINE` 候选
- 折线候选需 **≥ 2 个** 有效三维点；用户确认后走常规保存流程
- 双视角重复折线按距离阈值融合（`polyline_fusion_distance_threshold`）

### 5.2 使用注意

- 模型输出是**候选**，不是 Ground Truth
- 折线高度来自地面交点，复杂路沿仍需人工拖点云修正
- 模型类别 code 需与 Ontology 中 `CURB_WALL` 类别对应

---

## 六、完整操作流程示例

### 6.1 标注一个停车位

```text
工作目录：pc-tool 点云编辑器
前提：LiDAR Fusion 数据集，syncMode 已开启

1. 选择类别（toolType = PARKING_SLOT）
2. 按 P，依次点击：左前 → 左后 → 右后 → 右前
3. 在三视图中微调顶点（可选）
4. 保存当前帧（Ctrl+S 或自动保存策略）
5. 选中对象，Ctrl+Y 同步到全场景
6. 切换前后帧，检查 footprint 是否对齐、超出 12 m 的帧是否已移除
```

### 6.2 标注一段路沿并在多帧接长

```text
1. 选择 curb 类别（toolType = CURB_WALL）
2. 按 L，在当前帧可见范围内左键加点，双击结束
3. 选中折线，在主视图拖手柄，使顶点贴合路沿点云（0.5 m 内）
4. Ctrl+Y 同步
5. 下一帧：选中同 track，继续添加/调整可见段顶点
6. 再次 Ctrl+Y；检查重叠位置世界坐标一致，各帧仅保留圆内段
```

---

## 七、验证方法

### 7.1 停车位

- [ ] 四点顺序正确，开口边 P3-P0 与入口方向一致
- [ ] 无效四点无法创建
- [ ] 同步后各帧世界位置一致
- [ ] 距原点 > syncDistance 的帧无该 track
- [ ] 图像投影与 3D footprint 一致

### 7.2 Curb / Wall 折线

- [ ] 至少 2 个顶点
- [ ] 主视图拖点可改变 X/Y/Z，且能吸附点云
- [ ] 同步后圆外部分被裁剪，交点在圆周上
- [ ] 接长后旧帧翼段不被短源折线覆盖丢失
- [ ] Ctrl+Z 可撤销顶点编辑

### 7.3 后端单测（开发）

```bash
cd /PnP/lxzhu/lidar_annos/xtreme1/backend
mvn -q -Dtest=TrackSyncUseCaseTest test
```

---

## 八、常见问题与排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| Ctrl+Y 提示「没有追踪 ID」 | 对象尚未保存或未分配 trackId | 先保存当前帧 |
| Ctrl+Y 提示「不支持同步」 | `motionMode` 非可同步模式 | 地面形状应为 `STATIC` |
| 停车位创建失败 | 点序错误或自交 | 严格按左前→左后→右后→右前 |
| 折线无法结束 | 少于 2 点 | 至少添加 2 个顶点再双击 |
| 主视图拖折线点高度不变 | 仍在地面投影模式 | 使用主视图手柄（吸附点云），非仅改 XY |
| 拖手柄无反应 | 0.5 m 内无激光点 | 换更密点云位置或先缩放视图 |
| 下一帧仍见完整长线 | 后端未部署裁剪逻辑 | 确认 `TrackSyncUseCase` 裁剪版本 |
| 同步后折线消失 | 该帧圆内有效点 < 2 | 在该帧接长或增大 syncDistance |
| 模型折线类别对不上 | Ontology 未配置对应类 | 在数据集中添加 `CURB_WALL` 类别 |

---

## 九、备注与限制

1. **语义规范需项目补充**：代码定义了几何与工具，curb / wall / fence 的业务判定标准需在 Ontology 或项目标注手册中单独维护。
2. **同步半径仅看 XY**：高度变化不参与半径裁剪。
3. **停车位不支持折线式分段同步**：四边形整体进 / 整体出。
4. **折线支持分段与接长**：适合长路沿逐帧延伸标注。
5. **未保存前编辑器可能显示完整几何**：裁剪发生在后端同步之后。
6. **主视图折线手柄为 2D HTML 投影**：不处理深度遮挡排序。
7. **默认 syncDistance = 12 m**：可根据场景点云覆盖范围在属性面板调整。

---

## 参考文档

- `docs/superpowers/specs/2026-08-21-curb-wall-main-view-edit-design.md` — 主视图画线与顶点吸附设计
- `docs/superpowers/specs/2026-08-21-curb-wall-sync-clip-design.md` — 折线按半径裁剪同步设计
- `docs/keypoint-lifted-box-detection-design.md` — 模型辅助检测设计
