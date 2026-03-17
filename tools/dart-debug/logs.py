#!/usr/bin/env python3
"""Stream log output from a running Flutter app via Dart VM Service."""
import sys
import json
import asyncio
import base64
from datetime import datetime
import websockets

async def main():
    if len(sys.argv) < 2:
        print("Usage: python logs.py <vm-service-ws-uri>")
        sys.exit(1)

    uri = sys.argv[1]

    async with websockets.connect(uri) as ws:
        # Subscribe to log streams
        for stream in ["Stdout", "Stderr", "Debug", "Logging"]:
            await ws.send(json.dumps({
                "jsonrpc": "2.0", "id": f"sub_{stream}",
                "method": "streamListen", "params": {"streamId": stream}
            }))
            resp = json.loads(await ws.recv())
            if "error" in resp:
                # Stream may not exist, skip silently
                pass

        print("Listening for logs... (Ctrl+C to stop)")
        try:
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("method") == "streamNotify":
                    event = msg.get("params", {}).get("event", {})
                    kind = event.get("kind", "")
                    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]

                    if kind in ("WriteEvent",):
                        # Stdout/Stderr
                        raw = event.get("bytes", "")
                        try:
                            text = base64.b64decode(raw).decode("utf-8").rstrip()
                        except Exception:
                            text = raw
                        if text:
                            stream_id = msg["params"].get("streamId", "")
                            prefix = "ERR" if stream_id == "Stderr" else "OUT"
                            print(f"[{ts}] [{prefix}] {text}")

                    elif kind == "Logging":
                        log_record = event.get("logRecord", {})
                        message = log_record.get("message", {}).get("valueAsString", "")
                        level = log_record.get("level", 0)
                        logger = log_record.get("loggerName", {}).get("valueAsString", "")
                        prefix = logger if logger else "LOG"
                        print(f"[{ts}] [{prefix}] {message}")

                    elif kind == "Extension":
                        ext_kind = event.get("extensionKind", "")
                        ext_data = event.get("extensionData", {})
                        print(f"[{ts}] [EXT:{ext_kind}] {json.dumps(ext_data)}")

                    else:
                        # Other debug events
                        print(f"[{ts}] [{kind}] {json.dumps(event, default=str)}")
        except KeyboardInterrupt:
            print("\nStopped.")

if __name__ == "__main__":
    asyncio.run(main())
