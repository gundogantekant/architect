#!/usr/bin/env python3
"""
BLE Relay — HTTP server for direct Mac → Neuronic helmet communication.
Use when the Flutter app is disconnected from the helmet.
BLE is 1:1, so this cannot run simultaneously with the app's BLE connection.

Endpoints:
  GET  /scan         — Scan for Neuronic devices
  POST /connect      — Connect by name: {"name": "Neuronic_Light_XXXXXX"}
  POST /disconnect   — Disconnect
  GET  /state        — Connection state + device info
  POST /send         — Send JSON command: {"action":"...","value":"...","payload":{}}
  GET  /logs         — SSE stream of log characteristic notifications
  POST /firmware/upload — Upload firmware binary (multipart)
"""
import asyncio
import json
import logging
import time
from collections import deque
from http import HTTPStatus
from aiohttp import web
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

logger = logging.getLogger(__name__)

# BLE UUIDs (same as firmware/bletest.py)
SERVICE_UUID = "4f5eab65-6ad4-4e1d-b057-93001bbc193f"
COMMAND_CHAR = "555b7c23-e11a-42e6-ba85-7129080b7123"
LOG_CHAR = "555b7c23-e11a-42e6-ba85-7129080b7124"
OTA_CHAR = "555b7c23-e11a-42e6-ba85-7129080b7125"
MTU = 512
CHUNK_SIZE = MTU - 3


class BleRelay:
    def __init__(self):
        self.client: BleakClient | None = None
        self.connected = False
        self.device_name = ""
        self.device_address = ""
        self.log_buffer: deque = deque(maxlen=500)
        self.command_history: deque = deque(maxlen=200)
        self.log_subscribers: list[asyncio.Queue] = []
        self._response_event = asyncio.Event()
        self._last_response: dict | None = None
        self._msg_buffer = ""

    def _command_notification(self, char: BleakGATTCharacteristic, data: bytearray):
        """Handle command characteristic notifications (responses from helmet)."""
        text = data.decode("utf-8", errors="replace")
        try:
            if self._is_json(text):
                parsed = json.loads(text)
                self._msg_buffer = ""
            elif self._is_json(self._msg_buffer + text):
                parsed = json.loads(self._msg_buffer + text)
                self._msg_buffer = ""
            else:
                self._msg_buffer += text
                return
        except json.JSONDecodeError:
            self._msg_buffer += text
            return

        entry = {"timestamp": time.time(), "direction": "rx", "type": "command", "data": parsed}
        self.command_history.append(entry)
        self._last_response = parsed
        self._response_event.set()

        # Notify SSE subscribers
        for q in self.log_subscribers:
            q.put_nowait({"type": "command_rx", **entry})

    def _log_notification(self, char: BleakGATTCharacteristic, data: bytearray):
        """Handle log characteristic notifications."""
        text = data.decode("utf-8", errors="replace")
        entry = {"timestamp": time.time(), "direction": "rx", "type": "log", "data": text}
        self.log_buffer.append(entry)

        for q in self.log_subscribers:
            q.put_nowait(entry)

    @staticmethod
    def _is_json(s: str) -> bool:
        try:
            json.loads(s)
            return True
        except (json.JSONDecodeError, ValueError):
            return False

    async def send_command(self, cmd: dict) -> dict | None:
        """Send a JSON command and wait for response."""
        if not self.client or not self.connected:
            raise RuntimeError("Not connected")

        command_json = json.dumps(cmd)
        command_bytes = command_json.encode()

        # Record sent command
        self.command_history.append({
            "timestamp": time.time(), "direction": "tx", "type": "command", "data": cmd
        })

        self._response_event.clear()
        self._last_response = None

        # Send with chunking if needed
        for i in range(0, len(command_bytes), CHUNK_SIZE):
            chunk = command_bytes[i:i + CHUNK_SIZE]
            await self.client.write_gatt_char(COMMAND_CHAR, chunk, response=True)

        # Wait for response with timeout
        try:
            await asyncio.wait_for(self._response_event.wait(), timeout=5.0)
            return self._last_response
        except asyncio.TimeoutError:
            return None


relay = BleRelay()


async def handle_scan(request: web.Request) -> web.Response:
    """Scan for Neuronic BLE devices."""
    duration = float(request.query.get("duration", "5"))
    devices = []

    discovered = await BleakScanner.discover(timeout=duration)
    for d in discovered:
        name = d.name or ""
        if "neuronic" in name.lower() or "light" in name.lower():
            devices.append({"name": name, "address": d.address, "rssi": d.rssi})

    return web.json_response({"devices": devices})


async def handle_connect(request: web.Request) -> web.Response:
    """Connect to a device by name."""
    if relay.connected:
        return web.json_response({"error": "Already connected", "device": relay.device_name}, status=409)

    body = await request.json()
    name = body.get("name", "")
    if not name:
        return web.json_response({"error": "Missing 'name' field"}, status=400)

    device = await BleakScanner.find_device_by_name(name, timeout=10)
    if not device:
        return web.json_response({"error": f"Device '{name}' not found"}, status=404)

    relay.client = BleakClient(device)
    await relay.client.connect()
    relay.connected = True
    relay.device_name = name
    relay.device_address = device.address

    # Subscribe to notifications
    await relay.client.start_notify(COMMAND_CHAR, relay._command_notification)
    await relay.client.start_notify(LOG_CHAR, relay._log_notification)

    return web.json_response({"status": "connected", "name": name, "address": device.address})


async def handle_disconnect(request: web.Request) -> web.Response:
    """Disconnect from the device."""
    if not relay.connected or not relay.client:
        return web.json_response({"error": "Not connected"}, status=400)

    try:
        await relay.client.stop_notify(COMMAND_CHAR)
        await relay.client.stop_notify(LOG_CHAR)
        await relay.client.disconnect()
    except Exception as e:
        logger.warning(f"Disconnect error: {e}")

    relay.connected = False
    relay.client = None
    relay.device_name = ""
    relay.device_address = ""
    return web.json_response({"status": "disconnected"})


async def handle_state(request: web.Request) -> web.Response:
    """Return connection state."""
    return web.json_response({
        "connected": relay.connected,
        "device_name": relay.device_name,
        "device_address": relay.device_address,
        "log_buffer_size": len(relay.log_buffer),
        "command_history_size": len(relay.command_history),
    })


async def handle_send(request: web.Request) -> web.Response:
    """Send a JSON command to the helmet."""
    if not relay.connected:
        return web.json_response({"error": "Not connected"}, status=400)

    body = await request.json()
    action = body.get("action")
    value = body.get("value")
    if not action or not value:
        return web.json_response({"error": "Missing 'action' or 'value'"}, status=400)

    cmd = {"action": action, "value": value}
    if "payload" in body:
        cmd["payload"] = body["payload"]

    try:
        response = await relay.send_command(cmd)
        return web.json_response({"sent": cmd, "response": response})
    except RuntimeError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_logs_sse(request: web.Request) -> web.StreamResponse:
    """SSE stream of log and command notifications."""
    resp = web.StreamResponse()
    resp.headers["Content-Type"] = "text/event-stream"
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    await resp.prepare(request)

    queue: asyncio.Queue = asyncio.Queue()
    relay.log_subscribers.append(queue)

    try:
        while True:
            entry = await queue.get()
            data = json.dumps(entry, default=str)
            await resp.write(f"data: {data}\n\n".encode())
    except (asyncio.CancelledError, ConnectionResetError):
        pass
    finally:
        relay.log_subscribers.remove(queue)

    return resp


async def handle_firmware_upload(request: web.Request) -> web.Response:
    """Upload firmware binary to helmet via OTA characteristic."""
    if not relay.connected or not relay.client:
        return web.json_response({"error": "Not connected"}, status=400)

    # Step 1: Tell helmet to prepare for upload
    prep_response = await relay.send_command({"action": "firmware", "value": "upload"})
    if not prep_response or prep_response.get("payload", {}).get("response") != "ok":
        return web.json_response({"error": "Helmet rejected upload", "response": prep_response}, status=500)

    # Step 2: Read firmware binary from request
    reader = await request.multipart()
    field = await reader.next()
    if not field:
        return web.json_response({"error": "No file in request"}, status=400)

    firmware_data = await field.read()
    total_chunks = (len(firmware_data) + CHUNK_SIZE - 1) // CHUNK_SIZE

    # Step 3: Write firmware chunks
    start = time.time()
    for i in range(0, len(firmware_data), CHUNK_SIZE):
        chunk = firmware_data[i:i + CHUNK_SIZE]
        await relay.client.write_gatt_char(OTA_CHAR, chunk, response=True)

    elapsed = time.time() - start

    # Step 4: Tell helmet to apply update
    update_response = await relay.send_command({"action": "firmware", "value": "update"})

    return web.json_response({
        "status": "uploaded",
        "size_bytes": len(firmware_data),
        "chunks": total_chunks,
        "elapsed_seconds": round(elapsed, 1),
        "update_response": update_response,
    })


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/scan", handle_scan)
    app.router.add_post("/connect", handle_connect)
    app.router.add_post("/disconnect", handle_disconnect)
    app.router.add_get("/state", handle_state)
    app.router.add_post("/send", handle_send)
    app.router.add_get("/logs", handle_logs_sse)
    app.router.add_post("/firmware/upload", handle_firmware_upload)

    # CORS middleware
    @web.middleware
    async def cors_middleware(request, handler):
        if request.method == "OPTIONS":
            resp = web.Response(status=200)
        else:
            resp = await handler(request)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    app.middlewares.append(cors_middleware)
    return app


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)-15s %(name)-8s %(levelname)s: %(message)s",
    )
    print("BLE Relay starting on http://localhost:8098")
    print("Endpoints: /scan, /connect, /disconnect, /state, /send, /logs, /firmware/upload")
    web.run_app(create_app(), host="127.0.0.1", port=8098)
