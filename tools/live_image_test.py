import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def main():
    provider = server.get_active_provider()
    model = sys.argv[1] if len(sys.argv) > 1 else "gpt-image-2-all"
    payload = {
        "model": model,
        "prompt": "Minimal premium starry sky, deep blue night, fine stars, calm cinematic light",
        "n": 1,
        "size": "1024x1024",
    }
    request = urllib.request.Request(
        server.image_generations_url(provider),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": "Bearer " + provider["apiKey"],
        },
        method="POST",
    )

    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=server.IMAGE_GENERATION_TIMEOUT) as response:
            upstream = json.loads(response.read().decode("utf-8"))
            raw_images = server.extract_response_images(upstream, {})
            stored_images = server.stored_generated_images(raw_images)
            files = []
            for url in stored_images:
                if url.startswith("/generated/"):
                    path = server.GENERATED_DIR / url.rsplit("/", 1)[-1]
                    files.append(
                        {
                            "url": url,
                            "exists": path.exists(),
                            "bytes": path.stat().st_size if path.exists() else 0,
                        }
                    )
                else:
                    files.append({"url": url[:120], "exists": False, "bytes": 0})
            print(
                json.dumps(
                    {
                        "ok": True,
                        "elapsed": round(time.time() - started, 1),
                        "raw_count": len(raw_images),
                        "stored_count": len(stored_images),
                        "files": files,
                        "shape": server.response_shape(upstream),
                    },
                    ensure_ascii=False,
                )
            )
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        print(json.dumps({"ok": False, "status": error.code, "error": body[:500]}, ensure_ascii=False))
        raise


if __name__ == "__main__":
    main()
