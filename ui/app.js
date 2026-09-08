/**
 * LapiX Desktop Controller
 * Orchestrates PyWebView RPC, zero-latency CSS orientation matrix, timeline trimmer, and audio controls.
 */

(function () {
  'use strict';

  // --- STATE ---
  const state = {
    hardware: null,
    currentMedia: null,
    currentAngle: 0,
    selectedCodec: 'h264',
    isFetching: false,
    isRendering: false,
    isPlaying: false,
    isMuted: false,
    volume: 1.0,
    duration: 0.0,
    trimIn: 0.0,
    trimOut: 0.0,
    activeDrag: null, // 'in' | 'out' | 'seek'
    outputDir: '',
    outputDirName: 'Desktop',
  };

  // --- DOM ELEMENTS ---
  const elements = {
    // Header
    engineBadge: document.getElementById('hardware-badge'),
    engineLabel: document.getElementById('engine-label'),
    btnPurgeCache: document.getElementById('btn-purge-cache'),
    cacheFootprint: document.getElementById('cache-footprint'),

    // Ingest
    urlInput: document.getElementById('stream-url-input'),
    btnPaste: document.getElementById('btn-paste-clipboard'),
    btnFetch: document.getElementById('btn-fetch'),
    ingestProgress: document.getElementById('ingest-progress-container'),
    ingestProgressBar: document.getElementById('ingest-progress-bar'),
    ingestStatusText: document.getElementById('ingest-status-text'),
    ingestSpeedText: document.getElementById('ingest-speed-text'),

    // Viewer
    viewerViewport: document.getElementById('viewer-viewport'),
    standbyState: document.getElementById('standby-state'),
    videoContainer: document.getElementById('video-stage-container'),
    playerVideo: document.getElementById('player-video'),
    viewerHud: document.getElementById('viewer-hud'),
    hudResolution: document.getElementById('hud-resolution'),
    hudDuration: document.getElementById('hud-duration'),
    hudAnglePill: document.getElementById('hud-angle-pill'),
    streamInfoOverlay: document.getElementById('stream-info-overlay'),
    streamTitleDisplay: document.getElementById('stream-title-display'),
    streamCreatorDisplay: document.getElementById('stream-creator-display'),

    // Trimmer
    trimmerPanel: document.getElementById('trimmer-panel'),
    timelineTrackContainer: document.getElementById('timeline-track-container'),
    timelineTrack: document.getElementById('timeline-track'),
    handleIn: document.getElementById('handle-in'),
    handleOut: document.getElementById('handle-out'),
    timelinePlayhead: document.getElementById('timeline-playhead'),
    regionDimmedLeft: document.getElementById('region-dimmed-left'),
    regionActive: document.getElementById('region-active'),
    regionDimmedRight: document.getElementById('region-dimmed-right'),
    badgeInTime: document.getElementById('badge-in-time'),
    badgePlayheadTime: document.getElementById('badge-playhead-time'),
    badgeOutTime: document.getElementById('badge-out-time'),
    badgeDurationTime: document.getElementById('badge-duration-time'),
    btnResetTrim: document.getElementById('btn-reset-trim'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    btnHudFullscreen: document.getElementById('btn-hud-fullscreen'),
    fullscreenIcon: document.getElementById('fullscreen-icon'),
    fullscreenText: document.getElementById('fullscreen-text'),

    // Control Dock
    btnRotateLeft: document.getElementById('btn-rotate-left'),
    btnRotateRight: document.getElementById('btn-rotate-right'),
    btnRotateReset: document.getElementById('btn-rotate-reset'),
    orientationReadout: document.getElementById('orientation-readout'),
    btnPlayPause: document.getElementById('btn-play-pause'),
    playPauseText: document.getElementById('play-pause-text'),
    playPauseIcon: document.getElementById('play-pause-icon'),
    btnMute: document.getElementById('btn-mute'),
    muteIcon: document.getElementById('mute-icon'),
    volumeSlider: document.getElementById('volume-slider'),
    volumeReadout: document.getElementById('volume-readout'),

    // Export Bar
    btnCodecH264: document.getElementById('btn-codec-h264'),
    btnCodecHevc: document.getElementById('btn-codec-hevc'),
    btnSelectFolder: document.getElementById('btn-select-folder'),
    destinationFolderName: document.getElementById('destination-folder-name'),
    footerDestinationLink: document.getElementById('footer-destination-link'),
    footerDestinationName: document.getElementById('footer-destination-name'),
    btnRender: document.getElementById('btn-render'),
    renderIconWrapper: document.getElementById('render-icon-wrapper'),
    renderBtnText: document.getElementById('render-btn-text'),

    // Toasts
    toastContainer: document.getElementById('toast-container'),
  };

  // --- TIME FORMATTING HELPER ---
  function formatPreciseTime(sec) {
    if (isNaN(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
  }

  // --- PYWEBVIEW BRIDGE ACCESS ---
  function getApi() {
    if (window.pywebview && window.pywebview.api) {
      return window.pywebview.api;
    }
    return null;
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(title, message, type = 'info', actionCallback = null, actionLabel = 'VIEW') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const iconSvg = type === 'success' 
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

    toast.innerHTML = `
      <div class="toast-icon">${iconSvg}</div>
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        <div class="toast-message">${message}</div>
      </div>
    `;

    if (actionCallback) {
      const btn = document.createElement('button');
      btn.className = 'toast-action-btn';
      btn.textContent = actionLabel;
      btn.onclick = () => {
        actionCallback();
        toast.remove();
      };
      toast.appendChild(btn);
    }

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px) scale(0.95)';
      setTimeout(() => toast.remove(), 300);
    }, actionCallback ? 8000 : 4500);
  }

  // --- INITIALIZATION ---
  async function initSystem() {
    const api = getApi();
    if (!api) return;

    try {
      const info = await api.get_system_info();
      state.hardware = info.hardware;

      if (info.hardware) {
        elements.engineLabel.textContent = info.hardware.label;
        if (info.hardware.is_hardware) {
          elements.engineBadge.classList.add('hardware-active');
        } else {
          elements.engineBadge.classList.remove('hardware-active');
        }

        if (!info.hardware.ffmpeg_available) {
          showToast('FFmpeg Missing', 'FFmpeg was not detected in your system PATH. Transcoding will be unavailable.', 'error');
        }
      }

      if (info.cache_size_str) {
        elements.cacheFootprint.textContent = `CACHE: ${info.cache_size_str}`;
      }

      if (info.output_dir) {
        state.outputDir = info.output_dir;
        state.outputDirName = info.output_dir_name || 'Desktop';
        updateDestinationUI();
      }
    } catch (err) {
      console.warn('System probe info call error:', err);
    }
  }

  // --- CLIPBOARD DETECTION ---
  async function checkClipboardForUrl() {
    const api = getApi();
    if (!api) return;

    try {
      const clipText = await api.read_clipboard();
      if (clipText && (clipText.startsWith('http://') || clipText.startsWith('https://'))) {
        const currentVal = elements.urlInput.value.trim();
        if (!currentVal) {
          elements.urlInput.value = clipText.trim();
          showToast('URL Detected', 'Pasted video stream URL from clipboard', 'info');
        }
      }
    } catch (err) {
      // Ignore clipboard access errors silently
    }
  }

  // --- PROGRESS EVENT BRIDGES ---
  window.onDownloadProgress = function (data) {
    elements.ingestProgress.style.display = 'flex';
    const pct = data.percent || 0;
    elements.ingestProgressBar.style.width = `${pct}%`;

    if (data.state === 'downloading') {
      const speedMb = data.speed ? (data.speed / (1024 * 1024)).toFixed(1) : '0.0';
      const etaStr = data.eta ? `${data.eta}s remaining` : '';
      elements.ingestStatusText.textContent = `Capturing Master Stream: ${pct}% [${etaStr}]`;
      elements.ingestSpeedText.textContent = `${speedMb} MB/s`;
    } else if (data.state === 'processing') {
      elements.ingestStatusText.textContent = 'Demuxing & preparing instant preview...';
      elements.ingestSpeedText.textContent = 'FINALIZING';
    }
  };

  window.onRenderProgress = function (data) {
    const pct = data.percent || 0;
    const speed = data.speed || '1.0x';
    if (elements.renderIconWrapper) {
      elements.renderIconWrapper.innerHTML = `<span class="spinner"></span>`;
    }
    if (elements.renderBtnText) {
      elements.renderBtnText.textContent = `EXPORTING ${pct}% (${speed})`;
    }
  };

  // --- STREAM FETCHING ---
  async function fetchStream() {
    const url = elements.urlInput.value.trim();
    if (!url) {
      showToast('Input Required', 'Please enter or paste a valid stream URL.', 'error');
      elements.urlInput.focus();
      return;
    }

    const api = getApi();
    if (!api) {
      showToast('Engine Error', 'PyWebView API bridge is not connected.', 'error');
      return;
    }

    state.isFetching = true;
    elements.btnFetch.disabled = true;
    elements.btnFetch.innerHTML = `<span class="spinner"></span> <span>INGESTING...</span>`;
    elements.ingestProgress.style.display = 'flex';
    elements.ingestProgressBar.style.width = '5%';
    elements.ingestStatusText.textContent = 'Resolving CDN stream endpoint...';
    elements.ingestSpeedText.textContent = 'CONNECTING';

    try {
      const media = await api.fetch_stream(url);
      state.currentMedia = media;
      loadMediaIntoPlayer(media);
      showToast('Capture Ready', `Captured master stream: ${media.title}`, 'success');
      updateCacheFootprint();
    } catch (err) {
      console.error('Fetch stream failed:', err);
      showToast('Capture Failed', String(err), 'error');
    } finally {
      state.isFetching = false;
      elements.btnFetch.disabled = false;
      elements.btnFetch.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
          <rect x="3" y="17" width="18" height="4" rx="1"></rect>
        </svg>
        <span>FETCH STREAM</span>
      `;
      setTimeout(() => {
        elements.ingestProgress.style.display = 'none';
        elements.ingestProgressBar.style.width = '0%';
      }, 1200);
    }
  }

  // --- VIEWER & MEDIA PLAYER ---
  function loadMediaIntoPlayer(media) {
    // Hide Standby, show video
    elements.standbyState.style.display = 'none';
    elements.videoContainer.style.display = 'flex';
    elements.viewerHud.style.display = 'flex';
    elements.streamInfoOverlay.style.display = 'flex';
    elements.trimmerPanel.style.display = 'flex';

    // Set video src to local range-supporting stream URL
    elements.playerVideo.src = media.stream_url;
    elements.playerVideo.load();
    elements.playerVideo.volume = state.volume;
    elements.playerVideo.play().then(() => {
      state.isPlaying = true;
      updatePlayPauseUI();
    }).catch(() => {
      state.isPlaying = false;
      updatePlayPauseUI();
    });

    // Populate HUD
    const resText = (media.width && media.height) ? `${media.width} x ${media.height}` : 'ORIGINAL RES';
    elements.hudResolution.textContent = resText;

    const durMin = Math.floor((media.duration || 0) / 60);
    const durSec = Math.floor((media.duration || 0) % 60).toString().padStart(2, '0');
    elements.hudDuration.textContent = `${durMin}:${durSec}`;

    elements.streamTitleDisplay.textContent = media.title || 'Untitled Stream';
    elements.streamCreatorDisplay.textContent = `@${media.uploader || 'creator'}`;

    // Initialize Trim state
    state.duration = parseFloat(media.duration || 0);
    state.trimIn = 0.0;
    state.trimOut = state.duration;

    // Reset orientation
    setOrientation(0);

    // Enable dock & trimmer buttons
    elements.btnRotateLeft.disabled = false;
    elements.btnRotateRight.disabled = false;
    elements.btnRotateReset.disabled = false;
    elements.btnPlayPause.disabled = false;
    elements.btnMute.disabled = false;
    elements.volumeSlider.disabled = false;
    elements.btnResetTrim.disabled = false;
    elements.btnFullscreen.disabled = false;
    elements.btnRender.disabled = false;

    updateTrimmerUI();
  }

  // Update onloadedmetadata for exact duration, resolution, & transform calibration
  elements.playerVideo.addEventListener('loadedmetadata', () => {
    if (elements.playerVideo.duration && !isNaN(elements.playerVideo.duration)) {
      state.duration = elements.playerVideo.duration;
      if (state.trimOut <= 0 || state.trimOut > state.duration) {
        state.trimOut = state.duration;
      }
      const durMin = Math.floor(state.duration / 60);
      const durSec = Math.floor(state.duration % 60).toString().padStart(2, '0');
      elements.hudDuration.textContent = `${durMin}:${durSec}`;
      updateTrimmerUI();
    }
    if (elements.playerVideo.videoWidth && elements.playerVideo.videoHeight) {
      elements.hudResolution.textContent = `${elements.playerVideo.videoWidth} x ${elements.playerVideo.videoHeight}`;
    }
    updateVideoTransform();
  });

  // Loop playback strictly inside trimmed range
  elements.playerVideo.addEventListener('timeupdate', () => {
    const curTime = elements.playerVideo.currentTime;
    if (curTime < state.trimIn - 0.25 || (state.trimOut > 0 && curTime >= state.trimOut)) {
      elements.playerVideo.currentTime = state.trimIn;
    }
    updateTrimmerUI();
  });

  // --- TIMELINE TRIMMER & PRECISION SCRUBBER ---
  function updateTrimmerUI() {
    if (!state.duration || state.duration <= 0) return;

    const inPct = Math.max(0, Math.min(100, (state.trimIn / state.duration) * 100));
    const outPct = Math.max(0, Math.min(100, (state.trimOut / state.duration) * 100));
    const curTime = elements.playerVideo.currentTime || 0;
    const playPct = Math.max(0, Math.min(100, (curTime / state.duration) * 100));

    elements.handleIn.style.left = `${inPct}%`;
    elements.handleOut.style.left = `${outPct}%`;
    elements.regionDimmedLeft.style.width = `${inPct}%`;
    elements.regionActive.style.left = `${inPct}%`;
    elements.regionActive.style.width = `${Math.max(0, outPct - inPct)}%`;
    elements.regionDimmedRight.style.width = `${Math.max(0, 100 - outPct)}%`;
    elements.timelinePlayhead.style.left = `${playPct}%`;

    elements.badgeInTime.textContent = `IN: ${formatPreciseTime(state.trimIn)}`;
    elements.badgePlayheadTime.textContent = `POS: ${formatPreciseTime(curTime)}`;
    elements.badgeOutTime.textContent = `OUT: ${formatPreciseTime(state.trimOut)}`;

    const cutDuration = Math.max(0, state.trimOut - state.trimIn);
    elements.badgeDurationTime.textContent = `CLIP: ${formatPreciseTime(cutDuration)}`;
  }

  function resetTrim() {
    state.trimIn = 0.0;
    state.trimOut = state.duration;
    elements.playerVideo.currentTime = 0;
    updateTrimmerUI();
    showToast('Trim Reset', 'Full clip timeline restored.', 'info');
  }

  function getTimeFromClientX(clientX) {
    const rect = elements.timelineTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * (state.duration || 1);
  }

  // Mouse / Pointer Event Listeners for Trimmer Handles & Track
  function setupTrimmerEvents() {
    // In Handle Drag
    elements.handleIn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      state.activeDrag = 'in';
      elements.handleIn.setPointerCapture(e.pointerId);
    });

    // Out Handle Drag
    elements.handleOut.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      state.activeDrag = 'out';
      elements.handleOut.setPointerCapture(e.pointerId);
    });

    // Track Click to Seek
    elements.timelineTrack.addEventListener('pointerdown', (e) => {
      if (state.activeDrag) return;
      state.activeDrag = 'seek';
      const t = getTimeFromClientX(e.clientX);
      elements.playerVideo.currentTime = Math.max(state.trimIn, Math.min(state.trimOut, t));
      updateTrimmerUI();
    });

    window.addEventListener('pointermove', (e) => {
      if (!state.activeDrag || !state.duration) return;

      const t = getTimeFromClientX(e.clientX);

      if (state.activeDrag === 'in') {
        state.trimIn = Math.max(0, Math.min(t, state.trimOut - 0.2));
        elements.playerVideo.currentTime = state.trimIn;
        updateTrimmerUI();
      } else if (state.activeDrag === 'out') {
        state.trimOut = Math.min(state.duration, Math.max(t, state.trimIn + 0.2));
        elements.playerVideo.currentTime = state.trimOut;
        updateTrimmerUI();
      } else if (state.activeDrag === 'seek') {
        elements.playerVideo.currentTime = Math.max(state.trimIn, Math.min(state.trimOut, t));
        updateTrimmerUI();
      }
    });

    window.addEventListener('pointerup', () => {
      if (state.activeDrag) {
        state.activeDrag = null;
      }
    });

    elements.btnResetTrim.addEventListener('click', resetTrim);
  }

  // --- ZERO-LATENCY CSS ORIENTATION ENGINE ---
  function setOrientation(targetAngle) {
    state.currentAngle = ((targetAngle % 360) + 360) % 360;
    updateVideoTransform();
    updateOrientationHUD();
  }

  function rotateCW() {
    setOrientation(state.currentAngle + 90);
  }

  function rotateCCW() {
    setOrientation(state.currentAngle - 90);
  }

  function resetOrientation() {
    setOrientation(0);
  }

  function updateVideoTransform() {
    const angle = state.currentAngle;
    const viewport = elements.viewerViewport;
    const rect = viewport.getBoundingClientRect();
    const vw = rect.width;
    const vh = rect.height;

    const vidEl = elements.playerVideo;
    const clientW = vidEl.clientWidth || (state.currentMedia ? state.currentMedia.width : 1920);
    const clientH = vidEl.clientHeight || (state.currentMedia ? state.currentMedia.height : 1080);

    let scale = 1.0;

    if (angle === 90 || angle === 270) {
      const scaleToFitHeight = vh / (clientW || 1);
      const scaleToFitWidth = vw / (clientH || 1);
      const fit = Math.min(scaleToFitHeight, scaleToFitWidth);
      scale = Math.min(fit * 0.96, 1.0);
    }

    vidEl.style.transform = `rotate(${angle}deg) scale(${scale})`;
  }

  function updateOrientationHUD() {
    const angle = state.currentAngle;
    let label = `${angle}°`;
    if (angle === 0) label = '0° ORIGINAL';
    else if (angle === 90) label = '90° CW';
    else if (angle === 180) label = '180° FLIP';
    else if (angle === 270) label = '270° CW (90° CCW)';

    elements.orientationReadout.textContent = label;
    elements.hudAnglePill.textContent = `ROTATION: ${angle}°`;
  }

  // --- FULLSCREEN CONTROLLER ---
  const FULLSCREEN_ENTER_ICON = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
    </svg>
  `;

  const FULLSCREEN_EXIT_ICON = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
      <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
    </svg>
  `;

  function isFullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
  }

  async function toggleFullscreen() {
    if (!state.currentMedia) return;

    try {
      if (isFullscreenActive()) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          await document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
          await document.mozCancelFullScreen();
        }
      } else {
        const target = elements.viewerViewport;
        if (target.requestFullscreen) {
          await target.requestFullscreen();
        } else if (target.webkitRequestFullscreen) {
          await target.webkitRequestFullscreen();
        } else if (target.mozRequestFullScreen) {
          await target.mozRequestFullScreen();
        } else {
          const api = getApi();
          if (api && api.toggle_fullscreen) {
            await api.toggle_fullscreen();
          }
        }
      }
    } catch (err) {
      console.warn('Fullscreen toggle fallback:', err);
      const api = getApi();
      if (api && api.toggle_fullscreen) {
        try {
          await api.toggle_fullscreen();
        } catch (_) {}
      }
    }
  }

  function onFullscreenChange() {
    const active = isFullscreenActive();
    if (active) {
      if (elements.fullscreenText) elements.fullscreenText.textContent = 'EXIT FULL';
      if (elements.fullscreenIcon) elements.fullscreenIcon.innerHTML = FULLSCREEN_EXIT_ICON;
      if (elements.btnFullscreen) elements.btnFullscreen.setAttribute('title', 'Exit Fullscreen (F, Esc)');
      if (elements.btnHudFullscreen) {
        elements.btnHudFullscreen.setAttribute('title', 'Exit Fullscreen (F, Esc)');
        elements.btnHudFullscreen.innerHTML = FULLSCREEN_EXIT_ICON;
      }
    } else {
      if (elements.fullscreenText) elements.fullscreenText.textContent = 'FULLSCREEN';
      if (elements.fullscreenIcon) elements.fullscreenIcon.innerHTML = FULLSCREEN_ENTER_ICON;
      if (elements.btnFullscreen) elements.btnFullscreen.setAttribute('title', 'Toggle Fullscreen (F)');
      if (elements.btnHudFullscreen) {
        elements.btnHudFullscreen.setAttribute('title', 'Toggle Fullscreen (F)');
        elements.btnHudFullscreen.innerHTML = FULLSCREEN_ENTER_ICON;
      }
    }
    setTimeout(updateVideoTransform, 50);
    setTimeout(updateVideoTransform, 200);
  }

  // --- PLAYBACK & AUDIO VOLUME CONTROLS ---
  function togglePlayPause() {
    const vid = elements.playerVideo;
    if (vid.paused) {
      if (vid.currentTime >= state.trimOut) {
        vid.currentTime = state.trimIn;
      }
      vid.play();
      state.isPlaying = true;
    } else {
      vid.pause();
      state.isPlaying = false;
    }
    updatePlayPauseUI();
  }

  function updatePlayPauseUI() {
    if (state.isPlaying) {
      elements.playPauseText.textContent = 'PAUSE';
      elements.playPauseIcon.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
      `;
    } else {
      elements.playPauseText.textContent = 'PLAY';
      elements.playPauseIcon.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
      `;
    }
  }

  function updateVolumeUI() {
    const vid = elements.playerVideo;
    const isMuted = vid.muted || state.volume === 0;

    if (isMuted) {
      elements.volumeReadout.textContent = '0%';
      elements.volumeSlider.value = 0;
      elements.muteIcon.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <line x1="23" y1="9" x2="17" y2="15"></line>
          <line x1="17" y1="9" x2="23" y2="15"></line>
        </svg>
      `;
    } else {
      const pct = Math.round(state.volume * 100);
      elements.volumeReadout.textContent = `${pct}%`;
      elements.volumeSlider.value = state.volume;
      elements.muteIcon.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      `;
    }
  }

  function toggleMute() {
    const vid = elements.playerVideo;
    vid.muted = !vid.muted;
    state.isMuted = vid.muted;
    if (!vid.muted && state.volume === 0) {
      state.volume = 0.5;
      vid.volume = 0.5;
    }
    updateVolumeUI();
  }

  function onVolumeSliderInput(e) {
    const val = parseFloat(e.target.value);
    state.volume = val;
    const vid = elements.playerVideo;
    vid.volume = val;
    if (val > 0 && vid.muted) {
      vid.muted = false;
      state.isMuted = false;
    } else if (val === 0) {
      vid.muted = true;
      state.isMuted = true;
    }
    updateVolumeUI();
  }

  const RENDER_ICON_SVG = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
  `;

  // --- DESTINATION FOLDER CONTROLS ---
  function updateDestinationUI() {
    const name = state.outputDirName || 'Desktop';
    const path = state.outputDir || 'Desktop';

    if (elements.destinationFolderName) {
      elements.destinationFolderName.textContent = name;
    }
    if (elements.btnSelectFolder) {
      elements.btnSelectFolder.setAttribute('title', `Destination: ${path}\nClick to choose another folder`);
    }
    if (elements.footerDestinationName) {
      elements.footerDestinationName.textContent = name;
    }
    if (elements.footerDestinationLink) {
      elements.footerDestinationLink.setAttribute('title', `Destination: ${path}\nClick to choose another folder`);
    }
    if (elements.renderBtnText && !state.isRendering) {
      elements.renderBtnText.textContent = `RENDER TO ${name.toUpperCase()}`;
    }
  }

  async function chooseDestinationFolder() {
    const api = getApi();
    if (!api || !api.select_output_directory) return;

    try {
      const res = await api.select_output_directory();
      if (res && res.success && res.path) {
        state.outputDir = res.path;
        state.outputDirName = res.name || 'Folder';
        updateDestinationUI();
        showToast('Destination Selected', `Export folder set to: ${res.path}`, 'success');
      }
    } catch (err) {
      console.error('Failed to select destination folder:', err);
      showToast('Destination Error', String(err), 'error');
    }
  }

  // --- EXPORT PIPELINE ---
  async function renderToDesktop() {
    if (!state.currentMedia || state.isRendering) return;

    const api = getApi();
    if (!api) {
      showToast('Engine Error', 'PyWebView API is not available.', 'error');
      return;
    }

    state.isRendering = true;
    elements.btnRender.disabled = true;
    if (elements.renderIconWrapper) {
      elements.renderIconWrapper.innerHTML = `<span class="spinner"></span>`;
    }
    if (elements.renderBtnText) {
      elements.renderBtnText.textContent = `INITIALIZING EXPORT...`;
    }

    try {
      const result = await api.export_stream(
        state.currentMedia.id,
        state.currentAngle,
        state.selectedCodec,
        state.trimIn,
        state.trimOut
      );

      const isCopy = result.is_lossless_copy;
      const title = isCopy ? 'Instant Lossless Export Complete' : 'Hardware Transcode Complete';
      const destLabel = result.destination_name || state.outputDirName || 'folder';
      const msg = `Saved to ${destLabel}: ${result.filename}`;

      showToast(
        title,
        msg,
        'success',
        () => {
          api.open_desktop_folder(result.output_path);
        },
        'OPEN IN FOLDER'
      );
    } catch (err) {
      console.error('Render export error:', err);
      showToast('Export Error', String(err), 'error');
    } finally {
      state.isRendering = false;
      elements.btnRender.disabled = false;
      if (elements.renderIconWrapper) {
        elements.renderIconWrapper.innerHTML = RENDER_ICON_SVG;
      }
      updateDestinationUI();
    }
  }

  // --- CACHE FOOTPRINT ---
  async function updateCacheFootprint() {
    const api = getApi();
    if (!api) return;
    try {
      const info = await api.get_system_info();
      if (info.cache_size_str) {
        elements.cacheFootprint.textContent = `CACHE: ${info.cache_size_str}`;
      }
    } catch (_) {}
  }

  async function purgeCache() {
    const api = getApi();
    if (!api) return;
    try {
      const count = await api.clear_cache();
      showToast('Cache Purged', `Removed ${count} cached temporary files.`, 'info');
      updateCacheFootprint();
    } catch (err) {
      showToast('Purge Error', String(err), 'error');
    }
  }

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    // Ingest
    elements.btnFetch.addEventListener('click', fetchStream);
    elements.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fetchStream();
    });

    elements.btnPaste.addEventListener('click', async () => {
      const api = getApi();
      if (api) {
        try {
          const text = await api.read_clipboard();
          if (text) {
            elements.urlInput.value = text.trim();
            elements.urlInput.focus();
          }
        } catch (_) {}
      } else {
        try {
          const text = await navigator.clipboard.readText();
          if (text) elements.urlInput.value = text.trim();
        } catch (_) {}
      }
    });

    // Orientation Controls
    elements.btnRotateLeft.addEventListener('click', rotateCCW);
    elements.btnRotateRight.addEventListener('click', rotateCW);
    elements.btnRotateReset.addEventListener('click', resetOrientation);

    // Playback & Volume Controls
    elements.btnPlayPause.addEventListener('click', togglePlayPause);
    elements.btnMute.addEventListener('click', toggleMute);
    elements.volumeSlider.addEventListener('input', onVolumeSliderInput);
    elements.playerVideo.addEventListener('click', togglePlayPause);

    // Fullscreen Controls
    if (elements.btnFullscreen) {
      elements.btnFullscreen.addEventListener('click', toggleFullscreen);
    }
    if (elements.btnHudFullscreen) {
      elements.btnHudFullscreen.addEventListener('click', toggleFullscreen);
    }
    elements.playerVideo.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });

    // Fullscreen Change Observer
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (document.activeElement === elements.urlInput) return;

      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleMute();
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        if (state.duration > 0) {
          const curTime = elements.playerVideo.currentTime || 0;
          state.trimIn = Math.max(0, Math.min(curTime, state.trimOut - 0.2));
          updateTrimmerUI();
          showToast('Mark In', `Cut start: ${formatPreciseTime(state.trimIn)}`, 'info');
        }
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        if (state.duration > 0) {
          const curTime = elements.playerVideo.currentTime || 0;
          state.trimOut = Math.min(state.duration, Math.max(curTime, state.trimIn + 0.2));
          updateTrimmerUI();
          showToast('Mark Out', `Cut end: ${formatPreciseTime(state.trimOut)}`, 'info');
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 1.0;
        elements.playerVideo.currentTime = Math.max(state.trimIn, elements.playerVideo.currentTime - step);
        updateTrimmerUI();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 1.0;
        elements.playerVideo.currentTime = Math.min(state.trimOut, elements.playerVideo.currentTime + step);
        updateTrimmerUI();
      }
    });

    // Timeline Trimmer Events
    setupTrimmerEvents();

    // Codec Toggle
    elements.btnCodecH264.addEventListener('click', () => {
      state.selectedCodec = 'h264';
      elements.btnCodecH264.classList.add('active');
      elements.btnCodecHevc.classList.remove('active');
    });

    elements.btnCodecHevc.addEventListener('click', () => {
      state.selectedCodec = 'hevc';
      elements.btnCodecHevc.classList.add('active');
      elements.btnCodecH264.classList.remove('active');
    });

    // Destination Folder Selector
    if (elements.btnSelectFolder) {
      elements.btnSelectFolder.addEventListener('click', chooseDestinationFolder);
    }
    if (elements.footerDestinationLink) {
      elements.footerDestinationLink.addEventListener('click', chooseDestinationFolder);
    }

    // Render Action
    elements.btnRender.addEventListener('click', renderToDesktop);

    // Cache Purge
    elements.btnPurgeCache.addEventListener('click', purgeCache);

    // Viewport Resize Auto-Adjustment
    window.addEventListener('resize', () => {
      if (state.currentMedia) {
        updateVideoTransform();
      }
    });

    // Window Focus Clipboard Watcher
    window.addEventListener('focus', checkClipboardForUrl);
  }

  // --- BOOTSTRAP ---
  window.addEventListener('pywebviewready', () => {
    initSystem();
    setupEventListeners();
  });

  if (window.pywebview && window.pywebview.api) {
    initSystem();
    setupEventListeners();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      setupEventListeners();
      setTimeout(initSystem, 200);
      setTimeout(initSystem, 800);
    });
  }

})();
