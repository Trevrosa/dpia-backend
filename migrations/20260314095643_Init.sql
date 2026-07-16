CREATE TABLE sensor_data (
    submitted_at INT PRIMARY KEY DEFAULT (unixepoch()),
    air_temp REAL,
    ground_temp REAL,
    humidity INTEGER,
    voc INTEGER,
    nox INTEGER,
    pm25 INTEGER,
    pm10 INTEGER
);