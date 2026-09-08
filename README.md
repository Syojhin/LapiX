<div align="center">

<img src="ui/assets/logo.png" width="128" height="128" alt="LapiX Logo" />

# LapiX
### Ultra-Low Latency Lossless Stream Capture & Orientation Suite

[![Release](https://img.shields.io/github/v/release/Syojhin/LapiX?style=for-the-badge&color=E63946)](https://github.com/Syojhin/LapiX/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6?style=for-the-badge&logo=windows)](https://github.com/Syojhin/LapiX)
[![Engine](https://img.shields.io/badge/hardware%20accel-NVENC%20%7C%20AMF%20%7C%20QSV%20%7C%20VTB-FF5722?style=for-the-badge)](https://github.com/Syojhin/LapiX)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](LICENSE)

<br/>

<a href="https://github.com/Syojhin/LapiX/releases/latest/download/LapiX-Portable-v1.0.0.zip">
  <img src="https://img.shields.io/badge/DOWNLOAD-Portable%20Bundle%20(Recommended)-2A9D8F?style=for-the-badge&logo=zip&logoColor=white" height="34" alt="Download Portable Bundle" />
</a>
&nbsp;
<a href="https://github.com/Syojhin/LapiX/releases/latest/download/LapiX.exe">
  <img src="https://img.shields.io/badge/DOWNLOAD-LapiX.exe%20Only-E63946?style=for-the-badge&logo=windows&logoColor=white" height="34" alt="Download LapiX.exe" />
</a>

<br/><br/>

*A production-grade, zero-bloat desktop media application that captures public video streams at source-identical master quality, provides instantaneous client-side orientation transforms, precision timeline trimming, and visual-lossless hardware export.*

---

</div>

## 🚀 Key Features

* **Instant Multi-Platform Stream Ingest**: Direct capture from TikTok, YouTube (Shorts & Standard Videos), X / Twitter, Instagram Reels, Twitch clips, and Reddit via high-throughput `yt-dlp`.
* **Zero-Latency CSS Orientation Canvas**: Instant $0^\circ$, $90^\circ$, $180^\circ$, and $270^\circ$ rotation using GPU-accelerated client-side transforms with dynamic aspect ratio containment (no re-encoding needed for preview).
* **Interactive Precision Trimmer & Scrubber**: Dual-handle draggable timeline (`IN` and `OUT` markers) with live looping cut verification and millisecond-accurate playhead badges.
* **5-Tier Hardware Transcode Cascade**: Probes and binds host GPU acceleration (NVIDIA NVENC, Apple VideoToolbox, AMD AMF, Intel QSV, or multi-threaded CPU fallback).
* **Pure Bitstream Copy (0° Orientation)**: When orientation is unmodified, bypasses video re-encoding entirely for instantaneous (<100ms) lossless bitstream packaging.
* **Strict Master Audio Invariant**: Always enforces `-c:a copy` passthrough. Audio tracks are never decoded, compressed, or degraded.
* **Custom Storage Destination Selector**: Choose any local drive, external disk, or network folder in advance with real-time UI synchronization.
* **Embedded HTTP 206 Streaming Engine**: Local loopback server with `Accept-Ranges: bytes` allows smooth seeking and scrubbing without WebView sandboxing blocks.
* **Pro Keyboard Shortcuts**:
  * <kbd>Space</kbd> : Toggle Play / Pause
  * <kbd>F</kbd> : Toggle Fullscreen (or double-click video)
  * <kbd>I</kbd> : Mark Cut Start Point (In)
  * <kbd>O</kbd> : Mark Cut End Point (Out)
  * <kbd>M</kbd> : Toggle Audio Mute
  * <kbd>←</kbd> / <kbd>→</kbd> : Step 1.0s (or 0.1s with <kbd>Shift</kbd>)
  * <kbd>Esc</kbd> : Exit Fullscreen

---

## 📦 Quick Start (Ready for Anyone to Use)

Choose the setup that fits best:

### 🌟 Option 1: Portable Zero-Config Bundle (Recommended for Friends)
* **[Download LapiX-Portable-v1.0.0.zip](https://github.com/Syojhin/LapiX/releases/latest/download/LapiX-Portable-v1.0.0.zip)**
* Extract the ZIP anywhere (or directly onto a USB flash drive).
* Double-click **`LapiX.exe`** to launch!
* *Bundles portable FFmpeg out of the box: zero installation, zero drivers, works on any Windows 10/11 machine instantly.*

### ⚡ Option 2: Standalone Executable
* **[Download LapiX.exe](https://github.com/Syojhin/LapiX/releases/latest/download/LapiX.exe)**
* Drop it anywhere on your system and double-click to run.
* *Uses your system's existing `ffmpeg` in `PATH`.*

---

## 🛠️ Developer Setup & Running from Source

### Prerequisites
* **Python 3.10+** (tested on 3.10 through 3.14)
* **FFmpeg** installed and accessible on PATH (or placed in the project root as `ffmpeg.exe`)
* Windows 10 or 11 (with Microsoft Edge WebView2, pre-installed on modern Windows)

### Installation
```bash
# Clone repository
git clone https://github.com/Syojhin/LapiX.git
cd LapiX

# Install minimal dependencies
pip install -r requirements.txt

# Run application
python app.py
```

### Compiling Standalone Executable
```bash
pyinstaller --noconsole --onefile --name "LapiX" --icon "ui/assets/app_icon.ico" --add-data "ui;ui" --add-data "engine;engine" --collect-all yt_dlp --clean -y app.py
```

---

## 🏗️ Architecture

```text
c:/Users/david/Desktop/Lara/LapiX/
├── LapiX.exe               # Standalone Windows executable (37 MB)
├── app.py                  # PyWebView desktop entrypoint & HTTP 206 streaming server
├── engine/
│   ├── __init__.py         # Package interface
│   ├── hardware.py         # 5-tier hardware probe cascade & portable FFmpeg auto-discovery
│   ├── downloader.py       # High-fidelity yt-dlp ingest & cache manager
│   └── transcode.py        # FFmpeg transcode pipeline, timestamp normalization, Explorer reveal
├── ui/
│   ├── index.html          # Industrial glassmorphic interface layout
│   ├── style.css           # Design tokens (Solar Crimson & Fiery Amber accents)
│   ├── app.js              # State manager, CSS orientation matrix, timeline trimmer RPC
│   └── assets/
│       ├── logo.png        # Glowing emblem asset
│       └── app_icon.ico    # Multi-resolution application icon (16x16 - 256x256)
├── requirements.txt        # Runtime dependencies (pywebview, yt-dlp)
└── README.md
```

---

## 📜 License & Credits

Distributed under the MIT License.

Crafted with precision by **Syojhin & Lara**.
