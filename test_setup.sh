#!/bin/bash
# Automate setup wizard inputs for testing

# 1-4. Optional Deps (redis, mongodb, imagemagick, bun)
# Each will ask: "How would you like to handle missing X?" or similar.
# My code for optional deps:
# console.log(`⚠ ${dep} is missing (Optional)`);
# const choice = await qm.select(`${dep} is recommended but not found.`, [
#     `Install ${dep} now`,
#     `Skip (I don't need this feature)`,
#     `Use remote service (for Redis/Mongo)`
# ]);
# So I need to send "2" for each.

(
echo "2" # redis
echo "2" # mongodb
echo "2" # imagemagick
echo "2" # bun
echo "123456789:ABCDefghIJKLmnopQRSTuvwxYZabcde" # Token
echo "123456789" # Owner ID
echo "testuser" # Username
echo "123456789" # Admin IDs
echo "-100123456789" # Log ID
echo "2" # SQLite (1:Mongo, 2:SQLite, 3:Postgres, 4:MySQL)
echo "./database.sqlite" # SQLite path
echo "n" # Redis enable?
echo "1" # QR (1:QR, 2:Pairing Code)
echo "./sessions" # Sessions
echo "y" # Web Dashboard
echo "3001" # Port
echo "localhost" # Domain
echo "n" # HTTPS
echo "admin" # User
echo "password" # Pass
echo "n" # OpenAI
echo "n" # Gemini
echo "n" # Claude
echo "n" # Pinterest
echo "n" # Weather
echo "y" # Save
) | ./setup
