use std::{
    env,
    net::{Ipv4Addr, SocketAddrV4},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use axum_client_ip::{ClientIp, ClientIpSource};
use chrono::TimeZone;
use chrono_tz::OffsetComponents;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite, prelude::FromRow};
use tokio::{net::TcpListener, signal};
use tower_http::{services::ServeDir, timeout::TimeoutLayer};
use tracing::{info, instrument, level_filters::LevelFilter, warn};
use tracing_subscriber::{EnvFilter, Layer, layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    pool: Pool<Sqlite>,
    client: Client,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if let Err(err) = dotenvy::dotenv() {
        println!("could not load .env: {err}");
    }

    let env_filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .from_env_lossy();
    let fmt = if env::var("INVOCATION_ID").is_ok() {
        tracing_subscriber::fmt::layer().without_time().boxed()
    } else {
        tracing_subscriber::fmt::layer().boxed()
    };
    tracing_subscriber::Registry::default()
        .with(fmt)
        .with(env_filter)
        .init();

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| "./db.sqlite".to_string());
    let pool = sqlx::SqlitePool::connect(&database_url).await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    let state = AppState {
        pool,
        client: Client::new(),
    };

    let app = Router::new()
        .fallback_service(ServeDir::new("./static").precompressed_br())
        .route("/data", post(submit_data))
        .route("/data", get(get_data))
        .route("/time", get(time))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(10),
        ))
        .layer(ClientIpSource::RightmostXForwardedFor.into_extension())
        .with_state(state);

    let port = env::var("PORT").map_or(6767, |p| p.parse().expect("configured port is not an int"));
    let addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port);

    info!("starting server on {addr}");

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;

    Ok(())
}

// returns the millis since the unix epoch, offset from utc by the client's timezone
#[instrument(skip_all)]
async fn time(ClientIp(ip): ClientIp, State(state): State<AppState>) -> Result<String, String> {
    #[derive(Debug, Deserialize)]
    struct IpApiResponse {
        timezone: Option<String>,
        message: Option<String>,
    }

    let req = format!("http://ip-api.com/json/{ip}?fields=message,timezone");
    let resp: IpApiResponse = state
        .client
        .get(req)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let Some(tz) = resp.timezone else {
        return Err(resp.message.expect("should be set on failure"));
    };
    let tz: chrono_tz::Tz = tz
        .parse()
        .map_err(|e: chrono_tz::ParseError| e.to_string())?;
    info!("got timezone {tz}");

    let now = chrono::Utc::now();
    let offset = tz.offset_from_utc_datetime(&now.naive_utc());
    let offset = offset.base_utc_offset().num_milliseconds();

    Ok((now.timestamp_millis() + offset).to_string())
}

#[derive(Debug, Deserialize, Serialize, FromRow)]
struct SensorData {
    air_temp: Option<f32>,
    ground_temp: Option<f32>,
    humidity: Option<u8>,
    /// NOx index
    nox: Option<u16>,
    /// VOC index
    voc: Option<u16>,
    /// 10 micrometers
    pm10: Option<u16>,
    /// 2.5 micrometers
    pm25: Option<u16>,
    submitted_at: Option<u64>,
}

#[instrument(skip_all)]
async fn submit_data(Query(data): Query<SensorData>, State(state): State<AppState>) {
    info!("received data");

    let query =
        sqlx::query("INSERT INTO sensor_data (air_temp, ground_temp, humidity, voc, nox, pm10, pm25) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(data.air_temp)
            .bind(data.ground_temp)
            .bind(data.humidity)
            .bind(data.voc)
            .bind(data.nox)
            .bind(data.pm10)
            .bind(data.pm25)
            .execute(&state.pool)
            .await;

    if let Err(err) = query {
        warn!("failed to store data: {err}");
    } else {
        info!("data stored successfully");
    }
}

#[derive(Debug, Deserialize)]
struct DataQuery {
    start: Option<u64>,
    end: Option<u64>,
    latest: Option<bool>,
}

#[instrument(skip_all)]
async fn get_data(
    Query(query): Query<DataQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<SensorData>>, String> {
    let pool = &state.pool;
    let data: Vec<SensorData> = if let Some(start) = query.start
        && let Some(end) = query.end
    {
        info!("querying data from {start} to {end}");
        sqlx::query_as("SELECT * FROM sensor_data WHERE submitted_at >= ? AND submitted_at <= ?")
            .bind(start as i64)
            .bind(end as i64)
            .fetch_all(pool)
            .await
            .map_err(|err| err.to_string())?
    } else if let Some(start) = query.start {
        info!("querying data from {start} onwards");
        sqlx::query_as("SELECT * FROM sensor_data WHERE submitted_at >= ?")
            .bind(start as i64)
            .fetch_all(pool)
            .await
            .map_err(|err| err.to_string())?
    } else if let Some(end) = query.end {
        info!("querying data up to {end}");
        sqlx::query_as("SELECT * FROM sensor_data WHERE submitted_at <= ?")
            .bind(end as i64)
            .fetch_all(pool)
            .await
            .map_err(|err| err.to_string())?
    } else if query.latest.is_some_and(|l| l) {
        info!("querying most recent data");
        let data = sqlx::query_as("SELECT * FROM sensor_data ORDER BY rowid DESC LIMIT 1")
            .fetch_one(pool)
            .await;
        vec![data.map_err(|err| err.to_string())?]
    } else {
        info!("querying all data");
        sqlx::query_as("SELECT * FROM sensor_data")
            .fetch_all(pool)
            .await
            .map_err(|err| err.to_string())?
    };

    Ok(Json(data))
}

#[instrument(skip_all)]
async fn shutdown() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    tracing::info!("shutting down..");
}
