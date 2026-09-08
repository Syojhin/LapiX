"""
LapiX: Lossless Stream Capture & Orientation Utility
Main Application Entrypoint & PyWebView Desktop Orchestration
"""
import os
import re
import sys
import json
import logging
import mimetypes
import threading
import urllib.parse
from pathlib import Path
from typing import Dict, Any, Optional
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import webview

from engine.hardware import probe_hardware, HardwareProfile
from engine.downloader import StreamDownloader, CACHE_DIR, purge_cache, ensure_cache_dir
from engine.transcode import TranscodePipeline, reveal_in_explorer, get_desktop_dir

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s]: %(message)s"
)
logger = logging.getLogger("lapix.app")

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).parent.resolve()

UI_DIR = BASE_DIR / "ui"

_ACTIVE_WINDOW: Optional[webview.Window] = None


def get_cache_size_str() -> str:
    """Calculates formatted total cache size."""
    ensure_cache_dir()
    total = sum(f.stat().st_size for f in CACHE_DIR.glob("**/*") if f.is_file())
    if total < 1024 * 1024:
        return f"{round(total / 1024, 1)} KB"
    elif total < 1024 * 1024 * 1024:
        return f"{round(total / (1024 * 1024), 1)} MB"
    else:
        return f"{round(total / (1024 * 1024 * 1024), 2)} GB"


class RangeHTTPHandler(BaseHTTPRequestHandler):
    """
    HTTP 206 Partial Content server for instant video scrubbing and static UI assets.
    """

    def log_message(self, format, *args):
        # Silence verbose standard access logs
        pass

    def do_GET(self):
        url_path = urllib.parse.unquote(self.path.split("?")[0])

        # 1. Media Stream Endpoint: /media/<filename>
        if url_path.startswith("/media/"):
            filename = url_path[len("/media/"):]
            file_path = (CACHE_DIR / filename).resolve()
            # Security check: must reside inside CACHE_DIR
            if not str(file_path).startswith(str(CACHE_DIR.resolve())) or not file_path.exists():
                self.send_error(404, "Media file not found")
                return
            self.serve_file_with_range(file_path)
            return

        # 2. Static UI Files: /, /index.html, /style.css, /app.js, /assets/...
        if url_path == "/" or url_path == "":
            rel_path = "index.html"
        else:
            rel_path = url_path.lstrip("/")

        target_file = (UI_DIR / rel_path).resolve()
        if not str(target_file).startswith(str(UI_DIR.resolve())) or not target_file.exists():
            self.send_error(404, "Asset not found")
            return

        self.serve_file_with_range(target_file)

    def serve_file_with_range(self, file_path: Path):
        try:
            file_size = file_path.stat().st_size
            mime_type, _ = mimetypes.guess_type(str(file_path))
            if not mime_type:
                if file_path.suffix.lower() == ".mp4":
                    mime_type = "video/mp4"
                elif file_path.suffix.lower() == ".js":
                    mime_type = "application/javascript"
                elif file_path.suffix.lower() == ".css":
                    mime_type = "text/css"
                else:
                    mime_type = "application/octet-stream"

            range_header = self.headers.get("Range")

            if range_header:
                match = re.match(r"bytes=(\d+)-(\d*)", range_header)
                if match:
                    start = int(match.group(1))
                    end = int(match.group(2)) if match.group(2) else file_size - 1
                    end = min(end, file_size - 1)
                    if start > end or start >= file_size:
                        self.send_error(416, "Requested Range Not Satisfiable")
                        return

                    length = end - start + 1
                    self.send_response(206)
                    self.send_header("Content-Type", mime_type)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()

                    with open(file_path, "rb") as f:
                        f.seek(start)
                        bytes_to_send = length
                        chunk_size = 64 * 1024
                        while bytes_to_send > 0:
                            read_amt = min(chunk_size, bytes_to_send)
                            chunk = f.read(read_amt)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            bytes_to_send -= len(chunk)
                    return

            # Non-range full request
            self.send_response(200)
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            with open(file_path, "rb") as f:
                chunk_size = 64 * 1024
                while True:
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            logger.debug(f"Streaming error for {file_path}: {e}")


class LapiXServer:
    """Manages background daemon HTTP server on ephemeral loopback port."""

    def __init__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RangeHTTPHandler)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        logger.info(f"LapiX Local HTTP 206 Streaming Server active on http://127.0.0.1:{self.port}")

    def shutdown(self):
        try:
            self.server.shutdown()
        except Exception:
            pass


class Api:
    """
    PyWebView RPC Bridge.
    Note: All internal non-RPC attributes MUST start with '_' to prevent
    PyWebView from crawling and recursively reflecting on Python/.NET internals.
    """

    def __init__(self, server_port: int):
        self._server_port = server_port
        self._downloader = StreamDownloader(CACHE_DIR)
        self._transcoder = TranscodePipeline()
        self._active_streams: Dict[str, Dict[str, Any]] = {}
        self._output_dir: Path = get_desktop_dir()

    def get_system_info(self) -> Dict[str, Any]:
        """Probes hardware and returns active engine and cache details."""
        profile = probe_hardware()
        return {
            "hardware": profile.to_dict(),
            "cache_size_str": get_cache_size_str(),
            "server_port": self._server_port,
            "output_dir": str(self._output_dir),
            "output_dir_name": self._output_dir.name or str(self._output_dir),
        }

    def select_output_directory(self) -> Dict[str, Any]:
        """Opens native folder picker dialog for user to choose export destination."""
        global _ACTIVE_WINDOW
        initial_dir = str(self._output_dir) if self._output_dir.exists() else str(get_desktop_dir())
        chosen_dir: Optional[Path] = None

        try:
            if _ACTIVE_WINDOW:
                result = _ACTIVE_WINDOW.create_file_dialog(
                    dialog_type=webview.FileDialog.FOLDER,
                    directory=initial_dir
                )
                if result and len(result) > 0:
                    cand = Path(result[0]).resolve()
                    if cand.exists() and cand.is_dir():
                        chosen_dir = cand
        except Exception as e:
            logger.warning(f"webview create_file_dialog error: {e}, falling back to tkinter")

        if not chosen_dir:
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes('-topmost', True)
                selected = filedialog.askdirectory(initialdir=initial_dir, title="Select LapiX Export Folder")
                root.destroy()
                if selected:
                    cand = Path(selected).resolve()
                    if cand.exists() and cand.is_dir():
                        chosen_dir = cand
            except Exception as e:
                logger.error(f"Fallback askdirectory error: {e}")

        if chosen_dir:
            self._output_dir = chosen_dir
            logger.info(f"Updated LapiX export output directory: {self._output_dir}")
            return {
                "success": True,
                "path": str(self._output_dir),
                "name": self._output_dir.name or str(self._output_dir)
            }

        return {
            "success": False,
            "path": str(self._output_dir),
            "name": self._output_dir.name or str(self._output_dir)
        }

    def reset_output_directory(self) -> Dict[str, Any]:
        """Resets the export destination back to default Desktop."""
        self._output_dir = get_desktop_dir()
        return {
            "success": True,
            "path": str(self._output_dir),
            "name": self._output_dir.name or str(self._output_dir)
        }

    def read_clipboard(self) -> str:
        """Safely and instantly retrieves clipboard text on Windows without window instantiation."""
        if sys.platform == "win32":
            try:
                import ctypes
                import time
                from ctypes import wintypes

                user32 = ctypes.windll.user32
                kernel32 = ctypes.windll.kernel32

                # Explicit Win32 64-bit/32-bit prototypes to prevent pointer truncation and 0xc0000005 crash
                user32.OpenClipboard.argtypes = [wintypes.HWND]
                user32.OpenClipboard.restype = wintypes.BOOL
                user32.CloseClipboard.argtypes = []
                user32.CloseClipboard.restype = wintypes.BOOL
                user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
                user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
                user32.GetClipboardData.argtypes = [wintypes.UINT]
                user32.GetClipboardData.restype = wintypes.HANDLE

                kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
                kernel32.GlobalLock.restype = wintypes.LPVOID
                kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
                kernel32.GlobalUnlock.restype = wintypes.BOOL

                CF_UNICODETEXT = 13
                if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
                    return ""

                # Non-blocking retry if clipboard is temporarily locked by another app
                opened = False
                for _ in range(5):
                    if user32.OpenClipboard(None):
                        opened = True
                        break
                    time.sleep(0.01)

                if not opened:
                    return ""

                try:
                    handle = user32.GetClipboardData(CF_UNICODETEXT)
                    if handle:
                        ptr = kernel32.GlobalLock(handle)
                        if ptr:
                            try:
                                text = ctypes.wstring_at(ptr)
                                return text.strip() if text else ""
                            finally:
                                kernel32.GlobalUnlock(handle)
                finally:
                    user32.CloseClipboard()
            except Exception as e:
                logger.debug(f"Direct ctypes clipboard read error: {e}")

        # Fallback to tkinter for other platforms or if ctypes failed
        try:
            import tkinter as tk
            root = tk.Tk()
            root.withdraw()
            text = root.clipboard_get()
            root.destroy()
            return str(text).strip() if text else ""
        except Exception:
            return ""

    def fetch_stream(self, url: str) -> Dict[str, Any]:
        """Downloads stream from URL and emits progress to window UI."""
        def progress_cb(data: Dict[str, Any]):
            if _ACTIVE_WINDOW:
                js = f"if (window.onDownloadProgress) window.onDownloadProgress({json.dumps(data)});"
                try:
                    _ACTIVE_WINDOW.evaluate_js(js)
                except Exception:
                    pass

        payload = self._downloader.fetch(url, progress_callback=progress_cb)
        media_id = payload["id"]
        self._active_streams[media_id] = payload

        # Attach internal loopback streaming URL for the <video> tag
        filename = payload["filename"]
        payload["stream_url"] = f"http://127.0.0.1:{self._server_port}/media/{filename}"
        return payload

    def export_stream(
        self,
        media_id: str,
        angle: int,
        codec: str,
        start_time: float = 0.0,
        end_time: Optional[float] = None
    ) -> Dict[str, Any]:
        """Runs the FFmpeg transcode pipeline with optional trimming and renders output to selected folder."""
        matches = list(CACHE_DIR.glob(f"{media_id}.*"))
        if not matches:
            raise FileNotFoundError(f"Source stream with ID {media_id} not found in cache.")

        input_file = matches[0]
        meta = self._active_streams.get(media_id, {})
        uploader = meta.get("uploader", "creator")
        duration = float(meta.get("duration") or 0.0)

        def render_cb(data: Dict[str, Any]):
            if _ACTIVE_WINDOW:
                js = f"if (window.onRenderProgress) window.onRenderProgress({json.dumps(data)});"
                try:
                    _ACTIVE_WINDOW.evaluate_js(js)
                except Exception:
                    pass

        result = self._transcoder.transcode(
            input_path=str(input_file),
            uploader=uploader,
            video_id=media_id,
            angle=angle,
            codec=codec,
            total_duration=duration,
            start_time=float(start_time or 0.0),
            end_time=float(end_time) if end_time is not None else None,
            output_dir=self._output_dir,
            progress_callback=render_cb
        )
        result["destination_dir"] = str(self._output_dir)
        result["destination_name"] = self._output_dir.name or str(self._output_dir)
        return result

    def open_desktop_folder(self, file_path: str) -> bool:
        """Reveals the rendered file in Explorer/Finder."""
        reveal_in_explorer(file_path)
        return True

    def clear_cache(self) -> int:
        """Purges cached media files."""
        return purge_cache()

    def toggle_fullscreen(self) -> bool:
        """Toggles window fullscreen state."""
        global _ACTIVE_WINDOW
        if _ACTIVE_WINDOW:
            _ACTIVE_WINDOW.toggle_fullscreen()
            return bool(_ACTIVE_WINDOW.fullscreen)
        return False


def on_closed():
    """Cleanup hook executed when user closes window."""
    logger.info("LapiX window closed. Performing cache cleanup...")
    purge_cache()


def main():
    global _ACTIVE_WINDOW
    ensure_cache_dir()

    # Launch local streaming server
    server = LapiXServer()
    server.start()

    api = Api(server.port)

    # Launch PyWebView Window (Clean title: LapiX)
    window = webview.create_window(
        title="LapiX",
        url=f"http://127.0.0.1:{server.port}/index.html",
        width=1180,
        height=840,
        min_size=(920, 680),
        background_color="#0a0c10",
        js_api=api,
        text_select=True,
    )
    _ACTIVE_WINDOW = window
    window.events.closed += on_closed

    try:
        webview.start(debug=False)
    finally:
        server.shutdown()


if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    main()
