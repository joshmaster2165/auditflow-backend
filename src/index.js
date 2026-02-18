require('dotenv').config();

const express = require('express');
const cors = require('cors');
const analyzeRoutes = require('./routes/analyze');
const frameworkRoutes = require('./routes/framework');
const { testConnection } = require('./utils/supabase');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration - allow all origins for public API
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// JSON body parser with 50mb limit
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// Mount routes
app.use('/api/analyze', analyzeRoutes);
app.use('/api/framework', frameworkRoutes);

// Global error handler (includes multer errors)
app.use((err, req, res, next) => {
  // Ensure CORS headers are present on ALL error responses
  // (the cors middleware doesn't cover Express error handlers)
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }

  // Handle multer-specific errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 20MB.' });
  }
  if (err.name === 'MulterError') {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

  console.error('💥 Unhandled error:', err.message);
  console.error(err.stack);

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Start server
async function start() {
  console.log('\n🚀 AuditFlow Backend Starting...\n');

  // Start server FIRST so Railway can connect to the port immediately
  app.listen(PORT, () => {
    console.log(`\n✅ Server running on http://localhost:${PORT}`);
    console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📡 Analyze API: http://localhost:${PORT}/api/analyze`);
    console.log(`📡 Framework API: http://localhost:${PORT}/api/framework\n`);
  });

  // Test Supabase connection in background (non-blocking)
  testConnection().catch(err => {
    console.error('⚠️ Supabase connection test failed:', err.message);
  });
}

start().catch(err => {
  console.error('💥 Failed to start server:', err.message);
  process.exit(1);
});
