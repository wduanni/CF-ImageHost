# 🌌 Cloudflare 免费轻量直链图床

基于 Cloudflare 生态构建的轻量级直链图床，支持后台管理面板，高效、稳定与免费。

---

## 🛠️ 准备工作

在开始部署之前，请确保你的 Cloudflare 账户中已准备好以下组件：

* **新建 Worker**：用于提供图床的核心路由与后台服务（直接选用基础的 **Hello World** 模板即可）。
* **新建 R2 存储桶**：用于存储上传的图片文件，名称可自定义（例如：`my-image-bucket`）。
* **新建 D1 数据库**：用于存储图片的元数据（如文件名、尺寸、上传时间等），名称可自定义。

---

## ⚙️ 配置指南

### 1. Worker 环境变量与绑定

请前往你创建的 Worker 控制台 -> **设置 (Settings)**，进行以下配置：

#### 🔹 环境变量 (Environment Variables)
添加以下环境变量用于后台安全认证：

| 变量名称 | 类型 | 说明 |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | 文本 / 加密 | 后台管理面板的登录密码 |
| `SESSION_SECRET` | 文本 / 加密 | Session 加密密钥（建议填写一段随机的长字符串） |

#### 🔹 变量绑定 (Bindings)
将准备好的存储与数据库资源绑定到当前 Worker 中：

| 绑定类型 | 变量名称 (Variable Name) | 绑定的资源对象 |
| :--- | :--- | :--- |
| **R2 存储桶绑定** | `BUCKET` | 选择步骤 1 中创建的 **R2 存储桶** |
| **D1 数据库绑定** | `DB` | 选择步骤 1 中创建的 **D1 数据库** |
| **Images** | `IMAGES` | 绑定 Cloudflare Images 资源 |

---

### 2. D1 数据库初始化

进入你创建的 **D1 数据库** 控制台，点击 **控制台 (Console)** 标签页，复制并粘贴以下 SQL 语句并执行，以创建所需的图片元数据表及索引：

```sql
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  url TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  keep INTEGER NOT NULL DEFAULT 0,
  original_name TEXT,
  uploaded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_uploaded_at ON images(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_images_keep_uploaded_at ON images(keep, uploaded_at);
```

---

## 🚀 部署上线

1. 打开 Worker 的 **代码编辑器 (Quick Edit)**。
2. 复制本项目 `worker.js` 中的全部代码，覆盖粘贴到编辑器中。
3. 点击右上角的 **部署 (Save and deploy)**。

部署完成后，你便可以通过 Cloudflare 分配的默认域名（例如 `***.workers.dev`）直接访问并使用你的专属图床了。

> 💡 **设置自定义域名（推荐）**
> 
> 如果你有托管在 Cloudflare 的域名，建议在 Worker 的 **设置 -> 域** 中绑定你的独立域名，以获得更稳定的直链访问体验。
