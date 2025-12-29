/**
 * WinCC OA Project Manager - Main Application JavaScript
 * Author: orelmi
 */

/* ==========================================================================
   Debug Configuration
   ========================================================================== */

/**
 * Debug flags - set to true to enable console logging for specific features
 * Can be toggled at runtime via browser console: DEBUG_WEBSOCKET = true;
 */
let DEBUG_WEBSOCKET = false;
let DEBUG_LOGVIEWER = false;

/**
 * Conditional WebSocket debug logging
 * @param  {...any} args - Arguments to log
 */
function wsLog(...args) {
    if (DEBUG_WEBSOCKET) {
        console.log('[WS]', ...args);
    }
}

/**
 * Conditional WebSocket error logging (always shown)
 * @param  {...any} args - Arguments to log
 */
function wsError(...args) {
    console.error('[WS]', ...args);
}

/**
 * Conditional Log Viewer debug logging
 * @param  {...any} args - Arguments to log
 */
function logViewerLog(...args) {
    if (DEBUG_LOGVIEWER) {
        console.log('[Log]', ...args);
    }
}

/* ==========================================================================
   Global State
   ========================================================================== */

let pendingEvent = null;
let _serverAvailable = false;

// Last refresh time for display
let _lastRefreshTime = null;

// CSRF token state
let _csrfToken = null;
let _csrfTokenExpiry = null;

// WebSocket state
let _websocket = null;
let _wsReconnectAttempts = 0;
let _wsMaxReconnectAttempts = 5;
let _wsReconnectDelay = 2000;
let _wsHeartbeatInterval = null;

// Upload state
let _uploadInProgress = false;
let _uploadAbortController = null;

// Chunked upload configuration
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
const MAX_CONCURRENT_CHUNKS = 3;

/**
 * Request notification permission
 */
async function requestNotificationPermission() {
    if ('Notification' in window) {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            showToast('success', 'Notifications Enabled', 'You will receive deployment notifications');
        }
        return permission === 'granted';
    }
    return false;
}

/* ==========================================================================
   Compression Utilities
   ========================================================================== */

/**
 * Decompress gzip/deflate-compressed base64 data
 * @param {string} base64Data - Base64-encoded compressed data
 * @param {string} format - Compression format: 'gzip', 'deflate', or 'deflate-raw'
 * @returns {Promise<Object>} - Decompressed and parsed JSON object
 */
async function decompressGzipData(base64Data, format = 'gzip') {
    if (!base64Data || base64Data.length === 0) {
        throw new Error('Empty base64 data received');
    }

    // Decode base64 to binary
    let binaryString;
    try {
        binaryString = atob(base64Data);
    } catch (e) {
        wsError('Base64 decode failed:', e.message);
        throw e;
    }

    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Log first bytes to identify format
    // gzip: 1f 8b, zlib: 78 9c/78 da/78 01, raw deflate: varies
    const header = Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    wsLog('Compressed data header (hex):', header, '- size:', bytes.length);

    // Detect format from header bytes
    let detectedFormat = format;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        detectedFormat = 'gzip';
    } else if (bytes[0] === 0x78) {
        // zlib header (78 01, 78 9c, 78 da)
        detectedFormat = 'deflate';
    } else {
        // No recognized header - likely raw deflate
        detectedFormat = 'deflate-raw';
    }

    // Try detected format first, then fallbacks
    const formats = [detectedFormat];
    if (detectedFormat !== 'gzip') formats.push('gzip');
    if (detectedFormat !== 'deflate') formats.push('deflate');
    if (detectedFormat !== 'deflate-raw') formats.push('deflate-raw');

    let lastError = null;

    for (const fmt of formats) {
        try {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                }
            });

            const decompressedStream = stream.pipeThrough(new DecompressionStream(fmt));
            const reader = decompressedStream.getReader();
            const chunks = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }

            // Combine chunks
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

            if (totalLength === 0) {
                throw new Error('Decompressed to empty data');
            }

            const combined = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }

            // Debug: show raw decompressed bytes
            wsLog('Decompressed', totalLength, 'bytes. First 100 bytes (hex):',
                Array.from(combined.slice(0, 100)).map(b => b.toString(16).padStart(2, '0')).join(' '));

            // Try different encodings - WinCC OA may use UTF-16LE internally
            const encodings = ['utf-8', 'utf-16le', 'utf-16be', 'iso-8859-1'];

            for (const encoding of encodings) {
                try {
                    const decoder = new TextDecoder(encoding);
                    const jsonString = decoder.decode(combined);

                    // Debug: show what each encoding produces
                    wsLog('Trying', encoding, '- first 100 chars:', jsonString.substring(0, 100));

                    if (jsonString && jsonString.length > 0) {
                        // Check if it looks like valid JSON
                        const trimmed = jsonString.trim();
                        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                            wsLog('Decompression OK with', fmt, 'encoding:', encoding, '- size:', totalLength);
                            return JSON.parse(jsonString);
                        }
                    }
                } catch (decodeErr) {
                    wsLog('Encoding', encoding, 'failed:', decodeErr.message);
                }
            }

            // If no encoding worked, log the raw bytes for debugging
            wsError('Could not decode with any encoding. First 100 bytes:',
                Array.from(combined.slice(0, 100)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            throw new Error('Failed to decode decompressed data');
        } catch (e) {
            lastError = e;
            // Only log on final failure to reduce noise
        }
    }

    wsError('All decompression formats failed. Header:', header);
    throw lastError || new Error('All decompression formats failed');
}

/**
 * Check if a message is compressed and decompress if needed
 * @param {Object} data - Parsed JSON message from WebSocket
 * @returns {Promise<Object>} - Decompressed data or original data
 */
async function handleCompressedMessage(data) {
    if (data.compressed && data.encoding === 'gzip' && data.data) {
        wsLog('Decompressing message:', data.compressedSize, '->', data.originalSize, 'bytes');
        return await decompressGzipData(data.data);
    }
    return data;
}

/* ==========================================================================
   WebSocket Connection
   ========================================================================== */

/**
 * Initialize WebSocket connection for real-time updates
 */
function initWebSocket() {
    // Check if already connected or connecting
    if (_websocket && (_websocket.readyState === WebSocket.OPEN || _websocket.readyState === WebSocket.CONNECTING)) {
        wsLog('Already connected or connecting');
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/project/ws`;

    wsLog('Connecting to:', wsUrl);
    updateWebSocketStatus('connecting');

    try {
        _websocket = new WebSocket(wsUrl);

        _websocket.onopen = handleWebSocketOpen;
        _websocket.onmessage = handleWebSocketMessage;
        _websocket.onerror = handleWebSocketError;
        _websocket.onclose = handleWebSocketClose;
    } catch (error) {
        wsError('Connection error:', error);
        scheduleWebSocketReconnect();
    }
}

/**
 * Handle WebSocket open event
 */
function handleWebSocketOpen() {
    wsLog('Connected');
    _wsReconnectAttempts = 0;

    // Update UI to show connected status
    updateWebSocketStatus('connected');

    // Start heartbeat
    startWebSocketHeartbeat();

    // Subscribe to updates
    sendWebSocketMessage({
        type: 'subscribe',
        channels: ['pmon', 'deployment', 'logs']
    });

    // Re-subscribe to log file if one was selected
    if (_logCurrentFile && _logUseWebSocket) {
        sendWebSocketMessage({
            type: 'subscribeLog',
            file: _logCurrentFile,
            startPos: _logLastPos
        });
        // Stop polling since we're using WebSocket now
        stopLogRefresh();
        logViewerLog('Re-subscribed to log file via WebSocket:', _logCurrentFile);
    }

    // Refresh log file list
    refreshLogFiles();

    showToast('success', 'Real-time Connected', 'Live updates enabled');
}

/**
 * Handle incoming WebSocket messages
 * Supports both compressed and uncompressed messages
 */
async function handleWebSocketMessage(event) {
    try {
        // First parse the wrapper JSON
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (parseError) {
            wsError('JSON parse error:', parseError.message);
            wsError('Raw data preview:', event.data.substring(0, 200));
            return;
        }

        // Check if message is compressed and decompress if needed
        if (data.compressed) {
            try {
                data = await handleCompressedMessage(data);
            } catch (decompressError) {
                wsError('Decompression error:', decompressError.message);
                return;
            }
        }

        // Skip logging for frequent message types
        if (data.type !== 'heartbeat') {
            wsLog('Message received:', data.type);
        }

        switch (data.type) {
            case 'pmon':
                handlePmonUpdate(data);
                break;

            case 'deployment':
                handleDeploymentUpdate(data);
                break;

            case 'log':
                handleLogUpdate(data);
                break;

            case 'logContent':
                handleLogContent(data);
                break;

            case 'logFiles':
                handleLogFilesList(data);
                break;

            case 'heartbeat':
                // Heartbeat acknowledged
                break;

            case 'notification':
                showToast(data.level || 'info', data.title, data.message);
                break;

            case 'error':
                wsError('Server error:', data.message);
                showToast('error', 'Server Error', data.message || 'Unknown error');
                hideLogLoading();
                break;

            default:
                wsLog('Unknown message type:', data.type);
        }
    } catch (error) {
        wsError('Unexpected error:', error);
    }
}

/**
 * Handle WebSocket error
 */
function handleWebSocketError(event) {
    wsError('Error:', event);
    updateWebSocketStatus('disconnected');
}

/**
 * Handle WebSocket close
 */
function handleWebSocketClose(event) {
    wsLog('Closed:', event.code, event.reason);
    updateWebSocketStatus('disconnected');
    stopWebSocketHeartbeat();

    // If a log file was being viewed, fall back to HTTP polling
    if (_logCurrentFile && _logUseWebSocket) {
        logViewerLog('WebSocket closed, falling back to HTTP polling');
        loadLogLines();
        startLogRefresh();
    }

    // Attempt reconnection if not intentionally closed
    if (event.code !== 1000) {
        scheduleWebSocketReconnect();
    }
}

/**
 * Schedule WebSocket reconnection with exponential backoff
 */
function scheduleWebSocketReconnect() {
    if (_wsReconnectAttempts >= _wsMaxReconnectAttempts) {
        wsLog('Max reconnection attempts reached');
        showToast('warning', 'Connection Lost', 'Real-time updates unavailable. Refresh page to retry.');
        return;
    }

    const delay = _wsReconnectDelay * Math.pow(2, _wsReconnectAttempts);
    _wsReconnectAttempts++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${_wsReconnectAttempts})`);

    setTimeout(() => {
        if (!_websocket || _websocket.readyState === WebSocket.CLOSED) {
            initWebSocket();
        }
    }, delay);
}

/**
 * Send message through WebSocket
 */
function sendWebSocketMessage(data) {
    if (_websocket && _websocket.readyState === WebSocket.OPEN) {
        _websocket.send(JSON.stringify(data));
        return true;
    }
    return false;
}

/**
 * Start WebSocket heartbeat
 */
function startWebSocketHeartbeat() {
    stopWebSocketHeartbeat();
    _wsHeartbeatInterval = setInterval(() => {
        sendWebSocketMessage({ type: 'heartbeat' });
    }, 30000);
}

/**
 * Stop WebSocket heartbeat
 */
function stopWebSocketHeartbeat() {
    if (_wsHeartbeatInterval) {
        clearInterval(_wsHeartbeatInterval);
        _wsHeartbeatInterval = null;
    }
}

/**
 * Update WebSocket status indicator
 * @param {string} status - 'connected', 'connecting', or 'disconnected'
 */
function updateWebSocketStatus(status) {
    const container = document.getElementById('wsStatus');
    const indicator = container?.querySelector('.ws-indicator');
    const label = container?.querySelector('.ws-label');

    if (indicator) {
        indicator.classList.remove('connected', 'connecting', 'disconnected');
        indicator.classList.add(status);
    }

    if (label) {
        const labels = {
            connected: 'Online',
            connecting: 'Connecting...',
            disconnected: 'Offline'
        };
        label.textContent = labels[status] || 'Offline';
    }

    if (container) {
        const titles = {
            connected: 'WebSocket connected - Real-time updates active',
            connecting: 'Connecting to WebSocket...',
            disconnected: 'WebSocket disconnected - Using polling'
        };
        container.title = titles[status] || 'WebSocket disconnected';
    }
}

/**
 * Handle pmon update from WebSocket
 */
function handlePmonUpdate(data) {
    if (data && data.instances) {
        clearInstanceTabs();
        updateLastRefreshTime();

        const instances = data.instances;
        const tabsContainer = document.getElementById('instanceTabsContainer');
        const contentContainer = document.getElementById('instanceContentContainer');

        // Add RESTART ALL button if multiple instances
        if (instances.length > 1) {
            const restartAllBtn = document.createElement('button');
            restartAllBtn.className = 'btn-restart-all';
            restartAllBtn.innerHTML = '&#8635; Restart All Instances';
            restartAllBtn.title = 'Restart all project instances';
            restartAllBtn.onclick = () => confirmRestartAllInstances(instances);
            tabsContainer.appendChild(restartAllBtn);
        }

        instances.forEach((instance, index) => {
            const tabButton = document.createElement('button');
            tabButton.textContent = instance.hostname || 'Instance ' + (index + 1);
            tabButton.className = 'instance-tab-button';
            if (index === 0) tabButton.classList.add('active');
            tabButton.onclick = () => showInstanceContent(index, instances.length);
            tabsContainer.appendChild(tabButton);

            const contentDiv = document.createElement('div');
            contentDiv.id = 'instanceContent' + index;
            contentDiv.style.display = index === 0 ? 'block' : 'none';

            // Add instance header with restart button
            const instanceHeader = document.createElement('div');
            instanceHeader.className = 'instance-header';

            const instanceTitle = document.createElement('span');
            instanceTitle.className = 'instance-title';
            instanceTitle.textContent = instance.projectName || instance.hostname || 'Instance ' + (index + 1);

            const restartInstanceBtn = document.createElement('button');
            restartInstanceBtn.className = 'btn-restart-instance';
            restartInstanceBtn.innerHTML = '&#8635; Restart Instance';
            restartInstanceBtn.title = 'Restart all managers on this instance';
            restartInstanceBtn.onclick = () => confirmRestartInstance(instance.hostname);

            instanceHeader.appendChild(instanceTitle);
            instanceHeader.appendChild(restartInstanceBtn);
            contentDiv.appendChild(instanceHeader);

            const table = createManagerTable(instance);
            contentDiv.appendChild(table);
            contentContainer.appendChild(contentDiv);
        });
    }
}

/**
 * Handle deployment update from WebSocket
 */
function handleDeploymentUpdate(data) {
    const details = data.details || {};
    if (data.status === 'started') {
        showToast('info', 'Deployment Started', `Deploying ${details.fileName || 'file'}...`);
    } else if (data.status === 'completed') {
        showToast('success', 'Deployment Complete', `${details.fileName || 'File'} deployed successfully`);
        refreshHistory();
    } else if (data.status === 'failed') {
        showToast('error', 'Deployment Failed', details.message || 'Unknown error');
        refreshHistory();
    } else if (data.status === 'progress') {
        // Update progress bar if visible
        updateUploadProgress(details.progress, details.message);
    }
}

/**
 * Handle log update from WebSocket
 */
function handleLogUpdate(data) {
    // Only process if this is for the current file
    if (data.file && data.file !== _logCurrentFile) {
        return;
    }

    if (data.lines && data.lines.length > 0) {
        renderLogLines(data.lines);
    }

    // Update last position for tracking
    if (data.lastPos) {
        _logLastPos = data.lastPos;
    }
}

/**
 * Handle initial log content from WebSocket
 */
function handleLogContent(data) {
    // Only process if this is for the current file
    if (data.file && data.file !== _logCurrentFile) {
        return;
    }

    // Hide loading indicator
    hideLogLoading();

    // Clear existing content and render new lines
    const container = document.getElementById('logContainer');
    container.innerHTML = '';
    _logLineCount = 0;

    if (data.lines && data.lines.length > 0) {
        renderLogLines(data.lines);
    }

    // Update last position for tracking
    if (data.lastPos) {
        _logLastPos = data.lastPos;
    }

    // Update connection status
    updateLogConnectionStatus('streaming');
}

/**
 * Handle log files list from WebSocket
 */
function handleLogFilesList(data) {
    const select = document.getElementById('logFileSelect');
    const currentValue = select.value;

    // Clear existing options except the first one
    while (select.options.length > 1) {
        select.remove(1);
    }

    // Add new options
    const files = data.files || [];
    files.forEach(file => {
        const option = document.createElement('option');
        option.value = file.name;
        option.textContent = `${file.name} (${file.size} KB)`;
        select.appendChild(option);
    });

    // Restore selection if still available
    if (currentValue) {
        select.value = currentValue;
    }
}

/* ==========================================================================
   Chunked Upload with Progress
   ========================================================================== */

/**
 * Upload file in chunks with progress tracking
 * @param {File} file - The file to upload
 * @param {boolean} restart - Whether to restart after upload
 * @returns {Promise<boolean>} Success status
 */
async function uploadFileChunked(file, restart = false) {
    if (_uploadInProgress) {
        showToast('warning', 'Upload in Progress', 'Please wait for current upload to complete');
        return false;
    }

    _uploadInProgress = true;
    _uploadAbortController = new AbortController();

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = generateUploadId();

    console.log(`[Upload] Starting chunked upload: ${file.name}, ${totalChunks} chunks`);

    // Show progress UI
    showUploadProgress(file.name, file.size);

    try {
        // Get CSRF token
        const csrfToken = await getCsrfToken();
        if (!csrfToken) {
            throw new Error('Could not obtain CSRF token');
        }

        // Initialize upload session
        const initResponse = await fetch('/project/upload/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadId: uploadId,
                fileName: file.name,
                fileSize: file.size,
                totalChunks: totalChunks,
                restartProject: restart,
                csrfToken: csrfToken
            }),
            signal: _uploadAbortController.signal
        });

        if (!initResponse.ok) {
            throw new Error('Failed to initialize upload');
        }

        // Upload chunks
        let uploadedChunks = 0;
        const failedChunks = [];

        // Upload in batches for parallel processing
        for (let i = 0; i < totalChunks; i += MAX_CONCURRENT_CHUNKS) {
            const batch = [];

            for (let j = i; j < Math.min(i + MAX_CONCURRENT_CHUNKS, totalChunks); j++) {
                batch.push(uploadChunk(file, uploadId, j, totalChunks, csrfToken));
            }

            const results = await Promise.allSettled(batch);

            for (let k = 0; k < results.length; k++) {
                const chunkIndex = i + k;
                if (results[k].status === 'fulfilled' && results[k].value) {
                    uploadedChunks++;
                    const progress = Math.round((uploadedChunks / totalChunks) * 100);
                    updateUploadProgress(progress, `Uploading... ${uploadedChunks}/${totalChunks} chunks`);
                } else {
                    failedChunks.push(chunkIndex);
                    console.error(`[Upload] Chunk ${chunkIndex} failed`);
                }
            }

            // Check for abort
            if (_uploadAbortController.signal.aborted) {
                throw new Error('Upload cancelled');
            }
        }

        // Retry failed chunks
        if (failedChunks.length > 0) {
            console.log(`[Upload] Retrying ${failedChunks.length} failed chunks`);
            for (const chunkIndex of failedChunks) {
                const success = await uploadChunk(file, uploadId, chunkIndex, totalChunks, csrfToken, 3);
                if (success) {
                    uploadedChunks++;
                    const progress = Math.round((uploadedChunks / totalChunks) * 100);
                    updateUploadProgress(progress, `Retrying... ${uploadedChunks}/${totalChunks} chunks`);
                } else {
                    throw new Error(`Failed to upload chunk ${chunkIndex} after retries`);
                }
            }
        }

        // Finalize upload
        updateUploadProgress(100, 'Finalizing...');

        const finalizeResponse = await fetch('/project/upload/finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadId: uploadId,
                csrfToken: csrfToken
            }),
            signal: _uploadAbortController.signal
        });

        if (!finalizeResponse.ok) {
            throw new Error('Failed to finalize upload');
        }

        // Success
        updateUploadProgress(100, 'Complete!');
        showToast('success', 'Upload Complete', `${file.name} uploaded successfully`);

        // Refresh CSRF token
        await refreshCsrfToken();

        // Hide progress after delay
        setTimeout(() => {
            hideUploadProgress();
            refreshHistory();
        }, 2000);

        return true;

    } catch (error) {
        console.error('[Upload] Error:', error);

        if (error.name === 'AbortError' || error.message === 'Upload cancelled') {
            showToast('warning', 'Upload Cancelled', 'File upload was cancelled');
        } else {
            showToast('error', 'Upload Failed', error.message);
        }

        hideUploadProgress();
        return false;

    } finally {
        _uploadInProgress = false;
        _uploadAbortController = null;
    }
}

/**
 * Upload a single chunk
 * @param {File} file - The file
 * @param {string} uploadId - Upload session ID
 * @param {number} chunkIndex - Chunk index
 * @param {number} totalChunks - Total number of chunks
 * @param {string} csrfToken - CSRF token
 * @param {number} retries - Number of retries
 * @returns {Promise<boolean>} Success status
 */
async function uploadChunk(file, uploadId, chunkIndex, totalChunks, csrfToken, retries = 0) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    const formData = new FormData();
    formData.append('uploadId', uploadId);
    formData.append('chunkIndex', chunkIndex);
    formData.append('totalChunks', totalChunks);
    formData.append('chunk', chunk);
    formData.append('csrfToken', csrfToken);

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch('/project/upload/chunk', {
                method: 'POST',
                body: formData,
                signal: _uploadAbortController?.signal
            });

            if (response.ok) {
                return true;
            }

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                throw error;
            }
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }

    return false;
}

/**
 * Generate unique upload ID
 */
function generateUploadId() {
    return 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Cancel current upload
 */
function cancelUpload() {
    if (_uploadAbortController) {
        _uploadAbortController.abort();
        showToast('info', 'Cancelling', 'Upload is being cancelled...');
    }
}

/**
 * Show upload progress UI
 */
function showUploadProgress(fileName, fileSize) {
    const container = document.getElementById('uploadProgressContainer');
    if (container) {
        container.style.display = 'block';
        document.getElementById('uploadFileName').textContent = fileName;
        document.getElementById('uploadFileSize').textContent = formatFileSize(fileSize);
        document.getElementById('uploadProgressBar').style.width = '0%';
        document.getElementById('uploadProgressText').textContent = 'Starting...';
        document.getElementById('uploadProgressPercent').textContent = '0%';
    }
}

/**
 * Update upload progress UI
 */
function updateUploadProgress(percent, message) {
    const progressBar = document.getElementById('uploadProgressBar');
    const progressText = document.getElementById('uploadProgressText');
    const progressPercent = document.getElementById('uploadProgressPercent');

    if (progressBar) {
        progressBar.style.width = percent + '%';
    }
    if (progressText) {
        progressText.textContent = message || '';
    }
    if (progressPercent) {
        progressPercent.textContent = percent + '%';
    }
}

/**
 * Hide upload progress UI
 */
function hideUploadProgress() {
    const container = document.getElementById('uploadProgressContainer');
    if (container) {
        container.style.display = 'none';
    }
}

/* ==========================================================================
   Simple Upload Fallback (for servers without chunked upload support)
   ========================================================================== */

/**
 * Upload file with XMLHttpRequest for progress tracking
 * @param {File} file - The file to upload
 * @param {boolean} restart - Whether to restart after upload
 */
async function uploadFileWithProgress(file, restart = false) {
    if (_uploadInProgress) {
        showToast('warning', 'Upload in Progress', 'Please wait for current upload to complete');
        return false;
    }

    _uploadInProgress = true;

    // Get CSRF token
    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
        showToast('error', 'Security Error', 'Could not obtain CSRF token');
        _uploadInProgress = false;
        return false;
    }

    // Show progress
    showUploadProgress(file.name, file.size);

    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();

        formData.append('dateiupload', file);
        formData.append('restartProject', restart);
        formData.append('csrfToken', csrfToken);

        // Track upload progress
        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                const percent = Math.round((event.loaded / event.total) * 100);
                updateUploadProgress(percent, `Uploading... ${formatFileSize(event.loaded)} / ${formatFileSize(event.total)}`);
            }
        });

        // Handle completion
        xhr.addEventListener('load', async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                updateUploadProgress(100, 'Complete!');
                showToast('success', 'Upload Complete', `${file.name} uploaded successfully`);
                await refreshCsrfToken();

                setTimeout(() => {
                    hideUploadProgress();
                    refreshHistory();
                }, 2000);

                resolve(true);
            } else {
                showToast('error', 'Upload Failed', `Server returned: ${xhr.status}`);
                hideUploadProgress();
                resolve(false);
            }
            _uploadInProgress = false;
        });

        // Handle errors
        xhr.addEventListener('error', () => {
            showToast('error', 'Upload Error', 'Network error during upload');
            hideUploadProgress();
            _uploadInProgress = false;
            resolve(false);
        });

        // Handle abort
        xhr.addEventListener('abort', () => {
            showToast('warning', 'Upload Cancelled', 'File upload was cancelled');
            hideUploadProgress();
            _uploadInProgress = false;
            resolve(false);
        });

        // Store reference for cancel functionality
        _uploadAbortController = { abort: () => xhr.abort() };

        // Start upload
        xhr.open('POST', '/project/download');
        xhr.send(formData);
    });
}

/* ==========================================================================
   Theme Management (Siemens iX Design System)
   Uses data-ix-theme and data-ix-color-schema attributes
   ========================================================================== */

/**
 * Initialize theme from localStorage or system preference
 * Uses Siemens iX theme attributes: data-ix-theme="classic" data-ix-color-schema="light|dark"
 */
function initTheme() {
    const savedColorSchema = localStorage.getItem('ix-color-schema');

    if (savedColorSchema) {
        document.documentElement.setAttribute('data-ix-color-schema', savedColorSchema);
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        document.documentElement.setAttribute('data-ix-color-schema', 'dark');
    }
    // Default theme is 'classic' - already set in HTML
}

/**
 * Toggle between light and dark color schema (Siemens iX style)
 */
function toggleDarkMode() {
    const currentSchema = document.documentElement.getAttribute('data-ix-color-schema');
    const newSchema = currentSchema === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-ix-color-schema', newSchema);
    localStorage.setItem('ix-color-schema', newSchema);

    // Show toast notification
    const themeName = newSchema === 'dark' ? 'Dark' : 'Light';
    showToast('info', 'Theme Changed', `${themeName} mode enabled`);
}

// Initialize theme immediately to prevent flash
initTheme();

/* ==========================================================================
   Tab Navigation
   ========================================================================== */

/**
 * Switch between tabs in the main interface
 * @param {Event} evt - Click event
 * @param {string} tabName - ID of the tab content to show
 */
function openTab(evt, tabName) {
    const tabcontent = document.getElementsByClassName("tab-content");
    for (let i = 0; i < tabcontent.length; i++) {
        tabcontent[i].classList.remove("active");
    }

    const tablinks = document.getElementsByClassName("tab-link");
    for (let i = 0; i < tablinks.length; i++) {
        tablinks[i].classList.remove("active");
    }

    document.getElementById(tabName).classList.add("active");
    evt.currentTarget.classList.add("active");
}

/* ==========================================================================
   Download Tab Functions
   ========================================================================== */

/**
 * Toggle visibility of restart warning notice
 */
function toggleNotice() {
    const checkbox = document.getElementById("restartProject");
    const notice = document.getElementById("restartNotice");
    notice.style.display = checkbox.checked ? "block" : "none";
}

/**
 * Handle download form submission
 * Shows confirmation modal if restart is checked
 * @param {Event} event - Form submit event
 */
function handleDownload(event) {
    event.preventDefault();

    const fileInput = document.querySelector('input[name="dateiupload"]');
    const file = fileInput.files[0];

    if (!file) {
        showToast('warning', 'No File', 'Please select a ZIP file first');
        return;
    }

    const checkbox = document.getElementById("restartProject");

    if (checkbox.checked) {
        pendingEvent = event;
        document.getElementById("confirmationModal").style.display = "block";
    } else {
        // Show ZIP preview
        previewZipFile(file);
    }
}

/**
 * Handle confirmation modal response
 * @param {boolean} confirmed - Whether user confirmed the action
 */
function confirmDownload(confirmed) {
    document.getElementById("confirmationModal").style.display = "none";
    if (confirmed) {
        const fileInput = document.querySelector('input[name="dateiupload"]');
        const file = fileInput.files[0];
        if (file) {
            previewZipFile(file);
        }
    }
}

/**
 * Upload file to server
 * @param {Event} event - Form submit event
 */
async function downloadFile(event) {
    const form = document.getElementById("downloadForm");
    const formData = new FormData(form);

    // Get a valid CSRF token
    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
        alert("Security error: Could not obtain CSRF token. Please refresh the page.");
        return;
    }

    // Add CSRF token to form data
    formData.set('csrfToken', csrfToken);

    try {
        const response = await fetch("/project/download", {
            method: "POST",
            body: formData
        });

        if (response.ok) {
            const result = await response.text();
            alert("Download successful: " + result);
            // Refresh CSRF token after successful submission
            await refreshCsrfToken();
        } else if (response.status === 403) {
            alert("Security error: Invalid or expired CSRF token. Please try again.");
            await refreshCsrfToken();
        } else {
            alert("Download failed: " + response.statusText);
        }

    } catch (error) {
        alert("Error: " + error.message);
    }

    event.target.reset();
    toggleNotice();
}

/* ==========================================================================
   Console Tab Functions
   ========================================================================== */

/**
 * Clear instance tabs and content containers
 */
function clearInstanceTabs() {
    const tabsContainer = document.getElementById('instanceTabsContainer');
    const contentContainer = document.getElementById('instanceContentContainer');

    while (tabsContainer.firstChild) {
        tabsContainer.removeChild(tabsContainer.firstChild);
    }

    while (contentContainer.firstChild) {
        contentContainer.removeChild(contentContainer.firstChild);
    }
}


/**
 * Create a table displaying manager information
 * @param {Object} instance - Instance data with progs array
 * @returns {HTMLTableElement} - The created table element
 */
function createManagerTable(instance) {
    const table = document.createElement('table');
    table.border = '1';

    const headerRow = document.createElement('tr');
    const headers = ['manager', 'state', 'pid', 'startMode', 'restartCount', 'startTime', 'manNum', 'actions'];

    headers.forEach(header => {
        const th = document.createElement('th');
        th.textContent = header === 'actions' ? 'Actions' : header;
        headerRow.appendChild(th);
    });
    table.appendChild(headerRow);

    // Get hostname for this instance
    const hostname = instance.hostname || '';

    if (instance.progs) {
        instance.progs.forEach(prog => {
            const row = document.createElement('tr');
            headers.forEach(header => {
                const td = document.createElement('td');

                if (header === 'actions') {
                    // Create action buttons with hostname (skip for WCCILpmon)
                    td.className = 'manager-actions';
                    const managerName = prog.manager || '';
                    if (!managerName.includes('WCCILpmon')) {
                        td.appendChild(createManagerActionButtons(prog.shmId, prog.state, hostname, managerName));
                    }
                } else {
                    const value = prog[header] || '';
                    if (header === 'state') {
                        td.setAttribute('data-state', value);
                        td.className = 'state-cell';
                    }
                    td.textContent = value;
                }
                row.appendChild(td);
            });
            table.appendChild(row);
        });
    }

    return table;
}

/**
 * Create action buttons for a manager row
 * @param {number} shmId - Manager shared memory ID (index in pmon list)
 * @param {string} state - Current manager state
 * @param {string} hostname - Hostname of the instance
 * @param {string} managerName - Name of the manager
 * @returns {HTMLDivElement} - Container with action buttons
 */
function createManagerActionButtons(shmId, state, hostname, managerName) {
    const container = document.createElement('div');
    container.className = 'action-buttons';

    const isRunning = state && state.toLowerCase() === 'running';
    const isStopped = state && (state.toLowerCase() === 'stopped' || state.toLowerCase() === 'initialized');

    // Start button
    const startBtn = document.createElement('button');
    startBtn.className = 'btn-action btn-start';
    startBtn.innerHTML = '&#9654;'; // Play symbol
    startBtn.title = 'Start manager';
    startBtn.disabled = isRunning;
    startBtn.onclick = () => confirmManagerCommand('start', shmId, hostname, managerName);

    // Stop button
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-action btn-stop';
    stopBtn.innerHTML = '&#9632;'; // Stop symbol
    stopBtn.title = 'Stop manager';
    stopBtn.disabled = isStopped;
    stopBtn.onclick = () => confirmManagerCommand('stop', shmId, hostname, managerName);

    // Restart button
    const restartBtn = document.createElement('button');
    restartBtn.className = 'btn-action btn-restart';
    restartBtn.innerHTML = '&#8635;'; // Refresh symbol
    restartBtn.title = 'Restart manager';
    restartBtn.onclick = () => confirmManagerCommand('restart', shmId, hostname, managerName);

    container.appendChild(startBtn);
    container.appendChild(stopBtn);
    container.appendChild(restartBtn);

    return container;
}

/**
 * Show confirmation dialog before executing manager command
 * @param {string} action - Action to perform
 * @param {number} shmId - Manager shared memory ID
 * @param {string} hostname - Hostname of the instance
 * @param {string} managerName - Name of the manager
 */
function confirmManagerCommand(action, shmId, hostname, managerName) {
    const actionLabels = {
        'start': 'START',
        'stop': 'STOP',
        'restart': 'RESTART'
    };

    const message = `Are you sure you want to ${actionLabels[action]} the manager "${managerName}" on ${hostname}?`;

    if (confirm(message)) {
        sendManagerCommand(action, shmId, hostname);
    }
}

/**
 * Show confirmation dialog before restarting an instance
 * @param {string} hostname - Hostname of the instance to restart
 */
function confirmRestartInstance(hostname) {
    const message = `Are you sure you want to RESTART ALL MANAGERS on instance "${hostname}"?\n\nThis will temporarily interrupt all services on this instance.`;

    if (confirm(message)) {
        restartInstance(hostname);
    }
}

/**
 * Show confirmation dialog before restarting all instances
 * @param {Array} instances - Array of all instances
 */
function confirmRestartAllInstances(instances) {
    const hostnames = instances.map(i => i.hostname || 'Unknown').join(', ');
    const message = `Are you sure you want to RESTART ALL MANAGERS on ALL INSTANCES?\n\nThis will restart the following instances:\n${hostnames}\n\nThis will temporarily interrupt all services.`;

    if (confirm(message)) {
        restartAllInstances(instances);
    }
}

/**
 * Restart all managers on a specific instance
 * @param {string} hostname - Hostname of the instance to restart
 */
async function restartInstance(hostname) {
    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
        showToast('error', 'Error', 'No CSRF token available');
        return;
    }

    showToast('info', 'Instance Restart', `Restarting all managers on ${hostname}...`);

    try {
        const response = await fetch('/project/restart', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                restart: true,
                hostname: hostname,
                csrfToken: csrfToken
            })
        });

        await refreshCsrfToken();

        if (response.ok) {
            showToast('success', 'Instance Restart', `Restart command sent to ${hostname}`);
        } else if (response.status === 403) {
            showToast('error', 'Security Error', 'Invalid or expired CSRF token');
        } else {
            showToast('error', 'Restart Failed', response.statusText);
        }
    } catch (error) {
        showToast('error', 'Restart Failed', 'Network error: ' + error.message);
    }
}

/**
 * Restart all managers on all instances
 * @param {Array} instances - Array of all instances
 */
async function restartAllInstances(instances) {
    showToast('info', 'Restart All', `Restarting ${instances.length} instances...`);

    let successCount = 0;
    let failCount = 0;

    for (const instance of instances) {
        const hostname = instance.hostname;
        if (!hostname) continue;

        const csrfToken = await getCsrfToken();
        if (!csrfToken) {
            failCount++;
            continue;
        }

        try {
            const response = await fetch('/project/restart', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    restart: true,
                    hostname: hostname,
                    csrfToken: csrfToken
                })
            });

            await refreshCsrfToken();

            if (response.ok) {
                successCount++;
            } else {
                failCount++;
            }
        } catch (error) {
            failCount++;
        }
    }

    if (failCount === 0) {
        showToast('success', 'Restart All', `All ${successCount} instances restarting`);
    } else {
        showToast('warning', 'Restart All', `${successCount} succeeded, ${failCount} failed`);
    }
}

/**
 * Send a manager control command to the server
 * @param {string} action - Action to perform: 'start', 'stop', or 'restart'
 * @param {number} shmId - Manager shared memory ID (index in pmon list)
 * @param {string} hostname - Hostname of the target instance
 */
async function sendManagerCommand(action, shmId, hostname) {
    // Get a valid CSRF token
    const csrfToken = await getCsrfToken();

    if (!csrfToken) {
        showToast('error', 'Error', 'No CSRF token available');
        return;
    }

    const actionLabels = {
        'start': 'Starting',
        'stop': 'Stopping',
        'restart': 'Restarting'
    };

    showToast('info', 'Manager Control', `${actionLabels[action]} manager ${shmId} on ${hostname}...`);

    try {
        const response = await fetch('/project/manager', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: action,
                shmId: shmId,
                hostname: hostname,
                csrfToken: csrfToken
            })
        });

        // Token was used, fetch a new one
        await refreshCsrfToken();

        const result = await response.json();

        if (result.success) {
            showToast('success', 'Manager Control', result.message);
        } else {
            showToast('error', 'Manager Control Failed', result.error || 'Unknown error');
        }
    } catch (error) {
        console.error('Manager command error:', error);
        showToast('error', 'Manager Control Failed', 'Network error: ' + error.message);
    }
}

/**
 * Show content for a specific instance tab
 * @param {number} index - Index of the instance to show
 * @param {number} totalInstances - Total number of instances
 */
function showInstanceContent(index, totalInstances) {
    // Update tab buttons
    const buttons = document.querySelectorAll('.instance-tab-button');
    buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
    });

    // Update content visibility
    for (let i = 0; i < totalInstances; i++) {
        const content = document.getElementById('instanceContent' + i);
        if (content) {
            content.style.display = i === index ? 'block' : 'none';
        }
    }
}

/**
 * Update the last refresh timestamp display
 */
function updateLastRefreshTime() {
    _lastRefreshTime = new Date();
    const element = document.getElementById('lastRefreshTime');
    if (element) {
        element.textContent = _lastRefreshTime.toLocaleTimeString();
    }
}

/* ==========================================================================
   CSRF Token Management
   ========================================================================== */

/**
 * Fetch a new CSRF token from the server
 * @returns {Promise<string>} The CSRF token
 */
async function fetchCsrfToken() {
    try {
        const response = await fetch('/project/csrftoken');
        const text = await response.text();
        console.log('CSRF response status:', response.status, 'body:', text);

        if (response.ok && text) {
            const data = JSON.parse(text);
            _csrfToken = data.csrfToken;
            _csrfTokenExpiry = Date.now() + (data.expiresIn * 1000);
            updateCsrfTokenDisplay();
            console.log('CSRF token fetched successfully');
            return _csrfToken;
        } else {
            console.error('Failed to fetch CSRF token:', response.statusText);
            return null;
        }
    } catch (error) {
        console.error('Error fetching CSRF token:', error);
        return null;
    }
}

/**
 * Get a valid CSRF token, fetching a new one if needed
 * @returns {Promise<string>} The CSRF token
 */
async function getCsrfToken() {
    // If token is missing or expired (with 60s buffer), fetch a new one
    if (!_csrfToken || !_csrfTokenExpiry || Date.now() > (_csrfTokenExpiry - 60000)) {
        return await fetchCsrfToken();
    }
    return _csrfToken;
}

/**
 * Update the hidden CSRF token field in forms
 */
function updateCsrfTokenDisplay() {
    const csrfInputs = document.querySelectorAll('input[name="csrfToken"]');
    csrfInputs.forEach(input => {
        input.value = _csrfToken || '';
    });
}

/**
 * Consume the current token and fetch a new one
 * Called after successful form submission
 */
async function refreshCsrfToken() {
    _csrfToken = null;
    _csrfTokenExpiry = null;
    await fetchCsrfToken();
}

/* ==========================================================================
   Server Availability Check
   ========================================================================== */

/**
 * Check if server is reachable and show modal if not
 */
function checkServerAvailability() {
    fetch("/", { method: "HEAD" })
        .then(response => {
            if (!response.ok) throw new Error("Server not reachable");
            document.getElementById("serverModal").style.display = "none";

            if (!_serverAvailable) {
                // Reconnect WebSocket when server becomes available
                initWebSocket();
            }
            _serverAvailable = true;

            setTimeout(checkServerAvailability, 2000);
        })
        .catch(error => {
            _serverAvailable = false;
            document.getElementById("serverModal").style.display = "block";
            setTimeout(checkServerAvailability, 2000);
        });
}

/* ==========================================================================
   Log Viewer Functions
   ========================================================================== */

// Log viewer state
let _logLastLineId = 0;
let _logLastPos = 0;
let _logCurrentFile = null;
let _logIsScrollPaused = false;
let _logRefreshIntervalId = null;
let _logUseWebSocket = true; // Use WebSocket by default, fallback to polling
let _logLineCount = 0;
let _logIsLoading = false;

/**
 * Show log loading overlay
 * @param {string} message - Optional loading message
 */
function showLogLoading(message = 'Loading log file...') {
    const overlay = document.getElementById('logLoadingOverlay');
    const textElement = overlay?.querySelector('.log-loading-text');
    if (overlay) {
        if (textElement) textElement.textContent = message;
        overlay.style.display = 'flex';
    }
    _logIsLoading = true;
}

/**
 * Hide log loading overlay
 */
function hideLogLoading() {
    const overlay = document.getElementById('logLoadingOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
    _logIsLoading = false;
}

/**
 * Refresh the list of available log files
 * Uses WebSocket if available, falls back to HTTP
 */
function refreshLogFiles() {
    // Try WebSocket first
    if (_logUseWebSocket && _websocket && _websocket.readyState === WebSocket.OPEN) {
        sendWebSocketMessage({ type: 'getLogFiles' });
        return;
    }

    // Fallback to HTTP
    fetch('/logs/files')
        .then(response => response.json())
        .then(data => {
            handleLogFilesList(data);
        })
        .catch(error => {
            console.error('Error fetching log files:', error);
        });
}

/**
 * Handle log file selection change
 * Uses WebSocket subscription if available, falls back to HTTP polling
 */
function selectLogFile() {
    const select = document.getElementById('logFileSelect');
    const fileName = select.value;

    // Unsubscribe from previous file if using WebSocket
    if (_logCurrentFile && _logUseWebSocket && _websocket && _websocket.readyState === WebSocket.OPEN) {
        sendWebSocketMessage({ type: 'unsubscribeLog' });
    }

    if (!fileName) {
        stopLogRefresh();
        resetLogViewer();
        _logCurrentFile = null;
        return;
    }

    _logCurrentFile = fileName;
    _logLastLineId = 0;
    _logLastPos = 0;
    _logLineCount = 0;
    document.getElementById('logContainer').innerHTML = '';
    updateLogFileInfo(fileName);
    updateLogLineCount();

    // Show loading indicator
    showLogLoading('Loading ' + fileName + '...');

    // Try WebSocket subscription first
    if (_logUseWebSocket && _websocket && _websocket.readyState === WebSocket.OPEN) {
        sendWebSocketMessage({
            type: 'subscribeLog',
            file: fileName,
            startPos: 0
        });
        // No need for polling interval with WebSocket
        stopLogRefresh();
        updateLogConnectionStatus('streaming');
        logViewerLog('Subscribed to log file via WebSocket:', fileName);
    } else {
        // Fallback to HTTP polling
        logViewerLog('Using HTTP polling for log file:', fileName);
        updateLogConnectionStatus('polling');
        loadLogLines();
        startLogRefresh();
    }
}

/**
 * Start the log auto-refresh interval
 */
function startLogRefresh() {
    stopLogRefresh();
    _logRefreshIntervalId = setInterval(loadLogLines, 3000);
}

/**
 * Stop the log auto-refresh interval
 */
function stopLogRefresh() {
    if (_logRefreshIntervalId) {
        clearInterval(_logRefreshIntervalId);
        _logRefreshIntervalId = null;
    }
}

/**
 * Load new log lines from the server
 */
async function loadLogLines() {
    if (!_logCurrentFile) return;

    try {
        const response = await fetch(`/logs/read?file=${encodeURIComponent(_logCurrentFile)}&since=${_logLastLineId}&limit=1000`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Error('API Error');

        const data = await response.json();

        // Hide loading indicator after first successful load
        hideLogLoading();

        if (data.error) {
            throw new Error(data.error);
        }

        const newLines = data.lines || [];
        const newId = data.lastId || _logLastLineId;

        _logLastLineId = newId;

        if (newLines.length > 0) {
            renderLogLines(newLines);
        }

        applyLogFilter();

    } catch (error) {
        console.error('Error loading log lines:', error);
        hideLogLoading();
        const container = document.getElementById('logContainer');
        const errorSpan = document.createElement('span');
        errorSpan.className = 'log-error';
        errorSpan.textContent = '[Error] ' + error.message;
        container.appendChild(errorSpan);
    }
}

/**
 * Render log lines to the container
 * @param {string[]} lines - Array of log lines
 */
function renderLogLines(lines) {
    const container = document.getElementById('logContainer');

    for (const line of lines) {
        const span = document.createElement('span');
        span.className = getLogLevelClass(line);
        span.textContent = line;
        container.appendChild(span);
        _logLineCount++;
    }

    updateLogLineCount();

    if (!_logIsScrollPaused) {
        container.scrollTop = container.scrollHeight;
    }
}

/**
 * Determine CSS class based on log level
 * @param {string} line - Log line content
 * @returns {string} CSS class name
 */
function getLogLevelClass(line) {
    const upperLine = line.toUpperCase();
    if (upperLine.includes('SEVERE')) return 'log-severe';
    if (upperLine.includes('ERROR')) return 'log-error';
    if (upperLine.includes('WARNING') || upperLine.includes('WARN')) return 'log-warning';
    if (upperLine.includes('DEBUG')) return 'log-debug';
    if (upperLine.includes('INFO')) return 'log-info';
    return 'log-default';
}

/**
 * Apply filter to visible log lines
 */
function applyLogFilter() {
    const filterInput = document.getElementById('logFilterInput');
    const filter = filterInput.value.toLowerCase();
    const container = document.getElementById('logContainer');
    const spans = container.querySelectorAll('span');

    spans.forEach(span => {
        const visible = filter === '' || span.textContent.toLowerCase().includes(filter);
        span.style.display = visible ? 'block' : 'none';
    });

    if (!_logIsScrollPaused) {
        container.scrollTop = container.scrollHeight;
    }
}

/**
 * Initialize log viewer event listeners
 */
function initLogViewer() {
    const filterInput = document.getElementById('logFilterInput');
    const pauseCheckbox = document.getElementById('logPauseScroll');
    const container = document.getElementById('logContainer');

    if (filterInput) {
        filterInput.addEventListener('input', applyLogFilter);
    }

    if (pauseCheckbox) {
        // Auto-scroll toggle: checked = auto-scroll enabled (not paused)
        pauseCheckbox.checked = true; // Default: auto-scroll on
        pauseCheckbox.addEventListener('change', function(e) {
            _logIsScrollPaused = !e.target.checked; // Inverted: checked = scrolling
            container.classList.toggle('paused', _logIsScrollPaused);
        });
    }

    // Load initial file list
    refreshLogFiles();
}

/**
 * Reset log viewer to initial state
 */
function resetLogViewer() {
    const container = document.getElementById('logContainer');
    container.innerHTML = `
        <div class="log-placeholder">
            <span class="log-placeholder-icon">&#128196;</span>
            <span class="log-placeholder-text">Select a log file to view its contents</span>
        </div>
    `;
    _logLineCount = 0;
    updateLogLineCount();
    updateLogFileInfo(null);
    updateLogConnectionStatus('disconnected');
}

/**
 * Update the log line count display
 */
function updateLogLineCount() {
    const element = document.getElementById('logLineCount');
    if (element) {
        element.textContent = _logLineCount + ' line' + (_logLineCount !== 1 ? 's' : '');
    }
}

/**
 * Update the log file info display
 * @param {string|null} fileName - Current file name or null
 */
function updateLogFileInfo(fileName) {
    const element = document.getElementById('logFileInfo');
    if (element) {
        element.textContent = fileName ? fileName : 'No file selected';
    }
}

/**
 * Update the log connection status indicator
 * @param {string} status - 'streaming', 'polling', 'disconnected'
 */
function updateLogConnectionStatus(status) {
    const indicator = document.getElementById('logStatusIndicator');
    const text = document.getElementById('logStatusText');

    if (!indicator || !text) return;

    indicator.className = 'log-status-indicator';

    switch (status) {
        case 'streaming':
            indicator.classList.add('streaming');
            text.textContent = 'Live streaming';
            break;
        case 'polling':
            indicator.classList.add('polling');
            text.textContent = 'Polling (3s)';
            break;
        case 'connected':
            indicator.classList.add('connected');
            text.textContent = 'Connected';
            break;
        default:
            text.textContent = 'Not connected';
    }
}

/**
 * Clear the log filter input
 */
function clearLogFilter() {
    const filterInput = document.getElementById('logFilterInput');
    if (filterInput) {
        filterInput.value = '';
        applyLogFilter();
    }
}

/**
 * Scroll log container to top
 */
function scrollToTop() {
    const container = document.getElementById('logContainer');
    if (container) {
        container.scrollTop = 0;
    }
}

/**
 * Scroll log container to bottom
 */
function scrollToBottom() {
    const container = document.getElementById('logContainer');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

// Log viewer maximize state
let _logIsMaximized = false;

/**
 * Toggle log viewer maximize state
 */
function toggleLogMaximize() {
    const logsTab = document.getElementById('Logs');
    const maximizeIcon = document.getElementById('logMaximizeIcon');
    const minimizeIcon = document.getElementById('logMinimizeIcon');
    const maximizeBtn = document.getElementById('logMaximizeBtn');

    _logIsMaximized = !_logIsMaximized;

    if (_logIsMaximized) {
        logsTab.classList.add('maximized');
        maximizeIcon.style.display = 'none';
        minimizeIcon.style.display = 'block';
        maximizeBtn.title = 'Restore log viewer';
        document.body.style.overflow = 'hidden';
    } else {
        logsTab.classList.remove('maximized');
        maximizeIcon.style.display = 'block';
        minimizeIcon.style.display = 'none';
        maximizeBtn.title = 'Maximize log viewer';
        document.body.style.overflow = '';
    }
}

/**
 * Handle Escape key to exit maximized mode
 */
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _logIsMaximized) {
        toggleLogMaximize();
    }
});

/* ==========================================================================
   Deployment History Functions
   ========================================================================== */

// Store history data for filtering
let _historyData = [];

/**
 * Refresh deployment history from server
 */
function refreshHistory() {
    fetch('/project/history')
        .then(response => response.json())
        .then(data => {
            _historyData = data.history || [];
            renderHistory(_historyData);
            updateHistoryCount(data.totalCount || 0);
        })
        .catch(error => {
            console.error('Error fetching history:', error);
            document.getElementById('historyTableBody').innerHTML =
                '<tr><td colspan="6" class="history-empty">Error loading history</td></tr>';
        });
}

/**
 * Update the history count display
 * @param {number} count - Number of deployments
 */
function updateHistoryCount(count) {
    const countElement = document.getElementById('historyCount');
    if (countElement) {
        countElement.textContent = count + ' deployment' + (count !== 1 ? 's' : '');
    }
}

/**
 * Render history entries to the table
 * @param {Array} history - Array of history entries
 */
function renderHistory(history) {
    const tbody = document.getElementById('historyTableBody');

    if (!history || history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="history-empty">No deployment history available</td></tr>';
        return;
    }

    let html = '';
    history.forEach(entry => {
        const statusClass = entry.status === 0 ? 'success' : 'failed';
        const statusText = entry.status === 0 ? 'Success' : 'Failed';
        const fileSize = formatFileSize(entry.fileSize || 0);

        html += `<tr>
            <td>${escapeHtml(entry.timestamp || '-')}</td>
            <td>${escapeHtml(entry.fileName || '-')}</td>
            <td class="file-size">${fileSize}</td>
            <td>${escapeHtml(entry.user || 'unknown')}</td>
            <td><span class="hostname-badge">${escapeHtml(entry.hostname || '-')}</span></td>
            <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        </tr>`;
    });

    tbody.innerHTML = html;
}

/**
 * Filter history based on search and status filter
 */
function filterHistory() {
    const searchTerm = document.getElementById('historySearch').value.toLowerCase();
    const statusFilter = document.getElementById('historyStatusFilter').value;

    const filtered = _historyData.filter(entry => {
        // Status filter
        if (statusFilter === 'success' && entry.status !== 0) return false;
        if (statusFilter === 'failed' && entry.status === 0) return false;

        // Search filter
        if (searchTerm) {
            const searchableText = [
                entry.timestamp,
                entry.fileName,
                entry.user,
                entry.hostname
            ].join(' ').toLowerCase();

            if (!searchableText.includes(searchTerm)) return false;
        }

        return true;
    });

    renderHistory(filtered);
    updateHistoryCount(filtered.length);
}

/**
 * Export history to CSV file
 */
function exportHistoryCSV() {
    if (!_historyData || _historyData.length === 0) {
        showToast('warning', 'No Data', 'No deployment history to export');
        return;
    }

    // CSV header
    const headers = ['Date/Time', 'File Name', 'Size (bytes)', 'User', 'Host', 'Status', 'Message'];
    const csvRows = [headers.join(',')];

    // CSV data rows
    _historyData.forEach(entry => {
        const row = [
            `"${entry.timestamp || ''}"`,
            `"${entry.fileName || ''}"`,
            entry.fileSize || 0,
            `"${entry.user || ''}"`,
            `"${entry.hostname || ''}"`,
            entry.status === 0 ? 'Success' : 'Failed',
            `"${(entry.statusMessage || '').replace(/"/g, '""')}"`
        ];
        csvRows.push(row.join(','));
    });

    // Create and download file
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `deployment_history_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    showToast('success', 'Export Complete', `${_historyData.length} entries exported to CSV`);
}

/**
 * Format file size to human readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ==========================================================================
   Toast Notifications
   ========================================================================== */

/**
 * Show a toast notification
 * @param {string} type - Toast type: 'success', 'error', 'warning', 'info'
 * @param {string} title - Toast title
 * @param {string} message - Toast message
 * @param {number} duration - Duration in ms (default: 5000)
 */
function showToast(type, title, message, duration = 5000) {
    const container = document.getElementById('toastContainer');

    const icons = {
        success: '\u2713',
        error: '\u2717',
        warning: '\u26A0',
        info: '\u2139'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <div class="toast-content">
            <div class="toast-title">${escapeHtml(title)}</div>
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">\u00D7</button>
    `;

    container.appendChild(toast);

    // Auto-remove after duration
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/* ==========================================================================
   ZIP Preview Functions
   ========================================================================== */

// Store pending file for upload
let _pendingZipFile = null;

/**
 * Preview ZIP contents before upload
 * @param {File} file - The ZIP file to preview
 */
async function previewZipFile(file) {
    _pendingZipFile = file;

    // Update info
    document.getElementById('zipFileName').textContent = file.name;
    document.getElementById('zipFileSize').textContent = formatFileSize(file.size);

    // Read ZIP contents using JSZip-like approach (simplified)
    const tbody = document.getElementById('zipPreviewBody');
    tbody.innerHTML = '<tr><td colspan="2">Loading...</td></tr>';

    try {
        const entries = await readZipEntries(file);
        document.getElementById('zipFileCount').textContent = entries.length + ' files';

        let html = '';
        entries.forEach(entry => {
            const sizeStr = entry.isDirectory ? '-' : formatFileSize(entry.size);
            const pathClass = entry.isBlocked ? 'zip-file-warning' : '';
            html += `<tr>
                <td class="${pathClass}">${escapeHtml(entry.path)}</td>
                <td class="file-size">${sizeStr}</td>
            </tr>`;
        });
        tbody.innerHTML = html || '<tr><td colspan="2">Empty archive</td></tr>';

    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="2" class="zip-file-warning">Error reading ZIP: ${escapeHtml(error.message)}</td></tr>`;
    }

    // Show modal
    document.getElementById('zipPreviewModal').style.display = 'block';
}

/**
 * Read ZIP file entries (simplified - reads central directory)
 * @param {File} file - ZIP file
 * @returns {Promise<Array>} Array of file entries
 */
async function readZipEntries(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const entries = parseZipDirectory(data);
                resolve(entries);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Parse ZIP central directory to get file list
 * @param {Uint8Array} data - ZIP file data
 * @returns {Array} File entries
 */
function parseZipDirectory(data) {
    const entries = [];
    const view = new DataView(data.buffer);

    // Find End of Central Directory
    let eocdOffset = -1;
    for (let i = data.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset === -1) {
        throw new Error('Invalid ZIP file');
    }

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const entryCount = view.getUint16(eocdOffset + 10, true);

    // Parse central directory
    let offset = cdOffset;
    for (let i = 0; i < entryCount && offset < cdOffset + cdSize; i++) {
        if (view.getUint32(offset, true) !== 0x02014b50) break;

        const compSize = view.getUint32(offset + 20, true);
        const uncompSize = view.getUint32(offset + 24, true);
        const nameLen = view.getUint16(offset + 28, true);
        const extraLen = view.getUint16(offset + 30, true);
        const commentLen = view.getUint16(offset + 32, true);

        const nameBytes = data.slice(offset + 46, offset + 46 + nameLen);
        const path = new TextDecoder().decode(nameBytes);

        const isDirectory = path.endsWith('/');
        const isBlocked = path.includes('..') || path.startsWith('/');

        entries.push({
            path: path,
            size: uncompSize,
            compressedSize: compSize,
            isDirectory: isDirectory,
            isBlocked: isBlocked
        });

        offset += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

/**
 * Close ZIP preview modal
 */
function closeZipPreview() {
    document.getElementById('zipPreviewModal').style.display = 'none';
    _pendingZipFile = null;
}

/**
 * Confirm ZIP upload after preview
 */
function confirmZipUpload() {
    closeZipPreview();

    if (_pendingZipFile) {
        // Trigger the actual upload
        uploadZipFile(_pendingZipFile);
    }
}

/**
 * Upload ZIP file to server with progress tracking
 * Uses XMLHttpRequest for progress events support
 * @param {File} file - The ZIP file to upload
 */
async function uploadZipFile(file) {
    const restart = document.getElementById('restartProject').checked;
    // Use the progress-enabled upload function which handles everything
    await uploadFileWithProgress(file, restart);
}

/* ==========================================================================
   Initialization
   ========================================================================== */

/**
 * Initialize application on DOM ready
 */
document.addEventListener("DOMContentLoaded", async function() {
    toggleNotice();
    refreshHistory();
    initLogViewer();
    // Fetch initial CSRF token
    await fetchCsrfToken();
    // Initialize WebSocket for real-time updates (also handles pmon status)
    initWebSocket();
});

/**
 * Start server availability check on window load
 */
window.onload = function() {
    checkServerAvailability();
};
