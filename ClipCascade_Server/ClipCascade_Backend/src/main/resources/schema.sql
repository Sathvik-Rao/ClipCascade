-- query to create the table users if it doesn't exist (Java: Users.class)
CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(255) PRIMARY KEY, -- Username is primary key(unique and not null)
    password VARCHAR(255) NOT NULL, -- Password cannot be null
    role VARCHAR(255) NOT NULL DEFAULT 'USER', -- Default value for role
    enabled BOOLEAN NOT NULL DEFAULT TRUE -- Default value for enabled
);

-- query to create the table user_info if it doesn't exist (Java: UserInfo.class)
CREATE TABLE IF NOT EXISTS user_info (
    username VARCHAR(255) PRIMARY KEY, -- Username is primary key (unique and not null)
    marked_for_deletion BOOLEAN DEFAULT FALSE, -- Flag indicating if the user is marked for deletion
    first_signup BIGINT, -- Timestamp of the user's first signup
    last_login BIGINT, -- Timestamp of the user's last login
    first_signup_ip VARCHAR(255), -- IP address of the user at the time of first signup
    last_login_ip VARCHAR(255), -- IP address of the user at the time of last login
    failed_login_attempts INT DEFAULT 0, -- Number of failed login attempts
    lockout_time VARCHAR(255), -- Lockout time in string format
    password_changed_at BIGINT, -- Timestamp of when the password was last changed
    email VARCHAR(255), -- User's email address
    otp VARCHAR(255), -- One-time password for authentication
    phone VARCHAR(20), -- User's phone number
    first_name VARCHAR(255), -- User's first name
    last_name VARCHAR(255), -- User's last name
    notes TEXT -- Additional notes about the user
);
