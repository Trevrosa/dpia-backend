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
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;
use tokio::{net::TcpListener, signal};
use tower_http::timeout::TimeoutLayer;
use tracing::{info, instrument, level_filters::LevelFilter, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if let Err(err) = dotenvy::dotenv() {
        println!("could not load .env: {err}");
    }

    let env_filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .from_env_lossy();
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let database_url = env::var("DATABASE_URL").unwrap_or_else(|_| "./db.sqlite".to_string());
    let pool = sqlx::SqlitePool::connect(&database_url).await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    let app = Router::new()
        .route("/data", post(submit_data))
        .route("/data", get(get_data))
        .route("/time", get(async || Utc::now().timestamp_millis().to_string()))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(10),
        ))
        .with_state(pool);

    let port = env::var("PORT")
        .map(|p| p.parse().expect("configured port is not an int"))
        .unwrap_or(6767);
    let addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port);

    info!("starting server on {addr}");

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;

    Ok(())
}

#[derive(Debug, Deserialize, Serialize, FromRow)]
struct SensorData {
    air_temp: f32,
    ground_temp: f32,
    humidity: i8,
    /// NOx index
    nox: u16,
    /// VOC index
    voc: u16,
    /// 10 micrometers
    pm10: u16,
    /// 2.5 micrometers
    pm25: u16,
    submitted_at: Option<u64>,
}

#[instrument(skip_all)]
async fn submit_data(Query(data): Query<SensorData>, pool: State<sqlx::SqlitePool>) {
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
            .execute(&pool.0)
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
    pool: State<sqlx::SqlitePool>,
) -> Result<Json<Vec<SensorData>>, String> {
    let data: Vec<SensorData> = if let Some(start) = query.start
        && let Some(end) = query.end
    {
        info!("querying data from {start} to {end}");
        sqlx::query_as("SELECT * FROM sensor_data WHERE submitted_at >= ? AND submitted_at <= ?")
            .bind(start as i64)
            .bind(end as i64)
            .fetch_all(&pool.0)
            .await
            .map_err(|err| err.to_string())?
    } else if let Some(start) = query.start {
        info!("querying data from {start} onwards");
        sqlx::query_as("SELECT * FROM sensor_data WHERE submitted_at >= ?")
            .bind(start as i64)
            .fetch_all(&pool.0)
            .await
            .map_err(|err| err.to_string())?
    } else if let Some(end) = query.end {
        info!("querying data up to {end}");
        sqlx::query_as("SELECT * FROM sensor_data WHERE submitted_at <= ?")
            .bind(end as i64)
            .fetch_all(&pool.0)
            .await
            .map_err(|err| err.to_string())?
    } else if query.latest.is_some_and(|l| l) {
        info!("querying most recent data");
        let data = sqlx::query_as("SELECT * FROM sensor_data ORDER BY rowid DESC LIMIT 1")
            .fetch_one(&pool.0)
            .await;
        vec![data.map_err(|err| err.to_string())?]
    } else {
        info!("querying all data");
        sqlx::query_as("SELECT * FROM sensor_data")
            .fetch_all(&pool.0)
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