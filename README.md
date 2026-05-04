# MinAI

MinAI 是一个面向 1H1G 小服务器的轻量 AI 对话网站。它使用零第三方依赖的 Python 后端和原生前端，支持 OpenAI-compatible 第三方 API Key、后台管理、登录限制、对话保存、图片生成和精选模型列表。

## 功能特性

- 前台对话页，支持浅色/深色模式、附件上传、历史对话、星标置顶和删除对话。
- 后台 `/admin` 管理站点变量、用户、管理员和第三方 API 通道。
- API 通道采用 Chatbox 风格配置：名称、API Host、API Path、API Key、模型。
- API Key 只保存在服务器端，不会下发到浏览器。
- 默认要求用户登录后才能使用 AI。
- 支持 OpenAI-compatible 文本模型和图片模型。
- 图片生成采用后台任务轮询，避免长请求导致页面超时。
- 模型列表默认只展示核心模型，减少用户选择成本。

## 技术栈

- 后端：Python 3.9+ 标准库
- 前端：HTML / CSS / 原生 JavaScript
- 数据：本地 JSON 文件，无数据库依赖
- 部署：systemd、PM2 或 aaPanel / 宝塔国际版反向代理

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

## 本地运行

复制环境变量示例：

```bash
cp .env.example .env
```

修改 `.env`：

```env
PORT=3000
SITE_TITLE=MinAI
API_BASE_URL=https://yunwu.ai/v1
API_KEY=your_api_key_here
AI_MODEL=deepseek-v3-1-250821
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
- API Host：例如 `https://yunwu.ai/v1`
- API Path：例如 `/chat/completions`
- API Key：第三方平台密钥
- 默认模型：例如 `deepseek-v3-1-250821`

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

aaPanel / 宝塔国际版中可以创建 Python 项目，启动文件填写：

```text
server.py
```

反向代理目标填写：

```text
http://127.0.0.1:3000
```

## GitHub 发布注意事项

发布前确认以下文件不会被提交：

- `.env`
- `data/`
- `generated/`
- `screenshots/`
- `__pycache__/`
- 临时部署脚本或包含服务器密码/API Key 的文件

本仓库未附带开源许可证。如需公开给其他人复用，建议在发布前明确选择许可证，例如 MIT、Apache-2.0 或保持私有仓库。
