require('dotenv').config();

const express = require('express');
const cors = require('cors');
const analyzeRoutes = require('./routes/analyze');
const frameworkRoutes = require('./routes/framework');
const crosswalkRoutes = require('./routes/crosswalk');
const { testConnection } = require('./utils/supabase');

// ── Validate required environment variables ──
const REQUIRED_ENV = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ── Process-level error handlers ──
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS configuration — use ALLOWED_ORIGINS env var ──
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, health checks)
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
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
app.use('/api/crosswalk', crosswalkRoutes);

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

  // Handle CORS errors
  if (err.message && err.message.includes('not allowed by CORS')) {
    return res.status(403).json({ error: err.message });
  }

  console.error('💥 Unhandled error:', err.message);
  console.error(err.stack);

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Start server with graceful shutdown ──
async function start() {
  console.log('\n🚀 AuditFlow Backend Starting...\n');

  if (allowedOrigins.length > 0) {
    console.log(`🔒 CORS: Allowing origins: ${allowedOrigins.join(', ')}`);
  } else {
    console.log('⚠️ CORS: No ALLOWED_ORIGINS set — all origins permitted');
  }

  // Start server FIRST so Railway can connect to the port immediately
  const server = app.listen(PORT, () => {
    console.log(`\n✅ Server running on http://localhost:${PORT}`);
    console.log(`📋 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📡 Analyze API: http://localhost:${PORT}/api/analyze`);
    console.log(`📡 Framework API: http://localhost:${PORT}/api/framework`);
    console.log(`📡 Crosswalk API: http://localhost:${PORT}/api/crosswalk\n`);
  });

  // Graceful shutdown
  function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    // Force close after 10s if connections don't drain
    setTimeout(() => process.exit(1), 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Test Supabase connection in background (non-blocking)
  testConnection().catch(err => {
    console.error('⚠️ Supabase connection test failed:', err.message);
  });
}

start().catch(err => {
  console.error('💥 Failed to start server:', err.message);
  process.exit(1);
});
