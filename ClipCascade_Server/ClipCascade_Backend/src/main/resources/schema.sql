-- query to create the table Users in H2 database
CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(255) PRIMARY KEY, -- Username is primary key(unique and not null)
    password VARCHAR(255) NOT NULL, -- Password cannot be null
    role VARCHAR(255) NOT NULL DEFAULT 'USER', -- Default value for role
    enabled BOOLEAN NOT NULL DEFAULT TRUE -- Default value for enabled
);
