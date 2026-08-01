# backup/ —— 扩展副本目录

此目录由 `../scripts/backup-extensions.sh` 自动生成,内容为 `~/.pi/agent/extensions/`
的同步副本,仅作 GitHub 备份用途。

- ⚠️ **请勿手动修改此目录** —— 下次运行备份脚本时会被覆盖
- 需要恢复时,用 rsync 拷回 `~/.pi/agent/extensions/`
