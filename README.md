# Muse 2 LSL Gateway & Real-Time Neuro-Telemetry Dashboard

A full-stack real-time EEG/PPG telemetry gateway and interactive audio synthesizer for the **Muse 2 (and Muse S)** brain-sensing headband.

The application connects to a Muse headset over Bluetooth Low Energy (BLE), streams biosignals over Lab Streaming Layer (LSL), computes digital signal processing (DSP) metrics in Python (spectral frequency bands and photoplethysmography pulse rates), and streams the processed telemetry over WebSockets to an interactive real-time dashboard and ambient drone synthesizer.

---

## Features

- **Multi-Modal Biosignal Streaming**:
  - **EEG (256 Hz)**: TP9, AF7, AF8, TP10, and AUX channels rendered with stacked real-time oscilloscope visualizers.
  - **PPG (64 Hz)**: Ambient, Infrared (IR), and Red channels with online causal systolic peak detection and BPM calculation.
  - **IMU (52 Hz)**: 3-Axis Accelerometer (forces) and 3-Axis Gyroscope (rotation speed).
- **Real-Time Digital Signal Processing (DSP)**:
  - Relative EEG band power computation: **Delta** (1–4 Hz), **Theta** (4–8 Hz), **Alpha** (8–13 Hz), **Beta** (13–30 Hz), and **Gamma** (30–45 Hz) using windowed FFTs with spectral leakage suppression.
  - Causal moving-average smoothing and refractory-bounded systolic peak detection for PPG heart rate calculation.
- **Interactive Biofeedback Drone Synthesizer**:
  - 5-voice microtonal additive drone synthesizer built with the Web Audio API.
  - Modulated directly by brainwaves: Delta controls sub-bass ground, Theta modulates swell rate/depth, Alpha drives low-pass brightness filter, Beta controls micro-detune drift, and PPG pulses trigger harmonic chime plucks.
  - Switchable musical scales (G Minor Pentatonic, C Major Pentatonic, D Phrygian Dominant, Pygmy, Zen Bhairav).
  - CRT-style time-domain audio oscilloscope visualizer.
- **Offline / Telemetry Simulation Mode**:
  - Full end-to-end telemetry generator simulating realistic rhythmic brainwaves, heart pulses, and head motion for testing and demonstration without physical hardware.
- **Robust Gateway Architecture**:
  - Built with FastAPI and Uvicorn.
  - High-throughput non-blocking WebSocket broadcast bridge.
  - Graceful subprocess process-group management and error reporting.

---

## Architecture

```
+-------------------+             BLE             +------------------------+
|  Muse 2 Headband  | --------------------------> | muselsl background CLI |
+-------------------+                             +------------------------+
                                                              |
                                                              v LSL Streams (EEG, PPG, ACC, GYRO)
+----------------------------------------------------------------------+
|                      FastAPI / Python Gateway                        |
|                                                                      |
|  +-------------------+      +-------------------+      +----------+  |
|  |    LSLReceiver    | ---> | Signal Processors | ---> | asyncio  |  |
|  |  (pylsl inlets)   |      |  (EEG & PPG DSP)  |      |  Queue   |  |
|  +-------------------+      +-------------------+      +----------+  |
|                                                              |       |
|                                     WebSocket Broadcast <----+       |
+----------------------------------------------------------------------+
                                      |
                                      v ws://localhost:8000/api/ws
+----------------------------------------------------------------------+
|                      Browser Frontend (Vanilla JS)                   |
|                                                                      |
|  * Real-time Multi-Channel Canvas Oscilloscopes                      |
|  * Relative Brainwave Power Meters (Delta / Theta / Alpha / Beta / Gamma) |
|  * Web Audio Drone Synthesizer Engine & Biofeedback Modulators       |
|  * Built-in Offline Telemetry Simulation Mode                        |
+----------------------------------------------------------------------+
```

---

## Prerequisites

- **Python**: 3.10, 3.11, or 3.12.
- **Operating System**: Linux (Ubuntu, Debian, Fedora, Arch) or macOS.
- **Bluetooth**: Bluetooth 4.0+ BLE adapter.
  - On Linux, ensure `bluez` and `libbluetooth-dev` are installed.
  - If scanning requires root privileges on your distribution, grant raw network access to Python:
    ```bash
    sudo setcap 'cap_net_raw,cap_net_admin+eip' $(readlink -f venv/bin/python)
    ```

---

## Quickstart

### 1. Set Up Python Environment

```bash
# Create virtual environment if not already present
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate

# Install required packages
pip install -r requirements.txt
```

### 2. Start the Gateway Server

Run the startup script:
```bash
./run.sh
```
Or start manually with Uvicorn:
```bash
source venv/bin/activate
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Open the Dashboard

Navigate to [http://localhost:8000](http://localhost:8000) in your web browser (Chrome, Firefox, or Edge recommended).

### 4. Stop the Gateway

Run the stop script to terminate both the server and any active background streaming processes:
```bash
./stop.sh
```

---

## Telemetry Simulation Mode (No Hardware Needed)

If you do not have a physical Muse headband connected, you can preview the full dashboard and synthesizer immediately:
1. Open the dashboard in your browser.
2. Click the **"Drone Synthesizer"** tab in the top right.
3. Click the **"Simulate Telemetry"** button.
4. Click **"ENGAGE DRONE ENGINE"** to activate the audio synthesizer.
5. All visualizers, brainwave meters, and heartbeat chimes will begin animating dynamically.

When a physical Muse device connects and transmits real LSL data, simulation mode automatically disables itself.

---

## Connecting a Physical Muse Headband

1. Turn on your Muse 2 or Muse S headband (ensure the LEDs are pulsing in pairing mode).
2. In the dashboard sidebar under **EEG Interface**, click **"Scan for Devices"**.
3. When your headband appears in the list, click **"Connect"**.
4. The backend spawns `muselsl stream` to connect over BLE and publish LSL streams.
5. Once streams appear, the active stream indicators under **Active LSL Streams** turn amber, and live waveforms render on the dashboard.
6. To disconnect, click **"Disconnect Stream"**.

---

## Running Automated Tests

Run the unit test suite:
```bash
./venv/bin/python -m unittest discover -s tests -v
```

The test suite validates:
- Causal moving-average filtering and BPM calculations for PPG.
- Frequency band segmentation, FFT calculations, and channel shape safety for EEG.
- FastAPI REST endpoints (`/api/status`, `/api/stream/start`, `/api/stream/stop`).

---

## Project Structure

```
.
├── backend/
│   ├── main.py          # FastAPI application, REST endpoints & WebSocket gateway
│   ├── processor.py     # EEGProcessor (FFT band powers) & PPGProcessor (peak detection)
│   └── receiver.py      # LSLReceiver (PyLSL stream discovery and sample pulling)
├── frontend/
│   ├── app.js           # RealTimeChart visualizers, WebSocket client & Web Audio synth
│   ├── index.html       # Single-page dashboard & layout markup
│   └── style.css        # Amber terminal cyberpunk styling
├── tests/
│   ├── test_api.py      # Unit tests for REST endpoints
│   └── test_processor.py# Unit tests for EEG and PPG signal processing algorithms
├── run.sh               # Gateway startup script
├── stop.sh              # Gateway and process cleanup script
├── requirements.txt     # Python package dependencies
└── README.md            # Documentation and user guide
```
