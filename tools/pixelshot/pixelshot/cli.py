import argparse
import asyncio
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path

import requests
import websockets
from PIL import Image

from . import __version__


CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "chromium",
    "chrome",
]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Render a URL or file into screenshot tiles.")
    parser.add_argument("source", nargs="?", help="URL, file:// URL, or local file path to render.")
    parser.add_argument("--output", required=False, help="Directory where tile images and tiles.json are written.")
    parser.add_argument("--tile-height", type=int, default=1024)
    parser.add_argument("--quality", type=int, default=85)
    parser.add_argument("--viewport-width", type=int, default=1440)
    parser.add_argument("--wait-network-idle", action="store_true")
    parser.add_argument("--cdp-url", default="")
    parser.add_argument("--timeout-ms", type=int, default=120000)
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args(argv)

    if args.version:
        print(f"pixelshot {__version__}")
        return 0
    if not args.source:
        parser.error("source is required unless --version is used")
    if not args.output:
        parser.error("--output is required")

    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    source = normalize_source(args.source)
    deadline = time.time() + max(1, args.timeout_ms / 1000)

    chrome = None
    temp_dir = None
    cdp_url = args.cdp_url.strip().rstrip("/")
    try:
        if not cdp_url:
            chrome_path = find_chrome()
            if not chrome_path:
                raise RuntimeError("No local Chrome/Chromium executable found.")
            port = free_port()
            temp_dir = tempfile.TemporaryDirectory(prefix="pixelshot-chrome-")
            cdp_url = f"http://127.0.0.1:{port}"
            chrome = subprocess.Popen([
                chrome_path,
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--disable-background-networking",
                "--disable-default-apps",
                "--disable-extensions",
                "--no-first-run",
                f"--remote-debugging-port={port}",
                f"--user-data-dir={temp_dir.name}",
                "about:blank",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait_for_cdp(cdp_url, deadline)

        target = create_target(cdp_url, source)
        try:
            screenshot = asyncio.run(capture_full_page(
                target["webSocketDebuggerUrl"],
                source,
                args.viewport_width,
                args.wait_network_idle,
                deadline,
            ))
        finally:
            close_target(cdp_url, target.get("id"))

        manifest = write_tiles(output, screenshot, args.tile_height, args.quality)
        (output / "tiles.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        return 0
    except Exception as exc:
        print(f"pixelshot error: {exc}", file=sys.stderr)
        return 1
    finally:
        if chrome is not None:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
        if temp_dir is not None:
            temp_dir.cleanup()


def normalize_source(value):
    text = str(value).strip()
    if text.startswith(("http://", "https://", "file://", "data:")):
        return text
    file = Path(text).expanduser()
    if file.exists():
        return file.resolve().as_uri()
    return text


def find_chrome():
    for candidate in CHROME_CANDIDATES:
        if os.path.isabs(candidate) and os.path.exists(candidate):
            return candidate
        if not os.path.isabs(candidate):
            found = shutil_which(candidate)
            if found:
                return found
    return ""


def shutil_which(command):
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(folder, command)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return ""


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_cdp(cdp_url, deadline):
    last_error = None
    while time.time() < deadline:
        try:
            res = requests.get(f"{cdp_url}/json/version", timeout=1)
            if res.ok:
                return
        except Exception as exc:
            last_error = exc
        time.sleep(0.1)
    raise RuntimeError(f"Chrome CDP did not become available: {last_error}")


def create_target(cdp_url, source):
    encoded = urllib.parse.quote(source, safe="")
    for method in ("put", "get"):
        request = getattr(requests, method)
        res = request(f"{cdp_url}/json/new?{encoded}", timeout=5)
        if res.ok:
            target = res.json()
            if target.get("webSocketDebuggerUrl"):
                return target
    raise RuntimeError(f"Could not create CDP target at {cdp_url}.")


def close_target(cdp_url, target_id):
    if not target_id:
        return
    try:
        requests.get(f"{cdp_url}/json/close/{target_id}", timeout=2)
    except Exception:
        pass


async def capture_full_page(ws_url, source, viewport_width, wait_network_idle, deadline):
    async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
        cdp = Cdp(ws)
        await cdp.call("Page.enable")
        await cdp.call("Runtime.enable")
        await cdp.call("Network.enable")
        await cdp.call("Emulation.setDeviceMetricsOverride", {
            "width": viewport_width,
            "height": 900,
            "deviceScaleFactor": 1,
            "mobile": False,
        })
        await cdp.call("Page.navigate", {"url": source})
        await wait_for_page(cdp, wait_network_idle, deadline)
        metrics = await cdp.call("Page.getLayoutMetrics")
        content = metrics.get("contentSize") or {}
        width = max(1, int(content.get("width") or viewport_width))
        height = max(1, int(content.get("height") or 900))
        await cdp.call("Emulation.setDeviceMetricsOverride", {
            "width": min(max(width, viewport_width), 16384),
            "height": min(height, 16384),
            "deviceScaleFactor": 1,
            "mobile": False,
        })
        shot = await cdp.call("Page.captureScreenshot", {
            "format": "png",
            "fromSurface": True,
            "captureBeyondViewport": True,
            "clip": {
                "x": 0,
                "y": 0,
                "width": width,
                "height": height,
                "scale": 1,
            },
        })
        return base64.b64decode(shot["data"])


async def wait_for_page(cdp, wait_network_idle, deadline):
    loaded = False
    inflight = set()
    idle_since = None
    while time.time() < deadline:
        timeout = max(0.05, min(0.5, deadline - time.time()))
        event = await cdp.next_event(timeout)
        if event:
            method = event.get("method")
            params = event.get("params") or {}
            if method == "Page.loadEventFired":
                loaded = True
                if not wait_network_idle:
                    return
            elif method == "Network.requestWillBeSent":
                inflight.add(params.get("requestId"))
                idle_since = None
            elif method in ("Network.loadingFinished", "Network.loadingFailed"):
                inflight.discard(params.get("requestId"))
                if not inflight:
                    idle_since = time.time()
        elif loaded and (not wait_network_idle or (not inflight and idle_since and time.time() - idle_since >= 0.5)):
            return
    if not loaded:
        raise RuntimeError("Timed out waiting for page load.")


def write_tiles(output, screenshot_bytes, tile_height, quality):
    source_file = output / "full-page.png"
    source_file.write_bytes(screenshot_bytes)
    image = Image.open(source_file)
    width, height = image.size
    tile_height = max(128, int(tile_height or 1024))
    tiles = []
    for index, y in enumerate(range(0, height, tile_height)):
        tile = image.crop((0, y, width, min(y + tile_height, height)))
        name = f"tile-{index:03d}.png"
        tile.save(output / name, optimize=True)
        tiles.append({
            "index": index,
            "file": name,
            "path": name,
            "x": 0,
            "y": y,
            "width": width,
            "height": tile.size[1],
            "quality": quality,
        })
    return {
        "schemaVersion": 1,
        "sourceImage": "full-page.png",
        "width": width,
        "height": height,
        "tileHeight": tile_height,
        "tiles": tiles,
    }


class Cdp:
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 1
        self.pending_events = []

    async def call(self, method, params=None):
        message_id = self.next_id
        self.next_id += 1
        await self.ws.send(json.dumps({
            "id": message_id,
            "method": method,
            "params": params or {},
        }))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == message_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method} failed: {msg['error']}")
                return msg.get("result") or {}
            self.pending_events.append(msg)

    async def next_event(self, timeout):
        if self.pending_events:
            return self.pending_events.pop(0)
        try:
            return json.loads(await asyncio.wait_for(self.ws.recv(), timeout=timeout))
        except asyncio.TimeoutError:
            return None
