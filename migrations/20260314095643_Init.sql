CREATE TABLE sensor_data (
    submitted_at INT PRIMARY KEY DEFAULT (unixepoch()),
    air_temp REAL NOT NULL,
    ground_temp REAL NOT NULL,
    humidity INTEGER NOT NULL,
    voc INTEGER NOT NULL,
    nox INTEGER NOT NULL,
    pm25 INTEGER NOT NULL,
    pm10 INTEGER NOT NULL
);