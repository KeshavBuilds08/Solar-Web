/**
 * SolarClean Dashboard — ThingSpeak Integration & Dashboard Logic
 * Reads: Field 1 = Voltage, Field 2 = Current, Field 3 = Humidity, Field 4 = Ultrasonic (dust)
 */

(function () {
  'use strict';

  /* ========== Configuration ========== */
  const CONFIG = {
    // ThingSpeak credentials
    channelId: '3531242',
    readApiKey: 'VSKXXRE6IET6WPZJ',
    writeApiKey: '5KRH68GL6XUO6C9',
    // ThingSpeak base URL
    baseUrl: 'https://api.thingspeak.com',
    // Polling interval in ms (ThingSpeak free: min 15s)
    pollInterval: 15000,
    // Number of data points for charts
    chartPoints: 40,
    // Cleaning thresholds (defaults)
    thresholds: {
      dustDistance: 10,   // cm — below this = dirty
      humidity: 80        // % — above this = skip cleaning
    }
  };

  /* ========== State ========== */
  let state = {
    voltage: null,
    current: null,
    humidity: null,
    dustDistance: null,
    power: null,
    energy: 0,
    history: { voltage: [], current: [], humidity: [], dust: [], labels: [] },
    motorStatus: 'idle',        // idle | running | cleaning
    autoClean: true,
    lastUpdate: null,
    online: false,
    cleaningCount: 0,
    pollTimer: null,
    charts: {}
  };

  /* ========== DOM Refs ========== */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  /* ========== Session Guard ========== */
  function requireAuth() {
    const raw = sessionStorage.getItem('circuitech_active_session');
    if (!raw) {
      window.location.replace('login.html?restricted=1&next=dashboard.html');
      return false;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.token || (Date.now() - parsed.timestamp > 8 * 3600 * 1000)) {
        sessionStorage.removeItem('circuitech_active_session');
        window.location.replace('login.html?restricted=1&next=dashboard.html');
        return false;
      }
      return true;
    } catch (e) {
      window.location.replace('login.html?restricted=1&next=dashboard.html');
      return false;
    }
  }

  /* ========== Initialization ========== */
  function init() {
    if (!requireAuth()) return;

    loadConfig();
    bindEvents();
    initCharts();

    if (CONFIG.channelId && CONFIG.readApiKey) {
      fetchData();
      startPolling();
      addLog('info', 'Dashboard initialized — fetching ThingSpeak data');
    } else {
      showConfigModal();
      addLog('warn', 'No ThingSpeak credentials — configure to start');
    }
  }

  /* ========== Config persistence (localStorage) ========== */
  function loadConfig() {
    try {
      const saved = localStorage.getItem('solarclean_config');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only load thresholds from storage; credentials are hardcoded
        CONFIG.thresholds.dustDistance = parsed.dustDistance ?? 10;
        CONFIG.thresholds.humidity = parsed.humidityThreshold ?? 80;
      }
    } catch (e) { /* ignore */ }

    // Reflect in inputs
    const dustInput = $('#threshold-dust');
    const humInput = $('#threshold-humidity');
    if (dustInput) dustInput.value = CONFIG.thresholds.dustDistance;
    if (humInput) humInput.value = CONFIG.thresholds.humidity;
  }

  function saveConfig() {
    localStorage.setItem('solarclean_config', JSON.stringify({
      channelId: CONFIG.channelId,
      readApiKey: CONFIG.readApiKey,
      dustDistance: CONFIG.thresholds.dustDistance,
      humidityThreshold: CONFIG.thresholds.humidity
    }));
  }

  /* ========== Events ========== */
  function bindEvents() {
    // Config modal
    $('#btn-settings').addEventListener('click', showConfigModal);
    $('#config-save').addEventListener('click', handleConfigSave);
    $('#config-cancel').addEventListener('click', hideConfigModal);
    $('#config-overlay').addEventListener('click', (e) => {
      if (e.target === $('#config-overlay')) hideConfigModal();
    });

    // Motor controls
    $('#btn-clean-now').addEventListener('click', triggerManualClean);
    $('#btn-stop-motor').addEventListener('click', stopMotor);

    // Threshold inputs
    $('#threshold-dust').addEventListener('change', (e) => {
      CONFIG.thresholds.dustDistance = parseFloat(e.target.value) || 10;
      saveConfig();
      addLog('info', `Dust threshold updated to ${CONFIG.thresholds.dustDistance} cm`);
      evaluateCleaning();
    });
    $('#threshold-humidity').addEventListener('change', (e) => {
      CONFIG.thresholds.humidity = parseFloat(e.target.value) || 80;
      saveConfig();
      addLog('info', `Humidity threshold updated to ${CONFIG.thresholds.humidity}%`);
      evaluateCleaning();
    });

    // Log clear
    $('#btn-clear-log').addEventListener('click', () => {
      $('#log-entries').innerHTML = '';
      addLog('info', 'Log cleared');
    });
  }

  /* ========== ThingSpeak Fetch (JSONP — works from file://) ========== */
  let jsonpCounter = 0;

  function fetchData() {
    if (!requireAuth()) return;
    if (!CONFIG.channelId || !CONFIG.readApiKey) return;

    const callbackName = '_tsCallback' + (jsonpCounter++);
    const url = `${CONFIG.baseUrl}/channels/${CONFIG.channelId}/feeds.json?api_key=${CONFIG.readApiKey}&results=${CONFIG.chartPoints}&callback=${callbackName}`;

    window[callbackName] = function (data) {
      // Cleanup
      delete window[callbackName];
      const script = document.getElementById(callbackName);
      if (script) script.remove();

      if (!data || !data.feeds || data.feeds.length === 0) {
        updateOnlineStatus(false);
        addLog('warn', 'No data returned from ThingSpeak');
        return;
      }

      processFeeds(data.feeds);
      updateOnlineStatus(true);
    };

    const script = document.createElement('script');
    script.id = callbackName;
    script.src = url;
    script.onerror = function () {
      delete window[callbackName];
      script.remove();
      updateOnlineStatus(false);
      addLog('error', 'Failed to reach ThingSpeak');
    };
    document.head.appendChild(script);
  }

  function processFeeds(feeds) {
    // Reset history
    state.history = { voltage: [], current: [], humidity: [], dust: [], labels: [] };

    feeds.forEach((feed) => {
      const v = parseFloat(feed.field1);
      const c = parseFloat(feed.field2);
      const h = parseFloat(feed.field3);
      const d = parseFloat(feed.field4);
      const t = new Date(feed.created_at);

      state.history.voltage.push(isNaN(v) ? null : v);
      state.history.current.push(isNaN(c) ? null : c);
      state.history.humidity.push(isNaN(h) ? null : h);
      state.history.dust.push(isNaN(d) ? null : d);
      state.history.labels.push(formatTime(t));
    });

    // Latest values
    const latest = feeds[feeds.length - 1];
    state.voltage = parseFloat(latest.field1) || 0;
    state.current = parseFloat(latest.field2) || 0;
    state.humidity = parseFloat(latest.field3) || 0;
    state.dustDistance = parseFloat(latest.field4) || 0;
    state.power = state.voltage * state.current;
    state.lastUpdate = new Date(latest.created_at);

    // Simple energy estimation (Wh)
    state.energy += (state.power * (CONFIG.pollInterval / 3600000));

    updateUI();
    updateCharts();
    evaluateCleaning();

    // Sync snapshot to Supabase PostgreSQL table
    syncTelemetryToSupabase(state.voltage, state.current, state.humidity, state.dustDistance);
  }

  /* ========== Supabase PostgreSQL Synchronization ========== */
  let lastTelemetrySaveTime = 0;

  async function syncTelemetryToSupabase(v, c, h, d) {
    const now = Date.now();
    // Throttle inserts to once per minute to stay well within free tier limits
    if (now - lastTelemetrySaveTime < 60000) return;
    lastTelemetrySaveTime = now;

    if (!window.supabase) return;
    try {
      const conf = window.SecurityDB ? window.SecurityDB.getCloudConfig() : null;
      if (!conf || !conf.url || !conf.anonKey) return;
      const client = window.supabase.createClient(conf.url, conf.anonKey);

      await client.from('sensor_telemetry_history').insert([
        {
          voltage: v,
          current: c,
          humidity: h,
          dust_distance: d,
          soiling_state: d < CONFIG.thresholds.dustDistance ? 'Soiled (Cleaning Required)' : 'Optimal',
          gateway_status: 'online'
        }
      ]);
    } catch (e) {
      console.warn('Telemetry cloud snapshot skip:', e);
    }
  }

  async function logCleaningToSupabase(mode, dust, humidity) {
    if (!window.supabase) return;
    try {
      const conf = window.SecurityDB ? window.SecurityDB.getCloudConfig() : null;
      if (!conf || !conf.url || !conf.anonKey) return;
      const client = window.supabase.createClient(conf.url, conf.anonKey);
      const session = window.SecurityDB ? window.SecurityDB.getSession() : null;
      const operatorName = session ? session.name : (mode === 'auto' ? 'ESP32 Automation Engine' : 'Manual Operator');

      await client.from('cleaning_logs').insert([
        {
          mode: mode,
          status: 'completed',
          dust_distance_before: dust,
          humidity_at_cleaning: humidity,
          duration_seconds: 8,
          triggered_by: operatorName,
          notes: `Wiper sweep executed via ${mode} trigger.`
        }
      ]);
      addLog('info', `Saved cleaning event to Supabase cloud table [cleaning_logs]`);
    } catch (err) {
      console.warn('Could not record cleaning log to Supabase:', err);
    }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(fetchData, CONFIG.pollInterval);
  }

  /* ========== UI Updates ========== */
  function updateUI() {
    // Metric values
    animateValue($('#val-voltage'), state.voltage, 1);
    animateValue($('#val-current'), state.current, 2);
    animateValue($('#val-humidity'), state.humidity, 1);
    animateValue($('#val-dust'), state.dustDistance, 1);

    // Progress bars (normalized)
    updateBar($('#bar-voltage'), state.voltage, 25);    // max ~25V
    updateBar($('#bar-current'), state.current, 10);    // max ~10A
    updateBar($('#bar-humidity'), state.humidity, 100);
    updateBar($('#bar-dust'), Math.max(0, 30 - state.dustDistance), 30); // invert: closer = dirtier

    // Sub-labels
    $('#sub-voltage').textContent = state.voltage > 18 ? 'Optimal' : state.voltage > 12 ? 'Moderate' : 'Low';
    $('#sub-current').textContent = state.current > 5 ? 'High load' : state.current > 1 ? 'Normal' : 'Minimal';
    $('#sub-humidity').textContent = state.humidity > CONFIG.thresholds.humidity ? 'Too humid' : state.humidity > 50 ? 'Moderate' : 'Dry';
    $('#sub-dust').textContent = state.dustDistance < CONFIG.thresholds.dustDistance ? 'Dirty — clean needed' : 'Clean';

    // Power stats
    $('#stat-power').textContent = state.power.toFixed(1) + ' W';
    $('#stat-voltage-avg').textContent = average(state.history.voltage).toFixed(1) + ' V';
    $('#stat-current-avg').textContent = average(state.history.current).toFixed(1) + ' A';
    $('#stat-cleans').textContent = state.cleaningCount;

    // Last update
    if (state.lastUpdate) {
      $('#last-update').textContent = 'Updated ' + timeSince(state.lastUpdate);
    }
  }

  function updateOnlineStatus(isOnline) {
    state.online = isOnline;
    const badge = $('#status-badge');
    const dot = badge.querySelector('.status-dot');
    if (isOnline) {
      badge.className = 'status-badge online';
      badge.querySelector('span:last-child').textContent = 'LIVE';
    } else {
      badge.className = 'status-badge offline';
      badge.querySelector('span:last-child').textContent = 'OFFLINE';
    }
  }

  function animateValue(el, target, decimals) {
    if (!el) return;
    const current = parseFloat(el.textContent) || 0;
    const diff = target - current;
    const steps = 20;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      const val = current + (diff * (step / steps));
      el.textContent = val.toFixed(decimals);
      if (step >= steps) clearInterval(timer);
    }, 30);
  }

  function updateBar(el, value, max) {
    if (!el) return;
    const pct = Math.min(100, Math.max(0, (value / max) * 100));
    el.style.width = pct + '%';
  }

  /* ========== Charts (Chart.js) ========== */
  function initCharts() {
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17,24,39,0.95)',
          titleColor: '#f1f5f9',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.08)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          titleFont: { family: 'Inter', weight: '600' },
          bodyFont: { family: 'Inter' }
        }
      },
      scales: {
        x: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Inter', size: 10 }, maxTicksLimit: 8 }
        },
        y: {
          display: true,
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#64748b', font: { family: 'Inter', size: 10 } }
        }
      },
      elements: {
        point: { radius: 0, hoverRadius: 4 },
        line: { tension: 0.35, borderWidth: 2 }
      }
    };

    // Voltage chart
    state.charts.voltage = new Chart($('#chart-voltage'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Voltage (V)',
          data: [],
          borderColor: '#f59e0b',
          backgroundColor: createGradient('#chart-voltage', '#f59e0b'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });

    // Current chart
    state.charts.current = new Chart($('#chart-current'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Current (A)',
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: createGradient('#chart-current', '#3b82f6'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });

    // Humidity chart
    state.charts.humidity = new Chart($('#chart-humidity'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Humidity (%)',
          data: [],
          borderColor: '#10b981',
          backgroundColor: createGradient('#chart-humidity', '#10b981'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });

    // Dust / Ultrasonic chart
    state.charts.dust = new Chart($('#chart-dust'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Distance (cm)',
          data: [],
          borderColor: '#ef4444',
          backgroundColor: createGradient('#chart-dust', '#ef4444'),
          fill: true
        }]
      },
      options: { ...commonOptions }
    });
  }

  function createGradient(canvasSelector, hex) {
    const canvas = $(canvasSelector);
    if (!canvas) return hex;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 220);
    grad.addColorStop(0, hexToRgba(hex, 0.25));
    grad.addColorStop(1, hexToRgba(hex, 0));
    return grad;
  }

  function updateCharts() {
    const labels = state.history.labels;
    updateSingleChart(state.charts.voltage, labels, state.history.voltage);
    updateSingleChart(state.charts.current, labels, state.history.current);
    updateSingleChart(state.charts.humidity, labels, state.history.humidity);
    updateSingleChart(state.charts.dust, labels, state.history.dust);
  }

  function updateSingleChart(chart, labels, data) {
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update('none');
  }

  /* ========== Cleaning Logic ========== */
  function evaluateCleaning() {
    if (state.motorStatus === 'running' || state.motorStatus === 'cleaning') return;
    if (!state.autoClean) return;

    const dustDirty = state.dustDistance < CONFIG.thresholds.dustDistance && state.dustDistance > 0;
    const humidityOk = state.humidity < CONFIG.thresholds.humidity;

    if (dustDirty && humidityOk) {
      startCleaning('auto');
    } else if (dustDirty && !humidityOk) {
      addLog('warn', `Panel dirty (${state.dustDistance} cm) but humidity too high (${state.humidity}%) — skipping`);
    }
  }

  function startCleaning(mode) {
    state.motorStatus = 'cleaning';
    state.cleaningCount++;
    updateMotorUI();
    addLog('success', `Cleaning started (${mode}) — motor running`);
    showToast('success', '[ACTUATOR] Wiper cleaning cycle initiated');

    // Simulate cleaning cycle (in real system, ESP32 controls the motor via ThingSpeak write)
    setTimeout(() => {
      if (state.motorStatus === 'cleaning') {
        state.motorStatus = 'idle';
        updateMotorUI();
        addLog('success', 'Cleaning cycle completed');
        showToast('success', '[ACTUATOR] Surface sweep completed successfully');
        logCleaningToSupabase(mode, state.dustDistance, state.humidity);
      }
    }, 8000);
  }

  function triggerManualClean() {
    if (state.motorStatus !== 'idle') {
      showToast('warn', 'Motor is already active');
      return;
    }
    startCleaning('manual');
  }

  function stopMotor() {
    if (state.motorStatus === 'idle') return;
    state.motorStatus = 'idle';
    updateMotorUI();
    addLog('warn', 'Motor stopped manually');
    showToast('info', 'Motor stopped');
  }

  function updateMotorUI() {
    const indicator = $('#motor-indicator');
    const btnClean = $('#btn-clean-now');

    indicator.className = 'motor-status-indicator ' + state.motorStatus;
    indicator.textContent = state.motorStatus === 'idle' ? 'IDLE' : state.motorStatus === 'cleaning' ? 'CLEANING' : 'RUNNING';

    btnClean.disabled = state.motorStatus !== 'idle';
  }

  /* ========== Config Modal ========== */
  function showConfigModal() {
    $('#config-channel').value = CONFIG.channelId;
    $('#config-apikey').value = CONFIG.readApiKey;
    $('#config-overlay').classList.add('visible');
  }

  function hideConfigModal() {
    $('#config-overlay').classList.remove('visible');
  }

  function handleConfigSave() {
    const chId = $('#config-channel').value.trim();
    const apiKey = $('#config-apikey').value.trim();

    if (!chId || !apiKey) {
      showToast('error', 'Both Channel ID and API Key are required');
      return;
    }

    CONFIG.channelId = chId;
    CONFIG.readApiKey = apiKey;
    saveConfig();
    hideConfigModal();

    addLog('success', 'ThingSpeak credentials updated');
    showToast('success', 'Configuration saved!');

    fetchData();
    startPolling();
  }

  /* ========== System Log ========== */
  function addLog(type, message) {
    const container = $('#log-entries');
    if (!container) return;

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const now = new Date();
    entry.innerHTML = `
      <span class="log-time">${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}</span>
      <span class="log-type ${type}">${type}</span>
      <span class="log-msg">${message}</span>
    `;

    container.prepend(entry);

    // Cap at 50 entries
    while (container.children.length > 50) {
      container.removeChild(container.lastChild);
    }
  }

  /* ========== Toasts ========== */
  function showToast(type, message) {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  /* ========== Helpers ========== */
  function formatTime(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function timeSince(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  function average(arr) {
    const nums = arr.filter(v => v !== null && !isNaN(v));
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ========== Start ========== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
