# Xtreme1 Deploy

## BEVFusion 模型部署

```bash
cd ~/lidar_annos/xtreme1
export HOME=$HOME

# 若 mmdetection3d 不在 /PnP/lxzhu/mmdetection3d，先设置路径：
# export BEVFUSION_DETECTION_REPO_DIR=$HOME/mmdetection3d

bash deploy/point-cloud-bevfusion-detection/deploy.sh
```

**不要挂载 `/opt/conda`**：若宿主机没有该目录，Docker 会挂载空目录并覆盖镜像内 Python，导致 `python not found`。

## 连接超时排查

若 UI 报 `Model service connection timed out`，通常是 **backend 容器访问不到模型容器**。

容器状态 `Restarting (127)` 表示启动命令找不到（常见原因：挂载宿主机 `/opt/conda` 后缺少 gunicorn）。
修复后需 **rebuild 镜像**：

```bash
docker compose build --no-cache point-cloud-bevfusion-detection
docker compose --profile model up -d point-cloud-bevfusion-detection
```

```bash
bash deploy/point-cloud-bevfusion-detection/diagnose.sh
```

确认 backend 能连通：

```bash
docker exec xtreme1-backend-1 curl -sf http://point-cloud-bevfusion-detection:5000/health
```
