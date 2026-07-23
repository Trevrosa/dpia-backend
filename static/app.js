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
const ONE_MINUTE_MS = 60;
const POINTS_VISIBLE = 10;
const PIXELS_PER_X_TICK = 50;
const MIN_X_TICKS = 4;
const MAX_X_TICKS = 20;

// Register the zoom plugin (assumes ChartZoom is globally available)
if (typeof ChartZoom !== 'undefined') {
    Chart.register(ChartZoom);
}

const charts = new Map();
const currentDataTable = document.getElementById("currentDataTable");
const filterForm = document.getElementById("filterForm");
const refreshBtn = document.getElementById("refreshBtn");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

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

function getResponsiveMaxTicks(width) {
    return Math.max(
        MIN_X_TICKS,
        Math.min(MAX_X_TICKS, Math.floor(width / PIXELS_PER_X_TICK)),
    );
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

function formatValue(value, unit) {
    if (value === null || value === undefined) return "N/A";
    return `${value}${unit ? ` ${unit}` : ""}`;
}

function showTableMessage(message) {
    currentDataTable.innerHTML = "";
    const row = document
        .getElementById("messageRowTemplate")
        .content.cloneNode(true);
    row.querySelector(".message-cell").textContent = message;
    currentDataTable.appendChild(row);
}

function getChartOptions(showLegend, yRange, yUnit) {
    const defaultRange = getPastDayRangeMs();
    return {
        normalized: true,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        onResize(chart, size) {
            chart.options.scales.x.ticks.maxTicksLimit = getResponsiveMaxTicks(
                size.width,
            );
        },
        plugins: {
            legend: { display: showLegend },
            tooltip: {
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
            // Zoom & pan configuration – only on x‑axis
            zoom: {
                pan: {
                    enabled: true,
                    mode: 'x',
                    modifierKey: null,
                },
                zoom: {
                    wheel: {
                        enabled: true,
                        speed: 0.05,
                        modifierKey: null,
                    },
                    pinch: {
                        enabled: true,
                    },
                    mode: 'x',
                },
                limits: {
                    x: {
                        minRange: ONE_MINUTE_MS * 1000, // prevent zooming to less than 1 minute
                    }
                }
            }
        },
        scales: {
            x: {
                type: "linear",
                min: defaultRange.min,
                max: defaultRange.max,
                ticks: {
                    autoSkip: false,
                    maxRotation: 0,
                    minRotation: 0,
                    padding: 12,
                    stepSize: getResponsiveMaxTicks(window.innerWidth) / 60,
                    maxTicksLimit: getResponsiveMaxTicks(window.innerWidth),
                    callback(value) {
                        return formatTimeOnly(value);
                    },
                },
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

    charts.set(metric.key, chart);
    // No custom dragging – zoom plugin handles pan/zoom
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

    let options = getChartOptions(true);
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

    charts.set("air_quality", chart);
    // No custom dragging – zoom plugin handles pan/zoom
}

function initializeCharts() {
    INDIVIDUAL_CHART_METRICS.forEach((key) => {
        const metric = METRICS.find((item) => item.key === key);
        if (metric) createSingleMetricChart(metric);
    });
    createAirQualityChart();
}

function updateCharts(data) {
    const sorted = [...data].sort(
        (a, b) => (a.submitted_at ?? 0) - (b.submitted_at ?? 0),
    );

    INDIVIDUAL_CHART_METRICS.forEach((key) => {
        const metric = METRICS.find((item) => item.key === key);
        if (!metric) return;
        const chart = charts.get(metric.key);
        if (!chart) return;
        chart.data.datasets[0].data = sorted
            .filter(
                (item) =>
                    item[metric.key] !== null && item[metric.key] !== undefined,
            )
            .map((item) => {
                const x = normalizeTimestamp(item.submitted_at);
                return x ? { x, y: item[metric.key] } : null;
            })
            .filter(Boolean);
        chart.update();
    });

    const airQualityChart = charts.get("air_quality");
    if (airQualityChart) {
        AIR_QUALITY_METRICS.forEach((key, index) => {
            airQualityChart.data.datasets[index].data = sorted
                .filter((item) => item[key] !== null && item[key] !== undefined)
                .map((item) => {
                    const x = normalizeTimestamp(item.submitted_at);
                    return x ? { x, y: item[key] } : null;
                })
                .filter(Boolean);
        });
        airQualityChart.update();
    }
}

function applyXAxisRange(min, max) {
    charts.forEach((chart) => {
        chart.options.scales.x.min = min;
        chart.options.scales.x.max = max;
        chart.update("none");
    });
}

function getVisibleDataRange(data) {
    const timestamps = data
        .map((item) => normalizeTimestamp(item.submitted_at))
        .filter((ts) => Number.isFinite(ts))
        .sort((a, b) => a - b);

    if (!timestamps.length) return null;

    if (timestamps.length >= POINTS_VISIBLE) {
        const max = timestamps[timestamps.length - 1];
        const min = timestamps[timestamps.length - POINTS_VISIBLE];
        if (min === max) {
            return { min: max - ONE_MINUTE_MS * (POINTS_VISIBLE - 1), max };
        }
        return { min, max };
    }

    const min = timestamps[0];
    const max = timestamps[timestamps.length - 1];
    if (min === max) {
        return { min: max - ONE_MINUTE_MS * (POINTS_VISIBLE - 1), max };
    }
    return { min, max };
}

function applyXAxisRangeFromFilters(filters) {
    const startSeconds = filters.start ? Number(filters.start) : null;
    const endSeconds = filters.end ? Number(filters.end) : null;
    const defaultRange = getPastDayRangeMs();
    const min = Number.isFinite(startSeconds)
        ? startSeconds * 1000
        : defaultRange.min;
    const max = Number.isFinite(endSeconds)
        ? endSeconds * 1000
        : defaultRange.max;
    applyXAxisRange(min, max);
}

function updateCurrentTable(data) {
    if (!data.length) {
        showTableMessage("No sensor data available for this filter.");
        return;
    }

    const latest = [...data].sort(
        (a, b) => (b.submitted_at ?? 0) - (a.submitted_at ?? 0),
    )[0];
    currentDataTable.innerHTML = "";

    METRICS.forEach((metric) => {
        const row = document.createElement("tr");
        row.innerHTML = `
      <td>${metric.label}</td>
      <td>${formatValue(latest[metric.key], metric.unit)}</td>
      <td>${formatTimestamp(latest.submitted_at)}</td>
    `;
        currentDataTable.appendChild(row);
    });
}

async function loadData() {
    const filters = getFilters();
    const url = buildUrl(filters);

    showTableMessage("Loading data...");

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
        const dataRange = getVisibleDataRange(data);
        if (dataRange) {
            applyXAxisRange(dataRange.min, dataRange.max);
        } else {
            applyXAxisRangeFromFilters(filters);
        }
        updateCurrentTable(data);
    } catch (error) {
        showTableMessage(`Failed to load data: ${error.message}`);
        applyXAxisRangeFromFilters(filters);
        updateCharts([]);
    }
}

filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loadData();
});

clearFiltersBtn.addEventListener("click", () => {
    setDefaultDateRange();
    loadData();
});

refreshBtn.addEventListener("click", loadData);

setDefaultDateRange();
initializeCharts();
loadData();