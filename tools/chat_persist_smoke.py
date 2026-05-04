import json
import secrets

import server


user_id = "smoke_" + secrets.token_hex(4)
payload = server.upsert_user_conversation(
    user_id,
    "",
    [
        {"role": "user", "content": "生成一张星空"},
        {"role": "assistant", "content": "已生成图片。", "images": ["https://example.com/star.png"]},
    ],
)
try:
    messages = payload.get("messages") or []
    print(
        json.dumps(
            {
                "conversation_count": len(payload.get("conversations") or []),
                "message_count": len(messages),
                "image_count": len((messages[-1] or {}).get("images") or []) if messages else 0,
            },
            ensure_ascii=False,
        )
    )
finally:
    data = server.read_conversations()
    data.pop(user_id, None)
    server.write_json(server.CONVERSATIONS_PATH, data)
