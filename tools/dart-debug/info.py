#!/usr/bin/env python3
"""Show VM info from a running Flutter app."""
import sys
import json
import asyncio
import websockets

async def main():
    if len(sys.argv) < 2:
        print("Usage: python info.py <vm-service-ws-uri>")
        sys.exit(1)

    uri = sys.argv[1]

    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": "1", "method": "getVM", "params": {}}))
        vm = json.loads(await ws.recv())
        vm_info = vm.get("result", {})

        print(f"Dart VM {vm_info.get('version', 'unknown')}")
        print(f"PID: {vm_info.get('pid', '?')}")
        print(f"Start time: {vm_info.get('startTime', '?')}ms")
        print()

        isolates = vm_info.get("isolates", [])
        print(f"Isolates ({len(isolates)}):")
        for iso in isolates:
            print(f"  - {iso.get('name', '?')} [{iso['id']}]")

            # Get isolate details
            await ws.send(json.dumps({
                "jsonrpc": "2.0", "id": f"iso_{iso['id']}",
                "method": "getIsolate", "params": {"isolateId": iso["id"]}
            }))
            iso_detail = json.loads(await ws.recv())
            detail = iso_detail.get("result", {})

            libraries = detail.get("libraries", [])
            print(f"    Libraries: {len(libraries)}")

            # Get memory usage
            await ws.send(json.dumps({
                "jsonrpc": "2.0", "id": f"mem_{iso['id']}",
                "method": "getMemoryUsage", "params": {"isolateId": iso["id"]}
            }))
            mem_resp = json.loads(await ws.recv())
            mem = mem_resp.get("result", {})
            if mem.get("type") == "MemoryUsage":
                heap_used = mem.get("heapUsage", 0) / (1024 * 1024)
                heap_cap = mem.get("heapCapacity", 0) / (1024 * 1024)
                external = mem.get("externalUsage", 0) / (1024 * 1024)
                print(f"    Heap: {heap_used:.1f}MB / {heap_cap:.1f}MB | External: {external:.1f}MB")

if __name__ == "__main__":
    asyncio.run(main())
