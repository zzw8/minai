#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import posixpath
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
GENERATED_DIR = DATA_DIR / "generated"
SETTINGS_PATH = DATA_DIR / "settings.json"
USERS_PATH = DATA_DIR / "users.json"
PROVIDERS_PATH = DATA_DIR / "providers.json"
CONVERSATIONS_PATH = DATA_DIR / "conversations.json"
SECRET_PATH = DATA_DIR / "secret.key"
SESSION_COOKIE = "minai_session"
SESSION_MAX_AGE = 7 * 24 * 60 * 60
MAX_BODY_SIZE = 16 * 1024 * 1024
GENERATED_IMAGE_MAX_BYTES = 25 * 1024 * 1024
IMAGE_GENERATION_TIMEOUT = 30 * 60
IMAGE_JOB_TTL = 6 * 60 * 60
DEFAULT_SYSTEM_PROMPT = "你是一个专业、简洁、友好的 AI 助手。请优先用中文回答，除非用户要求其他语言。"
MODEL_CACHE = {}
IMAGE_JOBS = {}
IMAGE_JOBS_LOCK = threading.Lock()
IMAGE_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MODEL_ALIASES = {
    "gpt-image-2": "gpt-image-2-all",
}


class ModelFetchError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def load_env_file():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_env_file()


def read_json(path, fallback):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return fallback


def write_json(path, data):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    tmp_path.replace(path)


def ensure_data_files():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    if not USERS_PATH.exists():
        write_json(USERS_PATH, [])
    if not CONVERSATIONS_PATH.exists():
        write_json(CONVERSATIONS_PATH, {})
    if not PROVIDERS_PATH.exists():
        saved = read_json(SETTINGS_PATH, {})
        provider = new_provider(
            {
                "name": "默认通道",
                "apiBaseUrl": saved.get("apiBaseUrl") or os.getenv("API_BASE_URL") or "https://api.openai.com/v1",
                "apiKey": saved.get("apiKey") or os.getenv("API_KEY") or "",
                "aiModel": saved.get("aiModel") or os.getenv("AI_MODEL") or "gpt-4o-mini",
                "enabled": True,
                "isDefault": True,
            }
        )
        write_json(PROVIDERS_PATH, [provider])
    if not SECRET_PATH.exists():
        SECRET_PATH.write_text(secrets.token_hex(48), "utf-8")
    return SECRET_PATH.read_text("utf-8").strip()


def clean_text(value, max_length):
    return str(value or "").strip()[:max_length]


def normalize_model_id(model_id):
    cleaned = clean_text(model_id, 160)
    return MODEL_ALIASES.get(cleaned.lower(), cleaned)


def display_model_name(model_id):
    return normalize_model_id(model_id)


def strip_trailing_slash(value):
    return str(value or "").strip().rstrip("/")


def infer_api_path(api_host):
    parsed = urllib.parse.urlparse(strip_trailing_slash(api_host))
    path = parsed.path.rstrip("/")
    if path.endswith("/chat/completions"):
        return ""
    if path.endswith("/v1"):
        return "/chat/completions"
    if path in {"", "/"}:
        return "/v1/chat/completions"
    return "/chat/completions"


def chat_completions_url(provider_or_host, api_path=None):
    if isinstance(provider_or_host, dict):
        host = strip_trailing_slash(provider_or_host.get("apiHost") or provider_or_host.get("apiBaseUrl"))
        path = str(provider_or_host.get("apiPath") or "").strip()
    else:
        host = strip_trailing_slash(provider_or_host)
        path = str(api_path or "").strip()

    parsed = urllib.parse.urlparse(host)
    if parsed.path.rstrip("/").endswith("/chat/completions"):
        return host
    if not path:
        path = infer_api_path(host)
    if path and not path.startswith("/"):
        path = f"/{path}"
    return f"{host}{path}"


def models_url(provider):
    endpoint = chat_completions_url(provider)
    parsed = urllib.parse.urlparse(endpoint)
    path = parsed.path.rstrip("/")
    if path.endswith("/chat/completions"):
        path = path[: -len("/chat/completions")] + "/models"
    elif path.endswith("/completions"):
        path = path[: -len("/completions")] + "/models"
    else:
        path = path + "/models"
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def image_generations_url(provider):
    endpoint = chat_completions_url(provider)
    parsed = urllib.parse.urlparse(endpoint)
    path = parsed.path.rstrip("/")
    if path.endswith("/chat/completions"):
        path = path[: -len("/chat/completions")] + "/images/generations"
    elif path.endswith("/completions"):
        path = path[: -len("/completions")] + "/images/generations"
    elif path.endswith("/v1"):
        path = path + "/images/generations"
    else:
        path = path + "/v1/images/generations"
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def new_provider(data):
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return {
        "id": secrets.token_hex(16),
        "name": clean_text(data.get("name") or "默认通道", 60) or "默认通道",
        "apiMode": clean_text(data.get("apiMode") or "openai-compatible", 40) or "openai-compatible",
        "apiHost": strip_trailing_slash(data.get("apiHost") or data.get("apiBaseUrl") or "https://api.openai.com"),
        "apiPath": clean_text(data.get("apiPath") or "", 120),
        "apiKey": str(data.get("apiKey") or "").strip(),
        "aiModel": clean_text(data.get("aiModel") or "gpt-4o-mini", 80) or "gpt-4o-mini",
        "enabled": bool(data.get("enabled", True)),
        "isDefault": bool(data.get("isDefault")),
        "calls": 0,
        "success": 0,
        "failed": 0,
        "promptTokens": 0,
        "completionTokens": 0,
        "totalTokens": 0,
        "lastStatus": "",
        "lastError": "",
        "lastUsedAt": "",
        "createdAt": now,
        "updatedAt": now,
    }


APP_SECRET = ensure_data_files()


def get_settings():
    saved = read_json(SETTINGS_PATH, {})
    return {
        "siteTitle": clean_text(saved.get("siteTitle") or os.getenv("SITE_TITLE") or "MinAI", 40) or "MinAI",
        "systemPrompt": clean_text(saved.get("systemPrompt") or os.getenv("SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT, 4000)
        or DEFAULT_SYSTEM_PROMPT,
        "requireLogin": bool(saved.get("requireLogin", True)),
    }


def admin_settings(settings):
    active_provider = get_active_provider(require_key=False)
    return {
        "siteTitle": settings["siteTitle"],
        "systemPrompt": settings["systemPrompt"],
        "requireLogin": settings["requireLogin"],
        "activeProvider": public_provider(active_provider) if active_provider else None,
    }


def list_providers():
    providers = read_json(PROVIDERS_PATH, [])
    if not isinstance(providers, list):
        return []
    changed = False
    for provider in providers:
        if not provider.get("apiHost"):
            provider["apiHost"] = strip_trailing_slash(provider.get("apiBaseUrl") or "https://api.openai.com")
            changed = True
        if not provider.get("apiMode"):
            provider["apiMode"] = "openai-compatible"
            changed = True
        if "apiPath" not in provider:
            provider["apiPath"] = infer_api_path(provider.get("apiHost") or provider.get("apiBaseUrl"))
            changed = True
        provider["apiBaseUrl"] = provider.get("apiHost")
        for key, fallback in {
            "calls": 0,
            "success": 0,
            "failed": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "totalTokens": 0,
            "lastStatus": "",
            "lastError": "",
            "lastUsedAt": "",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }.items():
            if key not in provider:
                provider[key] = fallback
                changed = True
    if changed:
        save_providers(providers)
    return providers


def save_providers(providers):
    if providers and not any(provider.get("isDefault") for provider in providers):
        providers[0]["isDefault"] = True
    write_json(PROVIDERS_PATH, providers)


def public_provider(provider):
    if not provider:
        return None
    return {
        "id": provider.get("id"),
        "name": provider.get("name"),
        "apiMode": provider.get("apiMode") or "openai-compatible",
        "apiHost": provider.get("apiHost") or provider.get("apiBaseUrl"),
        "apiPath": provider.get("apiPath") or "",
        "apiBaseUrl": provider.get("apiHost") or provider.get("apiBaseUrl"),
        "endpointUrl": chat_completions_url(provider),
        "aiModel": normalize_model_id(provider.get("aiModel")),
        "enabled": bool(provider.get("enabled")),
        "isDefault": bool(provider.get("isDefault")),
        "apiKeySet": bool(provider.get("apiKey")),
        "apiKeyPreview": mask_key(provider.get("apiKey")),
        "calls": int(provider.get("calls") or 0),
        "success": int(provider.get("success") or 0),
        "failed": int(provider.get("failed") or 0),
        "promptTokens": int(provider.get("promptTokens") or 0),
        "completionTokens": int(provider.get("completionTokens") or 0),
        "totalTokens": int(provider.get("totalTokens") or 0),
        "lastStatus": provider.get("lastStatus") or "",
        "lastError": provider.get("lastError") or "",
        "lastUsedAt": provider.get("lastUsedAt") or "",
        "createdAt": provider.get("createdAt"),
        "updatedAt": provider.get("updatedAt"),
    }


def mask_key(value):
    key = str(value or "")
    if not key:
        return ""
    if len(key) <= 10:
        return "已设置"
    return f"{key[:4]}...{key[-4:]}"


def get_active_provider(require_key=True):
    providers = list_providers()
    candidates = [provider for provider in providers if provider.get("enabled")]
    if require_key:
        candidates = [provider for provider in candidates if provider.get("apiKey")]
    default_provider = next((provider for provider in candidates if provider.get("isDefault")), None)
    return default_provider or (candidates[0] if candidates else None)


def set_default_provider(providers, provider_id):
    for provider in providers:
        provider["isDefault"] = provider.get("id") == provider_id


def update_provider_stats(provider_id, ok, status, usage=None, error_message=""):
    providers = list_providers()
    for provider in providers:
        if provider.get("id") != provider_id:
            continue
        provider["calls"] = int(provider.get("calls") or 0) + 1
        provider["success" if ok else "failed"] = int(provider.get("success" if ok else "failed") or 0) + 1
        provider["lastStatus"] = str(status)
        provider["lastError"] = "" if ok else clean_text(error_message, 300)
        provider["lastUsedAt"] = now_iso()
        provider["updatedAt"] = now_iso()
        if isinstance(usage, dict):
            provider["promptTokens"] = int(provider.get("promptTokens") or 0) + int(usage.get("prompt_tokens") or 0)
            provider["completionTokens"] = int(provider.get("completionTokens") or 0) + int(
                usage.get("completion_tokens") or 0
            )
            provider["totalTokens"] = int(provider.get("totalTokens") or 0) + int(usage.get("total_tokens") or 0)
        break
    save_providers(providers)


def public_model(model):
    if isinstance(model, str):
        model = {"id": model}
    if not isinstance(model, dict):
        return None
    model_id = normalize_model_id(model.get("id"))
    if not model_id:
        return None
    endpoints = model.get("supported_endpoint_types") if isinstance(model.get("supported_endpoint_types"), list) else []
    return {
        "id": model_id,
        "name": display_model_name(model_id),
        "type": clean_text(model.get("model_type") or "模型", 40),
        "tags": clean_text(model.get("tags") or "", 160),
        "description": clean_text(model.get("description") or "", 220),
        "endpoints": endpoints,
    }


def public_models_from_upstream(upstream):
    if isinstance(upstream, dict) and isinstance(upstream.get("data"), list):
        raw_models = upstream.get("data")
    elif isinstance(upstream, list):
        raw_models = upstream
    else:
        raw_models = []

    deduped_models = {}
    for model in raw_models:
        public = public_model(model)
        if public:
            deduped_models[public["id"]] = public
    return list(deduped_models.values())


def fetch_provider_model_payload(provider):
    if not provider.get("apiKey"):
        raise ModelFetchError(400, "请先填写 API Key 后再获取模型。")

    request = urllib.request.Request(
        models_url(provider),
        headers={
            "Accept": "application/json",
            "Authorization": f'Bearer {provider["apiKey"]}',
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            upstream = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        error_text = error.read().decode("utf-8", "replace")
        try:
            error_json = json.loads(error_text)
        except Exception:
            error_json = {}
        message = (
            ((error_json.get("error") or {}).get("message") if isinstance(error_json.get("error"), dict) else None)
            or error_json.get("message")
            or f"模型列表请求失败，状态码 {error.code}"
        )
        raise ModelFetchError(error.code, message)
    except Exception:
        raise ModelFetchError(502, "无法获取模型列表，请检查 API Host、API Path、API Key 或服务器网络。")

    models = public_models_from_upstream(upstream)
    return {
        "provider": public_provider(provider),
        "defaultModel": display_model_name(provider.get("aiModel")),
        "defaultModelId": normalize_model_id(provider.get("aiModel")),
        "models": models,
        "count": len(models),
    }


def is_image_model(model_id):
    text = str(model_id or "").lower()
    image_keywords = (
        "image",
        "dall-e",
        "seedream",
        "wanx",
        "flux",
        "stable-diffusion",
        "sdxl",
        "midjourney",
        "mj-",
        "jimeng",
        "kolors",
        "hidream",
        "ideogram",
    )
    return any(keyword in text for keyword in image_keywords)


def latest_user_prompt(messages):
    for message in reversed(messages):
        content = message.get("content")
        if message.get("role") == "user" and isinstance(content, str) and content.strip():
            return content.strip()
        if message.get("role") == "user" and isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text" and str(item.get("text") or "").strip():
                    return str(item.get("text")).strip()
    return ""


def extract_response_images(upstream, message):
    images = []

    def add(value):
        if not isinstance(value, str):
            return
        value = value.strip()
        if value and (value.startswith("http://") or value.startswith("https://") or value.startswith("data:image/")):
            images.append(value)

    def add_b64(value, mime_type="image/png"):
        if isinstance(value, str) and value.strip():
            add(f"data:{mime_type};base64,{value.strip()}")

    def add_image_value(value, mime_type="image/png"):
        if not isinstance(value, str):
            return
        stripped = value.strip()
        if not stripped:
            return
        if stripped.startswith("http://") or stripped.startswith("https://") or stripped.startswith("data:image/"):
            add(stripped)
            return
        if looks_like_base64(stripped):
            add_b64(stripped, mime_type)

    def scan(value):
        if isinstance(value, str):
            add(value)
            return
        if isinstance(value, list):
            for item in value:
                scan(item)
            return
        if not isinstance(value, dict):
            return

        add(value.get("url"))
        add_image_value(value.get("image"), value.get("mime_type") or value.get("mimeType") or "image/png")
        add(value.get("image_url") if isinstance(value.get("image_url"), str) else None)
        add(value.get("data_url"))
        add(value.get("dataUrl"))
        add_b64(value.get("b64_json"), value.get("mime_type") or value.get("mimeType") or "image/png")
        add_b64(value.get("base64"), value.get("mime_type") or value.get("mimeType") or "image/png")

        image_url = value.get("image_url")
        if isinstance(image_url, dict):
            scan(image_url)

        for nested_key in ("data", "images", "output", "result", "results", "content"):
            scan(value.get(nested_key))

    scan(message.get("images"))
    scan(upstream.get("images"))
    scan(upstream.get("data"))
    scan(upstream.get("output"))
    scan(upstream.get("result"))
    seen = set()
    unique = []
    for image in images:
        if image in seen:
            continue
        seen.add(image)
        unique.append(image)
    return unique[:4]


def looks_like_base64(value):
    if len(value) < 80 or len(value) % 4 not in (0, 2, 3):
        return False
    sample = value[:200].replace("\n", "").replace("\r", "")
    return all(char.isalnum() or char in "+/=_-" for char in sample)


def detect_image_extension(raw, content_type="", source_url=""):
    mime_type = str(content_type or "").split(";", 1)[0].strip().lower()
    if mime_type in IMAGE_EXTENSIONS:
        return IMAGE_EXTENSIONS[mime_type]
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if raw.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return ".webp"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    path = urllib.parse.urlparse(source_url).path
    extension = Path(path).suffix.lower()
    if extension in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return ".jpg" if extension == ".jpeg" else extension
    return ""


def save_generated_image(raw, extension):
    if not raw:
        return ""
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{int(time.time())}-{secrets.token_hex(8)}{extension or '.png'}"
    (GENERATED_DIR / filename).write_bytes(raw)
    return f"/generated/{filename}"


def store_data_image(image):
    header, encoded = image.split(",", 1)
    mime_type = header.split(";", 1)[0].removeprefix("data:")
    extension = IMAGE_EXTENSIONS.get(mime_type, ".png")
    raw = base64.b64decode(encoded, validate=False)
    if len(raw) > GENERATED_IMAGE_MAX_BYTES:
        raise ValueError("generated image is too large")
    return save_generated_image(raw, extension)


def store_remote_image(url):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
            "User-Agent": "MinAI/1.0 image fetcher",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read(GENERATED_IMAGE_MAX_BYTES + 1)
        if len(raw) > GENERATED_IMAGE_MAX_BYTES:
            raise ValueError("generated image is too large")
        extension = detect_image_extension(raw, response.headers.get("Content-Type", ""), url)
        if not extension:
            raise ValueError("remote result is not an image")
        return save_generated_image(raw, extension)


def stored_generated_images(images):
    stored = []
    for image in images:
        if not isinstance(image, str):
            continue
        image = image.strip()
        if image.startswith("http://") or image.startswith("https://"):
            try:
                stored_url = store_remote_image(image)
                if stored_url:
                    stored.append(stored_url)
                    continue
            except Exception:
                stored.append(image)
                continue
        if not image.startswith("data:image/"):
            stored.append(image)
            continue
        try:
            stored_url = store_data_image(image)
            if stored_url:
                stored.append(stored_url)
        except Exception:
            stored.append(image)
    return stored[:4]


def response_shape(value, depth=0):
    if depth > 2:
        return "..."
    if isinstance(value, dict):
        return {str(key): response_shape(value.get(key), depth + 1) for key in list(value.keys())[:12]}
    if isinstance(value, list):
        return [response_shape(value[0], depth + 1)] if value else []
    if isinstance(value, str):
        return f"str:{len(value)}"
    return type(value).__name__


def cleanup_image_jobs():
    cutoff = time.time() - IMAGE_JOB_TTL
    with IMAGE_JOBS_LOCK:
        stale_ids = [job_id for job_id, job in IMAGE_JOBS.items() if float(job.get("updatedAtTs") or 0) < cutoff]
        for job_id in stale_ids:
            IMAGE_JOBS.pop(job_id, None)


def public_image_job(job):
    payload = {
        "jobId": job.get("id"),
        "status": job.get("status"),
        "createdAt": job.get("createdAt"),
        "updatedAt": job.get("updatedAt"),
    }
    for key in ("reply", "images", "model", "usage", "error", "conversationId", "conversations"):
        if key in job:
            payload[key] = job.get(key)
    return payload


def set_image_job(job_id, **updates):
    with IMAGE_JOBS_LOCK:
        job = IMAGE_JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updatedAt"] = now_iso()
        job["updatedAtTs"] = time.time()


def create_image_generation_job(provider, selected_model, prompt, user_id, conversation_id, stored_messages):
    cleanup_image_jobs()
    job_id = secrets.token_hex(12)
    now = now_iso()
    job = {
        "id": job_id,
        "status": "queued",
        "userId": user_id or "",
        "conversationId": clean_text(conversation_id, 64),
        "createdAt": now,
        "updatedAt": now,
        "updatedAtTs": time.time(),
    }
    with IMAGE_JOBS_LOCK:
        IMAGE_JOBS[job_id] = job
    worker = threading.Thread(
        target=run_image_generation_job,
        args=(job_id, dict(provider), selected_model, prompt, user_id, conversation_id, stored_messages),
        daemon=True,
    )
    worker.start()
    return job


def run_image_generation_job(job_id, provider, selected_model, prompt, user_id, conversation_id, stored_messages):
    set_image_job(job_id, status="running")
    payload = {
        "model": selected_model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
    }
    request = urllib.request.Request(
        image_generations_url(provider),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f'Bearer {provider["apiKey"]}',
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=IMAGE_GENERATION_TIMEOUT) as response:
            upstream = json.loads(response.read().decode("utf-8"))
            images = extract_response_images(upstream, {})
            if not images:
                shape = clean_text(json.dumps(response_shape(upstream), ensure_ascii=False), 300)
                message = f"图片接口没有返回图片字段: {shape}"
                update_provider_stats(provider["id"], False, response.status, upstream.get("usage"), message)
                set_image_job(job_id, status="failed", error="图片生成完成，但返回里没有可展示的 url 或 b64_json。请换一个图片模型再试。")
                return

            images = stored_generated_images(images)
            update_provider_stats(provider["id"], True, response.status, upstream.get("usage"))
            conversation_payload = {}
            if user_id:
                assistant_message = {"role": "assistant", "content": "已生成图片。", "images": images}
                conversation_payload = upsert_user_conversation(
                    user_id,
                    conversation_id,
                    stored_messages + [assistant_message],
                )
            set_image_job(
                job_id,
                status="done",
                reply="已生成图片。",
                images=images,
                model=upstream.get("model") or selected_model,
                usage=upstream.get("usage"),
                conversationId=conversation_payload.get("conversationId") or clean_text(conversation_id, 64),
                conversations=conversation_payload.get("conversations", []),
            )
    except urllib.error.HTTPError as error:
        error_text = error.read().decode("utf-8", "replace")
        try:
            error_json = json.loads(error_text)
        except Exception:
            error_json = {}
        message = (
            ((error_json.get("error") or {}).get("message") if isinstance(error_json.get("error"), dict) else None)
            or error_json.get("message")
            or f"上游图片接口请求失败，状态码 {error.code}"
        )
        update_provider_stats(provider["id"], False, error.code, None, message)
        set_image_job(job_id, status="failed", error=message)
    except (TimeoutError, socket.timeout):
        message = "图片生成等待超时。上游可能仍在排队，请稍后重试或换一个图片模型。"
        update_provider_stats(provider["id"], False, "timeout", None, message)
        set_image_job(job_id, status="failed", error=message)
    except Exception as error:
        message = f"无法连接上游图片接口: {type(error).__name__}"
        update_provider_stats(provider["id"], False, "network", None, message)
        set_image_job(job_id, status="failed", error="无法连接上游图片接口，请检查 API 地址或服务器网络。")


def list_users():
    users = read_json(USERS_PATH, [])
    return users if isinstance(users, list) else []


def save_users(users):
    write_json(USERS_PATH, users)


def public_user(user):
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "displayName": user.get("displayName") or user.get("username"),
        "role": user.get("role"),
        "status": user.get("status"),
        "createdAt": user.get("createdAt"),
        "updatedAt": user.get("updatedAt"),
    }


def has_active_admin():
    return any(user.get("role") == "admin" and user.get("status") == "active" for user in list_users())


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64)
    return f"scrypt:{salt}:{digest.hex()}"


def verify_password(password, stored_hash):
    try:
        method, salt, digest_hex = str(stored_hash or "").split(":", 2)
        if method != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=64)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def b64url_encode(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def b64url_decode(value):
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def sign(value):
    return b64url_encode(hmac.new(APP_SECRET.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest())


def create_session_token(user):
    payload = {"sub": user["id"], "exp": int(time.time()) + SESSION_MAX_AGE}
    encoded = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{encoded}.{sign(encoded)}"


def verify_session_token(token):
    if not token or "." not in token:
        return None
    encoded, signature = token.split(".", 1)
    if not hmac.compare_digest(signature, sign(encoded)):
        return None
    try:
        payload = json.loads(b64url_decode(encoded).decode("utf-8"))
    except Exception:
        return None
    if not payload.get("sub") or int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def validate_password(password):
    if len(str(password or "")) < 8:
        return "密码至少需要 8 位。"
    return ""


def validate_user_input(username, password):
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@-")
    if not 3 <= len(username) <= 32 or any(char not in allowed for char in username):
        return "用户名只能包含字母、数字、下划线、点、@ 和短横线，长度 3-32 位。"
    return validate_password(password)


def normalize_messages(messages):
    if not isinstance(messages, list):
        return []
    normalized = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = clean_text(message.get("content"), 12000)
        files = message.get("files") if isinstance(message.get("files"), list) else []
        file_blocks = []
        image_parts = []
        for file in files[:6]:
            if not isinstance(file, dict):
                continue
            name = clean_text(file.get("name"), 120)
            file_type = clean_text(file.get("type"), 80)
            text = clean_text(file.get("text"), 60000)
            data_url = str(file.get("dataUrl") or "")
            if file_type.startswith("image/") and data_url.startswith("data:image/"):
                image_parts.append({"type": "image_url", "image_url": {"url": data_url}})
                if name:
                    file_blocks.append(f"\n\n[图片附件: {name}]")
            elif text:
                file_blocks.append(f"\n\n[附件: {name or '未命名文件'} | {file_type or 'text/plain'}]\n{text}")
            elif name:
                file_blocks.append(f"\n\n[附件: {name}]\n该附件不是可直接读取的文本文件。")
        if file_blocks:
            content = f"{content}{''.join(file_blocks)}"
        if not content and not image_parts:
            continue
        role = "assistant" if message.get("role") == "assistant" else "user"
        if image_parts and role == "user":
            parts = []
            if content:
                parts.append({"type": "text", "text": content})
            parts.extend(image_parts[:4])
            normalized.append({"role": role, "content": parts})
        else:
            normalized.append({"role": role, "content": content})
    return normalized[-16:]


def conversation_messages(messages):
    if not isinstance(messages, list):
        return []
    normalized = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = "assistant" if message.get("role") == "assistant" else "user"
        content = clean_text(message.get("content"), 12000)
        images = message.get("images") if isinstance(message.get("images"), list) else []
        files = message.get("files") if isinstance(message.get("files"), list) else []
        safe_images = [
            str(url)
            for url in images
            if isinstance(url, str)
            and (
                url.startswith("http://")
                or url.startswith("https://")
                or url.startswith("/generated/")
                or url.startswith("data:image/")
            )
        ][:4]
        safe_files = []
        for file in files[:6]:
            if not isinstance(file, dict):
                continue
            safe_files.append(
                {
                    "name": clean_text(file.get("name"), 120),
                    "type": clean_text(file.get("type"), 80),
                    "text": clean_text(file.get("text"), 60000),
                    "dataUrl": clean_text(file.get("dataUrl"), 2_500_000)
                    if str(file.get("type") or "").startswith("image/")
                    and str(file.get("dataUrl") or "").startswith("data:image/")
                    else "",
                }
            )
        if content or safe_images or safe_files:
            normalized.append({"role": role, "content": content, "images": safe_images, "files": safe_files})
    return normalized[-40:]


def read_conversations():
    data = read_json(CONVERSATIONS_PATH, {})
    return data if isinstance(data, dict) else {}


def conversation_title(messages):
    for message in messages:
        if message.get("role") == "user" and message.get("content"):
            title = " ".join(str(message.get("content")).split())
            return clean_text(title, 28) or "新对话"
    return "新对话"


def normalize_conversation_item(item):
    if not isinstance(item, dict):
        return None
    messages = conversation_messages(item.get("messages"))
    conversation_id = clean_text(item.get("id"), 64) or secrets.token_hex(8)
    updated_at = clean_text(item.get("updatedAt"), 40) or now_iso()
    created_at = clean_text(item.get("createdAt"), 40) or updated_at
    return {
        "id": conversation_id,
        "title": clean_text(item.get("title"), 60) or conversation_title(messages),
        "messages": messages,
        "pinned": bool(item.get("pinned")),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def normalize_user_conversation_store(raw):
    now = now_iso()
    if isinstance(raw, list):
        messages = conversation_messages(raw)
        if not messages:
            return {"activeId": "", "items": []}
        item = {
            "id": secrets.token_hex(8),
            "title": conversation_title(messages),
            "messages": messages,
            "createdAt": now,
            "updatedAt": now,
        }
        return {"activeId": item["id"], "items": [item]}
    if not isinstance(raw, dict):
        return {"activeId": "", "items": []}

    items = []
    for item in raw.get("items") or raw.get("conversations") or []:
        normalized = normalize_conversation_item(item)
        if normalized:
            items.append(normalized)
    items.sort(key=lambda item: item.get("updatedAt") or "", reverse=True)
    items.sort(key=lambda item: not item.get("pinned"))
    active_id = clean_text(raw.get("activeId"), 64)
    if active_id and not any(item["id"] == active_id for item in items):
        active_id = ""
    if not active_id and items:
        active_id = items[0]["id"]
    return {"activeId": active_id, "items": items[:50]}


def conversation_summary(item):
    return {
        "id": item["id"],
        "title": item["title"],
        "pinned": bool(item.get("pinned")),
        "createdAt": item["createdAt"],
        "updatedAt": item["updatedAt"],
    }


def get_user_conversation_store(user_id):
    data = read_conversations()
    store = normalize_user_conversation_store(data.get(str(user_id)))
    data[str(user_id)] = store
    write_json(CONVERSATIONS_PATH, data)
    return store


def save_user_conversation_store(user_id, store):
    data = read_conversations()
    data[str(user_id)] = normalize_user_conversation_store(store)
    write_json(CONVERSATIONS_PATH, data)


def user_conversation_payload(user_id):
    store = get_user_conversation_store(user_id)
    active = next((item for item in store["items"] if item["id"] == store["activeId"]), None)
    return {
        "activeId": store["activeId"],
        "conversationId": store["activeId"],
        "messages": active["messages"] if active else [],
        "conversations": [conversation_summary(item) for item in store["items"]],
    }


def get_user_conversation(user_id):
    return user_conversation_payload(user_id)["messages"]


def save_user_conversation(user_id, messages):
    store = get_user_conversation_store(user_id)
    now = now_iso()
    active_id = store.get("activeId") or secrets.token_hex(8)
    active = next((item for item in store["items"] if item["id"] == active_id), None)
    if not active:
        active = {"id": active_id, "title": "新对话", "messages": [], "pinned": False, "createdAt": now, "updatedAt": now}
        store["items"].insert(0, active)
    active["messages"] = conversation_messages(messages)
    active["title"] = conversation_title(active["messages"])
    active["updatedAt"] = now
    store["activeId"] = active["id"]
    save_user_conversation_store(user_id, store)


def upsert_user_conversation(user_id, conversation_id, messages):
    store = get_user_conversation_store(user_id)
    now = now_iso()
    conversation_id = clean_text(conversation_id, 64) or store.get("activeId") or secrets.token_hex(8)
    item = next((entry for entry in store["items"] if entry["id"] == conversation_id), None)
    if not item:
        item = {"id": conversation_id, "title": "新对话", "messages": [], "pinned": False, "createdAt": now, "updatedAt": now}
        store["items"].insert(0, item)
    item["messages"] = conversation_messages(messages)
    item["title"] = conversation_title(item["messages"])
    item["updatedAt"] = now
    store["activeId"] = item["id"]
    save_user_conversation_store(user_id, store)
    return user_conversation_payload(user_id)


def create_user_conversation(user_id):
    store = get_user_conversation_store(user_id)
    now = now_iso()
    item = {"id": secrets.token_hex(8), "title": "新对话", "messages": [], "pinned": False, "createdAt": now, "updatedAt": now}
    store["items"].insert(0, item)
    store["activeId"] = item["id"]
    save_user_conversation_store(user_id, store)
    return user_conversation_payload(user_id)


def select_user_conversation(user_id, conversation_id):
    store = get_user_conversation_store(user_id)
    conversation_id = clean_text(conversation_id, 64)
    if not any(item["id"] == conversation_id for item in store["items"]):
        return None
    store["activeId"] = conversation_id
    save_user_conversation_store(user_id, store)
    return user_conversation_payload(user_id)


def set_user_conversation_pinned(user_id, conversation_id, pinned):
    store = get_user_conversation_store(user_id)
    conversation_id = clean_text(conversation_id, 64)
    item = next((entry for entry in store["items"] if entry["id"] == conversation_id), None)
    if not item:
        return None
    item["pinned"] = bool(pinned)
    save_user_conversation_store(user_id, store)
    return user_conversation_payload(user_id)


def delete_user_conversation(user_id, conversation_id):
    store = get_user_conversation_store(user_id)
    conversation_id = clean_text(conversation_id, 64)
    before = len(store["items"])
    store["items"] = [item for item in store["items"] if item["id"] != conversation_id]
    if len(store["items"]) == before:
        return None
    if store.get("activeId") == conversation_id:
        store["activeId"] = store["items"][0]["id"] if store["items"] else ""
    save_user_conversation_store(user_id, store)
    return user_conversation_payload(user_id)


def is_valid_http_url(value):
    parsed = urllib.parse.urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


class Handler(BaseHTTPRequestHandler):
    server_version = "MinAI/1.0"

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.route_api("GET", parsed.path)
            return
        if parsed.path.startswith("/generated/"):
            self.serve_generated(parsed.path, head_only=False)
            return
        self.serve_static(parsed.path)

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/generated/"):
            self.serve_generated(parsed.path, head_only=True)
            return
        self.serve_static(parsed.path, head_only=True)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        self.route_api("POST", parsed.path)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        self.route_api("PUT", parsed.path)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        self.route_api("DELETE", parsed.path)

    def route_api(self, method, path):
        if method == "GET" and path == "/api/public-config":
            settings = get_settings()
            user = self.get_user_from_request()
            self.send_json(
                200,
                {
                    "siteTitle": settings["siteTitle"],
                    "requireLogin": settings["requireLogin"],
                    "user": public_user(user) if user else None,
                },
            )
            return

        if method == "POST" and path == "/api/chat":
            self.handle_chat()
            return

        if method == "GET" and path == "/api/models":
            self.handle_models()
            return

        job_prefix = "/api/jobs/"
        if method == "GET" and path.startswith(job_prefix):
            self.handle_image_job(urllib.parse.unquote(path[len(job_prefix) :]))
            return

        if path == "/api/conversations/current":
            if method == "GET":
                self.handle_get_conversation()
                return
            if method == "POST":
                self.handle_save_conversation()
                return

        if method == "GET" and path == "/api/conversations":
            self.handle_get_conversations()
            return

        if method == "POST" and path == "/api/conversations/new":
            self.handle_new_conversation()
            return

        if method == "POST" and path == "/api/conversations/select":
            self.handle_select_conversation()
            return

        if method == "POST" and path == "/api/conversations/pin":
            self.handle_pin_conversation()
            return

        if method == "DELETE" and path == "/api/conversations":
            self.handle_delete_conversation()
            return

        if method == "POST" and path == "/api/auth/login":
            self.handle_login()
            return

        if method == "POST" and path == "/api/auth/logout":
            self.send_json(200, {"ok": True}, {"Set-Cookie": self.clear_cookie_header()})
            return

        if method == "GET" and path == "/api/auth/me":
            user = self.get_user_from_request()
            self.send_json(200, {"user": public_user(user) if user else None})
            return

        if method == "GET" and path == "/api/admin/setup-status":
            self.send_json(200, {"needsSetup": not has_active_admin()})
            return

        if method == "POST" and path == "/api/admin/setup":
            self.handle_setup()
            return

        if path.startswith("/api/admin/"):
            admin = self.require_admin()
            if not admin:
                return

            if method == "GET" and path == "/api/admin/me":
                self.send_json(200, {"user": public_user(admin)})
                return

            if method == "GET" and path == "/api/admin/settings":
                self.send_json(200, admin_settings(get_settings()))
                return

            if method in {"POST", "PUT"} and path == "/api/admin/settings":
                self.handle_update_settings()
                return

            if method == "GET" and path == "/api/admin/providers":
                self.send_json(200, {"providers": [public_provider(provider) for provider in list_providers()]})
                return

            if method == "POST" and path == "/api/admin/providers":
                self.handle_create_provider()
                return

            if method == "POST" and path == "/api/admin/models/preview":
                self.handle_admin_model_preview()
                return

            provider_prefix = "/api/admin/providers/"
            if path.startswith(provider_prefix):
                provider_id = urllib.parse.unquote(path[len(provider_prefix) :])
                if method in {"POST", "PUT"}:
                    self.handle_update_provider(provider_id)
                    return
                if method == "DELETE":
                    self.handle_delete_provider(provider_id)
                    return

            if method == "GET" and path == "/api/admin/users":
                self.send_json(200, {"users": [public_user(user) for user in list_users()]})
                return

            if method == "POST" and path == "/api/admin/users":
                self.handle_create_user()
                return

            prefix = "/api/admin/users/"
            if path.startswith(prefix):
                user_id = urllib.parse.unquote(path[len(prefix) :])
                if method in {"POST", "PUT"}:
                    self.handle_update_user(user_id, admin)
                    return
                if method == "DELETE":
                    self.handle_delete_user(user_id, admin)
                    return

        self.send_json(404, {"error": "Not found"})

    def handle_image_job(self, job_id):
        settings = get_settings()
        user = self.get_user_from_request()
        with IMAGE_JOBS_LOCK:
            job = dict(IMAGE_JOBS.get(clean_text(job_id, 64)) or {})
        if not job:
            self.send_json(404, {"error": "图片任务不存在或已过期。"})
            return
        if settings["requireLogin"] and not user:
            self.send_json(401, {"error": "请先登录后再查看图片任务。"})
            return
        if user and job.get("userId") and job.get("userId") != user.get("id"):
            self.send_json(403, {"error": "不能查看其他用户的图片任务。"})
            return
        self.send_json(200, public_image_job(job))

    def handle_chat(self):
        settings = get_settings()
        provider = get_active_provider()
        user = self.get_user_from_request()
        if settings["requireLogin"] and not user:
            self.send_json(401, {"error": "请先登录后再使用 AI 对话。"})
            return

        if not provider:
            self.send_json(500, {"error": "还没有可用的 API 通道。请先进入 /admin 后台配置第三方 API Key。"})
            return

        body = self.read_json_body()
        raw_messages = body.get("messages")
        messages = normalize_messages(raw_messages)
        stored_messages = conversation_messages(raw_messages)
        if not messages:
            self.send_json(400, {"error": "请输入消息内容。"})
            return

        selected_model = normalize_model_id(body.get("model") or provider["aiModel"])

        if is_image_model(selected_model):
            prompt = latest_user_prompt(messages)
            if not prompt:
                self.send_json(400, {"error": "请输入图片描述。"})
                return

            job = create_image_generation_job(
                provider,
                selected_model,
                prompt,
                user["id"] if user else "",
                body.get("conversationId"),
                stored_messages,
            )
            self.send_json(
                202,
                {
                    "jobId": job["id"],
                    "status": job["status"],
                    "reply": "图片生成任务已提交。",
                    "model": selected_model,
                },
            )
            return

        payload = {
            "model": selected_model,
            "temperature": body.get("temperature") if isinstance(body.get("temperature"), (int, float)) else 0.7,
            "messages": [{"role": "system", "content": settings["systemPrompt"]}] + messages,
        }
        request = urllib.request.Request(
            chat_completions_url(provider),
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f'Bearer {provider["apiKey"]}',
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                upstream = json.loads(response.read().decode("utf-8"))
                message = ((upstream.get("choices") or [{}])[0].get("message") or {})
                reply = message.get("content")
                images = extract_response_images(upstream, message)
                images = stored_generated_images(images)
                update_provider_stats(provider["id"], True, response.status, upstream.get("usage"))
                conversation_payload = {}
                if user:
                    assistant_message = {"role": "assistant", "content": reply or "没有收到有效回复。", "images": images}
                    conversation_payload = upsert_user_conversation(
                        user["id"],
                        body.get("conversationId"),
                        stored_messages + [assistant_message],
                    )
                self.send_json(
                    200,
                    {
                        "reply": reply or "没有收到有效回复。",
                        "images": images,
                        "model": upstream.get("model") or payload["model"],
                        "usage": upstream.get("usage"),
                        "conversationId": conversation_payload.get("conversationId"),
                        "conversations": conversation_payload.get("conversations", []),
                    },
                )
        except urllib.error.HTTPError as error:
            error_text = error.read().decode("utf-8", "replace")
            try:
                error_json = json.loads(error_text)
            except Exception:
                error_json = {}
            message = (
                ((error_json.get("error") or {}).get("message") if isinstance(error_json.get("error"), dict) else None)
                or error_json.get("message")
                or f"上游接口请求失败，状态码 {error.code}"
            )
            update_provider_stats(provider["id"], False, error.code, None, message)
            self.send_json(error.code, {"error": message})
        except Exception:
            update_provider_stats(provider["id"], False, "network", None, "无法连接上游 AI 接口")
            self.send_json(502, {"error": "无法连接上游 AI 接口，请检查 API 地址或服务器网络。"})

    def handle_models(self):
        settings = get_settings()
        user = self.get_user_from_request()
        if settings["requireLogin"] and not user:
            self.send_json(401, {"error": "请先登录后再选择模型。"})
            return

        provider = get_active_provider()
        if not provider:
            self.send_json(500, {"error": "还没有可用的 API 通道。请先进入 /admin 后台配置第三方 API Key。"})
            return

        cache_key = f'{provider.get("id")}:{provider.get("apiHost")}:{provider.get("apiPath")}:{provider.get("updatedAt")}'
        cached = MODEL_CACHE.get(cache_key)
        if cached and cached["expiresAt"] > time.time():
            self.send_json(200, cached["payload"])
            return

        try:
            payload = fetch_provider_model_payload(provider)
        except ModelFetchError as error:
            self.send_json(error.status, {"error": error.message})
            return

        MODEL_CACHE.clear()
        MODEL_CACHE[cache_key] = {"expiresAt": time.time() + 10 * 60, "payload": payload}
        self.send_json(200, payload)

    def handle_get_conversation(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再读取对话。"})
            return
        self.send_json(200, user_conversation_payload(user["id"]))

    def handle_save_conversation(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再保存对话。"})
            return
        body = self.read_json_body()
        messages = conversation_messages(body.get("messages"))
        payload = upsert_user_conversation(user["id"], body.get("conversationId"), messages)
        self.send_json(200, {"ok": True, **payload})

    def handle_get_conversations(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再读取对话列表。"})
            return
        self.send_json(200, user_conversation_payload(user["id"]))

    def handle_new_conversation(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再创建新对话。"})
            return
        self.send_json(200, create_user_conversation(user["id"]))

    def handle_select_conversation(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再切换对话。"})
            return
        body = self.read_json_body()
        payload = select_user_conversation(user["id"], body.get("conversationId"))
        if not payload:
            self.send_json(404, {"error": "对话不存在。"})
            return
        self.send_json(200, payload)

    def handle_pin_conversation(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再管理对话。"})
            return
        body = self.read_json_body()
        payload = set_user_conversation_pinned(user["id"], body.get("conversationId"), bool(body.get("pinned")))
        if not payload:
            self.send_json(404, {"error": "对话不存在。"})
            return
        self.send_json(200, payload)

    def handle_delete_conversation(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录后再删除对话。"})
            return
        body = self.read_json_body()
        payload = delete_user_conversation(user["id"], body.get("conversationId"))
        if not payload:
            self.send_json(404, {"error": "对话不存在。"})
            return
        self.send_json(200, payload)

    def handle_login(self):
        body = self.read_json_body()
        username = clean_text(body.get("username"), 64)
        password = str(body.get("password") or "")
        user = next((item for item in list_users() if item.get("username", "").lower() == username.lower()), None)
        if not user or user.get("status") != "active" or not verify_password(password, user.get("passwordHash")):
            self.send_json(401, {"error": "账号或密码不正确。"})
            return
        token = create_session_token(user)
        self.send_json(200, {"user": public_user(user)}, {"Set-Cookie": self.auth_cookie_header(token)})

    def handle_setup(self):
        if has_active_admin():
            self.send_json(409, {"error": "管理员已经初始化。"})
            return

        body = self.read_json_body()
        username = clean_text(body.get("username"), 64)
        display_name = clean_text(body.get("displayName") or username, 40)
        password = str(body.get("password") or "")
        validation_error = validate_user_input(username, password)
        if validation_error:
            self.send_json(400, {"error": validation_error})
            return

        users = list_users()
        if any(user.get("username", "").lower() == username.lower() for user in users):
            self.send_json(409, {"error": "该用户名已经存在。"})
            return

        admin = {
            "id": secrets.token_hex(16),
            "username": username,
            "displayName": display_name,
            "role": "admin",
            "status": "active",
            "passwordHash": hash_password(password),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        users.append(admin)
        save_users(users)
        token = create_session_token(admin)
        self.send_json(201, {"user": public_user(admin)}, {"Set-Cookie": self.auth_cookie_header(token)})

    def handle_update_settings(self):
        body = self.read_json_body()
        current = get_settings()
        next_settings = {
            "siteTitle": clean_text(body.get("siteTitle") or current["siteTitle"], 40) or "MinAI",
            "systemPrompt": clean_text(body.get("systemPrompt") or current["systemPrompt"], 4000) or DEFAULT_SYSTEM_PROMPT,
            "requireLogin": bool(body.get("requireLogin")),
        }

        write_json(SETTINGS_PATH, next_settings)
        self.send_json(200, admin_settings(next_settings))

    def handle_create_provider(self):
        body = self.read_json_body()
        provider = self.provider_from_body(body)
        if isinstance(provider, str):
            self.send_json(400, {"error": provider})
            return

        providers = list_providers()
        if provider["isDefault"] or not providers:
            set_default_provider(providers, "")
            provider["isDefault"] = True
        providers.append(provider)
        save_providers(providers)
        self.send_json(201, {"provider": public_provider(provider)})

    def handle_update_provider(self, provider_id):
        body = self.read_json_body()
        providers = list_providers()
        index = next((idx for idx, item in enumerate(providers) if item.get("id") == provider_id), -1)
        if index < 0:
            self.send_json(404, {"error": "API 通道不存在。"})
            return

        current = providers[index]
        updated = self.provider_from_body(body, current)
        if isinstance(updated, str):
            self.send_json(400, {"error": updated})
            return

        if updated["isDefault"]:
            set_default_provider(providers, updated["id"])
        elif current.get("isDefault"):
            updated["isDefault"] = True

        providers[index] = updated
        save_providers(providers)
        self.send_json(200, {"provider": public_provider(updated)})

    def handle_delete_provider(self, provider_id):
        providers = list_providers()
        target = next((provider for provider in providers if provider.get("id") == provider_id), None)
        if not target:
            self.send_json(404, {"error": "API 通道不存在。"})
            return
        if len(providers) <= 1:
            self.send_json(400, {"error": "至少需要保留一个 API 通道。"})
            return
        providers = [provider for provider in providers if provider.get("id") != provider_id]
        if target.get("isDefault") and providers:
            providers[0]["isDefault"] = True
        save_providers(providers)
        self.send_json(200, {"ok": True})

    def handle_admin_model_preview(self):
        body = self.read_json_body()
        provider_id = clean_text(body.get("providerId"), 80)
        current = None
        if provider_id:
            current = next((provider for provider in list_providers() if provider.get("id") == provider_id), None)
            if not current:
                self.send_json(404, {"error": "API 通道不存在。"})
                return

        provider = self.provider_from_body(body, current)
        if isinstance(provider, str):
            self.send_json(400, {"error": provider})
            return

        try:
            payload = fetch_provider_model_payload(provider)
        except ModelFetchError as error:
            self.send_json(error.status, {"error": error.message})
            return

        self.send_json(200, payload)

    def provider_from_body(self, body, current=None):
        provider = dict(current or new_provider({}))
        provider["name"] = clean_text(body.get("name") or provider.get("name") or "默认通道", 60) or "默认通道"
        provider["apiMode"] = "openai-compatible"
        provider["apiHost"] = strip_trailing_slash(
            body.get("apiHost") or body.get("apiBaseUrl") or provider.get("apiHost") or provider.get("apiBaseUrl")
        )
        provider["apiPath"] = clean_text(body.get("apiPath") if body.get("apiPath") is not None else provider.get("apiPath"), 120)
        provider["apiBaseUrl"] = provider["apiHost"]
        provider["aiModel"] = normalize_model_id(body.get("aiModel") or provider.get("aiModel") or "gpt-4o-mini")
        provider["enabled"] = bool(body.get("enabled", provider.get("enabled", True)))
        provider["isDefault"] = bool(body.get("isDefault", provider.get("isDefault", False)))
        provider["updatedAt"] = now_iso()
        if body.get("clearApiKey"):
            provider["apiKey"] = ""
        elif isinstance(body.get("apiKey"), str) and body.get("apiKey").strip():
            provider["apiKey"] = body.get("apiKey").strip()
        elif current is None:
            provider["apiKey"] = str(body.get("apiKey") or "").strip()

        if not provider["name"]:
            return "请填写通道名称。"
        if not is_valid_http_url(provider["apiHost"]):
            return "API Host 必须是 http 或 https 开头的有效地址。"
        endpoint_url = chat_completions_url(provider)
        if not is_valid_http_url(endpoint_url):
            return "API Host 和 API Path 组合后不是有效地址。"
        if not provider["aiModel"]:
            return "请填写模型名称。"
        return provider

    def handle_create_user(self):
        body = self.read_json_body()
        username = clean_text(body.get("username"), 64)
        display_name = clean_text(body.get("displayName") or username, 40)
        password = str(body.get("password") or "")
        role = "admin" if body.get("role") == "admin" else "user"
        status = "disabled" if body.get("status") == "disabled" else "active"
        validation_error = validate_user_input(username, password)
        if validation_error:
            self.send_json(400, {"error": validation_error})
            return

        users = list_users()
        if any(user.get("username", "").lower() == username.lower() for user in users):
            self.send_json(409, {"error": "该用户名已经存在。"})
            return

        user = {
            "id": secrets.token_hex(16),
            "username": username,
            "displayName": display_name,
            "role": role,
            "status": status,
            "passwordHash": hash_password(password),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        users.append(user)
        save_users(users)
        self.send_json(201, {"user": public_user(user)})

    def handle_update_user(self, user_id, admin):
        body = self.read_json_body()
        users = list_users()
        index = next((idx for idx, user in enumerate(users) if user.get("id") == user_id), -1)
        if index < 0:
            self.send_json(404, {"error": "用户不存在。"})
            return

        current = users[index]
        next_role = "admin" if body.get("role") == "admin" else "user"
        next_status = "disabled" if body.get("status") == "disabled" else "active"
        if current.get("id") == admin.get("id") and (next_role != "admin" or next_status != "active"):
            self.send_json(400, {"error": "不能移除自己的管理员权限或禁用自己。"})
            return

        if current.get("role") == "admin" and current.get("status") == "active" and (
            next_role != "admin" or next_status != "active"
        ):
            active_admins = [user for user in users if user.get("role") == "admin" and user.get("status") == "active"]
            if len(active_admins) <= 1:
                self.send_json(400, {"error": "至少需要保留一个启用状态的管理员。"})
                return

        current["displayName"] = clean_text(body.get("displayName") or current.get("displayName") or current["username"], 40)
        current["role"] = next_role
        current["status"] = next_status
        current["updatedAt"] = now_iso()
        if isinstance(body.get("password"), str) and body.get("password").strip():
            password_error = validate_password(body.get("password"))
            if password_error:
                self.send_json(400, {"error": password_error})
                return
            current["passwordHash"] = hash_password(body.get("password"))
        users[index] = current
        save_users(users)
        self.send_json(200, {"user": public_user(current)})

    def handle_delete_user(self, user_id, admin):
        users = list_users()
        target = next((user for user in users if user.get("id") == user_id), None)
        if not target:
            self.send_json(404, {"error": "用户不存在。"})
            return
        if target.get("id") == admin.get("id"):
            self.send_json(400, {"error": "不能删除当前登录的管理员。"})
            return
        if target.get("role") == "admin" and target.get("status") == "active":
            active_admins = [user for user in users if user.get("role") == "admin" and user.get("status") == "active"]
            if len(active_admins) <= 1:
                self.send_json(400, {"error": "至少需要保留一个启用状态的管理员。"})
                return
        save_users([user for user in users if user.get("id") != user_id])
        self.send_json(200, {"ok": True})

    def require_admin(self):
        user = self.get_user_from_request()
        if not user:
            self.send_json(401, {"error": "请先登录管理员账号。"})
            return None
        if user.get("role") != "admin" or user.get("status") != "active":
            self.send_json(403, {"error": "没有管理员权限。"})
            return None
        return user

    def get_user_from_request(self):
        token = self.get_cookie(SESSION_COOKIE)
        payload = verify_session_token(token)
        if not payload:
            return None
        user = next((item for item in list_users() if item.get("id") == payload.get("sub")), None)
        if not user or user.get("status") != "active":
            return None
        return user

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > MAX_BODY_SIZE:
            self.send_json(413, {"error": "请求内容过大。"})
            return {}
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def serve_static(self, path, head_only=False):
        if path in {"/admin", "/admin/"}:
            path = "/admin.html"
        if path == "/":
            path = "/index.html"
        safe_path = posixpath.normpath(urllib.parse.unquote(path)).lstrip("/")
        if safe_path.startswith(".") or "/." in f"/{safe_path}":
            self.send_json(404, {"error": "Not found"})
            return
        file_path = (PUBLIC_DIR / safe_path).resolve()
        try:
            file_path.relative_to(PUBLIC_DIR.resolve())
        except ValueError:
            self.send_json(403, {"error": "Forbidden"})
            return
        if not file_path.exists() or not file_path.is_file():
            requested_suffix = Path(safe_path).suffix
            if requested_suffix or safe_path.startswith("assets/"):
                self.send_json(404, {"error": "Not found"})
                return
            file_path = PUBLIC_DIR / ("admin.html" if path.startswith("/admin") else "index.html")
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if file_path.suffix == ".js":
            content_type = "text/javascript"
        if file_path.suffix in {".html", ".css", ".js", ".json"}:
            content_type += "; charset=utf-8"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        cache_control = "no-cache" if file_path.suffix in {".html", ".css", ".js"} else "public, max-age=86400"
        self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def serve_generated(self, path, head_only=False):
        safe_name = posixpath.basename(urllib.parse.unquote(path))
        file_path = (GENERATED_DIR / safe_name).resolve()
        try:
            file_path.relative_to(GENERATED_DIR.resolve())
        except ValueError:
            self.send_json(403, {"error": "Forbidden"})
            return
        if not file_path.exists() or not file_path.is_file():
            self.send_json(404, {"error": "Not found"})
            return
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def get_cookie(self, name):
        header = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie()
        try:
            jar.load(header)
            return jar[name].value if name in jar else ""
        except Exception:
            return ""

    def auth_cookie_header(self, token):
        return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_MAX_AGE}"

    def clear_cookie_header(self):
        return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def main():
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "3000"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"MinAI is running at http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
