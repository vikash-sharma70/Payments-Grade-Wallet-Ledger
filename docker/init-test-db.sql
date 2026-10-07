-- Separate database so the test-suite (which drops/recreates the schema) never touches dev data.
CREATE DATABASE wallet_test OWNER wallet;
