#!/usr/bin/env python3
"""Evaluate a Dart expression on a running Flutter app's isolate."""
import sys
import json
import asyncio
import websockets

async def main():
    if len(sys.argv) < 3:
        print("Usage: python eval.py <vm-service-ws-uri> <expression>")
        print("Example: python eval.py ws://127.0.0.1:12345/abc123=/ws \"1+1\"")
        sys.exit(1)

    uri = sys.argv[1]
    expr = sys.argv[2]

    async with websockets.connect(uri) as ws:
        # Get VM info to find the main isolate
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": "1", "method": "getVM", "params": {}}))
        vm = json.loads(await ws.recv())

        isolate_id = None
        for iso in vm.get("result", {}).get("isolates", []):
            if "main" in iso.get("name", "").lower() or iso.get("name", "") != "":
                isolate_id = iso["id"]
                break

        if not isolate_id:
            print("No isolate found")
            sys.exit(1)

        # Evaluate expression
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "id": "2", "method": "evaluate",
            "params": {"isolateId": isolate_id, "expression": expr, "scope": {}}
        }))
        result = json.loads(await ws.recv())

        if "result" in result:
            r = result["result"]
            if r.get("type") == "Error" or r.get("type") == "@Error":
                print(f"Error: {r.get('message', r)}", file=sys.stderr)
                sys.exit(1)
            value = r.get("valueAsString", r.get("value", json.dumps(r, indent=2)))
            print(value)
        elif "error" in result:
            print(f"Error: {result['error']}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
