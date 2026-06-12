# Xtreme1 容器启动与跟踪标注操作指南

本文档说明在本仓库（已恢复 LiDAR 序列帧跟踪功能）环境下，如何启动 Docker 服务、进入标注工具，并完成**手动跟踪**与**模型跟踪**。

相关文档：[GPU 模型服务启动指南](gpu-setup.md)

---

## 1. 服务与端口

| 服务 | 容器名示例 | 宿主机端口 | 说明 |
|------|-----------|-----------|------|
| **Web 入口（nginx）** | `xtreme1-nginx-1` | **8190** | 浏览器访问 `http://localhost:8190` |
| backend | `xtreme1-backend-1` | 8290 | API，一般通过 nginx 代理 |
| frontend | `xtreme1-frontend-1` | 8291 | 静态资源，一般通过 nginx 代理 |
| MySQL | `xtreme1-mysql-1` | 8191 | 用户 `xtreme1` / 密码 `Rc4K3L6f` |
| Redis | `xtreme1-redis-1` | 8192 | — |
| MinIO API | `xtreme1-minio-1` | 8193 | 对象存储 |
| MinIO 控制台 | `xtreme1-minio-1` | 8194 | 用户 `admin` / 密码 `1tQB970y` |
| pcd-tools | `xtreme1-pcd-tools-1` | 8295 | 点云解析 |
| point-cloud-object-detection | `xtreme1-point-cloud-object-detection-1` | 8293 | 点云检测（`model` profile，需 GPU） |
| image-object-detection | `xtreme1-image-object-detection-1` | 8292 | 图像检测（`model` profile，需 GPU） |
| **point-cloud-object-tracking** | `xtreme1-point-cloud-object-tracking-1` | **8296** | 跟踪模型（`model` profile，不需 GPU） |

默认账号（首次初始化）：`admin@basic.ai` / `basicai123`（以你实际注册账号为准）。

---

## 2. 首次启动（推荐流程）

### 2.0 为什么首次不用 `docker compose --profile model up -d`？

`docker-compose.yml` 里带 `profiles: [model]` 的服务**默认不会启动**，需要显式加 `--profile model` 才会拉起：

| 服务 | 端口 | 需要 GPU | 用途 |
|------|------|----------|------|
| `point-cloud-object-tracking` | 8296 | **否** | 模型跟踪（LIDAR_TRACKING） |
| `point-cloud-object-detection` | 8293 | **是** | 点云 3D 检测预标注 |
| `image-object-detection` | 8292 | **是** | 图像 2D 检测预标注 |

首次部署的目标是**先让网页能打开、能手动标注**，因此推荐分两步：

1. **先起基础栈**（nginx / backend / frontend / MySQL / MinIO 等）— 不依赖 GPU，启动快、失败面小
2. **再按需起模型服务** — 只用跟踪就单独起跟踪；要用检测再考虑 GPU（见 [gpu-setup.md](gpu-setup.md)）

> 若机器已配好 GPU 且首次就要检测 + 跟踪，可直接 `docker compose --profile model up -d` 一次全起；无 GPU 时请勿带 `model` profile 全起，否则两个检测容器可能起不来。

### 2.1 第一步：基础栈（必做）

在项目根目录执行：

```bash
cd /path/to/xtreme1

# 构建并启动基础服务（含本地 frontend / backend，带跟踪 UI 与 LIDAR_TRACKING API）
docker compose build frontend backend
docker compose up -d

# 等待 backend 健康（约 1～3 分钟）
docker compose ps
curl -sf http://localhost:8290/actuator/health

# 若通过 nginx 访问 API 出现 502，重启 nginx 刷新上游
docker compose restart nginx
```

浏览器打开：**http://localhost:8190**

此时已可进行 **Scene 手动跟踪**（画框、Alt+→ 复制、合并/拆分），**不需要** `--profile model`。

### 2.2 第二步：跟踪 / 检测模型（按需）

`docker compose --profile model up -d`（**不带服务名**）会同时拉起 3 个 model 服务。多数场景**不必全起**，原因如下：

| 原因 | 说明 |
|------|------|
| **功能不重叠** | 做 LiDAR **跟踪**只需 `point-cloud-object-tracking`（8296）；两个**检测**服务是另一套能力（自动画 3D/2D 框预标注），与跟踪无关 |
| **检测要 GPU** | `point-cloud-object-detection`、`image-object-detection` 配置了 `gpus: all`。无 GPU 或 toolkit 未配好时，容器会 **Exited / Restarting**，拖慢排障 |
| **更占资源** | 检测镜像大，常驻会占显存和内存；只做跟踪时白占资源 |
| **启动更慢** | 全起要拉 3 个大镜像，首次部署等待更长 |

**什么时候可以全起？** 机器已按 [gpu-setup.md](gpu-setup.md) 配好 GPU，且确实要用**点云/图像自动检测预标注 + 模型跟踪**时，再用最后一条命令。

按实际需求选择**一种**方式：

```bash
# 仅「模型跟踪」— 不依赖 GPU，推荐大多数跟踪场景
docker compose --profile model up -d point-cloud-object-tracking

# 基础栈 + 跟踪（不启动两个 GPU 检测服务）
docker compose up -d
docker compose --profile model up -d point-cloud-object-tracking

# 基础栈 + 全部模型（跟踪 + 点云/图像检测，检测需 GPU）
docker compose --profile model up -d
```

验证跟踪服务：

```bash
curl -sf http://localhost:8296/pointCloud/tracking -X POST \
  -H 'Content-Type: application/json' \
  -d '{"direction":"FORWARD","targetData":{"id":1},"objects":[]}'
```

或运行仓库脚本：

```bash
bash scripts/validate_tracking.sh
```

### 2.3 已有数据库、非全新安装时

若 MySQL 卷已存在，`V3__Add_tracking_model.sql` 不会自动重跑。需手动执行（仅需一次）：

```bash
docker exec -i xtreme1-mysql-1 mysql -uxtreme1 -pRc4K3L6f xtreme1 \
  < deploy/mysql/migration/V3__Add_tracking_model.sql
```

确认模型列表含 `LIDAR_TRACKING`：

```bash
docker exec xtreme1-mysql-1 mysql -uxtreme1 -pRc4K3L6f xtreme1 \
  -e "SELECT id, name, model_code FROM model;"
```

### 2.4 序列帧数据结构（Scene）

跟踪仅对**序列帧 / Scene** 任务生效。试用数据集若各帧为散落的 `SINGLE_DATA`，需合并为 Scene（`V4` 迁移，仅对 `parent_id=0` 的帧生效）：

```bash
docker exec -i xtreme1-mysql-1 mysql -uxtreme1 -pRc4K3L6f xtreme1 \
  < deploy/mysql/migration/V4__Group_trial_frames_to_scene.sql
```

执行后数据集列表应出现 **Scene-1** 卡片，而不是 16 张独立单帧卡片。

---

## 3. 日常启停命令

### 3.1 启动

```bash
# 仅基础栈（标注 + 手动跟踪，不含任何 model profile 服务）
docker compose up -d

# 基础栈 + 仅跟踪模型（8296，不需 GPU）
docker compose up -d
docker compose --profile model up -d point-cloud-object-tracking

# 基础栈 + 全部 model 服务（跟踪 + 点云/图像检测，检测需 GPU）
docker compose --profile model up -d
```

### 3.2 停止

```bash
# 停止并删除容器，保留数据卷
docker compose --profile model down

# 危险：连 MySQL / MinIO 数据一并删除
docker compose --profile model down -v
```

### 3.3 仅重建前端（改了 pc-tool 代码后）

```bash
docker compose build frontend
docker compose up -d --no-deps frontend
docker compose restart nginx
```

### 3.4 仅重建后端（改了 Java 跟踪 API 后）

```bash
docker compose build backend
docker compose up -d --no-deps backend
docker compose restart nginx
```

### 3.5 查看状态与日志

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f nginx
docker compose logs -f point-cloud-object-tracking
```

```
修改重启
docker compose --profile model down
docker compose --profile model up -d --build
```
---


## 4. 进入跟踪标注（前置条件）

跟踪功能**必须**满足以下全部条件：

1. 数据集类型为 **LiDAR Fusion**（或含点云 + 相机的融合数据）
2. 从 **Scene（序列场景）** 进入，不是单帧 `SINGLE_DATA`
3. 底部出现**时间轴**（如 `1 / 16`）
4. 时间轴右侧有：**跟踪**、**合并**、**拆分**、**删除** 按钮
5. 当前数据**未被其他用户占用**（卡片上无 `Editing by xxx`）

### 4.1 正确入口

1. 登录主站 → **Datasets** → 打开 **LiDAR Fusion Trial**
2. 找到 **Scene-1**（或你的场景名）
3. 点击 **Annotate**（不要对单帧点 Annotate）
4. 自动跳转到 pc-tool，URL 类似：

```
http://localhost:8190/tool/pc?recordId=<你的recordId>&datasetId=1&itemType=SCENE
```

### 4.2 数据被占用时

卡片显示 `Editing by tracktest` 等：

- 占用者登录后，在标注页点 **Close** 退出；或
- 数据集页右上角 **解锁图标** → Force Unlock → 选中对应用户 → 解锁

同一帧在系统中只能被一个 `data_edit` 记录锁定。

---

## 5. 手动跟踪操作

### 5.1 在第一帧创建轨迹

| 步骤 | 操作 |
|------|------|
| 1 | 时间轴停在起始帧 |
| 2 | 左侧选择类别（Car / Truck 等） |
| 3 | 按 **F**，在点云上拉 3D 框 |
| 4 | 框自动分配 **trackName**（1、2…）和 **trackId** |
| 5 | 右下角面板标题：`Cuboid 1`，下方灰色文字为 trackId |
| 6 | 时间轴左侧出现 `1(***abc123)` 轨迹行 |

### 5.2 复制到后续帧（核心操作）

选中 3D 框后：

| 方式 | 操作 |
|------|------|
| 快捷键 | **Alt + →** 向右复制 1 帧；**Alt + ←** 向左复制 1 帧 |
| 工具栏 | 时间轴中间带复制图标的 ← / → 按钮 |
| 批量 | 点右侧 **轨迹图标** → 方向 / 帧数 / 模式选 **复制** → **执行** |

复制后切换到下一帧，**拖动、旋转**框对齐物体，再 **Alt+→** 继续。

### 5.3 合并 / 拆分 / 删除轨迹

1. 在时间轴左侧**点击轨迹行**选中
2. 使用右侧按钮：
   - **合并**：两条轨迹合成一条
   - **拆分**：从当前帧拆出新轨迹
   - **删除**：删除该轨迹在所有帧上的框

### 5.4 保存

- 右上角 **Save**，或 **Ctrl + S**
- 标注完成可 **Submit**；仅退出用 **Close**（会释放数据锁）

### 5.5 推荐工作流

```
Scene Annotate 进入
    → 第 1 帧 F 画种子框
    → Alt+→ 复制到下一帧
    → 微调框位置
    → 重复直到最后一帧
    → Save
```

可开启时间轴左侧 **Auto-load** 预加载相邻帧，加快切换。

---

## 6. 模型跟踪操作（自动传播）

### 6.1 前置

```bash
docker compose --profile model up -d point-cloud-object-tracking backend
```

确认 `model` 表存在 **Basic Lidar Object Tracking**（`LIDAR_TRACKING`）。

> 当前跟踪服务为**匀速占位实现**，用于打通 API 与 UI；生产环境可替换为 AB3DMOT 等真实算法。

### 6.2 操作步骤

1. 在某一帧画好种子框（或选中已有框）
2. 时间轴右侧点 **轨迹图标**
3. 设置：
   - **方向**：向前 / 向后
   - **帧数**：要传播多少帧
   - **模式**：**模型**（不是「复制」）
4. 点 **执行**，等待提示「追踪成功」
5. 逐帧检查并微调
6. **Save**

### 6.3 失败排查

| 现象 | 处理 |
|------|------|
| **Model Run Error**（左侧工具栏点「模型」） | **不要**在左侧选「Basic Lidar Object Tracking」再点模型：跟踪参数不对。应使用时间轴 **「跟踪」→ 模式选「模型」→ 执行**。后端已修复：跟踪 HTTP 返回 `"code":"OK"` 时 Hutool 可能未映射到枚举，导致误判失败（需重建 `backend`）。 |
| 无「模型」选项 | 前端未用本地构建镜像，或 `noModelTrack: true` |
| 追踪错误 | `docker compose logs point-cloud-object-tracking` |
| 无追踪对象 | 未选中 3D 框 |
| 后端报错 | 确认 `LIDAR_TRACKING` 模型已写入数据库 |

---

## 7. 界面元素对照

| 位置 | 内容 |
|------|------|
| 底部时间轴 | 帧序号、播放、复制按钮、轨迹行 |
| 时间轴右侧 | 跟踪 / 合并 / 拆分 / 删除 |
| 右下角浮动面板 | `Cuboid <trackName>` + trackId |
| 左侧 Results | 类别下的数字编号 |
| 左侧相机缩略图 | 多相机图像（融合数据） |

---

## 8. 常见问题

### 8.1 点云 / 图片全黑

1. 确认 URL 中 `recordId` 有效（过期 record 会加载失败）
2. 浏览器 **硬刷新**（Ctrl+Shift+R）
3. 检查 API：`curl http://localhost:8190/api/model/list`（需登录 token，不应 500）
4. backend 重建后执行：`docker compose restart nginx`
5. 必须用 **Scene** 任务，不是 `SINGLE_DATA`

### 8.2 没有时间轴 / 无跟踪按钮

- 任务类型不是 Scene
- 或仍在使用官方旧前端镜像 → 执行 `docker compose build frontend && docker compose up -d --no-deps frontend`

### 8.3 `Editing by xxx`

其他用户的标注任务占用了数据 → 见 [4.2 数据被占用时](#42-数据被占用时)。

### 8.4 Scene 只能标 3 帧

其余帧被他人 `data_edit` 锁定；需对方解锁或 Force Unlock 后，重新对 **Scene-1** 点 Annotate。

### 8.5 只启动了跟踪容器，网页打不开

`point-cloud-object-tracking` 不会拉起 nginx/backend。应：

```bash
docker compose up -d
# 或
docker compose --profile model up -d
```

---

## 9. 本仓库与官方镜像的差异

当前 `docker-compose.yml` 默认：

- **frontend**：本地构建，覆盖 `pc-tool` / `text-tool`（含跟踪 UI）
- **backend**：本地构建（含 `LIDAR_TRACKING`、`ModelTypeEnum.TRACKING`）
- **point-cloud-object-tracking**：本地构建（`model` profile）

若改回官方镜像，需注释 `build:` 并恢复 `image: basicai/xtreme1-*:v0.9.1`，跟踪 UI 与跟踪 API 将不可用。

---

## 10. 快速检查清单

启动后按顺序自检：

- [ ] `docker compose ps` 中 `backend` 为 `healthy`（首次只需基础栈，不必强求 model 容器）
- [ ] 浏览器可打开 http://localhost:8190
- [ ] 数据集存在 **Scene-1**，无 `Editing by` 锁
- [ ] Annotate 后底部有时间轴
- [ ] 按 F 可画框，右下角显示 `Cuboid 1`
- [ ] Alt+→ 可复制到下一帧
- [ ] （可选）`bash scripts/validate_tracking.sh` 通过
- [ ] （可选）模型跟踪服务 `8296` 端口可访问

---

## 11. 相关文件

| 路径 | 说明 |
|------|------|
| `docker-compose.yml` | 服务编排 |
| `deploy/point-cloud-object-tracking/app.py` | 跟踪 HTTP 服务 |
| `deploy/mysql/migration/V3__Add_tracking_model.sql` | 跟踪模型 DB |
| `deploy/mysql/migration/V4__Group_trial_frames_to_scene.sql` | 单帧合并为 Scene |
| `frontend/pc-tool/src/components/TimeLine/` | 时间轴与跟踪 UI |
| `scripts/validate_tracking.sh` | 跟踪链路冒烟测试 |
| `scripts/browser_check_tracking.py` | 无头浏览器检查（开发用） |
