import os
import sys
import unittest
from fastapi.testclient import TestClient

# Add backend directory to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from main import app


class TestAPIEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_status_endpoint(self):
        """Verify /api/status returns expected structure and default values."""
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("streaming_active", data)
        self.assertIn("streaming_device", data)
        self.assertIn("active_lsl_streams", data)
        self.assertIn("last_stream_error", data)
        self.assertIsInstance(data["active_lsl_streams"], dict)

    def test_stream_start_missing_address(self):
        """Verify /api/stream/start rejects requests without a device address."""
        response = self.client.post("/api/stream/start", json={"name": "Muse-2-Test"})
        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertIn("Device address is required", data.get("detail", ""))

    def test_stream_stop_when_idle(self):
        """Verify /api/stream/stop succeeds gracefully when no stream is running."""
        response = self.client.post("/api/stream/stop")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data.get("success", False))

    def test_root_html_serves_with_no_cache(self):
        """Verify root endpoint serves the dashboard HTML with anti-cache headers."""
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Muse2", response.text)
        self.assertIn("no-cache", response.headers.get("cache-control", ""))


if __name__ == "__main__":
    unittest.main()
