# 本地启动指南（Clone 后从零部署）

本文说明在本仓库 **clone 代码之后**，如何使用 Docker Compose 在本地启动 Xtreme1 平台，并完成首次访问验证。

适用场景：Linux / macOS / Windows（WSL2）上已有 Docker 与 Docker Compose，**不需要 GPU** 即可完成 Web 主站与 LiDAR 融合手动标注。

相关文档：

- [跟踪与 Sync 操作说明](tracking-setup-and-usage.md)
- [GPU 模型服务](gpu-setup.md)
- 上游说明：[README.md](../README.md)

---

## 背景与目的

Xtreme1 由多个容器组成：Web 入口（nginx）、前端静态资源、Java 后端、MySQL、Redis、MinIO，以及可选的模型服务。  
本仓库在官方 v0.9.1 基础上扩展了 **LiDAR Fusion Sync Mode、Scene location 导入、pc-tool 跟踪** 等功能，**推荐从源码构建** `backend` 与 `frontend`，而不是只拉取旧版 Hub 镜像。

---

## 范围与假设

| 项目 | 说明 |
|------|------|
| 操作系统 | Linux 或 macOS；Windows 建议使用 WSL2 + Docker Desktop |
| Docker | Engine 20.10+；**必须有 Compose V2**（`docker compose`，中间是空格） |
| 磁盘 | 建议至少 10GB 可用空间（含镜像与数据卷） |
| 网络 | 首次 `docker compose build` 需下载 Maven / npm 依赖；网络不稳定时见「常见问题」 |
| GPU | **首次启动不需要**；模型预标注见 [gpu-setup.md](gpu-setup.md) |

下文默认项目根目录为 `xtreme/`（即包含 `docker-compose.yml` 的目录）。

---

## 前置条件

安装并验证 Docker 与 Compose：

```bash
docker --version
docker compose version
```

本仓库的 `docker-compose.yml` 使用了 `depends_on.condition`、`profiles` 等 Compose V2 语法，**需要 `docker compose`（V2 插件）**。  
Docker 20.10 默认**没有**这个子命令。若出现：

```text
docker: 'compose' is not a docker command.
```

说明当前只有 Docker Engine，没有 Compose 插件。先装 Compose V2，不要用旧的 `docker-compose`（带连字符的 V1）硬跑本仓库。

在 Ubuntu / Debian 上安装（任选一种）：

```bash
# 方式 A：官方 Compose 插件（推荐）
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
docker compose version
```

若仓库里没有 `docker-compose-plugin` 包，可装官方独立二进制：

```bash
# 方式 B：Compose V2 独立二进制
mkdir -p ~/.docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/download/v2.24.7/docker-compose-linux-x86_64 \
  -o ~/.docker/cli-plugins/docker-compose
chmod +x ~/.docker/cli-plugins/docker-compose
docker compose version
```

验证成功时应类似：

```text
Docker Compose version v2.24.7
```

可选：开启 BuildKit 加速构建（推荐）：

```bash
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
```

---

## 目录结构（与启动相关）

```text
xtreme/
├── docker-compose.yml          # 默认 Compose（clone 后自带）
├── backend/                    # Spring Boot 后端
├── frontend/                   # main + pc-tool + image-tool + text-tool
├── deploy/
│   ├── nginx/conf.d/           # nginx 反向代理
│   └── mysql/
│       ├── migration/          # 数据库 SQL 迁移
│       └── docker-init/        # 有序执行迁移的 init 脚本
├── scripts/
│   └── fast-deploy-pc-tool.sh  # 仅重建 pc-tool 前端（约 1～2 分钟）
└── docs/
    └── local-startup-guide.md  # 本文
```

---

## 第一步：Clone 代码

```bash
git clone <你的仓库地址> xtreme
cd xtreme
```

若仓库外层还有一层目录（例如 `test_xtreme/xtreme`），请 `cd` 到包含 `docker-compose.yml` 的那一层。

---

## 第二步：构建并启动服务

`docker-compose.yml` 已配置有序 MySQL 初始化：`deploy/mysql/docker-init/01-run-migrations.sh` 按固定顺序执行 `deploy/mysql/migration/` 下的 SQL（不要把 migration 目录直接挂到 `docker-entrypoint-initdb.d`，否则会按文件名排序，可能让 `V19` 早于 `V16` 执行而失败）。

在项目根目录执行：

```bash
cd /path/to/xtreme

# 构建 backend + frontend（首次约 10～20 分钟，视网络与 CPU 而定）
DOCKER_BUILDKIT=1 docker compose build --pull=false backend frontend

# 后台启动全部基础服务（不含 GPU 模型 profile）
docker compose up -d

# 查看状态，等待 backend 为 healthy
docker compose ps
```

### 启动哪些服务

| 服务 | 是否默认启动 | 说明 |
|------|--------------|------|
| nginx | 是 | 浏览器入口 `:8190` |
| backend | 是 | API |
| frontend | 是 | 主站 + pc-tool 等 |
| mysql / redis / minio | 是 | 基础依赖 |
| pcd-tools / image-vect-visualization | 是 | 点云解析等 |
| `point-cloud-object-detection` 等 | **否** | 需 `--profile model`，且检测类需 GPU |

**不要**在首次部署时执行 `docker compose --profile model up -d`，除非已配置 NVIDIA GPU 且明确需要检测模型。

---

## 第三步：验证服务

```bash
# 后端健康检查（直连 backend 端口）
curl -sf http://localhost:8290/actuator/health && echo OK

# 通过 nginx 访问 API（应返回 JSON，而非 502）
curl -sf http://localhost:8190/api/actuator/health && echo OK
```

若 nginx 返回 **502**，通常是 backend 尚未 ready，等待 1～3 分钟后执行：

```bash
docker compose restart nginx
```

浏览器访问：

| 地址 | 用途 |
|------|------|
| http://localhost:8190 | 主站（数据集、上传、任务） |
| http://localhost:8190/tool/pc | 点云 / LiDAR Fusion 标注工具 |
| http://localhost:8194 | MinIO 控制台 |

---

## 第四步：登录与首次使用

### 默认数据库用户

首次初始化后，`deploy/mysql/migration/V2__Init_data.sql` 会插入管理员：

| 字段 | 值 |
|------|-----|
| username | `admin` |
| nickname | `admin` |

密码为 bcrypt 哈希存储，**不同 fork 可能不同**。若 `admin` 无法登录：

1. 在登录页 **注册新账号** 后使用；或  
2. 在 MySQL 中重置 `user` 表密码（开发环境）。

部分环境文档中写的 `admin@basic.ai` / `basicai123` 来自已注册账号示例，**不一定等于** 空库初始化账号，以你库中 `user.username` 为准。

### 创建 LiDAR Fusion 数据集（简要）

1. 登录 → **Datasets** → 创建 **LiDAR Fusion** 数据集  
2. 需要 **Sync Mode** 时，在数据集设置中开启  
3. 上传 zip（勾选 **Auto create Scene** 可自动建 Scene，并导入 `location/location.txt`）  
4. 进入 Scene → **Annotate** 打开 pc-tool  

详细跟踪 / Sync 流程见 [tracking-setup-and-usage.md](tracking-setup-and-usage.md)。

---

## 端口与账号一览

| 服务 | 宿主机端口 | 账号 / 说明 |
|------|-----------|-------------|
| Web（nginx） | **8190** | 浏览器主入口 |
| backend | 8290 | 一般通过 nginx `/api/` 访问 |
| frontend | 8291 | 一般通过 nginx 访问 |
| MySQL | 8191 | 用户 `xtreme1`，密码 `Rc4K3L6f`，库 `xtreme1` |
| Redis | 8192 | 无密码 |
| MinIO API | 8193 | 用户 `admin`，密码 `1tQB970y`，桶 `xtreme1` |
| MinIO 控制台 | 8194 | 同上 |
| pcd-tools | 8295 | 点云工具服务 |

以上密码来自 `docker-compose.yml`，**仅适用于本地开发**，勿用于生产。

---

## 常用运维命令

假设工作目录为项目根目录 `xtreme/`。

```bash
# 查看日志
docker compose logs -f backend
docker compose logs -f nginx

# 停止 / 启动
docker compose stop
docker compose start

# 停止并删除容器（保留数据卷）
docker compose down

# 代码变更后重新构建并启动
DOCKER_BUILDKIT=1 docker compose build --pull=false backend frontend
docker compose up -d --no-build backend frontend nginx

# 仅快速更新 pc-tool 前端（改 pc-tool 代码后，约 1～2 分钟）
./scripts/fast-deploy-pc-tool.sh
# 浏览器硬刷新：Ctrl+Shift+R
```

### 按需启动跟踪模型（无 GPU 也可）

```bash
docker compose --profile model up -d point-cloud-object-tracking
curl -sf http://localhost:8296/health && echo OK
```

---

## 开发模式说明

### 只改 pc-tool 前端

不必每次全量 `docker compose build frontend`（约 10 分钟），使用：

```bash
./scripts/fast-deploy-pc-tool.sh
```

### 只改 backend

```bash
DOCKER_BUILDKIT=1 docker compose build --pull=false backend
docker compose up -d backend
```

### 本地 IDE 跑 backend（可选）

参考 [backend/README.md](../backend/README.md)：先 `docker compose up -d mysql redis minio`，再配置 `application-local.yml`，使用 `local` profile 启动 Java 进程。此时 backend 端口为 **8080**（非容器内的 8290 映射逻辑需自行对齐 nginx）。

---

## 输入与输出说明

| 操作 | 输入 | 成功时结果 |
|------|------|------------|
| `docker compose up -d` | 已构建镜像 | 容器 Running，backend healthy |
| 打开 `:8190` | 浏览器 | 登录页 / 主站 |
| 上传 zip | LiDAR Fusion 压缩包 | MinIO 有数据，数据集出现 Scene |
| pc-tool 标注 | Scene + record | 可加载点云与相机图 |

---

## 常见问题

### 0. `docker: 'compose' is not a docker command`

Docker 20.10.x 很常见：引擎有了，Compose V2 插件没装。按上文「前置条件」安装 `docker-compose-plugin` 或 Compose V2 二进制后再执行 `docker compose version`。

不要用 `docker-compose` V1 替代：本仓库 YAML 依赖 V2，V1 可能无法解析 `condition: service_healthy` 等字段。

### 1. `docker compose build` 很慢或拉镜像失败

使用不拉远程基础镜像的方式（依赖本地已有 `node:16`、`maven` 等）：

```bash
DOCKER_BUILDKIT=1 docker compose build --pull=false backend frontend
```

清理构建缓存（依赖异常时）：

```bash
docker builder prune
```

### 2. MySQL 启动后 backend 报错 / 缺表

多为迁移顺序错误或旧数据卷残留：

```bash
docker compose down -v   # 警告：会删除 MySQL/Redis/MinIO 全部数据
docker compose up -d
```

MySQL 首次初始化走 `deploy/mysql/docker-init/01-run-migrations.sh` 的固定顺序。若你本地仍把 `migration/` 直接挂到 `docker-entrypoint-initdb.d`，请改回仓库当前的 `docker-compose.yml` 挂载后再 `down -v` 重建。

### 3. nginx 502 Bad Gateway

```bash
docker compose ps          # 确认 backend 为 healthy
docker compose logs backend | tail -50
docker compose restart nginx
```

### 4. pc-tool 仍像旧版本（功能缺失、Load Object Error）

硬刷新浏览器，或执行：

```bash
./scripts/fast-deploy-pc-tool.sh
```

### 5. Sync 无效 / 无投影

检查：

- 数据集是否开启 **Sync Mode**
- Scene 是否已导入 **location**（上传 zip 时勾选 Auto create Scene，或手动 Upload Location）
- 帧 content 是否包含 **camera_config**
- 标注后是否按 **Ctrl+Y** 触发 Sync（Save 不会自动跨帧传播）

### 6. 端口被占用

修改 `docker-compose.yml` 中左侧宿主机端口（例如 `8190:80` → `9190:80`），访问时使用新端口。

---

## FAQ

**Q：clone 后可以直接 `docker compose up` 不 build 吗？**  
A：本仓库功能在源码中，**必须先** `docker compose build backend frontend`（或等价构建），否则会使用不存在/过期的本地镜像。

**Q：`docker-compose.develop.yml` 在哪？**  
A：该文件在 `.gitignore` 中，不会随 clone 下发。日常启动直接用仓库根目录的 `docker-compose.yml` 即可（MySQL 有序初始化已写在该文件中）。

**Q：生产环境能直接用这套密码吗？**  
A：不能。务必修改 MySQL、MinIO 等全部默认口令，并限制端口暴露。

**Q：ARM Mac（M1/M2）能跑吗？**  
A：可以，MySQL 等镜像可能需要 `platform: linux/amd64`，见 [README.md](../README.md) 中 ARM 说明。

---

## 最小命令清单（复制即用）

```bash
git clone <repo-url> xtreme
cd xtreme

export DOCKER_BUILDKIT=1
docker compose build --pull=false backend frontend
docker compose up -d

curl -sf http://localhost:8290/actuator/health
curl -sf http://localhost:8190/api/actuator/health

# 浏览器打开 http://localhost:8190
```

完成以上步骤后，即可登录、创建 LiDAR Fusion 数据集并开始标注。后续 Sync、跟踪、模型推理请参阅 [tracking-setup-and-usage.md](tracking-setup-and-usage.md)。
