import time
import logging
import threading
from typing import Callable, Dict, List, Tuple
import pylsl

logger = logging.getLogger("LSLReceiver")
logging.basicConfig(level=logging.INFO)

class LSLReceiver:
    def __init__(self, callback: Callable[[str, List[List[float]], List[float]], None]):
        """
        callback: Function that takes (stream_type, samples_list, timestamps_list)
        """
        self.callback = callback
        self._running = False
        self._stop_event = threading.Event()
        self._discovery_thread = None
        self._threads: Dict[str, threading.Thread] = {}
        self._inlets: Dict[str, pylsl.StreamInlet] = {}
        self._active_stream_types: Dict[str, str] = {}
        self._lock = threading.Lock()
        
        # Track supported stream types
        self.target_types = ['EEG', 'PPG', 'ACC', 'GYRO']

    def start(self):
        with self._lock:
            if self._running:
                return
            self._running = True
            self._stop_event.clear()
            
        logger.info("Starting LSL Receiver...")
        self._discovery_thread = threading.Thread(target=self._discover_loop, daemon=True)
        self._discovery_thread.start()

    def stop(self):
        with self._lock:
            if not self._running:
                return
            self._running = False
            self._stop_event.set()
            
        logger.info("Stopping LSL Receiver...")
        # Join discovery thread
        if self._discovery_thread:
            self._discovery_thread.join(timeout=1.0)
            self._discovery_thread = None
            
        # Stop all stream reading threads and close inlets
        with self._lock:
            for uid, inlet in self._inlets.items():
                try:
                    inlet.close_stream()
                except Exception as e:
                    logger.error(f"Error closing inlet {uid}: {e}")
            self._inlets.clear()
            self._threads.clear()
            self._active_stream_types.clear()
        
        logger.info("LSL Receiver stopped.")

    def get_status(self) -> Dict[str, bool]:
        """Returns the status of connected streams without blocking lock contention."""
        with self._lock:
            status = {t: False for t in self.target_types}
            for stype in self._active_stream_types.values():
                if stype in status:
                    status[stype] = True
            return status

    def _discover_loop(self):
        """Runs periodically to find new LSL streams and spawn reader threads."""
        while not self._stop_event.is_set():
            with self._lock:
                if not self._running:
                    break

            try:
                # Search for all available streams
                streams = pylsl.resolve_streams(wait_time=0.5)
                
                # Check for each target stream type
                for info in streams:
                    stype = info.type()
                    sname = info.name()
                    suid = info.uid()
                    
                    if stype in self.target_types:
                        with self._lock:
                            if suid not in self._inlets and suid not in self._threads:
                                logger.info(f"Discovered new stream: {sname} (Type: {stype}, UID: {suid})")
                                # Spawn a new thread to read this stream
                                t = threading.Thread(
                                    target=self._read_stream_loop,
                                    args=(info, suid, stype),
                                    daemon=True
                                )
                                self._threads[suid] = t
                                t.start()
            except Exception as e:
                logger.error(f"Error in discovery loop: {e}")

            # Responsive wait interrupted immediately if stop_event is set
            self._stop_event.wait(2.0)

    def _read_stream_loop(self, stream_info: pylsl.StreamInfo, uid: str, stype: str):
        """Reads data from a specific LSL inlet in a loop."""
        logger.info(f"Starting reader thread for stream {stype} (UID: {uid})")
        
        try:
            inlet = pylsl.StreamInlet(stream_info, max_buflen=360, processing_flags=pylsl.proc_ALL)
            with self._lock:
                self._inlets[uid] = inlet
                self._active_stream_types[uid] = stype
        except Exception as e:
            logger.error(f"Failed to create inlet for UID {uid}: {e}")
            with self._lock:
                if uid in self._threads:
                    del self._threads[uid]
            return

        # Read loop
        while not self._stop_event.is_set():
            with self._lock:
                if not self._running or uid not in self._inlets:
                    break

            try:
                # Pull chunk with a timeout (up to 40ms)
                samples, timestamps = inlet.pull_chunk(max_samples=512, timeout=0.04)
            except Exception as e:
                logger.warning(f"Lost connection to LSL stream {stype} (UID: {uid}): {e}")
                break

            if samples and len(samples) > 0:
                # Forward the chunk of samples to the callback safely
                try:
                    self.callback(stype, samples, timestamps)
                except Exception as e:
                    logger.error(f"Error in data callback for stream {stype}: {e}")

        # Cleanup this stream
        with self._lock:
            if uid in self._inlets:
                try:
                    self._inlets[uid].close_stream()
                except Exception:
                    pass
                del self._inlets[uid]
            if uid in self._threads:
                del self._threads[uid]
            if uid in self._active_stream_types:
                del self._active_stream_types[uid]
        
        logger.info(f"Stopped reader thread for stream {stype} (UID: {uid})")
