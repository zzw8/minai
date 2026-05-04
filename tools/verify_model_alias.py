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
        upstream = json.loads(response.read().decode("utf-8"))
    raw_models = upstream.get("data") if isinstance(upstream.get("data"), list) else []
    filtered = [model for model in raw_models if isinstance(model, dict) and server.is_openai_compatible_model(model)]
    models = {}
    for model in filtered:
        public = server.public_model(model)
        if public:
            models[public["id"]] = public
    curated = [models[model_id] for model_id in server.CURATED_MODEL_ORDER if model_id in models]
    if not curated:
        curated = list(models.values())[:8]
    print(
        json.dumps(
            {
                "has_gpt_image_2": "gpt-image-2" in models,
                "has_gpt_image_2_all": "gpt-image-2-all" in models,
                "alias": server.normalize_model_id("gpt-image-2"),
                "default": server.normalize_model_id(provider.get("aiModel")),
                "all_model_count": len(models),
                "curated_model_count": len(curated),
                "curated_models": [model["id"] for model in curated],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
