import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


SAMPLE_IMAGE = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class FakeResponse:
    status = 200

    def __init__(self):
        self.headers = {"Content-Type": "application/json"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps({"model": "gpt-image-2-all", "data": [{"b64_json": SAMPLE_IMAGE}]}).encode("utf-8")


def main():
    original_urlopen = server.urllib.request.urlopen
    server.urllib.request.urlopen = lambda *args, **kwargs: FakeResponse()
    try:
        provider = server.get_active_provider()
        job = server.create_image_generation_job(
            provider,
            "gpt-image-2-all",
            "smoke test",
            "",
            "",
            [{"role": "user", "content": "smoke test"}],
        )
        deadline = time.time() + 10
        result = {}
        while time.time() < deadline:
            with server.IMAGE_JOBS_LOCK:
                result = dict(server.IMAGE_JOBS.get(job["id"]) or {})
            if result.get("status") in {"done", "failed"}:
                break
            time.sleep(0.1)

        images = result.get("images") or []
        generated = images[0] if images else ""
        path = server.GENERATED_DIR / generated.rsplit("/", 1)[-1] if generated.startswith("/generated/") else None
        print(
            json.dumps(
                {
                    "status": result.get("status"),
                    "image_count": len(images),
                    "generated": generated,
                    "exists": bool(path and path.exists()),
                    "bytes": path.stat().st_size if path and path.exists() else 0,
                },
                ensure_ascii=False,
            )
        )
    finally:
        server.urllib.request.urlopen = original_urlopen


if __name__ == "__main__":
    main()
