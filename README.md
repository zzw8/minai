# MinAI

MinAI 是一个面向 1H1G 小服务器的轻量 AI 对话网站。它使用零第三方依赖的 Python 后端和原生前端，支持 OpenAI-compatible 第三方 API Key、后台管理、登录限制、对话保存、图片生成和动态模型列表。

## 功能特性

- 前台对话页，支持浅色/深色模式、附件上传、历史对话、星标置顶和删除对话。
- 后台 `/admin` 管理站点变量、用户、管理员和第三方 API 通道。
- API 通道采用 Chatbox 风格配置：名称、API Host、API Path、API Key、模型。
- 后台可一键从当前 API 通道获取模型列表，并填入默认模型。
- API Key 只保存在服务器端，不会下发到浏览器。
- 默认要求用户登录后才能使用 AI。
- 支持 OpenAI-compatible 文本模型和图片模型。
- 图片生成采用后台任务轮询，避免长请求导致页面超时。
- 前台模型列表默认使用上游 `/models` 返回的完整列表，适配不同第三方 API Key。

## 技术栈

- 后端：Python 3.9+ 标准库
- 前端：HTML / CSS / 原生 JavaScript
- 数据：本地 JSON 文件，无数据库依赖
- 部署：systemd + Nginx / aaPanel 反向代理

## 目录结构

```text
.
├── server.py                 # 主后端服务
├── public/                   # 前端页面和静态资源
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── admin.html
│   ├── admin.js
│   ├── admin.css
│   └── assets/
├── tools/                    # 本地/服务器验证脚本
├── .env.example              # 环境变量示例
├── ecosystem.config.cjs      # PM2 Python 启动示例
└── package.json              # 可选 npm 脚本入口
```

运行后会自动创建 `data/` 目录：

```text
data/settings.json
data/providers.json
data/users.json
data/conversations.json
data/secret.key
data/generated/
```

`data/` 包含用户、API Key、会话、Cookie 签名密钥和生成图片，已经被 `.gitignore` 排除，不应提交到 GitHub。

## 一键部署

Debian / Ubuntu 服务器可以直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/zzw8/minai/main/scripts/install.sh | bash
```

默认安装到：

```text
/www/wwwroot/minai
```

默认创建 systemd 服务：

```bash
systemctl status minai
```

如需修改安装目录或端口：

```bash
curl -fsSL https://raw.githubusercontent.com/zzw8/minai/main/scripts/install.sh | MINAI_DIR=/www/wwwroot/minai MINAI_PORT=3000 bash
```

安装完成后编辑：

```bash
nano /www/wwwroot/minai/.env
systemctl restart minai
```

然后用 Nginx 或 aaPanel / 宝塔国际版把站点反向代理到：

```text
http://127.0.0.1:3000
```

首次访问 `/admin` 创建管理员账号，再在后台配置 API 通道并点击“获取模型”。

## aaPanel / 宝塔国际版配置

宝塔不是必须项。推荐先用上面的一键部署脚本运行后端，再只使用宝塔管理域名、SSL 和反向代理。这样进程由 systemd 托管，重启和开机自启更稳定。

配置步骤：

1. 在宝塔中创建站点，域名填写你的实际域名。
2. 网站目录可填写 `/www/wwwroot/minai/public`，不需要启用 PHP。
3. 在站点设置里开启反向代理。
4. 代理名称填写 `minai`。
5. 目标 URL 填写 `http://127.0.0.1:3000`。
6. 发送域名保持默认或填写 `$host`。
7. 在 SSL 页面申请并开启 Let’s Encrypt 证书。
8. 访问 `https://你的域名/admin` 初始化管理员账号。

如果你不用宝塔，直接使用 Nginx 反向代理即可。

## 本地运行

复制环境变量示例：

```bash
cp .env.example .env
```

修改 `.env`：

```env
PORT=3000
SITE_TITLE=MinAI
API_BASE_URL=https://api.openai.com/v1
API_KEY=your_api_key_here
AI_MODEL=gpt-4o-mini
SYSTEM_PROMPT=你是一个专业、简洁、友好的 AI 助手。请优先用中文回答，除非用户要求其他语言。
```

启动：

```bash
python3 server.py
```

访问：

```text
http://127.0.0.1:3000
http://127.0.0.1:3000/admin
```

首次进入 `/admin` 会创建管理员账号。创建后建议在后台配置 API 通道，不要把真实 API Key 写入仓库。

## 第三方 API 配置

后台路径：

```text
/admin
```

推荐配置方式：

- API 模式：OpenAI API 兼容
- API Host：例如 `https://api.openai.com/v1` 或第三方兼容接口地址
- API Path：例如 `/chat/completions`
- API Key：第三方平台密钥
- 默认模型：可手动填写，也可以点击后台“获取模型”后从返回列表中选择

如果使用图片模型，当前推荐 `gpt-image-2-all`。

## 部署到 1H1G 服务器

上传项目到服务器：

```bash
scp -r . root@your-server:/www/wwwroot/minai
```

启动服务：

```bash
cd /www/wwwroot/minai
python3 server.py
```

生产环境建议使用 systemd：

```ini
[Unit]
Description=MinAI lightweight AI website
After=network.target

[Service]
WorkingDirectory=/www/wwwroot/minai
ExecStart=/usr/bin/python3 /www/wwwroot/minai/server.py
Restart=always
RestartSec=3
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Nginx 反向代理：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

aaPanel / 宝塔国际版只建议作为反向代理和 SSL 面板使用，反向代理目标填写：

```text
http://127.0.0.1:3000
```
