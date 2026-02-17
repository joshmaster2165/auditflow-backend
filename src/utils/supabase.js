const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'evidence';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function testConnection() {
  try {
    console.log('🔌 Testing Supabase connection...');
    const { data, error } = await supabase
      .from('evidence')
      .select('id')
      .limit(1);

    if (error) {
      console.error('❌ Supabase connection test failed:', error.message);
      return false;
    }

    console.log('✅ Supabase connection successful');
    return true;
  } catch (err) {
    console.error('❌ Supabase connection error:', err.message);
    return false;
  }
}

async function downloadFile(filePath) {
  const uniqueId = crypto.randomUUID();
  const fileName = path.basename(filePath);
  const localPath = path.join('/tmp', `auditflow-${uniqueId}-${fileName}`);

  console.log(`📥 Downloading file: ${filePath}`);

  // Try direct download first
  try {
    const { data, error } = await supabase.storage
      .from(storageBucket)
      .download(filePath);

    if (!error && data) {
      const buffer = Buffer.from(await data.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      console.log(`✅ File downloaded directly: ${localPath}`);
      return localPath;
    }

    console.log('⚠️ Direct download failed, trying signed URL...');
  } catch (err) {
    console.log('⚠️ Direct download error, trying signed URL...', err.message);
  }

  // Fallback to signed URL
  try {
    const { data: signedData, error: signedError } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(filePath, 60);

    if (signedError) {
      throw new Error(`Failed to create signed URL: ${signedError.message}`);
    }

    const response = await axios.get(signedData.signedUrl, {
      responseType: 'arraybuffer',
    });

    fs.writeFileSync(localPath, Buffer.from(response.data));
    console.log(`✅ File downloaded via signed URL: ${localPath}`);
    return localPath;
  } catch (err) {
    throw new Error(`Failed to download file "${filePath}": ${err.message}`);
  }
}

function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🧹 Cleaned up temp file: ${filePath}`);
    }
  } catch (err) {
    console.warn(`⚠️ Failed to clean up temp file: ${filePath}`, err.message);
  }
}

module.exports = {
  supabase,
  testConnection,
  downloadFile,
  cleanupFile,
};
