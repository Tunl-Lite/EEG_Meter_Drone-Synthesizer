// Muse2 LSL Gateway Real-Time Controller

// Display all real-time charts by default (EEG, PPG, ACC, GYRO)
const compactMode = false;
// Averaging window size (number of samples) for smoothing
const AVG_WINDOW = 5; // balances detail and smoothness

// --- Constants & Color Configurations (High-Contrast Theme) ---
const COLORS = {
    eeg: ['#ffb000', '#00e5ff', '#00e676', '#ff4081', '#b388ff'], // TP9, AF7, AF8, TP10, AUX
    ppg: ['#ff3344', '#ffaa00', '#00d4ff'], // Red, IR, Ambient
    imu: ['#ff3344', '#00e676', '#00d4ff']  // X, Y, Z
};

// --- Custom High-Performance Canvas Chart Class ---
class RealTimeChart {
    constructor(canvasId, channelCount, maxPoints, colors, minValRange = 100) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            console.error(`Canvas element #${canvasId} not found.`);
            return;
        }
        this.ctx = this.canvas.getContext('2d');
        this.channelCount = channelCount;
        this.maxPoints = maxPoints;
        this.colors = colors;
        this.minValRange = minValRange; // Minimum Y range to prevent noise amplification
        
        // Initialize circular/sliding buffers for each channel
        this.buffers = Array.from({ length: channelCount }, () => new Float32Array(maxPoints));
        this.bufferPtr = 0; // Insertion pointer
        this.dataSize = 0;   // Number of active data points in buffer
        
        // Rolling bounds for smooth Y-axis autoscaling (prevents sudden jumping)
        this.rollingMin = new Float32Array(channelCount).fill(-10);
        this.rollingMax = new Float32Array(channelCount).fill(10);
        
        // Resize canvas to match DPI
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        // Start render loop
        this.render = this.render.bind(this);
        requestAnimationFrame(this.render);
    }
    
    resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);
        this.width = rect.width;
        this.height = rect.height;
    }
    
    addSample(sample) {
        // sample: array of length channelCount
        for (let c = 0; c < this.channelCount; c++) {
            const val = sample[c] !== undefined ? sample[c] : 0;
            this.buffers[c][this.bufferPtr] = val;
        }
        
        this.bufferPtr = (this.bufferPtr + 1) % this.maxPoints;
        if (this.dataSize < this.maxPoints) {
            this.dataSize++;
        }
    }
    
    addChunk(samples) {
        // samples: array of arrays [[c1, c2, ...], [c1, c2, ...]]
        for (let i = 0; i < samples.length; i++) {
            this.addSample(samples[i]);
        }
    }
    
    render() {
        if (!this.width || !this.height) {
            this.resize();
            requestAnimationFrame(this.render);
            return;
        }
        
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        
        // Clear canvas
        ctx.clearRect(0, 0, w, h);
        
        if (this.dataSize < 2) {
            requestAnimationFrame(this.render);
            return;
        }
        
        // Render each channel
        for (let c = 0; c < this.channelCount; c++) {
            const buffer = this.buffers[c];
            const color = this.colors[c % this.colors.length];
            
            // Extract current data sequence in chronological order
            const data = new Float32Array(this.dataSize);
            for (let i = 0; i < this.dataSize; i++) {
                const idx = (this.bufferPtr - this.dataSize + i + this.maxPoints) % this.maxPoints;
                data[i] = buffer[idx];
            }
            
            // Calculate dynamic min/max
            let localMin = Infinity;
            let localMax = -Infinity;
            for (let i = 0; i < this.dataSize; i++) {
                const v = data[i];
                if (v < localMin) localMin = v;
                if (v > localMax) localMax = v;
            }
            
            // Guarantee a minimum range to prevent flatline noise zooming
            if (localMax - localMin < this.minValRange) {
                const center = (localMax + localMin) / 2;
                localMin = center - this.minValRange / 2;
                localMax = center + this.minValRange / 2;
            }
            
            // Apply temporal damping/low-pass to the Y-limits to make transitions smooth
            this.rollingMin[c] = this.rollingMin[c] * 0.92 + localMin * 0.08;
            this.rollingMax[c] = this.rollingMax[c] * 0.92 + localMax * 0.08;
            
            const yMin = this.rollingMin[c];
            const yMax = this.rollingMax[c];
            const yRange = yMax - yMin || 1;
            
            // Plot points
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.8;
            ctx.setLineDash([]);

            // Compute simple moving average for smoother display
            const smoothData = new Float32Array(this.dataSize);
            for (let i = 0; i < this.dataSize; i++) {
                let sum = 0;
                let count = 0;
                for (let j = Math.max(0, i - AVG_WINDOW + 1); j <= i; j++) {
                    sum += data[j];
                    count++;
                }
                smoothData[i] = sum / count;
            }
            
            for (let i = 0; i < this.dataSize; i++) {
                const val = smoothData[i];
                const x = (i / (this.maxPoints - 1)) * w;
                const y = h - ((val - yMin) / yRange) * h;
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        }
        
        requestAnimationFrame(this.render);
    }
}

// --- Global Application State ---
const state = {
    ws: null,
    charts: {},
    rates: {
        EEG: { count: 0, lastCalcTime: Date.now(), rate: 0 },
        PPG: { count: 0, lastCalcTime: Date.now(), rate: 0 },
        ACC: { count: 0, lastCalcTime: Date.now(), rate: 0 },
        GYRO: { count: 0, lastCalcTime: Date.now(), rate: 0 }
    },
    selectedDevice: null,
    simulation: {
        active: false,
        intervalId: null,
        ppgIntervalId: null
    },
    audio: {
        ctx: null,
        engaged: false,
        masterGain: null,
        analyser: null,
        delayNode: null,
        delayFeedback: null,
        voices: [],
        baseFreq: 65.4, // C2
        currentScale: 'g-minor-pentatonic'
    },
    bands: [0.2, 0.2, 0.2, 0.2, 0.2], // delta, theta, alpha, beta, gamma
    acc: [0, 0, 0], // x, y, z
    gyro: [0, 0, 0],
    calibration: {
        calibrating: false,
        startTime: null,
        duration: 10000, // 10 seconds (aligned with UI button)
        history: [],
        baselines: {
            delta: { min: 0.10, max: 0.35 },
            theta: { min: 0.10, max: 0.35 },
            alpha: { min: 0.10, max: 0.35 },
            beta: { min: 0.10, max: 0.35 },
            gamma: { min: 0.05, max: 0.25 }
        }
    },
    scales: {
        'g-minor-pentatonic': [1.0, 1.2, 1.5, 1.8, 2.0],  // Root, b3, 5, b7, Oct
        'c-major-pentatonic': [1.0, 1.25, 1.5, 1.68, 2.0], // Root, 3, 5, 6, Oct
        'd-phrygian-dominant': [1.0, 1.25, 1.5, 1.59, 2.0], // Root, 3, 5, b6, Oct
        'pygmy': [1.0, 1.19, 1.5, 1.68, 2.0],              // Root, b3, 5, 6, Oct
        'bhairav': [1.0, 1.25, 1.5, 1.88, 2.0]              // Root, 3, 5, 7, Oct
    }
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Real-Time Canvas Charts
    // EEG Stacked tracks (1 channel per track)
    state.charts['EEG_TP9'] = new RealTimeChart('canvas-eeg-tp9', 1, 500, [COLORS.eeg[0]], 40);
    state.charts['EEG_AF7'] = new RealTimeChart('canvas-eeg-af7', 1, 500, [COLORS.eeg[1]], 40);
    state.charts['EEG_AF8'] = new RealTimeChart('canvas-eeg-af8', 1, 500, [COLORS.eeg[2]], 40);
    state.charts['EEG_TP10'] = new RealTimeChart('canvas-eeg-tp10', 1, 500, [COLORS.eeg[3]], 40);
    state.charts['EEG_AUX'] = new RealTimeChart('canvas-eeg-aux', 1, 300, [COLORS.eeg[4]], 20);

    // PPG (3 channels overlaid)
    state.charts['PPG'] = new RealTimeChart('canvas-ppg', 3, 250, COLORS.ppg, 150);
    
    // ACC (3 channels overlaid)
    state.charts['ACC'] = new RealTimeChart('canvas-acc', 3, 200, COLORS.imu, 0.3);
    
    // GYRO (3 channels overlaid)
    state.charts['GYRO'] = new RealTimeChart('canvas-gyro', 3, 200, COLORS.imu, 3.0);

    // 2. Setup Event Listeners
    setupEventListeners();
    
    // 3. Connect WebSockets
    connectWebSocket();
    
    // 4. Start polling server status
    pollServerStatus();
    setInterval(pollServerStatus, 1000);
});

// --- WebSocket Connection ---
function connectWebSocket() {
    const wsUri = `ws://${window.location.host}/api/ws`;
    console.log(`Connecting to WebSocket: ${wsUri}`);
    
    state.ws = new WebSocket(wsUri);
    const badge = document.getElementById('ws-status');
    const badgeLabel = badge.querySelector('.status-label');
    
    state.ws.onopen = () => {
        console.log('WebSocket connected.');
        badge.classList.add('connected');
        badgeLabel.textContent = 'WEBSOCKET CONNECTED';
    };
    
    state.ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        handleStreamData(payload);
    };
    
    state.ws.onclose = () => {
        console.log('WebSocket disconnected. Retrying in 3 seconds...');
        badge.classList.remove('connected');
        badgeLabel.textContent = 'WEBSOCKET DISCONNECTED';
        
        // Clear all rate displays on disconnect safely
        const setRate = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };
        setRate('rate-eeg', '0 Hz');
        setRate('rate-ppg', '0 Hz');
        setRate('rate-acc', '0 Hz');
        setRate('rate-gyro', '0 Hz');
        
        setTimeout(connectWebSocket, 3000);
    };
    
    state.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// --- Process Incoming WebSocket Data ---
function handleStreamData(payload) {
    const stream = payload.stream;     // 'EEG', 'PPG', 'ACC', 'GYRO'
    const samples = payload.samples;   // Array of arrays
    const count = samples ? samples.length : 0;
    
    // Calculate and display dynamic sampling rate
    if (count > 0) {
        updateSampleRate(stream, count);
    }
    
    // Feed data to respective charts and update numerical values
    if (stream === 'EEG' && count > 0) {
        // samples format: [[tp9, af7, af8, tp10, aux], ...]
        // Route each channel to its stacked chart
        const tp9s = samples.map(s => [s[0]]);
        const af7s = samples.map(s => [s[1]]);
        const af8s = samples.map(s => [s[2]]);
        const tp10s = samples.map(s => [s[3]]);
        const auxs = samples.map(s => [s[4]]);
        
        state.charts['EEG_TP9'].addChunk(tp9s);
        state.charts['EEG_AF7'].addChunk(af7s);
        state.charts['EEG_AF8'].addChunk(af8s);
        state.charts['EEG_TP10'].addChunk(tp10s);
        state.charts['EEG_AUX'].addChunk(auxs);
        
        // Show current voltage values in UI (last sample in chunk)
        const lastSample = samples[count - 1];
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el && val !== undefined) el.textContent = `${val.toFixed(1)} uV`;
        };
        setVal('val-tp9', lastSample[0]);
        setVal('val-af7', lastSample[1]);
        setVal('val-af8', lastSample[2]);
        setVal('val-tp10', lastSample[3]);
        setVal('val-aux', lastSample[4]);
        
    } else if (stream === 'PPG' && count > 0) {
        state.charts['PPG'].addChunk(samples);
        
    } else if (stream === 'ACC' && count > 0) {
        state.charts['ACC'].addChunk(samples);
        state.acc = samples[count - 1]; // Store latest x, y, z forces
        
    } else if (stream === 'GYRO' && count > 0) {
        state.charts['GYRO'].addChunk(samples);
        state.gyro = samples[count - 1]; // Store latest rotation values
        
    } else if (stream === 'BANDS') {
        if (!payload.simulated && state.simulation && state.simulation.active) {
            console.log("Actual Muse LSL data detected. Automatically turning off simulation mode.");
            toggleSimulationMode(); // Disable simulation to prevent conflict
        }
        if (count > 0) {
            handleBandsData(samples[0]);
        }
    } else if (stream === 'PPG_BEAT') {
        if (!payload.simulated && state.simulation && state.simulation.active) {
            toggleSimulationMode(); // Disable simulation to prevent conflict
        }
        handlePpgBeat(payload.bpm);
    }
}

// --- Sample Rate Calculation ---
function updateSampleRate(stream, sampleCount) {
    const rateData = state.rates[stream];
    rateData.count += sampleCount;
    
    const now = Date.now();
    const elapsed = now - rateData.lastCalcTime;
    
    if (elapsed >= 1000) { // Recalculate rate every 1 second
        rateData.rate = Math.round((rateData.count / elapsed) * 1000);
        rateData.count = 0;
        rateData.lastCalcTime = now;
        
        // Update label
        const elId = `rate-${stream.toLowerCase()}`;
        const el = document.getElementById(elId);
        if (el) {
            el.textContent = `${rateData.rate} Hz`;
        }
    }
}

// --- REST API Interactions ---

async function fetchApi(endpoint, method = 'GET', body = null) {
    try {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(endpoint, options);
        return await response.json();
    } catch (err) {
        console.error(`API Error calling ${endpoint}:`, err);
        return { success: false, error: err.message };
    }
}

async function pollServerStatus() {
    const data = await fetchApi('/api/status');
    
    if (data.error) {
        // Reset sidebar state
        toggleStreamUiState(false, null);
        return;
    }
    
    // Sync Physical Streaming UI State
    toggleStreamUiState(data.streaming_active, data.streaming_device, data.active_lsl_streams);
    
    // Sync individual LSL Stream indicator lights
    updateLslStreamIndicators(data.active_lsl_streams);
}


function toggleStreamUiState(isActive, device, activeStreams) {
    const btnScan = document.getElementById('btn-scan');
    const btnStop = document.getElementById('btn-stop-stream');
    
    // Check if the Muse headband is fully linked by checking if any LSL stream is active
    const isLinked = activeStreams && Object.values(activeStreams).some(val => val === true);
    
    if (isActive) {
        btnScan.disabled = true;
        btnStop.disabled = false;
        
        // Highlight active streaming device if displayed
        if (device) {
            const items = document.querySelectorAll('.device-item');
            items.forEach(item => {
                const btnConnect = item.querySelector('.btn-connect-dev');
                if (item.dataset.address === device.address) {
                    item.classList.add('selected');
                    if (btnConnect) {
                        btnConnect.textContent = isLinked ? 'Connected' : 'Connecting...';
                        btnConnect.disabled = true;
                    }
                } else {
                    item.classList.remove('selected');
                    if (btnConnect) {
                        btnConnect.textContent = 'Connect';
                        btnConnect.disabled = true;
                    }
                }
            });
        }
    } else {
        btnScan.disabled = false;
        btnStop.disabled = true;
        
        const items = document.querySelectorAll('.device-item');
        items.forEach(item => {
            item.classList.remove('selected');
            const btnConnect = item.querySelector('.btn-connect-dev');
            if (btnConnect) {
                // If it is in the process of initiating connection, keep text as "Connecting..."
                if (btnConnect.textContent !== 'Connecting...') {
                    btnConnect.textContent = 'Connect';
                }
                btnConnect.disabled = false;
            }
        });
    }
}

function updateLslStreamIndicators(activeStreams) {
    const targetTypes = ['eeg', 'ppg', 'acc', 'gyro'];
    targetTypes.forEach(type => {
        const el = document.getElementById(`lsl-status-${type}`);
        if (el) {
            const uppercaseType = type.toUpperCase();
            const isActive = activeStreams && activeStreams[uppercaseType];
            if (isActive) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
                // Reset frequency display if not active
                const rateEl = document.getElementById(`rate-${type}`);
                if (rateEl) rateEl.textContent = '0 Hz';
            }
        }
    });
}

// --- UI Event Listeners Setup ---
function setupEventListeners() {
    
    // BLE Scanning controls
    document.getElementById('btn-scan').addEventListener('click', async () => {
        const listContainer = document.getElementById('device-list-container');
        listContainer.innerHTML = '<p class="empty-list-msg">Scanning for Muse headsets...</p>';
        
        const res = await fetchApi('/api/scan', 'POST');
        listContainer.innerHTML = '';
        
        if (res.success && res.devices.length > 0) {
            res.devices.forEach(device => {
                const item = document.createElement('div');
                item.className = 'device-item';
                item.dataset.name = device.name;
                item.dataset.address = device.address;
                
                item.innerHTML = `
                    <div class="device-info">
                        <span class="dev-name">${device.name}</span>
                        <span class="dev-addr">${device.address}</span>
                    </div>
                    <button class="btn btn-secondary btn-connect-dev">Connect</button>
                `;
                
                // Clicking "Connect" starts the stream subprocess
                item.querySelector('.btn-connect-dev').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    item.querySelector('.btn-connect-dev').textContent = 'Connecting...';
                    const streamRes = await fetchApi('/api/stream/start', 'POST', {
                        name: device.name,
                        address: device.address
                    });
                    
                    if (streamRes.success) {
                        pollServerStatus();
                    } else {
                        alert(`Failed to stream: ${streamRes.error}`);
                        item.querySelector('.btn-connect-dev').textContent = 'Connect';
                    }
                });
                
                listContainer.appendChild(item);
            });
        } else {
            listContainer.innerHTML = `
                <p class="empty-list-msg">
                    ${res.error ? 'Error scanning: ' + res.error : 'No Muse headbands discovered.'}
                </p>
            `;
        }
    });
    
    // Stop BLE Stream Subprocess
    document.getElementById('btn-stop-stream').addEventListener('click', async () => {
        const res = await fetchApi('/api/stream/stop', 'POST');
        if (res.success) {
            pollServerStatus();
        }
    });
    
    // IMU Tabs toggle (scoped strictly to .imu-tabs to prevent breaking header view-tabs)
    const imuTabs = document.querySelectorAll('.imu-tabs .tab-btn');
    imuTabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            imuTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const targetTab = tab.dataset.tab;
            const rAcc = document.getElementById('rate-acc');
            const rGyro = document.getElementById('rate-gyro');
            
            if (targetTab === 'tab-acc') {
                document.getElementById('tab-acc-panel').classList.remove('hidden');
                document.getElementById('tab-gyro-panel').classList.add('hidden');
                if (rAcc) rAcc.classList.remove('hidden');
                if (rGyro) rGyro.classList.add('hidden');
            } else {
                document.getElementById('tab-acc-panel').classList.add('hidden');
                document.getElementById('tab-gyro-panel').classList.remove('hidden');
                if (rAcc) rAcc.classList.add('hidden');
                if (rGyro) rGyro.classList.remove('hidden');
            }
            
            // Resize active canvases to ensure grid fitting
            state.charts['ACC'].resize();
            state.charts['GYRO'].resize();
        });
    });

    // View tab switching
    const viewTabs = document.querySelectorAll('.view-tabs .tab-btn');
    viewTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            viewTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const targetViewId = tab.dataset.view;
            if (targetViewId === 'telemetry-view') {
                document.getElementById('telemetry-view').classList.remove('hidden');
                document.getElementById('synth-view').classList.add('hidden');
            } else {
                document.getElementById('telemetry-view').classList.add('hidden');
                document.getElementById('synth-view').classList.remove('hidden');
                
                // Resize active canvases to ensure grid fitting
                state.charts['ACC'].resize();
                state.charts['GYRO'].resize();
                
                const canvas = document.getElementById('canvas-oscilloscope');
                if (canvas) {
                    const rect = canvas.getBoundingClientRect();
                    const dpr = window.devicePixelRatio || 1;
                    canvas.width = rect.width * dpr;
                    canvas.height = rect.height * dpr;
                }
            }
        });
    });

    // Engage Drone Engine button
    document.getElementById('btn-engage-audio').addEventListener('click', () => {
        if (!state.audio.engaged) {
            initSynth();
        } else {
            stopSynth();
        }
    });

    // Master Gain slider
    document.getElementById('slider-master-gain').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('val-master-gain').textContent = Math.round(val * 100) + '%';
        if (state.audio.engaged && state.audio.masterGain) {
            // Apply scale factor to prevent clipping (increased from 0.15 to 0.85 for louder sound)
            state.audio.masterGain.gain.setTargetAtTime(val * 0.85, state.audio.ctx.currentTime, 0.05);
        }
    });

    // Root Frequency slider
    document.getElementById('slider-root-freq').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.audio.baseFreq = val;
        document.getElementById('val-root-freq').textContent = `${val.toFixed(1)} Hz (${getNoteName(val)})`;
        if (state.audio.engaged) {
            updateSynthTuning();
        }
    });

    // Scale Selector
    document.getElementById('select-scale').addEventListener('change', (e) => {
        state.audio.currentScale = e.target.value;
        if (state.audio.engaged) {
            updateSynthTuning();
        }
    });

    // Simulate Telemetry button
    document.getElementById('btn-simulate-data').addEventListener('click', () => {
        toggleSimulationMode();
    });

    // Calibrate button
    document.getElementById('btn-calibrate').addEventListener('click', () => {
        runCalibration();
    });
}

// --- Pitch/Frequency Note Helper ---
function getNoteName(freq) {
    const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const noteNum = Math.round(12 * Math.log2(freq / 16.35)); // 16.35Hz is C0
    const octave = Math.floor(noteNum / 12);
    const noteName = notes[noteNum % 12];
    return `${noteName}${octave}`;
}

// --- Process EEG Band Powers ---
function handleBandsData(bands) {
    console.log('Received EEG band data:', bands);
    // bands: [delta, theta, alpha, beta, gamma]
    state.bands = bands;

    if (state.calibration.calibrating) {
        state.calibration.history.push(bands);
    }

    // Update relative UI meters
    const bandNames = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
    for (let i = 0; i < 5; i++) {
        const val = bands[i];
        const bar = document.getElementById(`meter-${bandNames[i]}`);
        const text = document.getElementById(`val-meter-${bandNames[i]}`);
        if (bar && text) {
            const pct = (val * 100).toFixed(1);
            bar.style.width = pct + '%';
            text.textContent = pct + '%';
        }
    }

    // Apply mappings to active Web Audio context
    if (state.audio.engaged && state.audio.ctx) {
        updateSynth();
    }
}

// --- Process PPG Heartbeat Peak ---
function handlePpgBeat(bpm) {
    document.getElementById('val-chime-bpm').textContent = bpm.toFixed(1);
    
    // Pulse dot effect in calibration / stats panel
    const calDot = document.getElementById('cal-dot');
    if (calDot) {
        calDot.classList.add('pulse-green');
        setTimeout(() => {
            calDot.classList.remove('pulse-green');
        }, 150);
    }
    
    if (state.audio.engaged && state.audio.ctx) {
        triggerHeartChime(bpm);
    }
}

// --- Web Audio Synth Engine Initialization ---
function initSynth() {
    try {
        const btnEngage = document.getElementById('btn-engage-audio');
        btnEngage.disabled = true;
        btnEngage.textContent = "ENGAGING ENGINE...";

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        state.audio.ctx = new AudioContextClass();
        if (state.audio.ctx.state === 'suspended') {
            state.audio.ctx.resume();
        }

        // 1. Master Gain
        state.audio.masterGain = state.audio.ctx.createGain();
        state.audio.masterGain.connect(state.audio.ctx.destination);
        
        const vol = parseFloat(document.getElementById('slider-master-gain').value);
        state.audio.masterGain.gain.setValueAtTime(vol * 0.85, state.audio.ctx.currentTime);
        // Smooth the initial master gain ramp to avoid pops
        state.audio.masterGain.gain.exponentialRampToValueAtTime(vol * 0.85, state.audio.ctx.currentTime + 0.03);

        // 2. Analyser Node for Oscilloscope
        state.audio.analyser = state.audio.ctx.createAnalyser();
        state.audio.analyser.fftSize = 256;
        state.audio.masterGain.connect(state.audio.analyser);

        // 3. Feedback Echo/Delay Node
        state.audio.delayNode = state.audio.ctx.createDelay(1.0);
        state.audio.delayNode.delayTime.setValueAtTime(0.4, state.audio.ctx.currentTime);
        
        state.audio.delayFeedback = state.audio.ctx.createGain();
        state.audio.delayFeedback.gain.setValueAtTime(0.42, state.audio.ctx.currentTime);
        
        state.audio.delayNode.connect(state.audio.delayFeedback);
        state.audio.delayFeedback.connect(state.audio.delayNode);
        state.audio.delayNode.connect(state.audio.masterGain);

        // 4. Voice setup
        state.audio.voices = [];
        const scale = state.scales[state.audio.currentScale];
        const root = state.audio.baseFreq;

        for (let i = 0; i < 5; i++) {
            const osc = state.audio.ctx.createOscillator();
            const filter = state.audio.ctx.createBiquadFilter();
            const gain = state.audio.ctx.createGain();
            const panner = state.audio.ctx.createStereoPanner();

            osc.type = (i < 2) ? 'triangle' : 'sawtooth';
            
            const freq = root * scale[i];
            osc.frequency.setValueAtTime(freq, state.audio.ctx.currentTime);
            
            filter.type = 'lowpass';
            filter.Q.setValueAtTime(2.0, state.audio.ctx.currentTime);
            filter.frequency.setValueAtTime(i < 2 ? 220 : 120, state.audio.ctx.currentTime); // starting values
            
            gain.gain.setValueAtTime(0.001, state.audio.ctx.currentTime); // tiny baseline to avoid zero‑gain clicks
        // Gentle attack envelope (ramp to a minimal audible level quickly)
        gain.gain.exponentialRampToValueAtTime(0.0015, state.audio.ctx.currentTime + 0.02);
            
            // Initial pan: Center (sub), Center (fifth), Left-ish (oct), Right-ish (third), Center-high (7th/9th)
            const panVal = (i === 2) ? -0.5 : (i === 3) ? 0.5 : 0.0;
            panner.pan.setValueAtTime(panVal, state.audio.ctx.currentTime);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(panner);
            panner.connect(state.audio.masterGain);
            panner.connect(state.audio.delayNode); // feed into echo loop

            osc.start(0);

            state.audio.voices.push({
                osc,
                filter,
                gain,
                panner,
                baseRatio: scale[i]
            });
        }

        // Finish engagement
        state.audio.engaged = true;
        btnEngage.textContent = "DISENGAGE DRONE ENGINE";
        btnEngage.classList.remove('btn-danger');
        btnEngage.classList.add('btn-primary');
        btnEngage.disabled = false;

        // Start Oscilloscope loop
        requestAnimationFrame(renderOscilloscope);
        
        console.log("Audio Drone Synthesizer successfully engaged.");
    } catch (e) {
        console.error("Failed to initialize Audio Drone Synthesizer:", e);
        alert("Web Audio initialization failed: " + e.message);
        const btnEngage = document.getElementById('btn-engage-audio');
        btnEngage.textContent = "ENGAGE DRONE ENGINE";
        btnEngage.disabled = false;
    }
}

// --- Web Audio Synth Engine Disengagement ---
function stopSynth() {
    if (!state.audio.engaged) return;
    
    const btnEngage = document.getElementById('btn-engage-audio');
    btnEngage.disabled = true;
    btnEngage.textContent = "SHUTTING DOWN...";

    state.audio.engaged = false;

    // Fade out master volume
    if (state.audio.masterGain) {
        const now = state.audio.ctx.currentTime;
        state.audio.masterGain.gain.setValueAtTime(state.audio.masterGain.gain.value, now);
        // Fade‑out with a short exponential ramp to avoid abrupt cutoff
        state.audio.masterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        // Then schedule a final gentle ramp to near‑silence
        state.audio.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    }

    setTimeout(() => {
        // Stop and disconnect voices
        state.audio.voices.forEach(v => {
            try { v.osc.stop(); } catch(e) {}
            try { v.osc.disconnect(); } catch(e) {}
            try { v.filter.disconnect(); } catch(e) {}
            try { v.gain.disconnect(); } catch(e) {}
            try { v.panner.disconnect(); } catch(e) {}
        });
        state.audio.voices = [];

        // Close AudioContext
        if (state.audio.ctx) {
            state.audio.ctx.close().then(() => {
                state.audio.ctx = null;
                btnEngage.textContent = "ENGAGE DRONE ENGINE";
                btnEngage.classList.remove('btn-primary');
                btnEngage.classList.add('btn-danger');
                btnEngage.disabled = false;
                
                // Clear voice meters in UI
                for (let i = 1; i <= 5; i++) {
                    document.getElementById(`voice-bar-${i}`).style.width = '0%';
                    document.getElementById(`voice-val-${i}`).textContent = '0.0%';
                }
                
                console.log("Audio Drone Synthesizer stopped.");
            });
        }
    }, 150);
}

// --- Update Synthesizer Tuning ---
function updateSynthTuning() {
    if (!state.audio.engaged || !state.audio.voices.length) return;
    
    const scale = state.scales[state.audio.currentScale];
    const root = state.audio.baseFreq;
    const now = state.audio.ctx.currentTime;

    state.audio.voices.forEach((voice, index) => {
        const targetFreq = root * scale[index];
        voice.baseRatio = scale[index];
        voice.osc.frequency.setTargetAtTime(targetFreq, now, 0.1);
    });
}

// --- Normalize Helper for baselines ---
function getNormalized(val, range) {
    // If the baseline range is degenerate (min === max), fall back to using the raw value
    // assuming the incoming band value is already between 0 and 1. This prevents the
    // synth parameters from being stuck at a constant 0.5 when calibration data is
    // unavailable or too narrow.
    if (range.max === range.min) {
        return Math.max(0, Math.min(1, val));
    }
    const norm = (val - range.min) / (range.max - range.min);
    return Math.max(0, Math.min(1, norm));
}



// --- Update Synthesizer Parameters from Telemetry ---
function updateSynth() {
    console.log('Updating synth with bands:', state.bands);
    if (!state.audio.engaged || !state.audio.voices.length || !state.audio.ctx) return;

    const now = state.audio.ctx.currentTime;
    
    // Get baseline-normalized values
    const nDelta = getNormalized(state.bands[0], state.calibration.baselines.delta);
    const nTheta = getNormalized(state.bands[1], state.calibration.baselines.theta);
    const nAlpha = getNormalized(state.bands[2], state.calibration.baselines.alpha);
    const nBeta = getNormalized(state.bands[3], state.calibration.baselines.beta);
    const nGamma = getNormalized(state.bands[4], state.calibration.baselines.gamma);

    // Compute code LFO swell (Theta controlled)
    const swellSpeed = 0.15 + 0.35 * nTheta; // cycles per second (0.15Hz - 0.5Hz)
    const swellDepth = 0.20 + 0.35 * nTheta; // volume sway (20% - 55%)
    const swellVal = Math.sin(Date.now() * 0.001 * Math.PI * 2 * swellSpeed) * swellDepth + (1.0 - swellDepth);

    // Accelerometer panning value (Gravity projection: X axis tilt)
    const tiltX = state.acc[0] ? (state.acc[0] / 9.8) : 0.0;

    // Apply voice mappings
    
    // Voice 1 (Root Triangle): Delta modulated
    const v1Gain = (0.35 + 0.65 * nDelta) * 0.60; // increased from 0.40
    state.audio.voices[0].gain.gain.setTargetAtTime(v1Gain, now, 0.1);
    state.audio.voices[0].filter.frequency.setTargetAtTime(250 + 200 * nAlpha, now, 0.1); // open low-pass slightly

    // Voice 2 (Fifth Triangle): Swell modulated
    const v2Gain = swellVal * 0.45; // increased from 0.25
    state.audio.voices[1].gain.gain.setTargetAtTime(v2Gain, now, 0.1);
    state.audio.voices[1].filter.frequency.setTargetAtTime(300 + 300 * nAlpha, now, 0.15);

    // Voice 3 (Octave Sawtooth): Alpha Filter + Beta Detune + Tilt Pan Left
    const v3Gain = swellVal * (0.12 + 0.08 * nAlpha) * 0.35; // increased from 0.18
    state.audio.voices[2].gain.gain.setTargetAtTime(v3Gain, now, 0.1);
    
    const cutoff3 = 120 + 1600 * nAlpha; // sweeps up to 1720Hz
    state.audio.voices[2].filter.frequency.setTargetAtTime(cutoff3, now, 0.2);
    
    const detune3 = (nBeta * 45); // up to 45 cents drift
    state.audio.voices[2].osc.detune.setTargetAtTime(detune3 * 0.4, now, 0.2);
    state.audio.voices[2].panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, -0.5 + tiltX * 0.8)), now, 0.15);

    // Voice 4 (Third Sawtooth): Alpha Filter + Beta Detune + Tilt Pan Right
    const v4Gain = swellVal * (0.12 + 0.08 * nAlpha) * 0.32; // increased from 0.16
    state.audio.voices[3].gain.gain.setTargetAtTime(v4Gain, now, 0.1);
    
    const cutoff4 = 110 + 1500 * nAlpha;
    state.audio.voices[3].filter.frequency.setTargetAtTime(cutoff4, now, 0.2);
    state.audio.voices[3].osc.detune.setTargetAtTime(-detune3 * 0.7, now, 0.2);
    state.audio.voices[3].panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, 0.5 + tiltX * 0.8)), now, 0.15);

    // Voice 5 (Ninth/Seventh Sawtooth): Gamma Modulated High Voice
    const v5Gain = swellVal * (0.2 + 0.8 * nGamma) * 0.25; // increased from 0.12
    state.audio.voices[4].gain.gain.setTargetAtTime(v5Gain, now, 0.1);
    
    const cutoff5 = 200 + 1800 * nAlpha;
    state.audio.voices[4].filter.frequency.setTargetAtTime(cutoff5, now, 0.2);
    state.audio.voices[4].osc.detune.setTargetAtTime(detune3 * 0.8, now, 0.2);

    // Gyroscope rotation speed controls echo feedback depth
    const gyroSpeed = Math.abs(state.gyro[0] || 0.0) + Math.abs(state.gyro[1] || 0.0);
    const normGyro = Math.min(1, gyroSpeed / 80.0); // 80 deg/s is threshold
    const feedbackVal = 0.35 + 0.38 * normGyro; // echo rings out between 35% and 73%
    state.audio.delayFeedback.gain.setTargetAtTime(feedbackVal, now, 0.2);

    // Update UI Level bars normalized by current maximum voice gains
    const gains = [v1Gain / 0.60, v2Gain / 0.45, v3Gain / 0.35, v4Gain / 0.32, v5Gain / 0.25];
    for (let i = 1; i <= 5; i++) {
        const gainVal = gains[i - 1];
        const pct = Math.max(0, Math.min(100, Math.round(gainVal * 100)));
        const bar = document.getElementById(`voice-bar-${i}`);
        const label = document.getElementById(`voice-val-${i}`);
        if (bar && label) {
            bar.style.width = pct + '%';
            label.textContent = pct.toFixed(1) + '%';
        }
    }
}

// --- Synthesize Heartbeat Pluck on PPG Event ---
function triggerHeartChime(bpm) {
    if (!state.audio.engaged || !state.audio.ctx) return;

    const now = state.audio.ctx.currentTime;
    
    // Choose chime frequencies based on current scale
    const scale = state.scales[state.audio.currentScale];
    
    // Play a high chime (Voice 4 ratio + 2 octaves up: scale[3] * 4)
    const baseFreq = state.audio.baseFreq * scale[3] * 4.0;
    
    // Sub-carrier (sine chime)
    const chime1 = state.audio.ctx.createOscillator();
    chime1.type = 'sine';
    chime1.frequency.setValueAtTime(baseFreq, now);

    // Harmonic overlay (triangle chime)
    const chime2 = state.audio.ctx.createOscillator();
    chime2.type = 'triangle';
    chime2.frequency.setValueAtTime(baseFreq * 1.501, now); // perfect fifth harmonic
    
    const chimeGain = state.audio.ctx.createGain();
    chimeGain.gain.setValueAtTime(0.0, now);
    chimeGain.gain.linearRampToValueAtTime(0.06, now + 0.005); // quick pluck rise
    chimeGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8); // decay tail

    chime1.connect(chimeGain);
    chime2.connect(chimeGain);
    
    chimeGain.connect(state.audio.masterGain);
    chimeGain.connect(state.audio.delayNode); // echoes ring out!

    chime1.onended = () => {
        try { chime1.disconnect(); } catch (e) {}
        try { chime2.disconnect(); } catch (e) {}
        try { chimeGain.disconnect(); } catch (e) {}
    };

    chime1.start(now);
    chime2.start(now);
    
    chime1.stop(now + 1.0);
    chime2.stop(now + 1.0);
}

// --- Render Time-Domain Audio Waveform ---
function renderOscilloscope() {
    if (!state.audio.engaged || !state.audio.analyser) return;

    const canvas = document.getElementById('canvas-oscilloscope');
    if (!canvas) {
        requestAnimationFrame(renderOscilloscope);
        return;
    }

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Fetch waveform amplitude bytes
    const bufferLength = state.audio.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    state.audio.analyser.getByteTimeDomainData(dataArray);

    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = '#ffb000'; // Amber lines
    ctx.lineWidth = 2;
    
    // Apply glowing retro CRT look
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#ffb000';

    ctx.beginPath();
    const sliceWidth = width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0; // convert 0..255 to 0..2
        const y = (v * height) / 2.0;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }

        x += sliceWidth;
    }

    ctx.lineTo(width, height / 2.0);
    ctx.stroke();

    // Reset shadow values for outer draws
    ctx.shadowBlur = 0;

    // Call updates on the synth values at matching draw rates
    updateSynth();

    requestAnimationFrame(renderOscilloscope);
}

// --- Run Calibration Baseline Procedure ---
function runCalibration() {
    if (state.calibration.calibrating) return;

    const btnCal = document.getElementById('btn-calibrate');
    const statusText = document.getElementById('cal-status-text');
    const calDot = document.getElementById('cal-dot');
    
    state.calibration.calibrating = true;
    state.calibration.startTime = Date.now();
    state.calibration.history = [];

    btnCal.disabled = true;
    calDot.classList.remove('pulse-green');
    
    console.log("Calibration started. Logging baseline telemetry data...");

    const checkTimer = setInterval(() => {
        const elapsed = Date.now() - state.calibration.startTime;
        const remaining = Math.ceil((state.calibration.duration - elapsed) / 1000);

        if (remaining > 0) {
            statusText.textContent = `CALIBRATING... (${remaining}s remaining)`;
        } else {
            clearInterval(checkTimer);
            
            state.calibration.calibrating = false;
            btnCal.disabled = false;
            
            const history = state.calibration.history;
            if (history.length >= 3) {
                // Compute new baselines
                // history: Array of [delta, theta, alpha, beta, gamma]
                const deltaVals = history.map(h => h[0]);
                const thetaVals = history.map(h => h[1]);
                const alphaVals = history.map(h => h[2]);
                const betaVals = history.map(h => h[3]);
                const gammaVals = history.map(h => h[4]);

                // We take 10th and 90th percentile to ignore extreme noise spikes
                const getPercentile = (arr, p) => {
                    const sorted = [...arr].sort((a, b) => a - b);
                    const idx = Math.floor(sorted.length * p);
                    return sorted[idx];
                };

                state.calibration.baselines.delta = { min: getPercentile(deltaVals, 0.1), max: getPercentile(deltaVals, 0.9) };
                state.calibration.baselines.theta = { min: getPercentile(thetaVals, 0.1), max: getPercentile(thetaVals, 0.9) };
                state.calibration.baselines.alpha = { min: getPercentile(alphaVals, 0.1), max: getPercentile(alphaVals, 0.9) };
                state.calibration.baselines.beta = { min: getPercentile(betaVals, 0.1), max: getPercentile(betaVals, 0.9) };
                state.calibration.baselines.gamma = { min: getPercentile(gammaVals, 0.1), max: getPercentile(gammaVals, 0.9) };

                // Enforce safety limits
                const safetyMargin = 0.03;
                const bandNames = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
                bandNames.forEach(b => {
                    const base = state.calibration.baselines[b];
                    if (base.max - base.min < safetyMargin) {
                        const mid = (base.max + base.min) / 2;
                        base.min = Math.max(0, mid - safetyMargin / 2);
                        base.max = Math.min(1, mid + safetyMargin / 2);
                    }
                });

                statusText.textContent = "CALIBRATED (CUSTOM BASELINES)";
                console.log('Calibration complete. Custom baselines:', JSON.stringify(state.calibration.baselines));
            } else {
                // Fallback: use full range baselines to ensure responsiveness
                console.warn('Calibration failed: insufficient EEG packets (', history.length, 'samples). Using full-range fallback baselines.');
                const fullNames = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
                fullNames.forEach(name => {
                    state.calibration.baselines[name] = { min: 0, max: 1 };
                });
                statusText.textContent = "CALIBRATED (FULL‑RANGE BASELINES)";
                console.log('Fallback baselines set to full range:', JSON.stringify(state.calibration.baselines));
            }

            // Apply baselines immediately if audio is engaged
            if (state.audio.engaged) {
                updateSynth();
            }

            // Blink green dot on completion
            calDot.classList.add('pulse-green');
            setTimeout(() => calDot.classList.remove('pulse-green'), 500);
        }
    }, 200);
}

// --- Telemetry Simulation Mode ---
function toggleSimulationMode() {
    const btnSim = document.getElementById('btn-simulate-data');
    if (state.simulation.active) {
        // Stop simulation
        if (state.simulation.intervalId) {
            clearInterval(state.simulation.intervalId);
            state.simulation.intervalId = null;
        }
        if (state.simulation.ppgIntervalId) {
            clearInterval(state.simulation.ppgIntervalId);
            state.simulation.ppgIntervalId = null;
        }
        state.simulation.active = false;
        if (btnSim) {
            btnSim.textContent = 'Simulate Telemetry';
            btnSim.classList.remove('btn-primary');
            btnSim.classList.add('btn-secondary');
        }
        console.log('Telemetry simulation stopped.');
        return;
    }

    // Start simulation
    state.simulation.active = true;
    if (btnSim) {
        btnSim.textContent = 'Stop Simulation';
        btnSim.classList.remove('btn-secondary');
        btnSim.classList.add('btn-primary');
    }
    console.log('Telemetry simulation started.');

    let simT = 0;
    const simFs = 256; // 256 Hz EEG simulation
    const stepIntervalMs = 40; // deliver chunks every 40ms (~10 samples)
    const samplesPerChunk = Math.round((simFs * stepIntervalMs) / 1000);

    state.simulation.intervalId = setInterval(() => {
        const eegChunk = [];
        const ppgChunk = [];
        const accChunk = [];
        const gyroChunk = [];

        for (let i = 0; i < samplesPerChunk; i++) {
            const t = simT + (i / simFs);
            // Simulated EEG: blend of alpha (10Hz), theta (6Hz), beta (18Hz), and delta (2Hz) + noise
            const alpha = Math.sin(2 * Math.PI * 10.0 * t) * 18.0;
            const theta = Math.sin(2 * Math.PI * 6.0 * t) * 12.0;
            const beta = Math.sin(2 * Math.PI * 18.0 * t) * 6.0;
            const delta = Math.sin(2 * Math.PI * 2.0 * t) * 15.0;
            const noise = (Math.random() - 0.5) * 4.0;

            const tp9 = 50.0 + delta + theta * 0.8 + noise;
            const af7 = 45.0 + alpha * 1.2 + beta * 0.6 + noise;
            const af8 = 45.0 + alpha * 1.1 + beta * 0.7 + noise;
            const tp10 = 50.0 + delta * 0.9 + theta + noise;
            const aux = 30.0 + noise * 1.5;

            eegChunk.push([tp9, af7, af8, tp10, aux]);

            // Simulated PPG at ~64Hz equivalent (1 in 4 samples)
            if (i % 4 === 0) {
                const pulse = Math.sin(2 * Math.PI * 1.2 * t);
                const ir = 1800.0 + 120.0 * pulse + (Math.random() - 0.5) * 5.0;
                const red = 1600.0 + 90.0 * pulse + (Math.random() - 0.5) * 4.0;
                const ambient = 80.0 + (Math.random() - 0.5) * 2.0;
                ppgChunk.push([ambient, ir, red]);
            }

            // Simulated IMU at ~52Hz (1 in 5 samples)
            if (i % 5 === 0) {
                const ax = Math.sin(t * 0.4) * 0.8;
                const ay = Math.cos(t * 0.3) * 0.6;
                const az = 9.8 + Math.sin(t * 0.6) * 0.3;
                accChunk.push([ax, ay, az]);

                const gx = Math.cos(t * 0.5) * 8.0;
                const gy = Math.sin(t * 0.4) * 6.0;
                const gz = Math.sin(t * 0.3) * 4.0;
                gyroChunk.push([gx, gy, gz]);
            }
        }

        simT += samplesPerChunk / simFs;

        // Feed chunks through data handler
        handleStreamData({ stream: 'EEG', samples: eegChunk, simulated: true });
        if (ppgChunk.length > 0) {
            handleStreamData({ stream: 'PPG', samples: ppgChunk, simulated: true });
        }
        if (accChunk.length > 0) {
            handleStreamData({ stream: 'ACC', samples: accChunk, simulated: true });
        }
        if (gyroChunk.length > 0) {
            handleStreamData({ stream: 'GYRO', samples: gyroChunk, simulated: true });
        }

        // Periodically compute drifting relative bands
        const driftDelta = 0.20 + 0.08 * Math.sin(simT * 0.3);
        const driftTheta = 0.22 + 0.06 * Math.cos(simT * 0.4);
        const driftAlpha = 0.28 + 0.10 * Math.sin(simT * 0.5);
        const driftBeta = 0.18 + 0.05 * Math.cos(simT * 0.6);
        const driftGamma = 0.12 + 0.04 * Math.sin(simT * 0.7);
        const sumBands = driftDelta + driftTheta + driftAlpha + driftBeta + driftGamma;

        const relBands = [
            driftDelta / sumBands,
            driftTheta / sumBands,
            driftAlpha / sumBands,
            driftBeta / sumBands,
            driftGamma / sumBands
        ];
        handleStreamData({ stream: 'BANDS', samples: [relBands], simulated: true });
    }, stepIntervalMs);

    // Simulated heartbeat pulse chime (~72 BPM -> every ~833ms)
    state.simulation.ppgIntervalId = setInterval(() => {
        const currentBpm = 72.0 + Math.sin(Date.now() * 0.001 * 0.2) * 4.0;
        handleStreamData({
            stream: 'PPG_BEAT',
            bpm: currentBpm,
            timestamp: Date.now() / 1000,
            simulated: true
        });
    }, 833);
}

