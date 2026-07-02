# 备份与恢复

CPAMP 的请求历史、配置和加密凭证都在本机。备份时最容易犯的错，是只复制 `usage.sqlite`，漏掉 WAL/SHM、`data.key` 或安装目录里的 secret 文件。

## 必备备份文件

至少把这些文件作为一组备份：

- `usage.sqlite`
- `usage.sqlite-wal`
- `usage.sqlite-shm`
- `data.key`

如果部署目录还有自定义配置文件，也应一起备份。使用一键安装脚本时，至少额外备份安装目录中的 `secrets/`；完整安装和 env/secret 管理模式会把 CPA Management Key 放在 `secrets/cpa-management-key`。

## 为什么必须备份 data.key

通过 setup 或面板保存的 CPA 连接，会把 CPA Management Key 使用 `data.key` 加密后保存到 SQLite。

- 只有 `usage.sqlite` 泄露时，攻击者不能直接读出 CPA Management Key。
- `usage.sqlite` 和 `data.key` 同时泄露时，CPA Management Key 可被解密。
- 丢失 `data.key` 时，已经保存的 CPA Management Key 无法恢复，只能重新保存 CPA 连接配置。

如果 CPA 连接由环境变量或 secret 文件管理，CPA Management Key 不写入 SQLite。请把对应的 secret 文件和数据目录作为一组备份。

## Docker 备份示例

如果使用 named volume，可以先停止容器，再用临时容器导出：

```bash
docker stop cpa-manager-plus
docker run --rm \
  -v cpa-manager-plus-data:/data:ro \
  -v "$PWD":/backup \
  alpine \
  tar czf /backup/cpa-manager-plus-data.tgz -C /data .
docker start cpa-manager-plus
```

如果使用宿主机目录挂载：

```bash
docker stop cpa-manager-plus
cp -a /srv/cpa-manager-plus-data /srv/cpa-manager-plus-data.backup
docker start cpa-manager-plus
```

## 原生包备份

停止进程后复制数据目录：

```bash
cp -a ./data ./data.backup
```

Windows PowerShell：

```powershell
Copy-Item -Recurse .\data .\data.backup
```

## 恢复

1. 停止 CPAMP。
2. 恢复完整数据目录。
3. 确认 `usage.sqlite` 和 `data.key` 来自同一次备份。
4. 如果使用 env/secret 管理 CPA 连接，同时恢复安装目录里的 `secrets/`。
5. 启动 CPAMP。
6. 登录后检查配置、监控数据和采集器状态。

如果恢复后出现解密失败，优先检查 `data.key` 是否和 SQLite 匹配。
