import os
import sys
import json
import time
import asyncio
import logging
import threading
import subprocess
from collections import deque
from contextlib import asynccontextmanager
from typing import Optional, Set, Dict, Any, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# Add backend directory to path if needed
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from receiver import LSLReceiver
from processor import EEGProcessor, PPGProcessor

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("MuseLSLGateway")

# Global State
active_websockets: Set[WebSocket] = set()
receiver: Optional[Any] = None
stream_process: Optional[subprocess.Popen] = None
stream_device_name: Optional[str] = None
stream_device_address: Optional[str] = None
stream_stderr_lines: deque = deque(maxlen=40)
stream_error: Optional[str] = None
eeg_processor: Optional[Any] = None
ppg_processor: Optional[Any] = None

# Async event loop queue for thread-to-asyncio bridge
loop: Optional[asyncio.AbstractEventLoop] = None
data_queue: Optional[asyncio.Queue] = None
broadcast_task: Optional[asyncio.Task] = None

def _read_stderr_loop(proc: subprocess.Popen):
    """Background reader thread to capture subprocess stderr diagnostic messages."""
    global stream_error
    if not proc.stderr:
        return
    try:
        for line in iter(proc.stderr.readline, ''):
            if line:
                stream_stderr_lines.append(line)
                logger.debug(f"[muselsl stderr] {line.strip()}")
        proc.stderr.close()
    except Exception:
        pass
    ret = proc.poll()
    if ret is not None and ret != 0:
        stream_error = "".join(list(stream_stderr_lines)[-5:]).strip() or f"Process exited with code {ret}"
        logger.warning(f"muselsl stream exited unexpectedly: {stream_error}")

def lsl_data_callback(stream_type: str, samples: list, timestamps: list):
    """Callback triggered by LSL Receiver threads when new samples arrive."""
    if not loop or not data_queue:
        return
        
    payload = {
        "stream": stream_type,
        "samples": samples,
        "timestamps": timestamps
    }
    
    # Thread-safe push into the asyncio Queue
    try:
        loop.call_soon_threadsafe(data_queue.put_nowait, payload)
    except Exception:
        # Queue might be full or loop is closing
        pass

    # Apply digital signal processing on incoming raw data
    if stream_type == "EEG" and eeg_processor:
        try:
            bands_list = eeg_processor.add_samples(samples)
            for bands in bands_list:
                bands_payload = {
                    "stream": "BANDS",
                    "samples": [bands],
                    "timestamps": [timestamps[-1] if timestamps else time.time()]
                }
                try:
                    loop.call_soon_threadsafe(data_queue.put_nowait, bands_payload)
                except Exception:
                    pass
        except Exception as e:
            logger.error(f"Error processing EEG bands: {e}")

    elif stream_type == "PPG" and ppg_processor:
        try:
            beat_events = ppg_processor.add_samples(samples, timestamps)
            for beat in beat_events:
                beat_payload = {
                    "stream": "PPG_BEAT",
                    "bpm": beat["bpm"],
                    "timestamp": beat["timestamp"]
                }
                try:
                    loop.call_soon_threadsafe(data_queue.put_nowait, beat_payload)
                except Exception:
                    pass
        except Exception as e:
            logger.error(f"Error processing PPG heartbeat: {e}")

async def broadcast_worker():
    """Async task that consumes data queue and broadcasts concurrently to all WebSocket clients."""
    logger.info("WebSocket Broadcast Worker started.")
    while True:
        try:
            if data_queue is None:
                await asyncio.sleep(0.1)
                continue
            payload = await data_queue.get()
            if active_websockets:
                message_str = json.dumps(payload)
                
                # Broadcast concurrently to all connected clients
                client_list = list(active_websockets)
                send_tasks = [asyncio.create_task(ws.send_text(message_str)) for ws in client_list]
                results = await asyncio.gather(*send_tasks, return_exceptions=True)
                
                disconnected = set()
                for ws, res in zip(client_list, results):
                    if isinstance(res, Exception):
                        disconnected.add(ws)
                        
                # Clean up disconnected sockets
                if disconnected:
                    active_websockets.difference_update(disconnected)
                    logger.info(f"Cleaned up {len(disconnected)} disconnected WebSocket client(s).")
                    if not active_websockets and receiver:
                        logger.info("No active WebSocket clients. Pausing LSL Receiver.")
                        await asyncio.to_thread(receiver.stop)
                        
            if data_queue is not None:
                data_queue.task_done()
        except asyncio.CancelledError:
            logger.info("WebSocket Broadcast Worker stopping...")
            break
        except Exception as e:
            logger.error(f"Error in WebSocket broadcast worker: {e}")
            await asyncio.sleep(0.1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manages application startup and shutdown lifecycle."""
    global loop, data_queue, broadcast_task, receiver, eeg_processor, ppg_processor

    # --- Startup ---
    loop = asyncio.get_running_loop()
    data_queue = asyncio.Queue(maxsize=1000)
    broadcast_task = asyncio.create_task(broadcast_worker())

    # Initialize receiver with the thread-safe callback
    receiver = LSLReceiver(callback=lsl_data_callback)

    # Initialize digital signal processors
    eeg_processor = EEGProcessor()
    ppg_processor = PPGProcessor()

    yield  # Application runs here

    # --- Shutdown ---
    global stream_process
    logger.info("Server shutting down, cleaning up processes...")

    # Stop LSL Receiver in a background thread to prevent blocking the event loop
    if receiver:
        await asyncio.to_thread(receiver.stop)

    # Stop Streaming Subprocess
    if stream_process:
        logger.info("Terminating streaming subprocess...")
        stream_process.terminate()
        try:
            await asyncio.to_thread(stream_process.wait, 2.0)
        except subprocess.TimeoutExpired:
            stream_process.kill()

    # Stop Broadcast Worker
    if broadcast_task:
        broadcast_task.cancel()
        await asyncio.gather(broadcast_task, return_exceptions=True)

# Create the FastAPI app with the lifespan context manager
app = FastAPI(title="Muse2 LSL Gateway", lifespan=lifespan)

# Enable CORS (standard compliant: wildcard origin with credentials=False)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API Endpoints ---

@app.get("/api/status")
def get_status() -> Dict[str, Any]:
    """Returns the current status of the gateway and diagnostic info."""
    global stream_process, stream_error
    is_stream_running = stream_process is not None and stream_process.poll() is None
    
    if stream_process is not None and not is_stream_running and not stream_error:
        stream_error = "".join(list(stream_stderr_lines)[-5:]).strip() or "Process exited"

    resolved_streams = {}
    if receiver:
        resolved_streams = receiver.get_status()
        
    return {
        "streaming_active": is_stream_running,
        "streaming_device": {
            "name": stream_device_name,
            "address": stream_device_address
        } if is_stream_running else None,
        "active_lsl_streams": resolved_streams,
        "last_stream_error": stream_error if not is_stream_running else None
    }

@app.post("/api/scan")
def scan_devices():
    """Scans for nearby Muse BLE devices using muselsl."""
    try:
        import muselsl
        logger.info("Scanning for Muse devices...")
        
        thread_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(thread_loop)
        try:
            muses = muselsl.list_muses(backend="bleak")
        finally:
            thread_loop.close()
            
        return {"success": True, "devices": muses}
    except Exception as e:
        logger.error(f"Error during BLE scan: {e}")
        return {"success": False, "error": str(e), "devices": []}

@app.post("/api/stream/start")
def start_stream(device: Dict[str, str]):
    """Launches the muselsl stream CLI command in a background subprocess."""
    global stream_process, stream_device_name, stream_device_address, stream_error
    
    if stream_process and stream_process.poll() is None:
        raise HTTPException(status_code=400, detail="A streaming process is already active.")
        
    address = device.get("address")
    name = device.get("name")
    
    if not address:
        raise HTTPException(status_code=400, detail="Device address is required.")
        
    logger.info(f"Starting Muse stream for address={address}, name={name}")
    stream_stderr_lines.clear()
    stream_error = None
    
    # Construct subprocess command
    cmd = [
        sys.executable, "-m", "muselsl", "stream",
        "--address", address,
        "--backend", "bleak",
        "--ppg",
        "--acc",
        "--gyro"
    ]
    
    if name:
        cmd.extend(["--name", name])
        
    try:
        stream_process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        stream_device_name = name
        stream_device_address = address
        
        # Start stderr reader thread to capture error outputs
        stderr_thread = threading.Thread(target=_read_stderr_loop, args=(stream_process,), daemon=True)
        stderr_thread.start()
        
        return {"success": True, "message": "Stream subprocess launched successfully."}
    except Exception as e:
        logger.error(f"Failed to start stream subprocess: {e}")
        stream_error = str(e)
        return {"success": False, "error": str(e)}

@app.post("/api/stream/stop")
def stop_stream():
    """Stops the active muselsl stream subprocess."""
    global stream_process, stream_device_name, stream_device_address
    
    if not stream_process or stream_process.poll() is not None:
        return {"success": True, "message": "No active streaming process to stop."}
        
    logger.info("Stopping streaming subprocess...")
    stream_process.terminate()
    try:
        stream_process.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        stream_process.kill()
        
    stream_process = None
    stream_device_name = None
    stream_device_address = None
    return {"success": True, "message": "Streaming process terminated."}

# --- WebSocket Gateway ---

@app.websocket("/api/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_websockets.add(websocket)
    logger.info(f"New client connected. Active WebSockets: {len(active_websockets)}")
    
    # If the receiver is not running, start it
    if receiver and not receiver._running:
        logger.info("First WebSocket client connected. Starting LSL Receiver...")
        receiver.start()
        
    try:
        # Keep connection open — client sends no messages, we only push data
        while True:
            await asyncio.sleep(30)  # heartbeat idle wait
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        active_websockets.discard(websocket)
        logger.info(f"Client disconnected. Active WebSockets: {len(active_websockets)}")
        # If no clients left, stop receiver in a non-blocking background thread
        if not active_websockets and receiver:
            logger.info("No active WebSocket clients remaining. Stopping LSL Receiver...")
            await asyncio.to_thread(receiver.stop)

# --- Static Frontend Serving ---
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="static")
else:
    logger.warning(f"Frontend directory '{frontend_dir}' not found. Static files serving disabled.")
