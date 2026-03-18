#!/usr/bin/env python3
"""Trigger hot reload on a running Flutter app via Dart VM Service."""
import sys
import json
import asyncio
import websockets

async def main():
    if len(sys.argv) < 2:
        print("Usage: python reload.py <vm-service-ws-uri>")
        sys.exit(1)

    uri = sys.argv[1]

    async with websockets.connect(uri) as ws:
        # Get the main isolate
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": "1", "method": "getVM", "params": {}}))
        vm = json.loads(await ws.recv())

        isolate_id = None
        for iso in vm.get("result", {}).get("isolates", []):
            isolate_id = iso["id"]
            break

        if not isolate_id:
            print("No isolate found")
            sys.exit(1)

        # Hot reload
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "id": "2", "method": "reloadSources",
            "params": {"isolateId": isolate_id}
        }))
        result = json.loads(await ws.recv())

        if "result" in result:
            success = result["result"].get("success", result["result"].get("type") == "ReloadReport")
            if success:
                print("Hot reload successful")
            else:
                print(f"Hot reload result: {json.dumps(result['result'], indent=2)}")
        elif "error" in result:
            print(f"Error: {result['error']}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
