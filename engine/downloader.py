"""
LapiX Engine: Master Ingest Pipeline (yt-dlp)
Fetches raw public video streams at source-identical master quality with local cache management.
"""
import os
import re
import shutil
import logging
from pathlib import Path
from typing import Dict, Any, Optional, Callable
import yt_dlp

from .hardware import find_ffmpeg_bin

logger = logging.getLogger("lapix.downloader")

CACHE_DIR = Path.home() / ".lapix" / "cache"


def ensure_cache_dir() -> Path:
    """Ensures ~/.lapix/cache/ exists."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR


def purge_cache() -> int:
    """Purges all files within ~/.lapix/cache/. Returns count of files deleted."""
    ensure_cache_dir()
    count = 0
    for item in CACHE_DIR.iterdir():
        try:
            if item.is_file():
                item.unlink()
                count += 1
            elif item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
                count += 1
        except Exception as e:
            logger.warning(f"Could not remove cache file {item}: {e}")
    return count


def sanitize_filename(name: str) -> str:
    """Removes invalid filename characters for safe cross-platform saving."""
    clean = re.sub(r'[\\/*?:"<>|]', "", name)
    clean = re.sub(r"\s+", "_", clean).strip("_")
    return clean[:60] if clean else "media"


class StreamDownloader:
    """
    High-fidelity stream ingest engine powered by yt-dlp.
    """

    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = cache_dir or ensure_cache_dir()

    def fetch(
        self,
        url: str,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ) -> Dict[str, Any]:
        """
        Downloads the target stream at master quality into ~/.lapix/cache/.
        Returns metadata payload containing media details and local path.
        """
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cleaned_url = url.strip().strip("'\"")

        def ytdl_hook(d: Dict[str, Any]):
            if not progress_callback:
                return
            status = d.get("status")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes") or 0
                speed = d.get("speed") or 0
                eta = d.get("eta") or 0
                percent = (downloaded / total * 100.0) if total > 0 else 0.0
                progress_callback({
                    "state": "downloading",
                    "percent": round(percent, 1),
                    "downloaded": downloaded,
                    "total": total,
                    "speed": speed,
                    "eta": eta,
                })
            elif status == "finished":
                progress_callback({
                    "state": "processing",
                    "percent": 100.0,
                    "filename": d.get("filename")
                })

        ydl_opts = {
            "format": "bestvideo+bestaudio/best",
            "merge_output_format": "mp4",
            "outtmpl": str(self.cache_dir / "%(id)s.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [ytdl_hook],
            "concurrent_fragment_downloads": 4,
            "overwrites": True,
            "socket_timeout": 30,
        }

        ffmpeg_bin = find_ffmpeg_bin()
        if ffmpeg_bin:
            ydl_opts["ffmpeg_location"] = str(Path(ffmpeg_bin).parent)

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(cleaned_url, download=True)
                if not info:
                    raise RuntimeError("Failed to extract stream metadata from URL.")

                video_id = info.get("id", "stream")
                title = info.get("title", "Untitled Stream")
                uploader = info.get("uploader") or info.get("channel") or info.get("creator") or "Unknown"
                duration = info.get("duration") or 0
                width = info.get("width") or 0
                height = info.get("height") or 0

                # Determine the exact merged or downloaded file path
                local_file = self.cache_dir / f"{video_id}.mp4"
                if not local_file.exists():
                    # Check if saved with another extension
                    matches = list(self.cache_dir.glob(f"{video_id}.*"))
                    if matches:
                        local_file = matches[0]
                    else:
                        raise FileNotFoundError(f"Downloaded stream file not found for ID {video_id}")

                file_size = local_file.stat().st_size if local_file.exists() else 0

                payload = {
                    "id": video_id,
                    "title": title,
                    "uploader": sanitize_filename(uploader),
                    "local_path": str(local_file.resolve()),
                    "filename": local_file.name,
                    "duration": duration,
                    "width": width,
                    "height": height,
                    "file_size": file_size,
                }
                logger.info(f"Stream fetched successfully: {video_id} ({local_file.name})")
                return payload

        except Exception as e:
            logger.error(f"Ingest failed for URL {cleaned_url}: {e}")
            raise RuntimeError(f"Stream capture failed: {str(e)}") from e
