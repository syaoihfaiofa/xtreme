# 运行环境
### 使用现有的Docker镜像：
`registry.talos.basic.ai/basicai/algorithm/images/service/pcd-tools`

# 服务
### 启动服务
```shell
python app.py 
```
- `--port`：服务端口，默认为5000
- `--num_processes`：进程数目，默认为1

### 接口说明
- 接口地址：`POST http://ip:port/pointcloud/convert_render:5000`
- 参考文档[点云二进制转换和渲染接口文档](https://zioug6is98.larksuite.com/docx/doxusHYVbF2WtOPP08IOcmWINWE)
