import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def main():
    provider = server.get_active_provider()
    request = urllib.request.Request(
        server.models_url(provider),
        headers={"Accept": "application/json", "Authorization": "Bearer " + provider["apiKey"]},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))

    models = data.get("data") if isinstance(data, dict) else []
    items = []
    for item in models:
        model_id = str(item.get("id") or "") if isinstance(item, dict) else str(item)
        haystack = json.dumps(item, ensure_ascii=False).lower() if isinstance(item, dict) else model_id.lower()
        if any(keyword in haystack for keyword in ["image", "图", "all", "gpt-image", "z-image"]):
            items.append(
                {
                    "id": model_id,
                    "type": item.get("model_type") if isinstance(item, dict) else "",
                    "tags": item.get("tags") if isinstance(item, dict) else "",
                    "endpoints": item.get("supported_endpoint_types") if isinstance(item, dict) else [],
                }
            )
    print(json.dumps({"count": len(items), "items": items[:160]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
