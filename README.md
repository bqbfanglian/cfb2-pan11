# CFB2 网盘

CFB2 是基于 Cloudflare Workers 的个人资源分发工具。收到链接的访客直接访问分享页。管理员在 `/admin` 上传资源、管理分享和接入 Backblaze B2 私有桶，Worker 自动分配新上传。

## 网页部署教程

全程用浏览器操作。准备 Cloudflare、GitHub 和 Backblaze B2 账号。

### 1. 一键部署 Worker 和 D1

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bqbfanglian/CFB2-Pan)

1. 点上面的按钮，登录 Cloudflare 并授权 GitHub。Cloudflare 会在你的 GitHub 账号下创建一个用于部署的仓库。若已有同名仓库，给新仓库取一个不同的名字，例如 `cfb2-pan-deploy`。 [Cloudflare 部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
2. 保留页面预填的 D1 和构建设置，部署命令用 `npm run deploy`。按下表填写两个 Secret，点击部署。Cloudflare 会创建和绑定 D1，部署命令会执行数据库迁移。首次部署和后续更新都无需手填数据库 ID 或粘贴 SQL。

   | Secret | 填写内容 |
   | --- | --- |
   | `ADMIN_PASSWORD` | 自设的管理员密码，16 至 128 个字符 |
   | `SHARE_SECRET` | 独立生成的随机字符串，至少 32 字节，例如 40 位随机字母和数字 |

   请备份并保留 `SHARE_SECRET`，它用于解密后台保存的桶密钥和复制已有分享链接。

3. 部署成功后，在 Worker 的 **Settings → Domains & Routes** 复制 `workers.dev` 地址。若账户首次使用 `workers.dev`，按控制台提示注册子域名。 [Cloudflare 的 `workers.dev` 地址](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

### 2. 在 Backblaze 准备私有桶和密钥

1. 打开 Backblaze 控制台，进入 **B2 Cloud Storage → Buckets → Create a Bucket**。选 **Private** 创建桶。记下桶名和 **S3 Endpoint**，例如 `s3.us-west-004.backblazeb2.com` 对应区域 `us-west-004`。可以先接入一个桶，之后再扩充。保留默认跨域配置。 [Backblaze 建桶](https://www.backblaze.com/docs/cloud-storage-create-and-manage-buckets)
2. 打开 **Application Keys → Add a New Application Key**，每个桶分别建一把密钥。

   | 表单字段 | 填写内容 |
   | --- | --- |
   | Name of Key | 自取，例如 `cfb2-pan-primary` |
   | Allow Access to Bucket(s) | 选择这把密钥对应的桶 |
   | Type of Access | **Read and Write** |
   | File Name Prefix | `cfb2-pan/` |

   点 **Create New Key** 后，保存显示的 `keyID` 和 `applicationKey`。密钥值只在创建时显示。 [Backblaze 应用密钥](https://www.backblaze.com/docs/en/cloud-storage-get-started-with-a-backblaze-integration#scoped-application-key-recommended)

### 3. 在管理台接入桶并发布资源

1. 打开站点的 `/admin`，用 `ADMIN_PASSWORD` 登录。进入 **存储 → 添加存储桶**。
2. 填第 2 步拿到的桶名、S3 区域、Key ID 和 Application Key。应用配额以 GiB 填写，例如 `10`。优先级只在占用率相同时生效，数值较小者优先。点 **验证并添加**，成功后应出现桶卡片和容量。Worker 会检查读写连通性，并加密保存桶密钥。
3. 进入 **资源 → 上传文件**。上传后点文件右侧的**创建分享**按钮。密码留空的分享可在无痕窗口直接下载。回到 **分享** 撤销链接后，访客的新下载请求会被拒绝。

<details>
<summary>直接使用现有 GitHub 仓库部署</summary>

1. 在 Cloudflare 的 **D1 SQL Database** 创建 `cfb2-pan`。打开 [初始化 SQL](migrations/0001_initial.sql)，点 **Raw** 并复制全文，粘贴进该库的 **Console**，点 **Execute**。 [D1 控制台执行 SQL](https://developers.cloudflare.com/d1/get-started/#populate-your-d1-database)
2. 复制该库的 **Database ID**，把部署仓库根目录 `wrangler.jsonc` 中的全零 `database_id` 替换掉，保留绑定名 `DB`。这一步只需做一次。同一 Worker 更新时继续使用该数据库。
3. 进入 **Workers & Pages → Create application → GitHub**，选择这个仓库和 `main` 分支。Worker 名用 `cfb2-pan`，构建命令填 `npm run check`，部署命令填 `npx wrangler deploy`，使用默认构建令牌。 [Workers Builds 导入仓库](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-a-new-worker)
4. 在 Worker 的 **Settings → Variables and Secrets** 添加第 1 节表格中的两个 **Secret**，再到 **Domains & Routes** 复制访问地址。 [Worker Secret 设置](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)

</details>

### 使用自定义域名

在 **Settings → Domains & Routes → Add → Custom Domain** 添加自己的主机名。若只用一个域名，直接用该地址登录和创建分享。若分开管理和分享域名，添加两个 Custom Domain，再在 **Variables and Secrets** 添加两项 **Text** 变量。`ADMIN_HOST` 填管理主机名，`SHARE_HOST` 填分享主机名，例如 `drive.example.com` 和 `share.example.com`。只填主机名，地址可继续沿用来保留旧分享。 [绑定 Worker 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#set-up-a-custom-domain-in-the-dashboard)

### 卡在哪一步就查哪一项

| 现象 | 检查位置 |
| --- | --- |
| Cloudflare 的导入列表没有仓库 | 查看 GitHub 的 Cloudflare 应用授权，确认允许访问该仓库。 |
| 构建日志提示 D1 绑定错误，或网盘打不开文件列表 | 在 Worker 的 **Bindings** 确认 `DB` 指向正确的 D1，在 D1 的 **Tables** 确认已有 `entries` 和 `bucket_settings`。 |
| 自动迁移提示 D1 权限不足 | 给 Workers Builds 使用的 API 令牌添加当前账户的 **D1 → Edit** 权限，再重试部署。 [构建令牌设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token) |
| 登录时提示管理员密码未配置 | 在 **Variables and Secrets** 添加或更新 `ADMIN_PASSWORD`，保存并部署设置。 |
| 绑定的自定义域名打不开 | 在 **Domains & Routes** 确认域名已绑到正确的 Worker。如果设置过 `ADMIN_HOST` 或 `SHARE_HOST`，核对拼写。 |
| 添加桶提示验证失败 | 确认桶名、区域和密钥对应，密钥有 **Read and Write** 权限，且允许 `cfb2-pan/` 前缀。 |
| 「移除桶」不可用 | 桶仍有文件、未完成上传或待清理记录。处理后等待定时清理，再刷新后台。 |

## 日常使用

- **存储**页可暂停或恢复新上传分配。正在上传的文件可续传，旧文件和分享照常下载。没有文件或上传引用的桶可从网盘移除，Backblaze 上的桶会保留。
- Worker 按上传后的占用率选桶，占用率相同再看 `priority`。写入前探测失败会换桶，已开始写入的会话固定在原桶。单文件上限 1 GiB，上传中断后，在同一浏览器和目录重新选原文件即可续传。
- 删除后会立即停止新下载，定时任务删除 B2 对象版本后释放配额。请分别备份 D1 元数据与要保留的 B2 文件。 [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## 本地开发

```bash
npm ci
npm run dev
```

打开 [本地管理台](http://127.0.0.1:8787/admin)，使用演示密码 `cfb2-demo-password` 登录。本地演示使用 Wrangler 模拟的 D1 和对象桶，数据位于 `.wrangler/state`。运行 `npm run check` 检查代码，运行 `npm run build` 验证部署构建。Windows PowerShell 可使用 `npm.cmd`。
