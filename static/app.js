const API_URL = "https://dpia.trevrosa.dev/data";

const METRICS = [
    { key: "air_temp", label: "Air Temperature", unit: "°C", color: "#3366cc" },
    {
        key: "ground_temp",
        label: "Ground Temperature",
        unit: "°C",
        color: "#ff7f0e",
    },
    { key: "humidity", label: "Humidity", unit: "%", color: "#2ca02c" },
    { key: "nox", label: "NOx Index", unit: "", color: "#9467bd" },
    { key: "voc", label: "VOC Index", unit: "", color: "#d62728" },
    { key: "pm10", label: "PM10", unit: "ug/m3", color: "#8c564b" },
    { key: "pm25", label: "PM2.5", unit: "ug/m3", color: "#17becf" },
];
const INDIVIDUAL_CHART_METRICS = ["air_temp", "ground_temp", "humidity"];
const AIR_QUALITY_METRICS = ["nox", "voc", "pm10", "pm25"];
const Y_AXIS_DEFAULTS = {
    air_temp: { min: 10, max: 40 },
    ground_temp: { min: 20, max: 60 },
    humidity: { min: 0, max: 100 },
};
const ONE_DAY_SECONDS = 24 * 60 * 60;
const ZOOM_LIMIT_MS = 5 * 60 * 1000;
const MAX_GAP_MS = 10 * 60 * 1000;

// Gauge ranges (same as chart Y axes)
const GAUGE_RANGES = {
    air_temp: { min: 10, max: 40, unit: "°C" },
    ground_temp: { min: 20, max: 60, unit: "°C" },
    humidity: { min: 0, max: 100, unit: "%" },
    nox: { min: 0, max: 10, unit: "" },
    voc: { min: 0, max: 10, unit: "" },
    pm10: { min: 0, max: 500, unit: "ug/m3" },
    pm25: { min: 0, max: 500, unit: "ug/m3" },
};

let defaultXMin = null;
let defaultXMax = null;
let crosshairTimestamp = null;
let autoRefreshInterval = null;
let lastUpdateTime = null;
let countdownInterval = null;
let nextRefreshTime = null;

// ---------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------
const crosshairPlugin = {
    id: "crosshair",
    afterDraw(chart, args, options) {
        if (crosshairTimestamp === null) return;
        const xScale = chart.scales.x;
        if (!xScale) return;
        const xPixel = xScale.getPixelForValue(crosshairTimestamp);
        const chartArea = chart.chartArea;
        if (xPixel < chartArea.left || xPixel > chartArea.right) return;

        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = "#F66";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xPixel, chartArea.top);
        ctx.lineTo(xPixel, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    },
};

Chart.register(crosshairPlugin);
Chart.register(ChartZoom);

const charts = new Map();
const filterForm = document.getElementById("filterForm");
const refreshBtn = document.getElementById("refreshBtn");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function getFilters() {
    const startInput = document.getElementById("startInput").value.trim();
    const endInput = document.getElementById("endInput").value.trim();
    const start = toUnixSeconds(startInput);
    const end = toUnixSeconds(endInput);
    return {
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
    };
}

function toUnixSeconds(dateTimeValue) {
    if (!dateTimeValue) return null;
    const milliseconds = new Date(dateTimeValue).getTime();
    if (Number.isNaN(milliseconds)) return null;
    return String(Math.floor(milliseconds / 1000));
}

function toDateTimeLocalValue(milliseconds) {
    const date = new Date(milliseconds);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function getPastDayRangeMs() {
    const end = Date.now();
    return { min: end - ONE_DAY_SECONDS * 1000, max: end };
}

function setDefaultDateRange() {
    const endSeconds = Math.floor(Date.now() / 1000);
    const startSeconds = endSeconds - ONE_DAY_SECONDS;
    document.getElementById("startInput").value = toDateTimeLocalValue(
        startSeconds * 1000,
    );
    document.getElementById("endInput").value = toDateTimeLocalValue(
        endSeconds * 1000,
    );
}

function buildUrl(filters) {
    const url = new URL(API_URL);
    Object.entries(filters).forEach(([k, v]) => url.searchParams.set(k, v));
    return url;
}

function normalizePayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object") {
        if (Array.isArray(payload.data)) return payload.data;
        if (Array.isArray(payload.records)) return payload.records;
        return [payload];
    }
    return [];
}

function normalizeTimestamp(ts) {
    if (typeof ts !== "number" || Number.isNaN(ts)) return null;
    return ts > 1_000_000_000_000 ? ts : ts * 1000;
}

function formatTimestamp(ts) {
    const normalized = normalizeTimestamp(ts);
    if (!normalized) return "N/A";
    return new Date(normalized).toLocaleString();
}

function formatTimeOnly(ts) {
    const normalized = normalizeTimestamp(Number(ts));
    if (!normalized) return "";
    return new Date(normalized).toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

// ---------------------------------------------------------------------
// Crosshair sync
// ---------------------------------------------------------------------
function getTimestampFromEvent(chart, event) {
    const rect = chart.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const xScale = chart.scales.x;
    if (!xScale) return null;
    const chartArea = chart.chartArea;
    if (x < chartArea.left || x > chartArea.right) return null;
    return xScale.getValueForPixel(x);
}

function syncCrosshair(event, timestamp) {
    crosshairTimestamp = timestamp;
    charts.forEach((chart) => {
        const elements = chart.getElementsAtEventForMode(event, "index", {
            intersect: false,
        });
        if (elements && elements.length) {
            chart.setActiveElements(elements);
        } else {
            chart.setActiveElements([]);
        }
        chart.tooltip.update();
        chart.draw();
    });
}

function clearCrosshair() {
    crosshairTimestamp = null;
    charts.forEach((chart) => {
        chart.setActiveElements([]);
        chart.tooltip.update();
        chart.draw();
    });
}

// ---------------------------------------------------------------------
// Chart range and limits
// ---------------------------------------------------------------------
function setAllChartsXRange(min, max) {
    charts.forEach((chart) => {
        chart.options.scales.x.min = min;
        chart.options.scales.x.max = max;
        chart.update("none");
    });
}

function setAllChartsXLimits(min, max) {
    charts.forEach((chart) => {
        chart.options.plugins.zoom.limits.x.min = min;
        chart.options.plugins.zoom.limits.x.max = max;
    });
}

function resetChartView(chart) {
    if (defaultXMin === null || defaultXMax === null) return;
    chart.options.scales.x.min = defaultXMin;
    chart.options.scales.x.max = defaultXMax;
    chart.update();
}

// ---------------------------------------------------------------------
// Autorefresh status
// ---------------------------------------------------------------------
function updateStatus() {
    const statusEl = document.getElementById("updateStatus");
    if (!statusEl) return;
    if (lastUpdateTime === null) {
        statusEl.textContent = "Last update: --";
        return;
    }
    const now = Date.now();
    const diff = Math.floor((now - lastUpdateTime) / 1000);
    if (diff < 60) {
        statusEl.textContent = `Last update: ${diff}s ago`;
    } else {
        const mins = Math.floor(diff / 60);
        const secs = diff % 60;
        statusEl.textContent = `Last update: ${mins}m ${secs}s ago`;
    }
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        const statusEl = document.getElementById("updateStatus");
        if (!statusEl) return;
        if (nextRefreshTime === null) return;
        const now = Date.now();
        const remaining = Math.max(
            0,
            Math.floor((nextRefreshTime - now) / 1000),
        );
        if (remaining === 0) {
            statusEl.textContent = "Refreshing...";
        } else {
            statusEl.textContent = `Next refresh in ${remaining}s`;
        }
    }, 1000);
}

function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(refresh, 30000);
}

function restartAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    startAutoRefresh();
    if (lastUpdateTime) {
        nextRefreshTime = Date.now() + 30000;
        updateStatus();
        startCountdown();
    }
}

// ---------------------------------------------------------------------
// Gauge functions
// ---------------------------------------------------------------------
function createGaugeCards() {
    const grid = document.getElementById("gaugeGrid");
    if (!grid) return;
    grid.innerHTML = "";
    METRICS.forEach((metric) => {
        const card = document.createElement("div");
        card.className = "gauge-card";
        card.id = `gauge-${metric.key}`;
        card.innerHTML = `
            <h3>${metric.label}</h3>
            <canvas id="gaugeCanvas-${metric.key}" width="160" height="160"></canvas>
        `;
        grid.appendChild(card);
    });
}

function drawGauge(canvasId, value, min, max, unit) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
        console.warn(`Canvas not found: ${canvasId}`);
        return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.42;
    const lineWidth = 10;

    const clamped = Math.min(Math.max(value, min), max);
    const percent = (clamped - min) / (max - min);

    // Full circle from 12 o'clock ( -PI/2 ) clockwise
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + 2 * Math.PI;
    const currentAngle = startAngle + 2 * Math.PI * percent;

    ctx.clearRect(0, 0, width, height);

    // Background arc (full circle)
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, startAngle, endAngle);
    ctx.strokeStyle = "#e0e5ec";
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.stroke();

    // Foreground arc (progress)
    if (percent > 0) {
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, "#2f6fed");
        gradient.addColorStop(1, "#66b3ff");
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, startAngle, currentAngle);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "round";
        ctx.stroke();
    }

    // Center label: numeric value
    ctx.fillStyle = "#152238";
    ctx.font = "bold 28px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(clamped.toFixed(1), centerX, centerY - 4);

    // Unit below value (smaller)
    ctx.fillStyle = "#5b6b83";
    ctx.font = "14px Inter, sans-serif";
    ctx.fillText(unit, centerX, centerY + 24);
}

function updateGauges(data) {
    if (!data || !data.length) {
        // Clear gauges
        METRICS.forEach((metric) => {
            const canvas = document.getElementById(`gaugeCanvas-${metric.key}`);
            if (canvas) {
                const ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        });
        return;
    }

    const latest = data.reduce((a, b) =>
        a.submitted_at > b.submitted_at ? a : b
    );

    METRICS.forEach((metric) => {
        const value = latest[metric.key];
        if (value === null || value === undefined) return;
        const range = GAUGE_RANGES[metric.key];
        if (!range) return;
        drawGauge(
            `gaugeCanvas-${metric.key}`,
            value,
            range.min,
            range.max,
            range.unit
        );
    });
}

// ---------------------------------------------------------------------
// Refresh function (updates end time to now)
// ---------------------------------------------------------------------
function refresh() {
    const endSeconds = Math.floor(Date.now() / 1000);
    document.getElementById("endInput").value = toDateTimeLocalValue(
        endSeconds * 1000,
    );
    loadData();
}

// ---------------------------------------------------------------------
// Chart options
// ---------------------------------------------------------------------
function getChartOptions(showLegend, yRange, yUnit) {
    return {
        normalized: true,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: showLegend },
            tooltip: {
                enabled: true,
                callbacks: {
                    title(items) {
                        if (!items.length) return "";
                        return formatTimestamp(items[0].parsed.x);
                    },
                    label(context) {
                        const base = context.dataset.label || "";
                        const value = context.parsed?.y;
                        if (value === null || value === undefined) return base;
                        return yUnit
                            ? `${base}: ${value} ${yUnit}`
                            : `${base}: ${value}`;
                    },
                },
            },
            zoom: {
                pan: {
                    enabled: true,
                    mode: "x",
                    modifierKey: null,
                },
                zoom: {
                    wheel: {
                        enabled: true,
                        speed: 0.05,
                        modifierKey: "shift",
                    },
                    pinch: { enabled: true },
                    mode: "x",
                },
                limits: {
                    x: { minRange: ZOOM_LIMIT_MS },
                },
            },
        },
        scales: {
            x: {
                type: "time",
                time: {
                    displayFormats: {
                        minute: "HH:mm",
                    },
                },
                grid: { color: "rgba(0,0,0,0.05)" },
            },
            y: {
                min: yRange?.min,
                max: yRange?.max,
                beginAtZero: false,
                grace: "6%",
            },
        },
    };
}

// ---------------------------------------------------------------------
// Chart creation
// ---------------------------------------------------------------------
function createSingleMetricChart(metric) {
    const ctx = document.getElementById(`chart-${metric.key}`);
    if (!ctx) return;

    const chart = new Chart(ctx, {
        type: "line",
        data: {
            datasets: [
                {
                    label: metric.label,
                    data: [],
                    borderColor: metric.color,
                    backgroundColor: `${metric.color}22`,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.25,
                    spanGaps: false,
                },
            ],
        },
        options: getChartOptions(
            false,
            Y_AXIS_DEFAULTS[metric.key],
            metric.unit,
        ),
    });

    chart.canvas.addEventListener("mousemove", (e) => {
        const timestamp = getTimestampFromEvent(chart, e);
        if (timestamp !== null && timestamp !== undefined) {
            syncCrosshair(e, timestamp);
        }
    });
    chart.canvas.addEventListener("mouseleave", clearCrosshair);
    ctx.addEventListener("dblclick", () => {
        resetChartView(chart);
    });

    charts.set(metric.key, chart);
}

function createAirQualityChart() {
    const ctx = document.getElementById("chart-air_quality");
    if (!ctx) return;

    const datasets = AIR_QUALITY_METRICS.map((key) => {
        const metric = METRICS.find((item) => item.key === key);
        return {
            label: metric.label,
            data: [],
            borderColor: metric.color,
            backgroundColor: `${metric.color}22`,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
            spanGaps: false,
        };
    });

    let options = getChartOptions(true, { min: 1, max: 500 });
    options.scales.y1 = {
        type: "linear",
        display: true,
        position: "right",
        grid: { drawOnChartArea: false },
    };
    const chart = new Chart(ctx, {
        type: "line",
        data: { datasets },
        options: options,
    });

    chart.canvas.addEventListener("mousemove", (e) => {
        const timestamp = getTimestampFromEvent(chart, e);
        if (timestamp !== null && timestamp !== undefined) {
            syncCrosshair(e, timestamp);
        }
    });
    chart.canvas.addEventListener("mouseleave", clearCrosshair);
    ctx.addEventListener("dblclick", () => {
        resetChartView(chart);
    });

    charts.set("air_quality", chart);
}

function initializeCharts() {
    INDIVIDUAL_CHART_METRICS.forEach((key) => {
        const metric = METRICS.find((item) => item.key === key);
        if (metric) createSingleMetricChart(metric);
    });
    createAirQualityChart();
}

// ---------------------------------------------------------------------
// Data gapbreaking
// ---------------------------------------------------------------------
function breakGaps(points, maxGapMs) {
    if (points.length < 2) return points.slice();
    const result = [];
    for (let i = 0; i < points.length - 1; i++) {
        result.push(points[i]);
        const gap = points[i + 1].x - points[i].x;
        if (gap > maxGapMs) {
            result.push({ x: points[i].x, y: null });
        }
    }
    result.push(points[points.length - 1]);
    return result;
}

// ---------------------------------------------------------------------
// Update charts and gauges
// ---------------------------------------------------------------------
function updateCharts(data) {
    const sorted = [...data].sort(
        (a, b) => (a.submitted_at ?? 0) - (b.submitted_at ?? 0),
    );

    INDIVIDUAL_CHART_METRICS.forEach((key) => {
        const metric = METRICS.find((item) => item.key === key);
        if (!metric) return;
        const chart = charts.get(metric.key);
        if (!chart) return;

        let points = sorted
            .filter(
                (item) =>
                    item[metric.key] !== null && item[metric.key] !== undefined,
            )
            .map((item) => {
                const x = normalizeTimestamp(item.submitted_at);
                return x ? { x, y: item[metric.key] } : null;
            })
            .filter(Boolean);

        points = breakGaps(points, MAX_GAP_MS);
        chart.data.datasets[0].data = points;
        chart.update();
        setTimeout(() => chart.resetZoom(), 200);
    });

    const airQualityChart = charts.get("air_quality");
    if (airQualityChart) {
        AIR_QUALITY_METRICS.forEach((key, index) => {
            let points = sorted
                .filter((item) => item[key] !== null && item[key] !== undefined)
                .map((item) => {
                    const x = normalizeTimestamp(item.submitted_at);
                    return x ? { x, y: item[key] } : null;
                })
                .filter(Boolean);
            points = breakGaps(points, MAX_GAP_MS);
            airQualityChart.data.datasets[index].data = points;
        });
        airQualityChart.update();
        setTimeout(() => airQualityChart.resetZoom(), 200);
    }

    // Update gauges with the latest data
    updateGauges(data);
}

// ---------------------------------------------------------------------
// Main data loading
// ---------------------------------------------------------------------
async function loadData() {
    const filters = getFilters();
    const url = buildUrl(filters);

    try {
        const response = await fetch(url, { method: "GET" });
        if (!response.ok) {
            throw new Error(`Request failed (${response.status})`);
        }

        const payload = await response.json();
        const data = normalizePayload(payload).filter(
            (item) => item && typeof item === "object",
        );

        updateCharts(data);

        const timestamps = data
            .map((item) => normalizeTimestamp(item.submitted_at))
            .filter((ts) => Number.isFinite(ts));

        const now = Date.now();
        let globalMin = timestamps.length
            ? Math.min(...timestamps)
            : now - ONE_DAY_SECONDS * 1000;

        const endSeconds = filters.end ? Number(filters.end) : null;
        const startSeconds = filters.start ? Number(filters.start) : null;

        let globalMax =
            endSeconds !== null && Number.isFinite(endSeconds)
                ? endSeconds * 1000
                : now;
        if (globalMax < globalMin) globalMax = globalMin + ZOOM_LIMIT_MS;

        setAllChartsXLimits(globalMin, globalMax);

        let visibleMin =
            startSeconds !== null && Number.isFinite(startSeconds)
                ? startSeconds * 1000
                : Math.max(globalMin, now - 60 * 60 * 1000);

        let visibleMax =
            endSeconds !== null && Number.isFinite(endSeconds)
                ? endSeconds * 1000
                : now;

        if (visibleMin >= visibleMax) {
            visibleMin = globalMin;
            visibleMax = globalMax;
        }
        visibleMin = Math.max(visibleMin, globalMin);
        visibleMax = Math.min(visibleMax, globalMax);

        defaultXMin = visibleMin;
        defaultXMax = visibleMax;
        setAllChartsXRange(visibleMin, visibleMax);

        // Update autorefresh status
        lastUpdateTime = Date.now();
        nextRefreshTime = lastUpdateTime + 30000;
        updateStatus();
        startCountdown();
        restartAutoRefresh();
    } catch (error) {
        console.error("Failed to load data:", error);
        const now = Date.now();
        const defaultMin = now - ONE_DAY_SECONDS * 1000;
        defaultXMin = defaultMin;
        defaultXMax = now;
        setAllChartsXRange(defaultMin, now);
        setAllChartsXLimits(defaultMin, now);
        updateCharts([]);
        // Reset status
        lastUpdateTime = null;
        nextRefreshTime = null;
        updateStatus();
        if (countdownInterval) clearInterval(countdownInterval);
    }
}

// ---------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------
filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loadData();
});

clearFiltersBtn.addEventListener("click", () => {
    setDefaultDateRange();
    loadData();
});

refreshBtn.addEventListener("click", refresh);

// ---------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------
setDefaultDateRange();
createGaugeCards();
initializeCharts();
loadData();
startAutoRefresh();