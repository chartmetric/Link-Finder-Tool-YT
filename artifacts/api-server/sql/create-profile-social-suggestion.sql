CREATE DATABASE IF NOT EXISTS poc_new_vertical;

CREATE TABLE IF NOT EXISTS poc_new_vertical.profile_social_suggestion
(
    suggestion_id UUID DEFAULT generateUUIDv4(),
    profile_id UInt32,
    profile_name String,
    platform LowCardinality(String),
    handle String,
    account_url String,
    source_vendors Array(String),
    confidence Float32,
    estimated_cost_usd Float64,
    source_details String,
    approved_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (profile_id, platform, approved_at, suggestion_id);