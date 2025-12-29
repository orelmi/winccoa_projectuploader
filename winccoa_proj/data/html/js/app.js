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
    const checkbox = document.getElementById("restartProject");

    if (checkbox.checked) {
        pendingEvent = event;
        document.getElementById("confirmationModal").style.display = "block";
    } else {
        downloadFile(event);
    }
}

/**
 * Handle confirmation modal response
 * @param {boolean} confirmed - Whether user confirmed the action
 */
function confirmDownload(confirmed) {
    document.getElementById("confirmationModal").style.display = "none";
    if (confirmed) {
        downloadFile(pendingEvent);
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
   Initialization
   ========================================================================== */

/**
 * Initialize application on DOM ready
 */
document.addEventListener("DOMContentLoaded", async function() {
    toggleNotice();
    refreshStatus();
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
