import json

import server


sample = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
images = server.stored_generated_images([sample])
print(json.dumps({"count": len(images), "url": images[0] if images else "", "exists": bool(images and (server.GENERATED_DIR / images[0].split("/")[-1]).exists())}))
