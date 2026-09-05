import numpy as np
import logging
from typing import List, Tuple, Optional, Dict, Any

logger = logging.getLogger("SignalProcessor")

class EEGProcessor:
    def __init__(self, window_size: int = 512, step_size: int = 32, fs: float = 256.0):
        self.window_size = window_size
        self.step_size = step_size
        self.fs = fs
        
        # Buffer for EEG data of shape (channels, samples)
        # Main EEG channels on Muse: TP9 (0), AF7 (1), AF8 (2), TP10 (3)
        self.num_channels = 4
        self.buffer = np.zeros((self.num_channels, 0))
        self.samples_since_last_calc = 0
        
        # Define frequency bands
        self.bands = {
            'delta': (1.0, 4.0),
            'theta': (4.0, 8.0),
            'alpha': (8.0, 13.0),
            'beta': (13.0, 30.0),
            'gamma': (30.0, 45.0)
        }
        
        # Precompute Hanning window to reduce spectral leakage
        self.hann_window = np.hanning(self.window_size)
        
        # Precompute FFT frequency bins and band index masks (eliminates redundant FFT math)
        self.freqs = np.fft.rfftfreq(self.window_size, d=1.0 / self.fs)
        self.band_indices: Dict[str, np.ndarray] = {}
        for band_name, (f_min, f_max) in self.bands.items():
            self.band_indices[band_name] = np.where((self.freqs >= f_min) & (self.freqs < f_max))[0]
        
    def add_samples(self, samples: List[List[float]]) -> List[List[float]]:
        """
        Add new samples and calculate band powers if step_size is reached.
        samples: list of [tp9, af7, af8, tp10, aux] (aux is ignored for bands)
        Returns: list of [delta, theta, alpha, beta, gamma] relative powers, or empty list.
        """
        if not samples:
            return []
            
        raw_arr = np.array(samples, dtype=float).T
        if raw_arr.ndim != 2 or raw_arr.shape[1] == 0:
            return []

        # Safe channel slicing/padding to avoid dimension mismatch crashes
        num_avail = min(raw_arr.shape[0], self.num_channels)
        if num_avail < self.num_channels:
            padded = np.zeros((self.num_channels, raw_arr.shape[1]), dtype=float)
            padded[:num_avail, :] = raw_arr[:num_avail, :]
            new_data = padded
        else:
            new_data = raw_arr[:self.num_channels, :]
        
        # Append to buffer
        self.buffer = np.hstack((self.buffer, new_data))
        self.samples_since_last_calc += new_data.shape[1]
        
        # Keep buffer at window_size
        if self.buffer.shape[1] > self.window_size:
            self.buffer = self.buffer[:, -self.window_size:]
            
        # If accumulated samples exceed step_size and buffer is full,
        # calculate bands and decrement step size without dropping remainder
        calculated_bands = []
        while self.buffer.shape[1] == self.window_size and self.samples_since_last_calc >= self.step_size:
            self.samples_since_last_calc -= self.step_size
            calculated_bands.append(self._calculate_bands())
            
        return calculated_bands

    def _calculate_bands(self) -> List[float]:
        """Calculates relative band powers averaged across all 4 channels."""
        channel_powers = {band: [] for band in self.bands}
        
        # Calculate FFT for each channel
        for c in range(self.num_channels):
            channel_data = self.buffer[c, :]
            
            # Detrend (remove DC offset)
            channel_data = channel_data - np.mean(channel_data)
            
            # Apply Hanning window
            windowed_data = channel_data * self.hann_window
            
            # Compute RFFT
            fft_vals = np.fft.rfft(windowed_data)
            psd = np.abs(fft_vals) ** 2
            
            # Extract power in each band using precomputed index masks
            for band_name, band_idx in self.band_indices.items():
                if len(band_idx) > 0:
                    band_power = float(np.sum(psd[band_idx]))
                else:
                    band_power = 0.0
                channel_powers[band_name].append(band_power)
                
        # Average across channels
        avg_powers = {}
        total_power = 0.0
        for band_name in self.bands:
            avg_power = float(np.mean(channel_powers[band_name]))
            avg_powers[band_name] = avg_power
            total_power += avg_power
            
        # Compute relative power
        relative_powers = []
        if total_power > 0:
            for band_name in ['delta', 'theta', 'alpha', 'beta', 'gamma']:
                relative_powers.append(float(avg_powers[band_name] / total_power))
        else:
            # Fallback uniform powers
            relative_powers = [0.2, 0.2, 0.2, 0.2, 0.2]
            
        return relative_powers


class PPGProcessor:
    def __init__(self, fs: float = 64.0, buffer_size: int = 128):
        self.fs = fs
        self.buffer_size = buffer_size
        
        # Buffer for IR channel (index 1 in Muse PPG: Ambient=0, IR=1, Red=2)
        self.ir_buffer: List[float] = []
        
        # Heart rate tracking
        self.last_peak_time: Optional[float] = None
        self.bpm_history: List[float] = []
        
        # Smoothing window size (~78ms at 64Hz)
        self.smoothing_win = 5
        self.kernel = np.ones(self.smoothing_win) / self.smoothing_win
        
        # Refractory period: minimum time between beats (350ms -> up to 171 BPM)
        self.refractory_period = 0.35

    def add_samples(self, samples: List[List[float]], timestamps: List[float]) -> List[dict]:
        """
        Process incoming PPG samples and detect heartbeats.
        samples: list of [ambient, ir, red]
        timestamps: list of timestamps
        Returns: list of beat event dicts: [{"bpm": float, "timestamp": float}]
        """
        beat_events = []
        if not samples or not timestamps:
            return []
            
        for sample, ts in zip(samples, timestamps):
            if len(sample) < 2:
                continue
                
            ir_val = sample[1]  # Use IR channel
            self.ir_buffer.append(ir_val)
            if len(self.ir_buffer) > self.buffer_size:
                self.ir_buffer.pop(0)
                
            # Need a minimum buffer size to calculate baseline
            if len(self.ir_buffer) < 32:
                continue
                
            # Detrend over recent window (up to 64 samples = 1 sec)
            win_len = min(64, len(self.ir_buffer))
            arr = np.array(self.ir_buffer[-win_len:], dtype=float)
            detrended = arr - np.mean(arr)
            
            # Causal moving-average smoothing (mode='valid' avoids right-boundary zero-padding drop)
            valid_smoothed = np.convolve(detrended, self.kernel, mode='valid')
            if len(valid_smoothed) < 3:
                continue
                
            curr_val = float(valid_smoothed[-1])
            prev_val = float(valid_smoothed[-2])
            prev_prev_val = float(valid_smoothed[-3])
            
            # Dynamic thresholding based on peak-to-peak amplitude
            local_min = float(np.min(valid_smoothed))
            local_max = float(np.max(valid_smoothed))
            p2p = local_max - local_min
            threshold = local_min + 0.40 * p2p
            
            # True local peak detection at previous sample:
            # 1. Candidate exceeds dynamic threshold
            # 2. Minimum signal floor to reject flatline noise
            # 3. Inflection point: rising from prev_prev and falling to curr
            is_peak = (prev_val > threshold and 
                       prev_val > 5.0 and 
                       prev_val > prev_prev_val and 
                       prev_val >= curr_val)
            
            # Timestamp associated with the peak point (1 sample back from current ts)
            peak_time = ts - (1.0 / self.fs)
            
            if is_peak:
                # Check refractory period
                if self.last_peak_time is None or (peak_time - self.last_peak_time) >= self.refractory_period:
                    if self.last_peak_time is not None:
                        ibi = peak_time - self.last_peak_time
                        
                        # Sanity check: IBI must correspond to 35-180 BPM (0.33s - 1.71s)
                        if 0.33 <= ibi <= 1.71:
                            bpm = 60.0 / ibi
                            self.bpm_history.append(bpm)
                            if len(self.bpm_history) > 5:
                                self.bpm_history.pop(0)
                            avg_bpm = float(np.mean(self.bpm_history))
                            
                            beat_events.append({
                                "bpm": round(avg_bpm, 1),
                                "timestamp": peak_time
                            })
                            
                    self.last_peak_time = peak_time
                    
        return beat_events
