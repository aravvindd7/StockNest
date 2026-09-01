const mongoose = require("mongoose");

/**
 * Connects to MongoDB using the connection string in MONGO_URI.
 * The process exits if the connection fails, since the API is
 * useless without a database.
 */
async function connectDB() {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error("MONGO_URI is not set in the environment (.env file).");
    }

    const conn = await mongoose.connect(uri);
    console.log(`[db] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (err) {
    console.error(`[db] Connection failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = connectDB;
