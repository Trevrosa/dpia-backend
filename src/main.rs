use std::{env, net::{Ipv4Addr, SocketAddrV4}, time::Duration};

use axum::{extract::Query, routing::post, Router};
use serde::Deserialize;
use tokio::{net::TcpListener, signal};
use tower_http::timeout::TimeoutLayer;
use tracing::{instrument, level_filters::LevelFilter};
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

    let app = Router::new()
        .route("/submit_data", post(submit_data))
        .layer(TimeoutLayer::new(Duration::from_secs(10)));

    let port = env::var("PORT")
        .map(|p| p.parse().expect("configured port is not an int"))
        .unwrap_or(6767);
    let addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port);

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;

    Ok(())
}

#[derive(Debug, Deserialize)]
struct SensorData {
    air_temp: i8,
    humidity: i8,
    ground_temp: i8
}

#[instrument(skip_all)]
async fn submit_data(Query(data): Query<SensorData>) {

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