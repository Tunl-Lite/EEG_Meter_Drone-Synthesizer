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
        self._last_sample_time: Dict[str, float] = {}
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
            inlets_to_close = list(self._inlets.values())
            threads_to_join = list(self._threads.values())
            self._inlets.clear()
            self._threads.clear()
            self._active_stream_types.clear()
            self._last_sample_time.clear()
            
        logger.info("Stopping LSL Receiver...")
        # Join discovery thread outside lock
        if self._discovery_thread:
            self._discovery_thread.join(timeout=1.0)
            self._discovery_thread = None
            
        # Close all inlets outside lock to prevent deadlocking with reading threads
        for inlet in inlets_to_close:
            try:
                inlet.close_stream()
            except Exception as e:
                logger.error(f"Error closing inlet: {e}")

        # Wait briefly for reader threads to exit cleanly
        for t in threads_to_join:
            try:
                t.join(timeout=0.5)
            except Exception:
                pass
        
        logger.info("LSL Receiver stopped.")

    def get_status(self) -> Dict[str, bool]:
        """Returns True only for streams actively receiving data within the last 2.5 seconds."""
        now = time.time()
        with self._lock:
            status = {t: False for t in self.target_types}
            for uid, stype in self._active_stream_types.items():
                last_time = self._last_sample_time.get(stype, 0.0)
                if (now - last_time) < 2.5:
                    status[stype] = True
            return status

    def _discover_loop(self):
        """Runs periodically to find new LSL streams and spawn reader threads."""
        while not self._stop_event.is_set():
            with self._lock:
                if not self._running:
                    break
                now = time.time()
                active_types = set(
                    stype for uid, stype in self._active_stream_types.items()
                    if (now - self._last_sample_time.get(stype, 0.0)) < 2.5
                )
                all_found = all(t in active_types for t in self.target_types)

            if all_found:
                # All target streams are actively receiving live data; idle wait
                self._stop_event.wait(3.0)
                continue

            try:
                # Search for all available streams with sufficient wait time for all local outlets
                streams = pylsl.resolve_streams(wait_time=1.0)
                
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
            self._stop_event.wait(1.5)

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

        last_data_time = time.time()

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
                last_data_time = time.time()
                with self._lock:
                    self._last_sample_time[stype] = last_data_time
                # Forward the chunk of samples to the callback safely
                try:
                    self.callback(stype, samples, timestamps)
                except Exception as e:
                    logger.error(f"Error in data callback for stream {stype}: {e}")
            else:
                # Disconnect inlet if idle for > 4 seconds (headset powered down or out of range)
                if (time.time() - last_data_time) > 4.0:
                    logger.info(f"Stream {stype} (UID: {uid}) timed out with no incoming data. Disconnecting inlet...")
                    break

        # Cleanup this stream
        inlet_to_close = None
        with self._lock:
            if uid in self._inlets:
                inlet_to_close = self._inlets.pop(uid)
            if uid in self._threads:
                del self._threads[uid]
            if uid in self._active_stream_types:
                del self._active_stream_types[uid]
            if stype in self._last_sample_time:
                del self._last_sample_time[stype]

        if inlet_to_close:
            try:
                inlet_to_close.close_stream()
            except Exception:
                pass
        
        logger.info(f"Stopped reader thread for stream {stype} (UID: {uid})")
