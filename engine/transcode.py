"""
LapiX Engine: Live Orientation & Transcoding Pipeline
Constructs and executes FFmpeg transcoding jobs with hardware acceleration and 0° stream-copy bypass.
"""
import os
import re
import sys
import shutil
import logging
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional, Callable

from .hardware import probe_hardware, HardwareProfile, find_ffmpeg_bin

logger = logging.getLogger("lapix.transcode")


def get_desktop_dir() -> Path:
    """Returns the user's desktop path cross-platform."""
    desktop = Path.home() / "Desktop"
    if desktop.exists():
        return desktop
    # Fallback to OneDrive Desktop if Windows redirected
    onedrive_desktop = Path.home() / "OneDrive" / "Desktop"
    if onedrive_desktop.exists():
        return onedrive_desktop
    return Path.home()


def sanitize_component(text: str) -> str:
    """Cleans names for safe filename generation."""
    clean = re.sub(r'[\\/*?:"<>|]', "", text)
    clean = re.sub(r"\s+", "_", clean).strip("_")
    return clean[:40] if clean else "media"


class TranscodePipeline:
    """
    Orchestrates FFmpeg transcoding and lossless stream copy.
    """

    def __init__(self, ffmpeg_bin: Optional[str] = None):
        self.ffmpeg_bin = ffmpeg_bin or find_ffmpeg_bin() or "ffmpeg"
        self.hardware: HardwareProfile = probe_hardware()

    def build_export_filename(self, uploader: str, video_id: str, angle: int, is_trimmed: bool = False) -> str:
        """
        Generates: lapix_[uploader]_[id]_[orientation](_cut).mp4
        """
        safe_uploader = sanitize_component(uploader)
        safe_id = sanitize_component(video_id)
        norm_angle = angle % 360
        trim_suffix = "_cut" if is_trimmed else ""
        orientation = f"rot{norm_angle}"
        base_name = f"lapix_{safe_uploader}_{safe_id}_{orientation}{trim_suffix}.mp4"
        return base_name

    def get_rotation_filter(self, angle: int) -> Optional[str]:
        """
        Maps rotation angle to FFmpeg transpose filter:
        - 0°: None (Direct stream copy)
        - 90° CW: transpose=1
        - 180°: transpose=2,transpose=2
        - 270° CW (90° CCW): transpose=2
        """
        norm_angle = angle % 360
        if norm_angle == 0:
            return None
        elif norm_angle == 90:
            return "transpose=1"
        elif norm_angle == 180:
            return "transpose=2,transpose=2"
        elif norm_angle == 270:
            return "transpose=2"
        else:
            # Arbitrary angle fallback if ever needed
            import math
            rad = norm_angle * (math.pi / 180.0)
            return f"rotate={rad}:ow='rotw({rad})':oh='roth({rad})'"

    def transcode(
        self,
        input_path: str,
        uploader: str,
        video_id: str,
        angle: int = 0,
        codec: str = "h264",
        total_duration: float = 0.0,
        start_time: float = 0.0,
        end_time: Optional[float] = None,
        output_dir: Optional[Path] = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ) -> Dict[str, Any]:
        """
        Executes FFmpeg export with optional trimming and orientation matrix.
        - 0° rotation without trimming triggers pure stream copy: -c:v copy -c:a copy.
        - Non-zero rotation triggers transpose filter with selected hardware encoder.
        - Always copies audio (-c:a copy).
        """
        in_file = Path(input_path).resolve()
        if not in_file.exists():
            raise FileNotFoundError(f"Input stream media file not found: {input_path}")

        dest_dir = output_dir or get_desktop_dir()
        dest_dir.mkdir(parents=True, exist_ok=True)

        is_trimmed = False
        if start_time > 0.05:
            is_trimmed = True
        if end_time is not None and total_duration > 0 and end_time < (total_duration - 0.05):
            is_trimmed = True

        filename = self.build_export_filename(uploader, video_id, angle, is_trimmed=is_trimmed)
        out_file = dest_dir / filename

        # Avoid collision if user re-exports
        counter = 1
        stem = out_file.stem
        while out_file.exists():
            out_file = dest_dir / f"{stem}_{counter}.mp4"
            counter += 1

        norm_angle = angle % 360
        vf_filter = self.get_rotation_filter(norm_angle)

        cmd = [self.ffmpeg_bin, "-y"]

        # Trimming parameters
        if start_time > 0.01:
            cmd.extend(["-ss", f"{start_time:.3f}"])
        if end_time is not None and end_time > start_time:
            # If -ss is before -i, -to indicates the duration or relative timestamp
            # Using -to with -i in FFmpeg:
            cmd.extend(["-to", f"{end_time:.3f}"])

        cmd.extend(["-i", str(in_file)])

        is_stream_copy = (vf_filter is None)

        if is_stream_copy:
            # 0° Pure stream copy - instantaneous lossless export
            cmd.extend(["-c:v", "copy"])
            cmd.extend(["-avoid_negative_ts", "make_zero"])
        else:
            # Apply orientation transpose filter
            cmd.extend(["-vf", vf_filter])

            # Select encoder from hardware profile
            profile = self.hardware.hevc if codec.lower() == "hevc" else self.hardware.h264
            cmd.extend(profile.args)

        # CRITICAL RULE: Always append -c:a copy across all operations
        cmd.extend(["-c:a", "copy"])
        cmd.extend(["-movflags", "+faststart"])
        cmd.append(str(out_file))

        logger.info(f"Executing FFmpeg command: {' '.join(cmd)}")

        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
            universal_newlines=True,
            bufsize=1
        )

        time_pattern = re.compile(r"time=(\d{2}):(\d{2}):(\d{2}\.\d+)")
        speed_pattern = re.compile(r"speed=\s*([\d\.]+)x")

        # Parse stderr for real-time progress
        stderr_log = []
        effective_duration = total_duration
        if end_time and end_time > start_time:
            effective_duration = end_time - start_time
        elif start_time > 0 and total_duration > start_time:
            effective_duration = total_duration - start_time

        if proc.stderr:
            for line in proc.stderr:
                stderr_log.append(line)
                if progress_callback and effective_duration > 0:
                    time_match = time_pattern.search(line)
                    speed_match = speed_pattern.search(line)
                    if time_match:
                        h, m, s = map(float, time_match.groups())
                        current_sec = h * 3600 + m * 60 + s
                        pct = min(99.0, round((current_sec / effective_duration) * 100.0, 1))
                        speed = speed_match.group(1) if speed_match else "1.0"
                        progress_callback({
                            "percent": pct,
                            "speed": f"{speed}x",
                            "state": "rendering"
                        })

        proc.wait()

        if proc.returncode != 0:
            err_msg = "".join(stderr_log[-15:])
            raise RuntimeError(f"FFmpeg transcode failed (exit code {proc.returncode}):\n{err_msg}")

        if progress_callback:
            progress_callback({
                "percent": 100.0,
                "speed": "done",
                "state": "complete"
            })

        out_size = out_file.stat().st_size if out_file.exists() else 0

        return {
            "output_path": str(out_file.resolve()),
            "filename": out_file.name,
            "file_size": out_size,
            "angle": norm_angle,
            "codec": codec,
            "is_lossless_copy": is_stream_copy,
            "encoder_used": "copy" if is_stream_copy else self.hardware.label
        }


def reveal_in_explorer(file_path: str) -> None:
    """Highlights the target exported file in the host OS file explorer."""
    path = Path(file_path).resolve()
    if not path.exists():
        return

    try:
        if sys.platform == "win32":
            subprocess.run(["explorer", f"/select,{str(path)}"], check=False)
        elif sys.platform == "darwin":
            subprocess.run(["open", "-R", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path.parent)], check=False)
    except Exception as e:
        logger.warning(f"Failed to open explorer for {file_path}: {e}")
