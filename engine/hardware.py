"""
LapiX Engine: Hardware Acceleration Probe
Probes available hardware encoders across NVIDIA, Apple Silicon, AMD, Intel, and CPU fallback.
"""
import shutil
import subprocess
import logging
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional

logger = logging.getLogger("lapix.hardware")


@dataclass
class CodecProfile:
    encoder: str
    args: List[str]


@dataclass
class HardwareProfile:
    tier: str
    vendor: str
    label: str
    is_hardware: bool
    h264: CodecProfile
    hevc: CodecProfile
    ffmpeg_available: bool = True
    ffmpeg_version: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tier": self.tier,
            "vendor": self.vendor,
            "label": self.label,
            "is_hardware": self.is_hardware,
            "ffmpeg_available": self.ffmpeg_available,
            "ffmpeg_version": self.ffmpeg_version,
            "h264": {
                "encoder": self.h264.encoder,
                "args": self.h264.args,
            },
            "hevc": {
                "encoder": self.hevc.encoder,
                "args": self.hevc.args,
            }
        }


# Encoders cascade ordered strictly by performance priority
ENCODER_CANDIDATES = [
    {
        "tier": "NVIDIA",
        "vendor": "NVIDIA NVENC",
        "label": "ENGINE: NVIDIA NVENC",
        "is_hardware": True,
        "probe_encoder": "h264_nvenc",
        "h264": CodecProfile(
            encoder="h264_nvenc",
            args=["-c:v", "h264_nvenc", "-cq", "18", "-preset", "p6"]
        ),
        "hevc": CodecProfile(
            encoder="hevc_nvenc",
            args=["-c:v", "hevc_nvenc", "-cq", "21", "-preset", "p6"]
        ),
    },
    {
        "tier": "APPLE",
        "vendor": "Apple VideoToolbox",
        "label": "ENGINE: APPLE VIDEOTOOLBOX",
        "is_hardware": True,
        "probe_encoder": "h264_videotoolbox",
        "h264": CodecProfile(
            encoder="h264_videotoolbox",
            args=["-c:v", "h264_videotoolbox", "-q:v", "75"]
        ),
        "hevc": CodecProfile(
            encoder="hevc_videotoolbox",
            args=["-c:v", "hevc_videotoolbox", "-q:v", "75"]
        ),
    },
    {
        "tier": "AMD",
        "vendor": "AMD AMF",
        "label": "ENGINE: AMD AMF",
        "is_hardware": True,
        "probe_encoder": "h264_amf",
        "h264": CodecProfile(
            encoder="h264_amf",
            args=["-c:v", "h264_amf", "-rc", "cqp", "-qp_p", "18", "-quality", "quality"]
        ),
        "hevc": CodecProfile(
            encoder="hevc_amf",
            args=["-c:v", "hevc_amf", "-rc", "cqp", "-qp_p", "21", "-quality", "quality"]
        ),
    },
    {
        "tier": "INTEL",
        "vendor": "Intel QSV",
        "label": "ENGINE: INTEL QSV",
        "is_hardware": True,
        "probe_encoder": "h264_qsv",
        "h264": CodecProfile(
            encoder="h264_qsv",
            args=["-c:v", "h264_qsv", "-global_quality", "18", "-preset", "veryslow"]
        ),
        "hevc": CodecProfile(
            encoder="hevc_qsv",
            args=["-c:v", "hevc_qsv", "-global_quality", "21", "-preset", "veryslow"]
        ),
    },
    {
        "tier": "CPU",
        "vendor": "Universal CPU Fallback",
        "label": "ENGINE: CPU (SOFTWARE)",
        "is_hardware": False,
        "probe_encoder": "libx264",
        "h264": CodecProfile(
            encoder="libx264",
            args=["-c:v", "libx264", "-crf", "17", "-preset", "slow"]
        ),
        "hevc": CodecProfile(
            encoder="libx265",
            args=["-c:v", "libx265", "-crf", "21", "-preset", "slow"]
        ),
    }
]


def test_encoder_available(encoder_name: str, ffmpeg_bin: str = "ffmpeg") -> bool:
    """
    Executes a silent 1-frame test using a 256x256 test canvas.
    Note: 256x256 is required because modern NVENC and hardware encoders fail on <128px frames.
    """
    cmd = [
        ffmpeg_bin,
        "-y",
        "-f", "lavfi",
        "-i", "color=black:s=256x256:d=0.01",
        "-c:v", encoder_name,
        "-f", "null",
        "-"
    ]
    try:
        # Hide console window on Windows
        startupinfo = None
        creationflags = 0
        import sys
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW

        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
            creationflags=creationflags,
            timeout=3.0
        )
        return proc.returncode == 0
    except Exception as e:
        logger.debug(f"Encoder probe failed for {encoder_name}: {e}")
        return False


def get_ffmpeg_version(ffmpeg_bin: str = "ffmpeg") -> str:
    """Returns the FFmpeg short version banner."""
    try:
        import sys
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        proc = subprocess.run(
            [ffmpeg_bin, "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=creationflags,
            timeout=2.0
        )
        if proc.returncode == 0 and proc.stdout:
            lines = proc.stdout.splitlines()
            return lines[0] if lines else "ffmpeg"
    except Exception:
        pass
    return "Unknown"


_CACHED_PROFILE: Optional[HardwareProfile] = None


def find_ffmpeg_bin() -> Optional[str]:
    """
    Locates the best available FFmpeg binary:
    1. Checks for portable ffmpeg.exe alongside the running executable or project root.
    2. Checks ./bin/ffmpeg.exe.
    3. Falls back to system PATH via shutil.which("ffmpeg").
    """
    import sys
    from pathlib import Path

    if getattr(sys, "frozen", False):
        base_dir = Path(sys.executable).parent
    else:
        base_dir = Path(__file__).parent.parent.resolve()

    candidates = [
        base_dir / "ffmpeg.exe",
        base_dir / "bin" / "ffmpeg.exe",
        base_dir / "ffmpeg" / "bin" / "ffmpeg.exe",
    ]
    for cand in candidates:
        if cand.exists() and cand.is_file():
            return str(cand.resolve())

    return shutil.which("ffmpeg")


def probe_hardware(force_refresh: bool = False) -> HardwareProfile:
    """
    Probes system FFmpeg and discovers the fastest available hardware acceleration tier.
    Caches the result for instant subsequent lookups.
    """
    global _CACHED_PROFILE
    if _CACHED_PROFILE is not None and not force_refresh:
        return _CACHED_PROFILE

    ffmpeg_bin = find_ffmpeg_bin()
    if not ffmpeg_bin:
        logger.error("FFmpeg not found in system PATH or local application directory.")
        _CACHED_PROFILE = HardwareProfile(
            tier="NONE",
            vendor="FFmpeg Not Installed",
            label="ERROR: FFMPEG NOT DETECTED",
            is_hardware=False,
            ffmpeg_available=False,
            ffmpeg_version="Missing",
            h264=ENCODER_CANDIDATES[-1]["h264"],
            hevc=ENCODER_CANDIDATES[-1]["hevc"]
        )
        return _CACHED_PROFILE

    version_str = get_ffmpeg_version(ffmpeg_bin)

    for candidate in ENCODER_CANDIDATES:
        probe_name = candidate["probe_encoder"]
        if test_encoder_available(probe_name, ffmpeg_bin):
            logger.info(f"Active hardware profile selected: {candidate['label']}")
            _CACHED_PROFILE = HardwareProfile(
                tier=candidate["tier"],
                vendor=candidate["vendor"],
                label=candidate["label"],
                is_hardware=candidate["is_hardware"],
                ffmpeg_available=True,
                ffmpeg_version=version_str,
                h264=candidate["h264"],
                hevc=candidate["hevc"]
            )
            return _CACHED_PROFILE

    # Guaranteed fallback
    fallback = ENCODER_CANDIDATES[-1]
    _CACHED_PROFILE = HardwareProfile(
        tier=fallback["tier"],
        vendor=fallback["vendor"],
        label=fallback["label"],
        is_hardware=fallback["is_hardware"],
        ffmpeg_available=True,
        ffmpeg_version=version_str,
        h264=fallback["h264"],
        hevc=fallback["hevc"]
    )
    return _CACHED_PROFILE
