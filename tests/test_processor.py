import os
import sys
import unittest
import numpy as np

# Add backend directory to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from processor import EEGProcessor, PPGProcessor


class TestEEGProcessor(unittest.TestCase):
    def setUp(self):
        self.processor = EEGProcessor(window_size=512, step_size=32, fs=256.0)

    def test_initialization(self):
        self.assertEqual(self.processor.num_channels, 4)
        self.assertEqual(self.processor.window_size, 512)
        self.assertEqual(self.processor.step_size, 32)
        self.assertEqual(len(self.processor.hann_window), 512)
        self.assertIn('alpha', self.processor.band_indices)
        self.assertIn('theta', self.processor.band_indices)
        self.assertIn('delta', self.processor.band_indices)
        self.assertIn('beta', self.processor.band_indices)
        self.assertIn('gamma', self.processor.band_indices)

    def test_empty_samples(self):
        res = self.processor.add_samples([])
        self.assertEqual(res, [])

    def test_channel_padding_safety(self):
        """Verify that supplying fewer than 4 channels does not crash np.hstack."""
        # 2-channel samples
        samples_2ch = [[10.0, 20.0] for _ in range(600)]
        res = self.processor.add_samples(samples_2ch)
        self.assertTrue(len(res) > 0)
        # Should return 5 relative band powers per calculation
        self.assertEqual(len(res[0]), 5)
        self.assertAlmostEqual(sum(res[0]), 1.0, places=4)

    def test_standard_5ch_eeg_processing(self):
        """Verify standard 5-channel Muse samples generate normalized band powers."""
        # Synthesize 10 Hz alpha wave on AF7 and AF8 (channels 1 & 2)
        fs = 256.0
        samples = []
        for i in range(600):
            t = i / fs
            alpha_signal = 30.0 * np.sin(2 * np.pi * 10.0 * t)
            samples.append([10.0, alpha_signal, alpha_signal, 10.0, 5.0])

        res = self.processor.add_samples(samples)
        self.assertTrue(len(res) > 0)
        first_bands = res[0]
        self.assertEqual(len(first_bands), 5)
        self.assertAlmostEqual(sum(first_bands), 1.0, places=4)
        # Alpha band (index 2: delta=0, theta=1, alpha=2, beta=3, gamma=4) should dominate
        alpha_power = first_bands[2]
        self.assertGreater(alpha_power, 0.40, "Alpha power should dominate for a 10 Hz input signal")

    def test_step_size_remainder_retention(self):
        """Verify that samples_since_last_calc decrements step_size rather than dropping remainder."""
        # Feed 512 samples to fill buffer
        fill_samples = [[1.0] * 5 for _ in range(512)]
        res = self.processor.add_samples(fill_samples)
        # 512 samples filled, 512 >= 32, should yield multiple steps
        self.assertTrue(len(res) > 0)
        self.assertLess(self.processor.samples_since_last_calc, self.processor.step_size)

    def test_nan_and_flatline_channel_resilience(self):
        """Verify that NaNs and flatlined disconnected channels do not corrupt band powers."""
        fs = 256.0
        samples = []
        for i in range(600):
            t = i / fs
            alpha_signal = 30.0 * np.sin(2 * np.pi * 10.0 * t)
            # Channel 0: NaN glitch, Channel 1: valid alpha, Channel 2: valid alpha, Channel 3: flatline 0.0
            tp9_val = np.nan if i % 50 == 0 else 10.0
            samples.append([tp9_val, alpha_signal, alpha_signal, 0.0, 0.0])

        res = self.processor.add_samples(samples)
        self.assertTrue(len(res) > 0)
        for bands in res:
            self.assertEqual(len(bands), 5)
            self.assertTrue(all(np.isfinite(b) for b in bands), "All band values must be finite")
            self.assertAlmostEqual(sum(bands), 1.0, places=4)
            # Alpha (index 2) should still dominate from valid channels 1 & 2
            self.assertGreater(bands[2], 0.35)


class TestPPGProcessor(unittest.TestCase):
    def setUp(self):
        self.processor = PPGProcessor(fs=64.0, buffer_size=128)

    def test_empty_samples(self):
        res = self.processor.add_samples([], [])
        self.assertEqual(res, [])

    def test_sine_wave_60_bpm(self):
        """A 1.0 Hz sinusoidal wave (60 BPM) at 64 Hz should accurately yield ~60.0 BPM."""
        fs = 64.0
        t0 = 1000.0
        beats = []

        # Run 4 seconds (256 samples)
        for i in range(256):
            t = t0 + i / fs
            ir_val = 2000.0 + 50.0 * np.sin(2 * np.pi * 1.0 * (i / fs))
            sample = [50.0, ir_val, 1500.0]
            out = self.processor.add_samples([sample], [t])
            if out:
                beats.extend(out)

        self.assertGreaterEqual(len(beats), 2, "Should detect at least 2 beats over 4 seconds")
        for b in beats:
            self.assertAlmostEqual(b["bpm"], 60.0, delta=1.5,
                                   msg=f"Detected BPM {b['bpm']} deviates from expected 60.0 BPM")

    def test_sine_wave_75_bpm(self):
        """A 1.25 Hz sinusoidal wave (75 BPM) at 64 Hz should accurately yield ~75.0 BPM."""
        fs = 64.0
        t0 = 2000.0
        beats = []

        for i in range(256):
            t = t0 + i / fs
            ir_val = 2000.0 + 50.0 * np.sin(2 * np.pi * 1.25 * (i / fs))
            sample = [50.0, ir_val, 1500.0]
            out = self.processor.add_samples([sample], [t])
            if out:
                beats.extend(out)

        self.assertGreaterEqual(len(beats), 2, "Should detect at least 2 beats over 4 seconds")
        for b in beats:
            self.assertAlmostEqual(b["bpm"], 75.0, delta=2.0,
                                   msg=f"Detected BPM {b['bpm']} deviates from expected 75.0 BPM")

    def test_refractory_period_suppresses_noise(self):
        """High-frequency noise (e.g. 10 Hz oscillations) should not trigger excessive heartbeats."""
        fs = 64.0
        t0 = 3000.0
        beats = []

        for i in range(128):
            t = t0 + i / fs
            ir_val = 2000.0 + 20.0 * np.sin(2 * np.pi * 10.0 * (i / fs))
            sample = [50.0, ir_val, 1500.0]
            out = self.processor.add_samples([sample], [t])
            if out:
                beats.extend(out)

        # In 2 seconds, 10 Hz noise could produce 20 peaks, but refractory period (0.35s) must cap beats
        self.assertLessEqual(len(beats), 6, "Refractory period must restrict false beat triggers")


if __name__ == "__main__":
    unittest.main()
