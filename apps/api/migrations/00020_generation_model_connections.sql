-- +goose Up
INSERT INTO generation_connection_limits(id,max_active) VALUES
 ('volcengine-ark',5),('gemini-images',1)
ON CONFLICT(id) DO NOTHING;
INSERT INTO generation_queue_limits(scope,key,max_active,max_queued) VALUES
 ('model','runninghub/h3',5,100),
 ('model','doubao-seedream-5-5-261028',5,100),
 ('model','doubao-seedream-5-0-pro-260628',5,100),
 ('model','gemini-3-pro-image-preview',1,100),
 ('connection','volcengine-ark',5,100),('connection','gemini-images',1,100)
ON CONFLICT(scope,key) DO NOTHING;
INSERT INTO generation_circuits(connection_id,operation) VALUES
 ('volcengine-ark','submit'),('volcengine-ark','query'),('volcengine-ark','save'),
 ('gemini-images','submit'),('gemini-images','query'),('gemini-images','save')
ON CONFLICT(connection_id,operation) DO NOTHING;
-- No destructive down migration for generation records.
