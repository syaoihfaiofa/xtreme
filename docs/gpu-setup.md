# Xtreme1 GPU 模型服务启动指南

本文说明如何在服务器上为 Xtreme1 **内置 AI 检测模型**启用 NVIDIA GPU，以及无 GPU 时的替代方案。

相关文档：[跟踪标注操作指南](tracking-setup-and-usage.md)

---

## 1. 哪些服务需要 GPU？

| 服务 | 端口 | 需要 GPU | 说明 |
|------|------|----------|------|
| `image-object-detection` | 8292 | **是** | 图像 2D 检测（COCO） |
| `point-cloud-object-detection` | 8293 | **是** | 点云 3D 检测 |
| `point-cloud-object-tracking` | 8296 | **否** | 点云跟踪（本仓库 CPU 占位服务） |
| `nginx` / `backend` / `frontend` / `mysql` 等 | — | **否** | 平台基础服务 |

[`docker-compose.yml`](../docker-compose.yml) 中前两个检测服务使用 `gpus: all`（与 `docker run --gpus all` 相同，**不要求** `daemon.json` 里配置 `runtimes.nvidia`）。

**结论：**

- 只做 **LiDAR 手动跟踪** 或 **模型跟踪（LIDAR_TRACKING）** → **不需要 GPU**
- 要用 **点云/图像自动检测预标注** → **需要 GPU + NVIDIA Container Toolkit**

---

## 2. 前置检查

在服务器上执行：

```bash
# 驱动是否正常（应看到 GPU 型号与驱动版本）
nvidia-smi

# Docker 是否可用
docker --version
docker compose version
```

若 `nvidia-smi` 报错，请先安装 NVIDIA 驱动：  
[NVIDIA CUDA 驱动安装指南](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/index.html)

推荐环境：

- Linux 服务器（Ubuntu 20.04 / 22.04 常见）
- NVIDIA GPU（官方示例为 T4 或同等级别）
- 显存建议 ≥ 8GB（检测模型并发时）
- 系统内存建议 ≥ 16GB（完整平台 + 模型）

---

## 3. 安装 NVIDIA Container Toolkit

使 Docker 容器能访问 GPU。

### 3.1 Ubuntu / Debian（官方推荐方式）

```bash
# 添加仓库
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
```

### 3.2 配置 Docker

安装 toolkit 后，若 `docker run --gpus all` 已能跑通，**通常不必改** `daemon.json`。

本仓库 compose 使用 `gpus: all`，与常见 GPU 容器写法一致。例如你的配置可以只有：

```json
{
  "data-root": "/PnP/docker",
  "exec-opts": ["native.cgroupdriver=cgroupfs"]
}
```

仅当其他项目仍要求 `runtime: nvidia` 时，才需要额外配置：

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

> 注意：若用 `nvidia-ctk runtime configure` 覆盖了 `daemon.json`，请保留原有的 `data-root`、`exec-opts` 等字段。

### 3.3 验证 Docker 能用 GPU

```bash
docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi
```

应输出与宿主机类似的 GPU 信息。

---

## 4. 启动命令

在项目根目录（含 `docker-compose.yml`）执行。

### 4.1 仅基础平台（不用任何 AI 模型，无需 GPU）

```bash
docker compose up -d
```

访问：http://\<服务器IP\>:8190

### 4.2 基础平台 + 跟踪模型（无需 GPU）

跟踪服务不依赖 GPU，可单独启动：

```bash
docker compose up -d
docker compose --profile model up -d point-cloud-object-tracking
```

或启动整个 `model` profile（若无 GPU，两个检测容器会启动失败，见下文「无 GPU」）：

```bash
docker compose --profile model up -d
```

### 4.3 完整 AI 模型（检测 + 跟踪，检测需 GPU）

```bash
# 首次需构建本地前后端与跟踪服务
docker compose build frontend backend point-cloud-object-tracking

# 启动基础栈
docker compose up -d

# 启动全部 model profile（含 2 个 GPU 检测 + 1 个 CPU 跟踪）
docker compose --profile model up -d
```

### 4.4 仅 GPU 检测模型（不启跟踪）

```bash
docker compose up -d
docker compose up -d image-object-detection point-cloud-object-detection
```

---

## 5. 启动后检查

```bash
# 所有容器状态
docker compose ps

# GPU 检测容器是否在跑
docker compose ps image-object-detection point-cloud-object-detection

# 查看检测服务日志
docker compose logs -f point-cloud-object-detection
docker compose logs -f image-object-detection

# 跟踪服务（CPU）
docker compose logs -f point-cloud-object-tracking
```

在 Xtreme1 主站 **Models** 页面应能看到：

| 模型 | model_code | 依赖服务 |
|------|------------|----------|
| Basic Lidar Object Detection | `LIDAR_DETECTION` | point-cloud-object-detection:8293 |
| COCO Object Detection | `IMAGE_DETECTION` | image-object-detection:8292 |
| Basic Lidar Object Tracking | `LIDAR_TRACKING` | point-cloud-object-tracking:8296 |

可在模型页点击 **Test Connection** 验证连通性。

---

## 6. 无 GPU 服务器怎么办？

| 需求 | 做法 |
|------|------|
| 标注、手动跟踪 | `docker compose up -d` 即可 |
| 模型跟踪（LIDAR_TRACKING） | 只启 `point-cloud-object-tracking`，不要启两个检测容器 |
| 点云/图像 AI 预检测 | 必须有 GPU；或改用外部模型 API 并改 backend 配置 |

避免在无 GPU 机器上执行完整的：

```bash
docker compose --profile model up -d
```

否则 `image-object-detection`、`point-cloud-object-detection` 会反复重启，日志中常见：

- `could not select device driver "" with capabilities: [[gpu]]`
- `nvidia-container-cli: initialization error`

**推荐无 GPU 启动方式：**

```bash
docker compose up -d
docker compose up -d point-cloud-object-tracking
```

---

## 7. 常见问题

### 7.1 `could not select device driver "" with capabilities: [[gpu]]`

- 未安装 NVIDIA Container Toolkit
- 或安装后未 `systemctl restart docker`
- 或云服务器未挂载 GPU 实例

按 [第 3 节](#3-安装-nvidia-container-toolkit) 重装并验证 `docker run --gpus all ... nvidia-smi`。

### 7.2 `nvidia-smi` 有输出，但 Xtreme1 检测容器仍失败

```bash
# 先确认通用 GPU 容器是否正常
docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi

# 再启检测服务看日志
docker compose up -d point-cloud-object-detection image-object-detection
docker compose logs point-cloud-object-detection --tail 50
```

若 `docker run --gpus all` 正常而 compose 失败，检查 compose 版本 ≥ 2.3，且服务含 `gpus: all`：

```bash
grep -A1 gpus docker-compose.yml
```

### 7.3 模型 Test Connection 失败

1. 对应容器是否在运行：`docker compose ps`
2. 后端能否访问容器内网地址（`http://point-cloud-object-detection:5000` 等）
3. 数据库是否有模型记录（新库执行 `V3__Add_tracking_model.sql`）

### 7.4 Docker Desktop + WSL2

Windows 开发机可参考官方 issue：  
[xtreme1-io/xtreme1#144](https://github.com/xtreme1-io/xtreme1/issues/144)

需在 WSL2 内安装驱动/toolkit，并在 Docker Desktop 中启用 GPU 支持。

### 7.5 显存不足 OOM

- 不要同时跑多个大模型推理任务
- 减小 batch 或关闭不用的检测服务：`docker compose stop image-object-detection`
- 换更大显存 GPU

---

## 8. 启停速查

```bash
# 启动（基础）
docker compose up -d

# 启动（基础 + 全部模型，要 GPU）
docker compose --profile model up -d

# 仅跟踪（无 GPU）
docker compose up -d point-cloud-object-tracking

# 停止模型服务
docker compose stop image-object-detection point-cloud-object-detection point-cloud-object-tracking

# 停止全部
docker compose --profile model down
```

---

## 9. 相关文件

| 路径 | 说明 |
|------|------|
| [`docker-compose.yml`](../docker-compose.yml) | `gpus: all` 与 `profiles: [model]` |
| [`deploy/point-cloud-object-tracking/`](../deploy/point-cloud-object-tracking/) | CPU 跟踪 HTTP 服务 |
| [`deploy/mysql/migration/V3__Add_tracking_model.sql`](../deploy/mysql/migration/V3__Add_tracking_model.sql) | 跟踪模型数据库记录 |
| [`docs/tracking-setup-and-usage.md`](tracking-setup-and-usage.md) | 跟踪标注操作 |
| [`README.md`](../README.md) | 官方安装与 model profile 说明 |
