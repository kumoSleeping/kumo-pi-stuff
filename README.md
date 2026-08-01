# kumo-pi-stuff(备份副本)

> ⚠️ **注意:这个仓库只是本地扩展的备份副本,不再用于 npm 发布。**

## 用途

本仓库只做一件事:**把本机 pi 的扩展(`~/.pi/agent/extensions/`)定期备份到 GitHub**。

- ❌ 不再发布到 npm(之前发布过的 `@kumovegetable/*` 包已撤回)
- ✅ 纯 GitHub 备份,防止本地误删/换机丢失

## 目录结构

```
kumo-pi-stuff/
├── README.md                 ← 本文件(仓库说明)
├── scripts/
│   └── backup-extensions.sh  ← 一键备份脚本
└── backup/
    ├── README.md             ← 副本目录说明
    └── extensions/           ← 扩展副本(脚本自动生成,勿手改)
```

## 使用方法

一键备份并推送:

```bash
./scripts/backup-extensions.sh
```

脚本会:
1. 把 `~/.pi/agent/extensions/` 同步复制到 `backup/extensions/`
2. 自动 `git commit`(带时间戳)
3. 推送到 GitHub(`origin/main`)

## 恢复方式

需要恢复时,从 `backup/extensions/` 拷回 `~/.pi/agent/extensions/` 即可:

```bash
rsync -a ~/.pi/agent/kumo-pi-stuff/backup/extensions/ ~/.pi/agent/extensions/
```

## 注意

- `backup/extensions/` 里的内容由脚本自动生成,手动修改会在下次备份时被覆盖
- 备份只包含扩展源码,不含密钥/凭证(token 等在 `~/.pi/agent/auth.json`,**不要**放进这个仓库)
