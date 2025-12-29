/**
 * WinCC OA Project Manager - Main Application JavaScript
 * Author: orelmi
 */

/* ==========================================================================
   Global State
   ========================================================================== */

let pendingEvent = null;
let _serverAvailable = false;

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

    try {
        const response = await fetch("/project/download", {
            method: "POST",
            body: formData
        });

        if (response.ok) {
            const result = await response.text();
            alert("Download successful: " + result);
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
    try {
        const response = await fetch("/project/restart", {
            method: "POST",
            body: JSON.stringify({ "restart": true })
        });

        if (response.ok) {
            const result = await response.text();
            alert("Restart command acknowledge: " + result);
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
   Initialization
   ========================================================================== */

/**
 * Initialize application on DOM ready
 */
document.addEventListener("DOMContentLoaded", function() {
    toggleNotice();
    refreshStatus();
});

/**
 * Start server availability check on window load
 */
window.onload = function() {
    checkServerAvailability();
};
