# MinAI

MinAI 是一个面向 1H1G 小服务器的轻量 AI 对话网站。它使用 Python 标准库后端和原生前端，支持 OpenAI-compatible 第三方 API Key、后台管理、登录限制、对话保存、图片生成、动态模型读取和前台模型开放控制。

## 功能特性

- 前台对话页支持浅色/深色模式、附件上传、历史对话、星标置顶和删除对话。
- 后台 `/admin` 可管理站点变量、用户、管理员和第三方 API 通道。
- API 通道采用 Chatbox 风格配置：名称、API Host、API Path、API Key、默认模型。
- 后台可从当前 API 通道读取模型列表，并勾选哪些模型允许在前台被用户调用。
- API Key 只保存在服务器端，不会下发到浏览器。
- 默认要求用户登录后才能使用 AI。
- 支持 OpenAI-compatible 文本模型和图片模型。
- 图片生成采用后台任务轮询，避免长请求导致页面超时。

## 技术栈

- 后端：Python 3.9+ 标准库
- 前端：HTML / CSS / 原生 JavaScript
- 数据：本地 JSON 文件，无数据库依赖
- 推荐部署：systemd 运行后端，Nginx 或 aaPanel / 宝塔国际版做反向代理和 SSL

## 目录结构

```text
.
├── server.py
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── admin.html
│   ├── admin.js
│   ├── admin.css
│   └── assets/
├── scripts/
│   └── install.sh
├── tools/
├── .env.example
├── ecosystem.config.cjs
└── package.json
```

运行后会自动创建 `data/` 目录，用于保存用户、API Key、对话、Cookie 签名密钥和生成图片。`data/` 不应提交到公开仓库。

## 推荐部署流程

### 1. 准备服务器

推荐系统：

```text
Debian 11+ 或 Ubuntu 20.04+
```

建议配置：

```text
1 核 CPU / 1 GB 内存 / 10 GB 磁盘
```

### 2. 一键安装

使用 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/zzw8/minai/main/scripts/install.sh | bash
```

默认安装目录：

```text
/www/wwwroot/minai
```

默认服务：

```bash
systemctl status minai
```

修改安装目录或端口：

```bash
curl -fsSL https://raw.githubusercontent.com/zzw8/minai/main/scripts/install.sh | MINAI_DIR=/www/wwwroot/minai MINAI_PORT=3000 bash
```

### 3. 配置环境变量

编辑 `.env`：

```bash
nano /www/wwwroot/minai/.env
```

示例：

```env
PORT=3000
SITE_TITLE=MinAI
API_BASE_URL=https://api.openai.com/v1
API_KEY=your_api_key_here
AI_MODEL=gpt-4o-mini
SYSTEM_PROMPT=你是一个专业、简洁、友好的 AI 助手。请优先用中文回答，除非用户要求其他语言。
```

保存后重启：

```bash
systemctl restart minai
```

### 4. 配置反向代理和 SSL

后端默认监听：

```text
http://127.0.0.1:3000
```

如果直接使用 Nginx，可添加：

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

如果使用 aaPanel / 宝塔国际版，建议只把它作为站点、SSL 和反向代理面板使用，不建议再用面板额外托管 Python 进程。

宝塔配置步骤：

1. 创建站点，域名填写你的实际域名。
2. 网站目录可填写 `/www/wwwroot/minai/public`，不需要启用 PHP。
3. 在站点设置中开启反向代理。
4. 代理名称填写 `minai`。
5. 目标 URL 填写 `http://127.0.0.1:3000`。
6. SSL 页面申请并开启 Let’s Encrypt 证书。
7. 访问 `https://你的域名/admin` 初始化管理员账号。

### 5. 初始化后台

访问：

```text
https://你的域名/admin
```

首次进入会创建管理员账号。创建后进入后台完成：

1. 配置 API Host、API Path、API Key 和默认模型。
2. 点击“获取模型”读取第三方接口返回的模型列表。
3. 勾选允许在前台给用户调用的模型。
4. 点击“保存”生效。

如果不勾选模型开放范围，系统会保持兼容模式，前台默认展示上游返回的全部模型。读取并保存勾选后，前台只展示被勾选的模型，未勾选模型不能被调用。

## 本地运行

```bash
cp .env.example .env
python3 server.py
```

访问：

```text
http://127.0.0.1:3000
http://127.0.0.1:3000/admin
```

## 手动部署

如果不使用一键脚本，可以手动上传项目：

```bash
scp -r . root@your-server:/www/wwwroot/minai
cd /www/wwwroot/minai
cp .env.example .env
python3 server.py
```

生产环境仍建议使用 systemd：

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
