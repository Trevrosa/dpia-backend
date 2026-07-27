import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  ChartConfiguration,
  ChartDataset,
  Plugin,
} from "chart.js";

import zoomPlugin from "chartjs-plugin-zoom";
import "chartjs-adapter-date-fns";

// Register plugins globally
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  zoomPlugin,
);

// ---------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------

interface SensorRecord {
  submitted_at: number;
  air_temp: number | null;
  ground_temp: number | null;
  humidity: number | null;
  nox: number | null;
  voc: number | null;
  pm10: number | null;
  pm25: number | null;
}

interface MetricConfig {
  key: keyof SensorRecord;
  label: string;
  unit: string;
  color: string;
}

interface GaugeRange {
  min: number;
  max: number;
  unit: string;
}

interface FilterParams {
  start?: string;
  end?: string;
}

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

const API_URL = "https://dpia.trevrosa.dev/data";

const METRICS: MetricConfig[] = [
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

const INDIVIDUAL_CHART_METRICS: (keyof SensorRecord)[] = [
  "air_temp",
  "ground_temp",
  "humidity",
];
const AIR_QUALITY_METRICS: (keyof SensorRecord)[] = [
  "nox",
  "voc",
  "pm10",
  "pm25",
];

const Y_AXIS_DEFAULTS: Record<string, { min: number; max: number }> = {
  air_temp: { min: 10, max: 40 },
  ground_temp: { min: 20, max: 60 },
  humidity: { min: 0, max: 100 },
};

const ONE_DAY_SECONDS = 24 * 60 * 60;
const ZOOM_LIMIT_MS = 5 * 60 * 1000;
const MAX_GAP_MS = 10 * 60 * 1000;

// Gauge ranges (same as chart Y axes)
const GAUGE_RANGES: Record<string, GaugeRange> = {
  air_temp: { min: 10, max: 40, unit: "°C" },
  ground_temp: { min: 20, max: 60, unit: "°C" },
  humidity: { min: 0, max: 100, unit: "%" },
  nox: { min: 0, max: 10, unit: "" },
  voc: { min: 0, max: 10, unit: "" },
  pm10: { min: 0, max: 500, unit: "ug/m3" },
  pm25: { min: 0, max: 500, unit: "ug/m3" },
};

// Map each metric to the chart canvas ID it should focus
const METRIC_TO_CHART_ID: Record<string, string> = {
  air_temp: "chart-air_temp",
  ground_temp: "chart-ground_temp",
  humidity: "chart-humidity",
  nox: "chart-air_quality",
  voc: "chart-air_quality",
  pm10: "chart-air_quality",
  pm25: "chart-air_quality",
};

// ---------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------

let defaultXMin: number | null = null;
let defaultXMax: number | null = null;
let crosshairTimestamp: number | null = null;
let autoRefreshInterval: number | null = null;
let lastUpdateTime: number | null = null;
let countdownInterval: number | null = null;
let nextRefreshTime: number | null = null;
let lastDataTimestamp: number | null = null;

const charts = new Map<string, Chart>();

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------

const filterForm = document.getElementById("filterForm") as HTMLFormElement;
const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;
const clearFiltersBtn = document.getElementById(
  "clearFiltersBtn",
) as HTMLButtonElement;

// ---------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------

const crosshairPlugin: Plugin = {
  id: "crosshair",
  afterDraw(chart) {
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

// ---------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------

function getFilters(): FilterParams {
  const startInput = (
    document.getElementById("startInput") as HTMLInputElement
  ).value.trim();
  const endInput = (
    document.getElementById("endInput") as HTMLInputElement
  ).value.trim();
  const start = toUnixSeconds(startInput);
  const end = toUnixSeconds(endInput);
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

function toUnixSeconds(dateTimeValue: string): string | null {
  if (!dateTimeValue) return null;
  const milliseconds = new Date(dateTimeValue).getTime();
  if (Number.isNaN(milliseconds)) return null;
  return String(Math.floor(milliseconds / 1000));
}

function toDateTimeLocalValue(milliseconds: number): string {
  const date = new Date(milliseconds);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function setDefaultDateRange(): void {
  const endSeconds = Math.floor(Date.now() / 1000);
  const startSeconds = endSeconds - ONE_DAY_SECONDS;
  (document.getElementById("startInput") as HTMLInputElement).value =
    toDateTimeLocalValue(startSeconds * 1000);
  (document.getElementById("endInput") as HTMLInputElement).value =
    toDateTimeLocalValue(endSeconds * 1000);
}

function buildUrl(filters: FilterParams): URL {
  const url = new URL(API_URL);
  Object.entries(filters).forEach(([k, v]) => url.searchParams.set(k, v));
  return url;
}

function normalizePayload(payload: unknown): SensorRecord[] {
  if (Array.isArray(payload)) return payload as SensorRecord[];
  if (payload && typeof payload === "object") {
    if (Array.isArray((payload as any).data))
      return (payload as any).data as SensorRecord[];
    if (Array.isArray((payload as any).records))
      return (payload as any).records as SensorRecord[];
    return [payload as SensorRecord];
  }
  return [];
}

function normalizeTimestamp(ts: unknown): number | null {
  if (typeof ts !== "number" || Number.isNaN(ts)) return null;
  return ts > 1_000_000_000_000 ? ts : ts * 1000;
}

function formatTimestamp(ts: number): string {
  const normalized = normalizeTimestamp(ts);
  if (!normalized) return "N/A";
  return new Date(normalized).toLocaleString();
}

// ---------------------------------------------------------------------
// Crosshair sync
// ---------------------------------------------------------------------

function getTimestampFromEvent(
  chart: Chart,
  event: MouseEvent,
): number | undefined | null {
  const rect = chart.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const xScale = chart.scales.x;
  if (!xScale) return null;
  const chartArea = chart.chartArea;
  if (x < chartArea.left || x > chartArea.right) return null;
  return xScale.getValueForPixel(x);
}

function syncCrosshair(event: MouseEvent, timestamp: number): void {
  crosshairTimestamp = timestamp;
  charts.forEach((chart) => {
    const elements = chart.getElementsAtEventForMode(
      event,
      "index",
      {
        intersect: false,
      },
      true,
    );
    if (elements && elements.length) {
      chart.setActiveElements(elements);
    } else {
      chart.setActiveElements([]);
    }
    chart.draw();
  });
}

function clearCrosshair(): void {
  crosshairTimestamp = null;
  charts.forEach((chart) => {
    chart.setActiveElements([]);
    chart.draw();
  });
}

// ---------------------------------------------------------------------
// Chart range and limits
// ---------------------------------------------------------------------

function setAllChartsXRange(min: number, max: number): void {
  charts.forEach((chart) => {
    chart.options.scales!.x!.min = min;
    chart.options.scales!.x!.max = max;
    chart.update("none");
  });
}

function setAllChartsXLimits(min: number, max: number): void {
  charts.forEach((chart) => {
    if (chart.options.plugins?.zoom?.limits?.x) {
      chart.options.plugins.zoom.limits.x.min = min;
      chart.options.plugins.zoom.limits.x.max = max;
    }
  });
}

function resetChartView(chart: Chart): void {
  if (defaultXMin === null || defaultXMax === null) return;
  chart.options.scales!.x!.min = defaultXMin;
  chart.options.scales!.x!.max = defaultXMax;
  chart.update();
}

// ---------------------------------------------------------------------
// Auto‑refresh status
// ---------------------------------------------------------------------

function updateStatus(): void {
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

function startCountdown(): void {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = window.setInterval(() => {
    const statusEl = document.getElementById("updateStatus");
    if (!statusEl) return;
    if (nextRefreshTime === null) return;
    const now = Date.now();
    const remaining = Math.max(0, Math.floor((nextRefreshTime - now) / 1000));
    if (remaining === 0) {
      statusEl.textContent = "Refreshing...";
    } else {
      statusEl.textContent = `Next refresh in ${remaining}s`;
    }
  }, 1000);
}

function startAutoRefresh(): void {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = window.setInterval(refresh, 30000);
}

function restartAutoRefresh(): void {
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

function createGaugeCards(): void {
  const grid = document.getElementById("gaugeGrid");
  if (!grid) return;
  grid.innerHTML = "";
  METRICS.forEach((metric) => {
    const card = document.createElement("div");
    card.className = "gauge-card";
    card.id = `gauge-${metric.key}`;
    card.dataset.metric = metric.key;
    card.innerHTML = `
      <h3>${metric.label}</h3>
      <canvas id="gaugeCanvas-${metric.key}" width="160" height="160"></canvas>
    `;
    card.addEventListener("click", () => {
      focusChart(metric.key);
    });
    grid.appendChild(card);
  });
}

function drawGauge(
  canvasId: string,
  value: number,
  min: number,
  max: number,
  unit: string,
): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
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

  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + 2 * Math.PI;
  const currentAngle = startAngle + 2 * Math.PI * percent;

  ctx.clearRect(0, 0, width, height);

  // Background arc
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, startAngle, endAngle);
  ctx.strokeStyle = "#e0e5ec";
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.stroke();

  // Foreground arc
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

  // Center label
  ctx.fillStyle = "#152238";
  ctx.font = "bold 28px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(clamped.toFixed(1), centerX, centerY - 4);

  ctx.fillStyle = "#5b6b83";
  ctx.font = "14px Inter, sans-serif";
  ctx.fillText(unit, centerX, centerY + 24);
}

function updateGauges(data: SensorRecord[]): void {
  if (!data || !data.length) {
    METRICS.forEach((metric) => {
      const canvas = document.getElementById(
        `gaugeCanvas-${metric.key}`,
      ) as HTMLCanvasElement;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
    lastDataTimestamp = null;
    return;
  }

  const latest = data.reduce((a, b) =>
    a.submitted_at > b.submitted_at ? a : b,
  );
  const newData =
    lastDataTimestamp === null || latest.submitted_at > lastDataTimestamp;
  if (newData) {
    lastDataTimestamp = latest.submitted_at;
  }

  METRICS.forEach((metric) => {
    const value = latest[metric.key];
    const range = GAUGE_RANGES[metric.key];
    if (!range) return;

    if (value === null || value === undefined) {
      const canvas = document.getElementById(
        `gaugeCanvas-${metric.key}`,
      ) as HTMLCanvasElement;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    if (newData) {
      const card = document.getElementById(`gauge-${metric.key}`);
      if (card) {
        card.classList.remove("gauge-flash");
        void card.offsetWidth; // force reflow
        card.classList.add("gauge-flash");
        setTimeout(() => {
          card.classList.remove("gauge-flash");
        }, 600);
      }
    }

    drawGauge(
      `gaugeCanvas-${metric.key}`,
      value,
      range.min,
      range.max,
      range.unit,
    );
  });
}

// ---------------------------------------------------------------------
// Focus chart on gauge click
// ---------------------------------------------------------------------

function focusChart(metricKey: string): void {
  const chartId = METRIC_TO_CHART_ID[metricKey];
  if (!chartId) return;
  const canvas = document.getElementById(chartId) as HTMLCanvasElement;
  if (!canvas) return;
  const card = canvas.closest(".chart-card") as HTMLElement;
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.remove("chart-highlight");
  void card.offsetWidth;
  card.classList.add("chart-highlight");
  setTimeout(() => {
    card.classList.remove("chart-highlight");
  }, 1000);
}

// ---------------------------------------------------------------------
// Refresh function
// ---------------------------------------------------------------------

function refresh(): void {
  const endSeconds = Math.floor(Date.now() / 1000);
  (document.getElementById("endInput") as HTMLInputElement).value =
    toDateTimeLocalValue(endSeconds * 1000);
  loadData();
}

// ---------------------------------------------------------------------
// Chart options
// ---------------------------------------------------------------------

function getChartOptions(
  showLegend: boolean,
  yRange?: { min: number; max: number },
  yUnit?: string,
): ChartConfiguration["options"] {
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
            return formatTimestamp(items[0].parsed.x!);
          },
          label(context) {
            const base = context.dataset.label || "";
            const value = context.parsed?.y;
            if (value === null || value === undefined) return base;
            return yUnit ? `${base}: ${value} ${yUnit}` : `${base}: ${value}`;
          },
        },
      },
      zoom: {
        pan: {
          enabled: true,
          mode: "x",
          modifierKey: undefined,
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

function createSingleMetricChart(metric: MetricConfig): void {
  const ctx = document.getElementById(
    `chart-${metric.key}`,
  ) as HTMLCanvasElement;
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
        } as ChartDataset,
      ],
    },
    options: getChartOptions(false, Y_AXIS_DEFAULTS[metric.key], metric.unit),
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

function createAirQualityChart(): void {
  const ctx = document.getElementById("chart-air_quality") as HTMLCanvasElement;
  if (!ctx) return;

  const datasets = AIR_QUALITY_METRICS.map((key) => {
    const metric = METRICS.find((item) => item.key === key)!;
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
    } as ChartDataset;
  });

  const options = getChartOptions(true, { min: 1, max: 500 });
  (options!.scales as any).y1 = {
    type: "linear",
    display: true,
    position: "right",
    grid: { drawOnChartArea: false },
  };
  const chart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options,
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

function initializeCharts(): void {
  INDIVIDUAL_CHART_METRICS.forEach((key) => {
    const metric = METRICS.find((item) => item.key === key);
    if (metric) createSingleMetricChart(metric);
  });
  createAirQualityChart();
}

// ---------------------------------------------------------------------
// Data gap‑breaking
// ---------------------------------------------------------------------

function breakGaps(
  points: Array<{ x: number; y: number | null }>,
  maxGapMs: number,
): Array<{ x: number; y: number | null }> {
  if (points.length < 2) return points.slice();
  const result: Array<{ x: number; y: number | null }> = [];
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

function updateCharts(data: SensorRecord[]): void {
  const sorted = [...data].sort(
    (a, b) => (a.submitted_at ?? 0) - (b.submitted_at ?? 0),
  );

  INDIVIDUAL_CHART_METRICS.forEach((key) => {
    const metric = METRICS.find((item) => item.key === key);
    if (!metric) return;
    const chart = charts.get(metric.key);
    if (!chart) return;

    let points: any[] = sorted
      .filter(
        (item) => item[metric.key] !== null && item[metric.key] !== undefined,
      )
      .map((item) => {
        const x = normalizeTimestamp(item.submitted_at);
        return x ? { x, y: item[metric.key] as number } : null;
      })
      .filter((p): p is { x: number; y: number } => p !== null);

    points = breakGaps(points, MAX_GAP_MS);
    chart.data.datasets[0].data = points;
    chart.update();
    setTimeout(() => chart.resetZoom(), 200);
  });

  const airQualityChart = charts.get("air_quality");
  if (airQualityChart) {
    AIR_QUALITY_METRICS.forEach((key, index) => {
      let points: any[] = sorted
        .filter((item) => item[key] !== null && item[key] !== undefined)
        .map((item) => {
          const x = normalizeTimestamp(item.submitted_at);
          return x ? { x, y: item[key] as number } : null;
        })
        .filter((p): p is { x: number; y: number } => p !== null);
      points = breakGaps(points, MAX_GAP_MS);
      airQualityChart.data.datasets[index].data = points;
    });
    airQualityChart.update();
    setTimeout(() => airQualityChart.resetZoom(), 200);
  }

  updateGauges(data);
}

// ---------------------------------------------------------------------
// Main data loading
// ---------------------------------------------------------------------

async function loadData(): Promise<void> {
  const filters = getFilters();
  const url = buildUrl(filters);

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }

    const payload = await response.json();
    const data = normalizePayload(payload).filter(
      (item): item is SensorRecord => item && typeof item === "object",
    );

    updateCharts(data);

    const timestamps = data
      .map((item) => normalizeTimestamp(item.submitted_at))
      .filter((ts): ts is number => Number.isFinite(ts));

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

    // Update auto‑refresh status
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
