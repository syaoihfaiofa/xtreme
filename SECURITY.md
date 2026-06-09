# Security Policy

This is a project of the [The Linux Foundation](https://www.linuxfoundation.org/) and follows the LF [How to report vulnerabilities to LF projects and foundations](https://apache.org/security/#reporting-a-vulnerability).


# 先保证主站已起来
docker compose up -d

# 再单独加跟踪
docker compose --profile model up -d point-cloud-object-tracking

# 重新启动：

docker compose start
# 或
docker compose up -d

# 连数据卷一起删（慎用）会清空数据库、MinIO 等持久化数据：

docker compose down -v