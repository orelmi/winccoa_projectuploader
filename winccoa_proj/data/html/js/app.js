/**
 * WinCC OA Project Manager - Main Application JavaScript
 * Author: orelmi
 */

/* ==========================================================================
   Global State
   ========================================================================== */

let pendingEvent = null;
let _serverAvailable = false;

// Auto-refresh state
let _autoRefreshEnabled = false;
let _autoRefreshIntervalId = null;
let _autoRefreshInterval = 5000; // Default: 5 seconds
let _lastRefreshTime = null;

// CSRF token state
let _csrfToken = null;
let _csrfTokenExpiry = null;

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
 * Send restart command to all project instances
 */
async function restartProject() {
    // Get a valid CSRF token
    const csrfToken = await getCsrfToken();
    if (!csrfToken) {
        alert("Security error: Could not obtain CSRF token. Please refresh the page.");
        return;
    }

    try {
        const response = await fetch("/project/restart", {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "restart": true,
                "csrfToken": csrfToken
            })
        });

        if (response.ok) {
            const result = await response.text();
            alert("Restart command acknowledge: " + result);
            // Refresh CSRF token after successful submission
            await refreshCsrfToken();
        } else if (response.status === 403) {
            alert("Security error: Invalid or expired CSRF token. Please try again.");
            await refreshCsrfToken();
        } else {
            alert("Restart failed: " + response.statusText);
        }

    } catch (error) {
        alert("Error: " + error.message);
    }
}

/**
 * Fetch and display pmon status for all instances
 */
function refreshStatus() {
    fetch('/project/pmon')
        .then(response => response.json())
        .then(data => {
            clearInstanceTabs();
            updateLastRefreshTime();

            const instances = data.instances;
            const tabsContainer = document.getElementById('instanceTabsContainer');
            const contentContainer = document.getElementById('instanceContentContainer');

            // Create tabs for each instance
            instances.forEach((instance, index) => {
                const tabButton = document.createElement('button');
                tabButton.textContent = instance.hostname || 'Instance ' + (index + 1);
                tabButton.className = 'instance-tab-button';
                if (index === 0) {
                    tabButton.classList.add('active');
                }
                tabButton.onclick = () => showInstanceContent(index, instances.length);
                tabsContainer.appendChild(tabButton);

                // Create content div for each instance
                const contentDiv = document.createElement('div');
                contentDiv.id = 'instanceContent' + index;
                contentDiv.style.display = index === 0 ? 'block' : 'none';

                // Create table for programs
                const table = createManagerTable(instance);
                contentDiv.appendChild(table);
                contentContainer.appendChild(contentDiv);
            });
        })
        .catch(error => {
            console.error('Error fetching instances:', error);
        });
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
    const headers = ['manager', 'resetMin', 'startMode', 'secKill', 'state', 'pid', 'restartCount', 'startTime', 'manNum', 'shmId', 'commandlineOptions'];

    headers.forEach(header => {
        const th = document.createElement('th');
        th.textContent = header;
        headerRow.appendChild(th);
    });
    table.appendChild(headerRow);

    if (instance.progs) {
        instance.progs.forEach(prog => {
            const row = document.createElement('tr');
            headers.forEach(header => {
                const td = document.createElement('td');
                const value = prog[header] || '';
                if (header === 'state') {
                    td.setAttribute('data-state', value);
                }
                td.textContent = value;
                row.appendChild(td);
            });
            table.appendChild(row);
        });
    }

    return table;
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

/* ==========================================================================
   Auto-Refresh Functions
   ========================================================================== */

/**
 * Toggle auto-refresh on/off
 */
function toggleAutoRefresh() {
    const checkbox = document.getElementById('autoRefreshCheckbox');
    _autoRefreshEnabled = checkbox.checked;

    if (_autoRefreshEnabled) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }

    updateAutoRefreshUI();
}

/**
 * Start the auto-refresh interval
 */
function startAutoRefresh() {
    if (_autoRefreshIntervalId) {
        clearInterval(_autoRefreshIntervalId);
    }

    _autoRefreshIntervalId = setInterval(function() {
        if (_serverAvailable) {
            refreshStatus();
        }
    }, _autoRefreshInterval);
}

/**
 * Stop the auto-refresh interval
 */
function stopAutoRefresh() {
    if (_autoRefreshIntervalId) {
        clearInterval(_autoRefreshIntervalId);
        _autoRefreshIntervalId = null;
    }
}

/**
 * Change the auto-refresh interval
 */
function changeRefreshInterval() {
    const select = document.getElementById('refreshIntervalSelect');
    _autoRefreshInterval = parseInt(select.value, 10);

    // Restart interval if auto-refresh is enabled
    if (_autoRefreshEnabled) {
        startAutoRefresh();
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

/**
 * Update auto-refresh UI state (button appearance, etc.)
 */
function updateAutoRefreshUI() {
    const checkbox = document.getElementById('autoRefreshCheckbox');
    const select = document.getElementById('refreshIntervalSelect');
    const statusIndicator = document.getElementById('autoRefreshStatus');

    if (checkbox) {
        checkbox.checked = _autoRefreshEnabled;
    }

    if (select) {
        select.disabled = !_autoRefreshEnabled;
    }

    if (statusIndicator) {
        statusIndicator.classList.toggle('active', _autoRefreshEnabled);
        statusIndicator.title = _autoRefreshEnabled ? 'Auto-refresh active' : 'Auto-refresh disabled';
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
        const response = await fetch('/project/csrf-token');
        if (response.ok) {
            const data = await response.json();
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
                refreshStatus();
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
let _logCurrentFile = null;
let _logIsFrozen = false;
let _logIsScrollPaused = false;
let _logRefreshIntervalId = null;

/**
 * Refresh the list of available log files
 */
function refreshLogFiles() {
    fetch('/logs/files')
        .then(response => response.json())
        .then(data => {
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
        })
        .catch(error => {
            console.error('Error fetching log files:', error);
        });
}

/**
 * Handle log file selection change
 */
function selectLogFile() {
    const select = document.getElementById('logFileSelect');
    const fileName = select.value;

    if (!fileName) {
        stopLogRefresh();
        document.getElementById('logContainer').textContent = 'Select a log file to view...';
        return;
    }

    _logCurrentFile = fileName;
    _logLastLineId = 0;
    document.getElementById('logContainer').innerHTML = '';

    // Start refreshing logs
    loadLogLines();
    startLogRefresh();
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
    if (_logIsFrozen || !_logCurrentFile) return;

    try {
        const response = await fetch(`/logs/read?file=${encodeURIComponent(_logCurrentFile)}&since=${_logLastLineId}&limit=1000`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) throw new Error('API Error');

        const data = await response.json();

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
    }

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
    const freezeCheckbox = document.getElementById('logFreezeUpdate');
    const container = document.getElementById('logContainer');

    if (filterInput) {
        filterInput.addEventListener('input', applyLogFilter);
    }

    if (pauseCheckbox) {
        pauseCheckbox.addEventListener('change', function(e) {
            _logIsScrollPaused = e.target.checked;
            container.classList.toggle('paused', _logIsScrollPaused);
        });
    }

    if (freezeCheckbox) {
        freezeCheckbox.addEventListener('change', function(e) {
            _logIsFrozen = e.target.checked;
            container.classList.toggle('frozen', _logIsFrozen);
        });
    }

    // Load initial file list
    refreshLogFiles();
}

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
 * Upload ZIP file to server
 * @param {File} file - The ZIP file to upload
 */
async function uploadZipFile(file) {
    const formData = new FormData();
    formData.append('dateiupload', file);
    formData.append('restartProject', document.getElementById('restartProject').checked);
    formData.append('csrfToken', getCsrfToken());

    showToast('info', 'Uploading', 'Deploying ' + file.name + '...');

    try {
        const response = await fetch('/project/download', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            showToast('success', 'Deployment Started', 'File uploaded successfully');
            // Refresh CSRF token after use
            await fetchCsrfToken();
            // Refresh history after a delay
            setTimeout(refreshHistory, 2000);
        } else {
            showToast('error', 'Upload Failed', 'Server returned: ' + response.status);
        }
    } catch (error) {
        showToast('error', 'Upload Error', error.message);
    }
}

/* ==========================================================================
   Initialization
   ========================================================================== */

/**
 * Initialize application on DOM ready
 */
document.addEventListener("DOMContentLoaded", async function() {
    toggleNotice();
    refreshStatus();
    refreshHistory();
    updateAutoRefreshUI();
    initLogViewer();
    // Fetch initial CSRF token
    await fetchCsrfToken();
});

/**
 * Start server availability check on window load
 */
window.onload = function() {
    checkServerAvailability();
};
