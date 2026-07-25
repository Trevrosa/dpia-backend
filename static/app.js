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

// -------------------------------------------------------------
// 1. Register the zoom plugin globally
// -------------------------------------------------------------
if (typeof ChartZoom !== "undefined") {
    Chart.register(ChartZoom);
}

const charts = new Map();
const currentDataTable = document.getElementById("currentDataTable");
const filterForm = document.getElementById("filterForm");
const refreshBtn = document.getElementById("refreshBtn");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

// -------------------------------------------------------------
// 2. Helper functions (filters, timestamps, formatting)
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// 3. Chart options – now using a TIME scale and the exact
//    pan/zoom configuration from the fixed example.
// -------------------------------------------------------------
function getChartOptions(showLegend, yRange, yUnit) {
    const defaultRange = getPastDayRangeMs();
    return {
        normalized: true,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
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
            // Pan & zoom – exactly as in the fixed example
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
                        modifierKey: null,
                    },
                    pinch: {
                        enabled: true,
                    },
                    mode: "x",
                },
                // Limits are set dynamically after data loads (see below)
                limits: {
                    x: {
                        minRange: ZOOM_LIMIT_MS, // prevent zooming below this scale
                    },
                },
            },
        },
        scales: {
            x: {
                type: "time",
                // initial min/max set later
                time: {
                    // unit: "",
                    displayFormats: {
                        minute: "HH:mm",
                    },
                },
                grid: {
                    color: "rgba(0,0,0,0.05)",
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

// -------------------------------------------------------------
// 4. Chart creation functions (unchanged except options)
// -------------------------------------------------------------
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
    ctx.addEventListener("dblclick", () => {
        chart.resetZoom();
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

    charts.set("air_quality", chart);
}

function initializeCharts() {
    INDIVIDUAL_CHART_METRICS.forEach((key) => {
        const metric = METRICS.find((item) => item.key === key);
        if (metric) createSingleMetricChart(metric);
    });
    createAirQualityChart();
}

// -------------------------------------------------------------
// 5. Updating charts with data (unchanged)
// -------------------------------------------------------------
function breakGaps(points, maxGapMs) {
    if (points.length < 2) return points.slice();
    const result = [];
    for (let i = 0; i < points.length - 1; i++) {
        result.push(points[i]);
        const gap = points[i + 1].x - points[i].x;
        if (gap > maxGapMs) {
            // Insert a null point to break the line immediately after points[i]
            result.push({ x: points[i].x, y: null });
        }
    }
    result.push(points[points.length - 1]);
    return result;
}
function updateCharts(data) {
    const sorted = [...data].sort(
        (a, b) => (a.submitted_at ?? 0) - (b.submitted_at ?? 0),
    );

    // Update individual charts
    INDIVIDUAL_CHART_METRICS.forEach((key) => {
        const metric = METRICS.find((item) => item.key === key);
        if (!metric) return;
        const chart = charts.get(metric.key);
        if (!chart) return;

        // Build raw points (filter out null/undefined values)
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

        // Break gaps if they exceed the threshold
        points = breakGaps(points, MAX_GAP_MS);

        chart.data.datasets[0].data = points;
        chart.update();
        setTimeout(() => {
            chart.resetZoom();
        }, 200);
    });

    // Update air quality chart (multi-dataset)
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
        airQualityChart.resetZoom();
        setTimeout(() => {
            airQualityChart.resetZoom();
        }, 200);
    }
}

// -------------------------------------------------------------
// 6. Setting the visible x axis range and limits
//    (simplified: no custom "visible points" logic)
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// 7. Current data table (unchanged)
// -------------------------------------------------------------
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

// -------------------------------------------------------------
// 8. Main data loading – now sets range & limits from the data
// -------------------------------------------------------------
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

        // Update charts with the new data
        updateCharts(data);

        // Determine global min/max timestamps from the data
        const timestamps = data
            .map((item) => normalizeTimestamp(item.submitted_at))
            .filter((ts) => Number.isFinite(ts));

        let globalMin, globalMax;
        if (timestamps.length) {
            globalMin = Math.min(...timestamps);
            globalMax = Math.max(...timestamps);
        } else {
            // Fallback: use the filter range or last 24h
            const defaultRange = getPastDayRangeMs();
            globalMin = defaultRange.min;
            globalMax = defaultRange.max;
        }

        // Set the zoom limits to the full data range (prevents panning beyond data)
        setAllChartsXLimits(globalMin, globalMax);

        // Set the initial visible range:
        // - if filters provide start/end, use those; otherwise show the full data range
        const startSeconds = filters.start ? Number(filters.start) : null;
        const endSeconds = filters.end ? Number(filters.end) : null;
        let visibleMin = Number.isFinite(startSeconds)
            ? startSeconds * 1000
            : globalMin;
        let visibleMax = Number.isFinite(endSeconds)
            ? endSeconds * 1000
            : globalMax;

        // Ensure the visible range is within the limits
        visibleMin = Math.max(visibleMin, globalMin);
        visibleMax = Math.min(visibleMax, globalMax);

        setAllChartsXRange(visibleMin, visibleMax);

        updateCurrentTable(data);
    } catch (error) {
        showTableMessage(`Failed to load data: ${error.message}`);
        // Reset to default range on error
        const defaultRange = getPastDayRangeMs();
        setAllChartsXRange(defaultRange.min, defaultRange.max);
        setAllChartsXLimits(defaultRange.min, defaultRange.max);
        updateCharts([]);
    }
}

// -------------------------------------------------------------
// 9. Event listeners (unchanged)
// -------------------------------------------------------------
filterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    loadData();
});

clearFiltersBtn.addEventListener("click", () => {
    setDefaultDateRange();
    loadData();
});

refreshBtn.addEventListener("click", () => {
    const endSeconds = Math.floor(Date.now() / 1000);
    document.getElementById("endInput").value = toDateTimeLocalValue(
        endSeconds * 1000,
    );
    loadData();
});

// -------------------------------------------------------------
// 10. Initialise
// -------------------------------------------------------------
setDefaultDateRange();
initializeCharts();
loadData();
