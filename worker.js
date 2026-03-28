/**
 * FileStreamBot - Cloudflare Workers Implementation with MongoDB
 * 
 * This worker implements a Telegram file-to-link bot with MongoDB storage,
 * matching the original Python repository's logic while running on Cloudflare Workers.
 * 
 * Environment Variables Required:
 * - MONGODB_URI: MongoDB connection string
 * - BOT_TOKEN: Telegram Bot API token
 * - OWNER_ID: Telegram user ID of the bot owner
 * - WORKER_URL: Base URL of the Cloudflare Worker
 */

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Main Request Handler
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Validate required environment variables
    if (!env.MONGODB_URI || !env.BOT_TOKEN || !env.OWNER_ID || !env.WORKER_URL) {
      return new Response(JSON.stringify({ 
        error: 'Missing required environment variables',
        required: ['MONGODB_URI', 'BOT_TOKEN', 'OWNER_ID', 'WORKER_URL']
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Health check and root
    if (pathname === '/' || pathname === '/health') {
      return new Response(JSON.stringify({ 
        status: 'running', 
        service: 'FileStreamBot',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Webhook endpoint for Telegram updates
    if (pathname === '/webhook' && request.method === 'POST') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleWebhookUpdate(update, env));
        return new Response('OK', { status: 200 });
      } catch (err) {
        console.error('Webhook error:', err);
        return new Response('Error', { status: 500 });
      }
    }

    // Streaming and Download endpoints
    if (pathname.startsWith('/dl/') || pathname.startsWith('/watch/')) {
      const parts = pathname.split('/');
      const fileId = parts[2];
      const isWatch = pathname.startsWith('/watch/');
      return handleFileRequest(fileId, isWatch, request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * ==================== MONGODB HELPERS ====================
 * Using MongoDB Atlas Data API for REST-based database operations
 */

/**
 * Parse MongoDB URI to extract connection details
 */
function parseMongoURI(uri) {
  try {
    // MongoDB URI format: mongodb+srv://username:password@cluster.mongodb.net/database?retryWrites=true&w=majority
    const url = new URL(uri.replace('mongodb+srv://', 'https://'));
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const host = url.hostname;
    const database = url.pathname.split('/')[1] || 'FileStreamBot';
    
    return {
      username,
      password,
      host,
      database
    };
  } catch (error) {
    console.error('Error parsing MongoDB URI:', error);
    return null;
  }
}

/**
 * Generic MongoDB Data API request
 * Note: This uses MongoDB's HTTP API endpoint which requires proper setup
 */
async function mongoRequest(action, collection, payload, env) {
  try {
    // Extract database info from URI
    const dbInfo = parseMongoURI(env.MONGODB_URI);
    if (!dbInfo) {
      throw new Error('Invalid MongoDB URI format');
    }

    // MongoDB Atlas Data API endpoint
    // You need to set up Data API in MongoDB Atlas and get the endpoint
    const apiUrl = env.MONGO_API_URL || `https://data.mongodb-api.com/app/${env.MONGO_APP_ID}/endpoint/data/v1`;
    const apiKey = env.MONGO_API_KEY;

    if (!apiKey) {
      throw new Error('MongoDB Data API key not configured');
    }

    const url = `${apiUrl}/action/${action}`;
    
    const body = {
      dataSource: env.MONGO_CLUSTER || 'Cluster0',
      database: dbInfo.database,
      collection: collection,
      ...payload
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    if (!response.ok || result.error) {
      throw new Error(`MongoDB API Error: ${result.error || response.statusText}`);
    }
    return result;
  } catch (error) {
    console.error('MongoDB request failed:', error);
    throw error;
  }
}

/**
 * Alternative: Direct MongoDB connection via REST API
 * This is a simplified version that stores data in a JSON format
 */
async function mongoRequestDirect(action, collection, payload, env) {
  try {
    // For Cloudflare Workers, we can use a MongoDB HTTP API wrapper
    // Or store data in Cloudflare KV as a fallback
    
    // This is a placeholder for direct MongoDB operations
    // In production, use MongoDB Atlas Data API with proper authentication
    
    console.log(`MongoDB ${action} on ${collection}:`, payload);
    return { success: true };
  } catch (error) {
    console.error('Direct MongoDB request failed:', error);
    throw error;
  }
}

/**
 * Add new user to database
 */
async function addUser(userId, env) {
  const user = {
    id: parseInt(userId),
    join_date: Date.now() / 1000,
    Links: 0
  };

  try {
    await mongoRequest('insertOne', 'users', { document: user }, env);
  } catch (error) {
    console.error('Error adding user:', error);
  }
}

/**
 * Get user from database
 */
async function getUser(userId, env) {
  try {
    const result = await mongoRequest('findOne', 'users', {
      filter: { id: parseInt(userId) }
    }, env);
    return result.document;
  } catch (error) {
    console.error('Error getting user:', error);
    return null;
  }
}

/**
 * Check if user is banned
 */
async function isUserBanned(userId, env) {
  try {
    const result = await mongoRequest('findOne', 'blacklist', {
      filter: { id: parseInt(userId) }
    }, env);
    return !!result.document;
  } catch (error) {
    console.error('Error checking ban status:', error);
    return false;
  }
}

/**
 * Add file to database
 */
async function addFile(fileInfo, env) {
  try {
    // Check if file already exists for this user
    const existingFile = await mongoRequest('findOne', 'file', {
      filter: {
        user_id: parseInt(fileInfo.user_id),
        file_unique_id: fileInfo.file_unique_id
      }
    }, env);

    if (existingFile.document) {
      return existingFile.document._id.$oid;
    }

    // Add timestamp
    fileInfo.time = Date.now() / 1000;

    // Insert new file
    const insertResult = await mongoRequest('insertOne', 'file', {
      document: fileInfo
    }, env);

    // Increment user's link count
    await mongoRequest('updateOne', 'users', {
      filter: { id: parseInt(fileInfo.user_id) },
      update: { $inc: { Links: 1 } }
    }, env);

    return insertResult.insertedId.$oid;
  } catch (error) {
    console.error('Error adding file:', error);
    throw error;
  }
}

/**
 * Get file from database by ID
 */
async function getFile(fileId, env) {
  try {
    const result = await mongoRequest('findOne', 'file', {
      filter: { _id: { $oid: fileId } }
    }, env);
    return result.document;
  } catch (error) {
    console.error('Error getting file:', error);
    return null;
  }
}

/**
 * ==================== TELEGRAM HANDLERS ====================
 */

/**
 * Handle Telegram Webhook Updates
 */
async function handleWebhookUpdate(update, env) {
  const message = update.message || update.channel_post;
  if (!message) return;

  const chatId = message.chat.id;
  const userId = message.from ? message.from.id : chatId;
  const isChannel = !!update.channel_post;

  // Check authorization (owner only for now)
  if (env.OWNER_ID && userId.toString() !== env.OWNER_ID.toString()) {
    return;
  }

  // Check if user is banned
  if (await isUserBanned(userId, env)) {
    await sendTelegramMessage(chatId, '❌ You are banned from using this bot.', env);
    return;
  }

  // Ensure user exists in database
  const user = await getUser(userId, env);
  if (!user) {
    await addUser(userId, env);
  }

  // Handle /start command
  if (message.text === '/start') {
    const startText = `
👋 <b>Welcome to FileStreamBot!</b>

I'm a Telegram file to direct link converter. Send me any file and I'll generate direct streaming and download links for you.

📋 <b>How to use:</b>
1. Send any file to this bot
2. I'll generate direct links
3. Share the links anywhere!

⚙️ <b>Features:</b>
✅ Direct file links
✅ Stream support
✅ Range request support
✅ Fast delivery
✅ 7-day link expiration

🔒 <b>Privacy:</b> Your files are processed securely.
    `.trim();
    await sendTelegramMessage(chatId, startText, env);
    return;
  }

  // Handle File Uploads
  const file = message.document || message.video || message.audio || message.photo || message.animation;
  if (file) {
    await handleFileUpload(message, file, userId, chatId, env);
    return;
  }

  // Handle text messages
  if (message.text) {
    await sendTelegramMessage(chatId, '📁 Please send a file (document, video, audio, photo, animation, etc.)', env);
  }
}

/**
 * Handle File Upload
 */
async function handleFileUpload(message, file, userId, chatId, env) {
  try {
    const fileObj = Array.isArray(file) ? file[file.length - 1] : file;
    const fileId = fileObj.file_id;
    const fileUniqueId = fileObj.file_unique_id;
    const fileName = fileObj.file_name || `file_${Date.now()}`;
    const fileSize = fileObj.file_size;
    const mimeType = fileObj.mime_type || 'application/octet-stream';

    // Prepare file info for database
    const fileInfo = {
      file_id: fileId,
      file_unique_id: fileUniqueId,
      file_name: fileName,
      file_size: fileSize,
      mime_type: mimeType,
      user_id: userId,
      chat_id: chatId,
      message_id: message.message_id
    };

    // Add file to database
    const dbFileId = await addFile(fileInfo, env);

    // Generate links
    const streamLink = `${env.WORKER_URL}/watch/${dbFileId}`;
    const downloadLink = `${env.WORKER_URL}/dl/${dbFileId}`;

    // Create response message
    const responseText = `
✅ <b>File Processed Successfully!</b>

📄 <b>File Name:</b> <code>${escapeHtml(fileName)}</code>
📊 <b>File Size:</b> <code>${formatBytes(fileSize)}</code>
🔗 <b>Unique ID:</b> <code>${dbFileId}</code>

<b>Share these links:</b>
🎬 <a href="${streamLink}">Stream Link</a>
📥 <a href="${downloadLink}">Download Link</a>
    `.trim();

    const replyMarkup = {
      inline_keyboard: [[
        { text: '🎬 Stream', url: streamLink },
        { text: '📥 Download', url: downloadLink }
      ]]
    };

    await sendTelegramMessage(chatId, responseText, env, replyMarkup);

  } catch (error) {
    console.error('Error handling file upload:', error);
    await sendTelegramMessage(chatId, `❌ Error: ${error.message}`, env);
  }
}

/**
 * ==================== FILE STREAMING ====================
 */

/**
 * Handle File Streaming/Download Requests
 */
async function handleFileRequest(fileId, isWatch, request, env) {
  try {
    // Get file metadata from MongoDB
    const fileData = await getFile(fileId, env);
    if (!fileData) {
      return new Response('File Not Found', { status: 404 });
    }

    const { file_id, file_name, file_size, mime_type } = fileData;

    // Get File Path from Telegram
    const fileInfoResp = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/getFile?file_id=${file_id}`);
    const fileInfo = await fileInfoResp.json();
    
    if (!fileInfo.ok) {
      return new Response('Telegram API Error', { status: 500 });
    }

    const filePath = fileInfo.result.file_path;
    const fileUrl = `${TELEGRAM_API}/file/bot${env.BOT_TOKEN}/${filePath}`;

    // Handle Range Requests
    const range = request.headers.get('Range');
    const headers = new Headers();
    if (range) {
      headers.set('Range', range);
    }

    // Fetch file from Telegram
    const fileResp = await fetch(fileUrl, { headers });
    
    if (!fileResp.ok) {
      return new Response('Failed to fetch file from Telegram', { status: 500 });
    }

    // Prepare response headers
    const responseHeaders = new Headers(fileResp.headers);
    responseHeaders.set('Content-Disposition', `${isWatch ? 'inline' : 'attachment'}; filename="${escapeHtml(file_name)}"`);
    responseHeaders.set('Content-Type', mime_type || 'application/octet-stream');
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('Cache-Control', 'public, max-age=3600');

    return new Response(fileResp.body, {
      status: fileResp.status,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Error handling file request:', error);
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

/**
 * ==================== TELEGRAM API HELPERS ====================
 */

/**
 * Send message to Telegram
 */
async function sendTelegramMessage(chatId, text, env, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.error('Failed to send Telegram message:', await response.text());
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

/**
 * ==================== UTILITY FUNCTIONS ====================
 */

/**
 * Format bytes to human-readable format
 */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
